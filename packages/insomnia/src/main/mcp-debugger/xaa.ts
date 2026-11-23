import crypto from 'node:crypto';

import { decodeJwt } from '~/common/mcp-debugger/jwt';

import { exchange, type OAuthContext, type OAuthExchange, type OAuthFinding, type OAuthStep, type OAuthTrace, STEP_TITLES } from './oauth-discovery';
import { b64url, beginInFlight, endInFlight, listenForCallback, pkcePair } from './oauth-flow';
import { readTokenResponse, storeToken, verifyToken } from './oauth-token';

// Task 4348 S8: Enterprise-Managed Authorization (XAA). The MCP client signs the user in at the company identity
// provider (OIDC), trades the ID token for an ID-JAG at the IdP (RFC 8693 token exchange), and presents the ID-JAG to the
// MCP server's authorization server (RFC 7523 JWT bearer grant) to get an ordinary access token. Nobody is sent to the
// MCP authorization server's own login or consent page.
// Spec: MCP extension "Enterprise-Managed Authorization" (2026-07-28) and draft-ietf-oauth-identity-assertion-authz-grant
// (-04 when this was written). Every HTTP exchange is its own Call in the Trace, like the rest of the OAuth debugger.
// PROTOTYPE-MOCK: client secret only (no private_key_jwt client assertion yet), OIDC ID tokens only (no SAML), the ID
// token's signature is not verified (it is decoded for display, the IdP is the party that checks it), the client secret
// is kept in memory for the wizard session and shown as sent in the trace bodies, and nothing is persisted.

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';
export const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token';
export const ID_JAG_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';
export const ID_JAG_JWT_TYPE = 'oauth-id-jag+jwt';

export interface XaaIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

interface IdpMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

/** What one wizard run holds between its steps. One per request, in memory only. */
interface XaaSession {
  idp: XaaIdp;
  metadata: IdpMetadata;
  idToken?: string;
  idJag?: string;
}
const sessions = new Map<string, XaaSession>();
export const hasIdToken = ({ requestId }: { requestId: string }) => Boolean(sessions.get(requestId)?.idToken);
export const clearXaaSession = ({ requestId }: { requestId: string }) => {
  sessions.delete(requestId);
};

const form = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

const step = (id: OAuthStep['id'], status: OAuthStep['status'], summary: string, findings: OAuthFinding[], exchanges: OAuthExchange[] = [], jwts?: OAuthStep['jwts']): OAuthStep => ({
  id,
  title: STEP_TITLES[id],
  status,
  summary,
  exchanges,
  findings,
  ...(jwts ? { jwts } : {}),
});
const statusOf = (findings: OAuthFinding[]): OAuthStep['status'] =>
  findings.some(f => f.level === 'error') ? 'error' : findings.some(f => f.level === 'warn') ? 'warn' : 'ok';

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
const errorDetail = (ex: OAuthExchange) => {
  const body = ex.response?.body as { error?: string; error_description?: string } | undefined;
  return ex.error ?? `${ex.response?.status}: ${[body?.error, body?.error_description].filter(Boolean).join(' - ') || 'no explanation in the response'}`;
};

// ---------- ID-JAG validation (pure) ----------

export interface IdJagExpectation {
  /** The IdP's issuer: who must have signed it. */
  idpIssuer: string;
  /** The MCP authorization server's issuer: the ID-JAG must be addressed to it (`aud`). */
  audience: string;
  /** The MCP server's resource identifier, when its protected resource metadata gave one. */
  resource?: string;
  /** The client id the IdP knows the client by. */
  clientId: string;
  now?: number;
}

/**
 * Check an ID-JAG against what the draft and the MCP extension require of one, from the client's side: the things an
 * authorization server will reject it for. Decode only; the signature is the authorization server's job to verify.
 */
export const checkIdJag = (token: string, expected: IdJagExpectation): OAuthFinding[] => {
  const decoded = decodeJwt(token);
  if (!decoded) {
    return [{ level: 'error', text: 'The IdP returned something that is not a JWT in access_token.' }];
  }
  const header = decoded.header as { typ?: unknown; alg?: unknown };
  const claims = decoded.payload;
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  const findings: OAuthFinding[] = [];
  findings.push(
    header.typ === ID_JAG_JWT_TYPE
      ? { level: 'info', text: `Header typ is ${ID_JAG_JWT_TYPE}.` }
      : { level: 'error', text: `Header typ must be ${ID_JAG_JWT_TYPE}, got ${String(header.typ ?? '(none)')}. An authorization server will refuse it.` },
  );
  if (header.alg === 'none') {
    findings.push({ level: 'error', text: 'alg is none: an unsigned ID-JAG is never acceptable.' });
  }
  for (const claim of ['iss', 'sub', 'aud', 'client_id', 'jti', 'exp', 'iat']) {
    if (claims[claim] === undefined) {
      findings.push({ level: 'error', text: `Required claim ${claim} is missing.` });
    }
  }
  if (claims.iss !== undefined && claims.iss !== expected.idpIssuer) {
    findings.push({ level: 'error', text: `iss is ${String(claims.iss)}, not the IdP issuer ${expected.idpIssuer}.` });
  }
  if (claims.aud !== undefined) {
    findings.push(
      claims.aud === expected.audience
        ? { level: 'info', text: `aud is the MCP authorization server (${expected.audience}).` }
        : { level: 'error', text: `aud is ${JSON.stringify(claims.aud)} but the MCP authorization server's issuer is ${expected.audience}. It will reject this with invalid_grant.` },
    );
  }
  if (claims.client_id !== undefined && claims.client_id !== expected.clientId) {
    findings.push({ level: 'warn', text: `client_id is ${String(claims.client_id)}, not ${expected.clientId}. The authorization server requires it to match the client that authenticates to it.` });
  }
  if (expected.resource) {
    findings.push(
      claims.resource === undefined
        ? { level: 'warn', text: 'No resource claim, so the access token cannot be audience-restricted to the MCP server (the extension says resource MUST be the MCP server identifier when present).' }
        : claims.resource === expected.resource
          ? { level: 'info', text: `resource is the MCP server (${expected.resource}).` }
          : { level: 'error', text: `resource is ${String(claims.resource)} but the MCP server is ${expected.resource}.` },
    );
  }
  if (typeof claims.exp === 'number') {
    const left = claims.exp - now;
    findings.push(left <= 0 ? { level: 'error', text: `Already expired (${-left} s ago).` } : { level: 'info', text: `Expires in ${left} s. ID-JAGs are short-lived; redeem it right away.` });
  }
  if (claims.email === undefined && claims.aud_sub === undefined) {
    findings.push({ level: 'info', text: 'No email or aud_sub claim (the draft recommends one so the authorization server can find the user).' });
  }
  return findings;
};

// ---------- step 1: identity provider sign-in ----------

const fetchIdpMetadata = async (issuer: string, trace?: OAuthTrace): Promise<{ metadata?: IdpMetadata; exchanges: OAuthExchange[] }> => {
  const base = issuer.replace(/\/+$/, '');
  const exchanges: OAuthExchange[] = [];
  for (const url of [`${base}/.well-known/openid-configuration`, `${base}/.well-known/oauth-authorization-server`]) {
    const ex = await exchange('GET', url, { accept: 'application/json' }, undefined, { trace, label: STEP_TITLES['idp-metadata'] });
    exchanges.push(ex);
    if (ex.response?.status === 200 && typeof ex.response.body === 'object' && ex.response.body !== null) {
      return { metadata: ex.response.body as IdpMetadata, exchanges };
    }
  }
  return { exchanges };
};

export interface XaaSignInOptions {
  requestId: string;
  idp: XaaIdp;
  openUrl: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  trace?: OAuthTrace;
}

export const xaaSignIn = async ({ requestId, idp, openUrl, timeoutMs = 5 * 60 * 1000, trace }: XaaSignInOptions): Promise<OAuthStep[]> => {
  sessions.delete(requestId);
  const steps: OAuthStep[] = [];

  // 1a. IdP metadata (OIDC discovery, then RFC 8414)
  const { metadata, exchanges } = await fetchIdpMetadata(idp.issuer, trace);
  if (!metadata) {
    steps.push(step('idp-metadata', 'error', 'No metadata found', [{ level: 'error', text: `Neither /.well-known/openid-configuration nor /.well-known/oauth-authorization-server answered with JSON under ${idp.issuer}.` }], exchanges));
    return steps;
  }
  const findings: OAuthFinding[] = [];
  if (metadata.issuer !== idp.issuer.replace(/\/+$/, '') && metadata.issuer !== idp.issuer) {
    findings.push({ level: 'error', text: `The metadata issuer is ${String(metadata.issuer)}, not ${idp.issuer}. A client must refuse a mismatched issuer.` });
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    findings.push({ level: 'error', text: 'The metadata has no authorization_endpoint or token_endpoint.' });
  }
  if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) {
    findings.push({ level: 'warn', text: 'The IdP does not list PKCE S256; sign-in will send it anyway.' });
  }
  findings.push(
    metadata.grant_types_supported?.includes(TOKEN_EXCHANGE_GRANT)
      ? { level: 'info', text: 'The IdP lists the token-exchange grant (RFC 8693).' }
      : { level: 'warn', text: 'The IdP does not list the token-exchange grant in grant_types_supported. Many IdPs omit it, so step 2 may still work; if it does not, this is why.' },
  );
  const metadataStatus = statusOf(findings);
  steps.push(step('idp-metadata', metadataStatus, metadataStatus === 'error' ? 'Unusable metadata' : 'Found', findings, exchanges));
  if (metadataStatus === 'error' || !metadata.authorization_endpoint || !metadata.token_endpoint) {
    return steps;
  }

  // 1b. browser sign-in: OIDC authorization code + PKCE on a loopback redirect
  const controller = beginInFlight(requestId);
  const listener = await listenForCallback();
  try {
    const { verifier, challenge } = pkcePair();
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));
    const authorizeUrl = new URL(metadata.authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: idp.clientId,
      redirect_uri: listener.redirectUri,
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })) {
      authorizeUrl.searchParams.set(key, value);
    }
    const browserCall = trace?.(STEP_TITLES['idp-signin'], { method: 'GET', url: authorizeUrl.toString(), headers: {} });
    await openUrl(authorizeUrl.toString());
    let callback: Record<string, string>;
    try {
      callback = (await listener.wait(timeoutMs, controller.signal)) as Record<string, string>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      browserCall?.fail(message === 'Cancelled' ? 'cancelled' : 'no-response', message);
      steps.push(step('idp-signin', 'error', message, [{ level: 'error', text: message }]));
      return steps;
    }
    const callbackFindings: OAuthFinding[] = [];
    if (callback.error) {
      callbackFindings.push({ level: 'error', text: `The IdP returned error=${callback.error}${callback.error_description ? `: ${callback.error_description}` : ''}` });
    }
    if (callback.state !== state) {
      callbackFindings.push({ level: 'error', text: `state mismatch: sent ${state}, got ${callback.state ?? '(none)'}. A client must reject this (CSRF).` });
    }
    if (callback.iss !== undefined && callback.iss !== metadata.issuer) {
      callbackFindings.push({ level: 'error', text: `iss is ${callback.iss}, not ${String(metadata.issuer)} (RFC 9207 mix-up check).` });
    }
    if (!callback.code && !callback.error) {
      callbackFindings.push({ level: 'error', text: 'The redirect carried no code.' });
    }
    const signInStatus = statusOf(callbackFindings);
    browserCall?.redirect({ ...callback, ...(callback.code ? { code: `${callback.code.slice(0, 6)}…` } : {}) }, signInStatus !== 'error');
    steps.push(
      step('idp-signin', signInStatus, signInStatus === 'error' ? 'Sign-in failed' : 'Signed in', [
        { level: 'info', text: `Opened in your browser: ${authorizeUrl.toString()}` },
        { level: 'info', text: 'The sign-in is the normal single sign-on to this client app: OIDC authorization code with PKCE S256, scope openid email profile.' },
        ...callbackFindings,
      ]),
    );
    if (signInStatus === 'error' || !callback.code) {
      return steps;
    }

    // 1c. code -> ID token at the IdP
    const ex = await exchange(
      'POST',
      metadata.token_endpoint,
      FORM_HEADERS,
      form({
        grant_type: 'authorization_code',
        code: callback.code,
        redirect_uri: listener.redirectUri,
        code_verifier: verifier,
        client_id: idp.clientId,
        client_secret: idp.clientSecret,
      }),
      { trace, label: STEP_TITLES['idp-token'] },
    );
    const body = ex.response?.body as { id_token?: string } | undefined;
    if (ex.error || !ex.response || ex.response.status >= 300 || !body?.id_token) {
      steps.push(step('idp-token', 'error', 'No ID token', [{ level: 'error', text: `The IdP did not return an ID token (${ex.response && !body?.id_token && ex.response.status < 300 ? 'no id_token in the response' : errorDetail(ex)}).` }], [ex]));
      return steps;
    }
    const decoded = decodeJwt(body.id_token);
    const tokenFindings: OAuthFinding[] = [];
    if (!decoded) {
      tokenFindings.push({ level: 'error', text: 'The id_token is not a JWT.' });
    } else {
      const claims = decoded.payload;
      if (claims.iss !== metadata.issuer) {
        tokenFindings.push({ level: 'error', text: `ID token iss is ${String(claims.iss)}, not ${String(metadata.issuer)}.` });
      }
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(idp.clientId)) {
        tokenFindings.push({ level: 'error', text: `ID token aud ${JSON.stringify(claims.aud)} does not include this client (${idp.clientId}).` });
      }
      if (claims.nonce !== nonce) {
        tokenFindings.push({ level: 'error', text: 'The ID token nonce does not match the one sent (replay protection).' });
      }
      if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
        tokenFindings.push({ level: 'error', text: 'The ID token has already expired.' });
      }
      tokenFindings.push({ level: 'info', text: `Signed in as ${String(claims.email ?? claims.sub)}. The signature is not checked here; the IdP checks it when you exchange this token.` });
    }
    const tokenStatus = statusOf(tokenFindings);
    steps.push(step('idp-token', tokenStatus, tokenStatus === 'error' ? 'Rejected' : 'ID token received', tokenFindings, [ex], [{ label: 'ID token', token: body.id_token }]));
    if (tokenStatus !== 'error') {
      sessions.set(requestId, { idp, metadata, idToken: body.id_token });
    }
    return steps;
  } finally {
    listener.close();
    endInFlight(requestId, controller);
  }
};

// ---------- step 2: token exchange for an ID-JAG ----------

export const xaaExchange = async ({ requestId, context, trace }: { requestId: string; context: OAuthContext; trace?: OAuthTrace }): Promise<OAuthStep[]> => {
  const session = sessions.get(requestId);
  if (!session?.idToken) {
    return [step('id-jag', 'error', 'Not signed in', [{ level: 'error', text: 'Sign in at the identity provider first (step 1).' }])];
  }
  const audience = context.authorizationServer.issuer;
  if (!audience) {
    return [step('id-jag', 'error', 'No audience', [{ level: 'error', text: "The MCP authorization server's metadata has no issuer, so there is no audience to ask the IdP for." }])];
  }
  const ex = await exchange(
    'POST',
    session.metadata.token_endpoint!,
    FORM_HEADERS,
    form({
      grant_type: TOKEN_EXCHANGE_GRANT,
      requested_token_type: ID_JAG_TOKEN_TYPE,
      subject_token: session.idToken,
      subject_token_type: ID_TOKEN_TYPE,
      audience,
      resource: context.resource,
      scope: context.scope,
      client_id: session.idp.clientId,
      client_secret: session.idp.clientSecret,
    }),
    { trace, label: STEP_TITLES['id-jag'] },
  );
  const body = ex.response?.body as { access_token?: string; issued_token_type?: string; token_type?: string; expires_in?: number; error?: string } | undefined;
  if (ex.error || !ex.response || ex.response.status >= 300 || !body?.access_token) {
    const refused = body?.error === 'access_denied';
    return [
      step(
        'id-jag',
        'error',
        refused ? 'Refused by IdP policy' : 'Exchange failed',
        [
          { level: 'error', text: `The IdP did not issue an ID-JAG (${errorDetail(ex)}).` },
          ...(refused
            ? [{ level: 'info' as const, text: "This is the admin's policy answering: this user, with this app, is not allowed to reach this MCP server. Nothing is wrong with the request itself." }]
            : []),
        ],
        [ex],
      ),
    ];
  }
  const findings: OAuthFinding[] = [];
  if (body.issued_token_type !== ID_JAG_TOKEN_TYPE) {
    findings.push({ level: 'warn', text: `issued_token_type is ${String(body.issued_token_type)}, expected ${ID_JAG_TOKEN_TYPE}.` });
  }
  if (body.token_type !== 'N_A') {
    findings.push({ level: 'warn', text: `token_type is ${String(body.token_type)}; the draft says N_A, since this is not an access token.` });
  }
  findings.push(...checkIdJag(body.access_token, { idpIssuer: session.metadata.issuer ?? session.idp.issuer, audience, resource: context.resource, clientId: session.idp.clientId }));
  const status = statusOf(findings);
  // Kept even when the checks above found problems: the authorization server is the authority, and a developer debugging
  // it wants to send a flawed ID-JAG on and see exactly how it reacts (step 3).
  session.idJag = body.access_token;
  return [step('id-jag', status, status === 'error' ? 'ID-JAG has problems' : 'ID-JAG issued', findings, [ex], [{ label: 'ID-JAG', token: body.access_token }])];
};

// ---------- step 3: redeem the ID-JAG at the MCP authorization server ----------

export const xaaRedeem = async ({
  requestId,
  context,
  asClient,
  trace,
}: {
  requestId: string;
  context: OAuthContext;
  /** The client's own registration at the MCP authorization server (a different registration from the IdP's). */
  asClient: { clientId: string; clientSecret: string };
  trace?: OAuthTrace;
}): Promise<OAuthStep[]> => {
  const session = sessions.get(requestId);
  if (!session?.idJag) {
    return [step('jwt-bearer', 'error', 'No ID-JAG', [{ level: 'error', text: 'Get an ID-JAG first (step 2). An ID-JAG can be redeemed once.' }])];
  }
  const endpoint = context.authorizationServer.token_endpoint;
  if (!endpoint) {
    return [step('jwt-bearer', 'error', 'No token_endpoint', [{ level: 'error', text: "The MCP authorization server's metadata has no token_endpoint." }])];
  }
  const idJag = session.idJag;
  session.idJag = undefined; // single use: the next run has to ask the IdP again
  const ex = await exchange(
    'POST',
    endpoint,
    FORM_HEADERS,
    form({ grant_type: JWT_BEARER_GRANT, assertion: idJag, client_id: asClient.clientId, client_secret: asClient.clientSecret }),
    { trace, label: STEP_TITLES['jwt-bearer'] },
  );
  const { tokenSet, findings } = readTokenResponse(ex, {});
  // An authorization server SHOULD NOT issue a refresh token for this grant, so the usual "no refresh token" warning does not apply.
  const adjusted = findings.map(f =>
    f.text.startsWith('No refresh token')
      ? ({ level: 'info', text: 'No refresh token, as the draft expects for this grant. When the token expires, run step 2 and 3 again; the ID token from step 1 can be reused until it expires.' } as OAuthFinding)
      : f,
  );
  if (!tokenSet) {
    const detail = errorDetail(ex);
    return [step('jwt-bearer', 'error', 'Refused', [{ level: 'error', text: `The MCP authorization server refused the ID-JAG (${detail}).` }, ...adjusted.filter(f => f.level === 'error' && !f.text.startsWith('The token endpoint refused'))], [ex])];
  }
  const tokenStep = step('jwt-bearer', statusOf(adjusted), 'Access token issued', adjusted, [ex]);
  tokenStep.tokens = tokenSet;
  storeToken(requestId, tokenSet, asClient.clientId, context);
  return [tokenStep, await verifyToken(tokenSet.accessToken, context.serverUrl, trace)];
};
