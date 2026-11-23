import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { exchange, type OAuthContext, type OAuthExchange, type OAuthFinding, type OAuthStep, type OAuthTrace, STEP_TITLES } from './oauth-discovery';

// Task 4348 S5b: client registration and the authorization redirect, as three more steps after discovery:
//   registration (DCR, CIMD client_id URL, or a pre-registered client_id) -> authorize (PKCE, opens the browser)
//   -> authorization response (a loopback listener receives the redirect; `state` and RFC 9207 `iss` are checked).
// It stops once a code is received. The token exchange, refresh and step-up are S5c.
// PROTOTYPE-MOCK: registrations are not cached or keyed by issuer (a fresh DCR every run); loopback redirect only.

const PREFERRED_PORT = 38_491;
export const CALLBACK_PATH = '/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const inFlight = new Map<string, AbortController>();

/** What the token exchange needs from a successful authorization response (S5c). One per request. */
export interface PendingExchange {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  context: OAuthContext;
  /** The scope actually requested (a step-up asks for more than `context.scope`), to compare with what is granted. */
  scope?: string;
}
const pendingExchanges = new Map<string, PendingExchange>();
export const takePendingExchange = (requestId: string) => {
  const pending = pendingExchanges.get(requestId);
  pendingExchanges.delete(requestId); // an authorization code is single use
  return pending;
};

export const b64url = (buf: Buffer) => buf.toString('base64url');
export const pkcePair = () => {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
};

export interface CallbackParams {
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  error_description?: string;
}

/** Check an authorization response against what we sent and what the authorization server advertised. */
export const checkAuthorizationResponse = (
  params: CallbackParams,
  expected: { state: string; issuer: string; issAdvertised: boolean },
): OAuthFinding[] => {
  const findings: OAuthFinding[] = [];
  if (params.error) {
    findings.push({ level: 'error', text: `The authorization server returned error=${params.error}${params.error_description ? `: ${params.error_description}` : ''}` });
  }
  if (params.state !== expected.state) {
    findings.push({ level: 'error', text: `state mismatch: sent ${expected.state}, got ${params.state ?? '(none)'}. A client must reject this response (CSRF).` });
  } else {
    findings.push({ level: 'info', text: 'state matches.' });
  }
  if (params.iss !== undefined) {
    findings.push(
      params.iss === expected.issuer
        ? { level: 'info', text: `iss matches the issuer we started with (${expected.issuer}).` }
        : { level: 'error', text: `iss mismatch: expected ${expected.issuer}, got ${params.iss}. This is the mix-up attack RFC 9207 defends against; a client must not send the code anywhere.` },
    );
  } else if (expected.issAdvertised) {
    findings.push({ level: 'error', text: 'The server advertises authorization_response_iss_parameter_supported but the response has no iss.' });
  } else {
    findings.push({ level: 'warn', text: 'No iss on the response and the server does not advertise it, so there is no mix-up protection here.' });
  }
  if (!params.error) {
    if (!params.code) {
      findings.push({ level: 'error', text: 'The response has no code.' });
    } else if (findings.some(f => f.level === 'error')) {
      findings.push({ level: 'warn', text: 'A code is present, but a client must not use it because the checks above failed.' });
    } else {
      findings.push({ level: 'info', text: 'Authorization code received. Use Get token in Step 3 to exchange it.' });
    }
  }
  return findings;
};

const statusOf = (findings: OAuthFinding[]) =>
  findings.some(f => f.level === 'error') ? ('error' as const) : findings.some(f => f.level === 'warn') ? ('warn' as const) : ('ok' as const);

const step = (id: OAuthStep['id'], status: OAuthStep['status'], summary: string, findings: OAuthFinding[], exchanges: OAuthExchange[] = []): OAuthStep => ({
  id,
  title: STEP_TITLES[id],
  status,
  summary,
  exchanges,
  findings,
});

export interface Listener {
  redirectUri: string;
  wait: (timeoutMs: number, signal: AbortSignal) => Promise<CallbackParams>;
  close: () => void;
}

/** A one-shot loopback HTTP listener (RFC 8252) for the redirect back from the browser. */
export const listenForCallback = async (): Promise<Listener> => {
  let resolveCallback: (p: CallbackParams) => void = () => {};
  const received = new Promise<CallbackParams>(resolve => {
    resolveCallback = resolve;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Insomnia</title><p style="font-family:sans-serif">Authorization response received. You can close this tab and return to Insomnia.</p>');
    resolveCallback(Object.fromEntries(url.searchParams) as CallbackParams);
  });
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
  try {
    await listen(PREFERRED_PORT);
  } catch {
    await listen(0);
  }
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    wait: (timeoutMs, signal) =>
      new Promise<CallbackParams>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No authorization response within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Cancelled'));
        });
        void received.then(p => {
          clearTimeout(timer);
          resolve(p);
        });
      }),
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
};

const isUrl = (value: string) => /^https?:\/\//i.test(value);

const register = async (context: OAuthContext, redirectUri: string, clientIdInput: string | undefined, trace?: OAuthTrace) => {
  const as = context.authorizationServer;
  if (clientIdInput && isUrl(clientIdInput)) {
    // CIMD: the client_id is a URL to a document the server fetches. Fetch it too so problems show up here.
    const doc = await exchange('GET', clientIdInput, { accept: 'application/json' }, undefined, { trace, label: 'Client metadata document (CIMD)' });
    const findings: OAuthFinding[] = [{ level: 'info', text: `client_id (CIMD URL): ${clientIdInput}` }];
    if (!as.client_id_metadata_document_supported) {
      findings.push({ level: 'warn', text: 'The server does not advertise client_id_metadata_document_supported, so it may not accept a URL client_id.' });
    }
    const body = doc.response?.body as { client_id?: string; redirect_uris?: string[] } | undefined;
    if (doc.response?.status !== 200 || typeof body !== 'object') {
      findings.push({ level: 'error', text: `Could not fetch the client metadata document (${doc.error ?? doc.response?.status}).` });
    } else {
      if (body.client_id !== clientIdInput) {
        findings.push({ level: 'error', text: `The document's client_id (${String(body.client_id)}) must equal the URL it is served from.` });
      }
      if (!body.redirect_uris?.includes(redirectUri)) {
        findings.push({ level: 'error', text: `The document's redirect_uris must include ${redirectUri} (this run's loopback address).` });
      }
    }
    return { clientId: clientIdInput, step: step('registration', statusOf(findings), 'CIMD client_id URL', findings, [doc]) };
  }
  if (clientIdInput) {
    return {
      clientId: clientIdInput,
      step: step('registration', 'ok', 'Pre-registered client_id', [
        { level: 'info', text: `Using client_id ${clientIdInput}. No registration request was made.` },
        { level: 'info', text: `Its registered redirect URI must include ${redirectUri}.` },
      ]),
    };
  }
  if (!as.registration_endpoint) {
    return {
      clientId: undefined,
      step: step('registration', 'error', 'No way to register', [
        { level: 'error', text: 'No client_id was given and the server has no registration_endpoint. Enter a pre-registered client_id or a CIMD URL.' },
      ]),
    };
  }
  const dcr = await exchange(
    'POST',
    as.registration_endpoint,
    { 'content-type': 'application/json', accept: 'application/json' },
    {
      client_name: 'Insomnia MCP debugger',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    { trace, label: STEP_TITLES.registration },
  );
  const body = dcr.response?.body as { client_id?: string; error?: string; error_description?: string } | undefined;
  if (dcr.response && dcr.response.status < 300 && body?.client_id) {
    return {
      clientId: body.client_id,
      step: step('registration', 'ok', `Registered as ${body.client_id}`, [{ level: 'info', text: 'Dynamic Client Registration (RFC 7591) succeeded.' }], [dcr]),
    };
  }
  return {
    clientId: undefined,
    step: step(
      'registration',
      'error',
      'Registration failed',
      [{ level: 'error', text: dcr.error ?? `${dcr.response?.status}: ${body?.error_description ?? body?.error ?? 'no client_id in the response'}` }],
      [dcr],
    ),
  };
};

/** Space-separated union of two scope strings, order kept, duplicates dropped. */
export const unionScopes = (...scopes: (string | undefined)[]) =>
  [...new Set(scopes.flatMap(scope => (scope ?? '').split(/\s+/)).filter(Boolean))].join(' ') || undefined;

export interface AuthorizeOptions {
  requestId: string;
  context: OAuthContext;
  /** A pre-registered client_id, or an HTTPS CIMD URL. Empty means use Dynamic Client Registration. */
  clientId?: string;
  /** Opens the authorization URL in the user's browser. Injected so tests can stand in for the browser. */
  openUrl: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  /** Overrides the scope to request (step-up asks for the union of what it has and what the server wants). */
  scope?: string;
  /** Reports each call to the Trace (S5 follow-up). */
  trace?: OAuthTrace;
}

export const runAuthorization = async ({ requestId, context, clientId: clientIdInput, openUrl, timeoutMs = DEFAULT_TIMEOUT_MS, scope: scopeOverride, trace }: AuthorizeOptions): Promise<OAuthStep[]> => {
  inFlight.get(requestId)?.abort();
  pendingExchanges.delete(requestId);
  const controller = new AbortController();
  inFlight.set(requestId, controller);
  const as = context.authorizationServer;
  const steps: OAuthStep[] = [];
  const listener = await listenForCallback();
  try {
    const registration = await register(context, listener.redirectUri, clientIdInput?.trim() || undefined, trace);
    if (registration.clientId && registration.step.status !== 'error') {
      registration.step.clientId = registration.clientId;
    }
    steps.push(registration.step);
    if (!registration.clientId || registration.step.status === 'error') {
      return steps;
    }
    if (!as.authorization_endpoint) {
      steps.push(step('authorize', 'error', 'No authorization_endpoint', [{ level: 'error', text: 'The server metadata has no authorization_endpoint.' }]));
      return steps;
    }

    const { verifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(16));
    const authorizeUrl = new URL(as.authorization_endpoint);
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: registration.clientId,
      redirect_uri: listener.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: context.resource,
      scope: scopeOverride ?? context.scope,
    };
    for (const [key, value] of Object.entries(params)) {
      if (value) {
        authorizeUrl.searchParams.set(key, value);
      }
    }
    const authorizeFindings: OAuthFinding[] = [
      { level: 'info', text: `Opened in your browser: ${authorizeUrl.toString()}` },
      { level: 'info', text: `PKCE S256 challenge sent; the verifier (${verifier.slice(0, 6)}…) stays in Insomnia until the token exchange.` },
      context.resource
        ? { level: 'info', text: `resource=${context.resource} (RFC 8707) binds the token to this MCP server.` }
        : { level: 'warn', text: 'The protected resource metadata gave no resource, so no resource parameter was sent.' },
      (scopeOverride ?? context.scope)
        ? { level: 'info', text: `scope=${scopeOverride ?? context.scope}` }
        : { level: 'info', text: 'No scope requested.' },
    ];
    // The browser leg is one Call: the request is the authorize URL we open, the reply is the redirect that comes back.
    const browserCall = trace?.(STEP_TITLES.authorize, { method: 'GET', url: authorizeUrl.toString(), headers: {} });
    await openUrl(authorizeUrl.toString());
    steps.push(step('authorize', 'ok', 'Opened in your browser', authorizeFindings));

    let callback: CallbackParams;
    try {
      callback = await listener.wait(timeoutMs, controller.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      browserCall?.fail(message === 'Cancelled' ? 'cancelled' : 'no-response', message);
      steps.push(step('callback', 'error', message, [{ level: 'error', text: message }]));
      return steps;
    }
    const findings = checkAuthorizationResponse(callback, {
      state,
      issuer: as.issuer ?? '',
      issAdvertised: as.authorization_response_iss_parameter_supported === true,
    });
    const status = statusOf(findings);
    browserCall?.redirect(callback as Record<string, string | undefined>, status !== 'error');
    if (status !== 'error' && callback.code) {
      pendingExchanges.set(requestId, { code: callback.code, verifier, clientId: registration.clientId, redirectUri: listener.redirectUri, context, scope: scopeOverride ?? context.scope });
    }
    steps.push(step('callback', status, status === 'error' ? 'Rejected' : 'Code received', [{ level: 'info', text: `Callback: ${JSON.stringify({ ...callback, code: callback.code ? `${callback.code.slice(0, 6)}…` : undefined })}` }, ...findings]));
    return steps;
  } finally {
    listener.close();
    if (inFlight.get(requestId) === controller) {
      inFlight.delete(requestId);
    }
  }
};

/** S8: register an in-flight browser leg for this request (aborting a previous one) so Cancel works for it too. */
export const beginInFlight = (requestId: string): AbortController => {
  inFlight.get(requestId)?.abort();
  const controller = new AbortController();
  inFlight.set(requestId, controller);
  return controller;
};
export const endInFlight = (requestId: string, controller: AbortController) => {
  if (inFlight.get(requestId) === controller) {
    inFlight.delete(requestId);
  }
};

export const cancelAuthorization = ({ requestId }: { requestId: string }) => {
  inFlight.get(requestId)?.abort();
};
