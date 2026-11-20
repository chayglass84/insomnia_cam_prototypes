// Task 4348 S5a: read-only MCP OAuth discovery. Walks the spec's discovery chain one step at a time and records every
// exchange so the UI can show raw requests/responses: unauthenticated MCP request (401 + WWW-Authenticate) -> protected
// resource metadata (RFC 9728) -> authorization server metadata (RFC 8414, OIDC fallback) plus a verdict on what a client can do with it.
// No tokens are issued here (S5b/S5c). Not in Ardi, so this is new work against the MCP authorization spec.
// PROTOTYPE-MOCK: plain fetch with no proxy, TLS options or custom headers; one authorization server (the first listed).

export type OAuthStepStatus = 'ok' | 'warn' | 'error' | 'skipped';

export interface OAuthFinding {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface OAuthExchange {
  request: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response?: { status: number; headers: Record<string, string>; body: unknown };
  error?: string;
  durationMs: number;
}

export interface OAuthStep {
  id: 'challenge' | 'protected-resource' | 'authorization-server' | 'registration' | 'authorize' | 'callback';
  title: string;
  status: OAuthStepStatus;
  summary: string;
  /** Every request tried for this step, in order (metadata lookups probe several candidate URLs). */
  exchanges: OAuthExchange[];
  findings: OAuthFinding[];
}

/** What discovery learned, handed to the authorization flow (S5b) so it does not have to rediscover. */
export interface OAuthContext {
  serverUrl: string;
  /** `resource` from the protected resource metadata, sent as the RFC 8707 `resource` parameter. */
  resource?: string;
  /** Scope from the 401 challenge, else the PRM's scopes_supported joined. */
  scope?: string;
  authorizationServer: AuthServerMetadata;
}

export interface OAuthDiscoveryResult {
  serverUrl: string;
  steps: OAuthStep[];
  /** Present only when discovery reached a usable authorization server document. */
  context?: OAuthContext;
}

export interface WwwAuthenticateChallenge {
  scheme: string;
  params: Record<string, string>;
}

/** Parse a `WWW-Authenticate` header value into challenges (quoted and bare params, several challenges per header). */
export const parseWwwAuthenticate = (header: string | undefined): WwwAuthenticateChallenge[] => {
  if (!header) {
    return [];
  }
  const challenges: WwwAuthenticateChallenge[] = [];
  const tokenRe = /([A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*)\s*(?:=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+)))?/g;
  let current: WwwAuthenticateChallenge | undefined;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(header)) !== null) {
    const [, name, quoted, bare] = match;
    const hasValue = quoted !== undefined || bare !== undefined;
    if (hasValue && current) {
      current.params[name.toLowerCase()] = (quoted ?? bare ?? '').replace(/\\(.)/g, '$1');
    } else if (!hasValue) {
      current = { scheme: name, params: {} };
      challenges.push(current);
    }
  }
  return challenges;
};

/** RFC 9728 s3.1 candidate URLs when the 401 gave no `resource_metadata`: path-aware first, then the bare origin form. */
export const protectedResourceCandidates = (serverUrl: string): string[] => {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const base = `${url.origin}/.well-known/oauth-protected-resource`;
  return path && path !== '' ? [`${base}${path}`, base] : [base];
};

/** RFC 8414 s3.1 / OIDC discovery candidates for an issuer, in the order the MCP spec tells clients to try them. */
export const authorizationServerCandidates = (issuer: string): string[] => {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server${path}`,
      `${url.origin}/.well-known/openid-configuration${path}`,
      `${url.origin}${path}/.well-known/openid-configuration`,
    ];
  }
  return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
};

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
  token_endpoint_auth_methods_supported?: string[];
  grant_types_supported?: string[];
  scopes_supported?: string[];
}

/** Turn the authorization server metadata into what an MCP client needs to decide how to proceed. */
export const buildVerdict = (metadata: AuthServerMetadata): OAuthFinding[] => {
  const findings: OAuthFinding[] = [];
  const methods = metadata.code_challenge_methods_supported;
  if (!methods) {
    findings.push({
      level: 'error',
      text: 'code_challenge_methods_supported is missing. The MCP spec says clients MUST refuse to proceed when PKCE support cannot be confirmed.',
    });
  } else if (!methods.includes('S256')) {
    findings.push({ level: 'error', text: `PKCE S256 is not offered (server lists: ${methods.join(', ')}).` });
  } else {
    findings.push({ level: 'info', text: 'PKCE S256 supported.' });
  }
  if (metadata.client_id_metadata_document_supported) {
    findings.push({ level: 'info', text: 'Client ID Metadata Documents (CIMD) supported: the client_id can be an HTTPS URL.' });
  }
  if (metadata.registration_endpoint) {
    findings.push({ level: 'info', text: `Dynamic Client Registration available at ${metadata.registration_endpoint}.` });
  }
  if (!metadata.client_id_metadata_document_supported && !metadata.registration_endpoint) {
    findings.push({
      level: 'warn',
      text: 'Neither CIMD nor a registration_endpoint is advertised: a pre-registered client_id would be required.',
    });
  }
  if (metadata.authorization_response_iss_parameter_supported) {
    findings.push({ level: 'info', text: 'RFC 9207 iss parameter on the authorization response supported (clients should verify it).' });
  } else {
    findings.push({ level: 'warn', text: 'The server does not advertise authorization_response_iss_parameter_supported, so there is no iss check to rely on (mix-up attacks).' });
  }
  if (!metadata.authorization_endpoint) {
    findings.push({ level: 'error', text: 'authorization_endpoint is missing.' });
  }
  if (!metadata.token_endpoint) {
    findings.push({ level: 'error', text: 'token_endpoint is missing.' });
  }
  return findings;
};

const TIMEOUT_MS = 8000;

const headersToObject = (headers: Headers) => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const parseBody = (contentType: string, text: string): unknown => {
  if (!text) {
    return undefined;
  }
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
};

export const exchange = async (method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<OAuthExchange> => {
  const started = Date.now();
  const request = { method, url, headers, ...(body === undefined ? {} : { body }) };
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    return {
      request,
      response: { status: res.status, headers: headersToObject(res.headers), body: parseBody(res.headers.get('content-type') ?? '', text) },
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { request, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started };
  }
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Try each candidate URL until one answers 200 with a JSON object; every attempt is kept as an exchange. */
const fetchMetadata = async (candidates: string[]) => {
  const exchanges: OAuthExchange[] = [];
  for (const url of candidates) {
    const ex = await exchange('GET', url, { accept: 'application/json' });
    exchanges.push(ex);
    if (ex.response?.status === 200 && isJsonObject(ex.response.body)) {
      return { exchanges, metadata: ex.response.body, url };
    }
  }
  return { exchanges, metadata: undefined, url: undefined };
};

export const discoverOAuth = async ({ url, headers = [] }: { url: string; headers?: { name: string; value: string }[] }): Promise<OAuthDiscoveryResult> => {
  const steps: OAuthStep[] = [];
  const customHeaders = Object.fromEntries(headers.filter(h => h.name.toLowerCase() !== 'authorization').map(h => [h.name, h.value]));

  // Step 1: an unauthenticated initialize. A protected server answers 401 + WWW-Authenticate (RFC 9728 s5.1).
  const challengeEx = await exchange(
    'POST',
    url,
    { ...customHeaders, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Insomnia', version: '0-prototype' } },
    },
  );
  const challengeFindings: OAuthFinding[] = [];
  const status = challengeEx.response?.status;
  const challenges = parseWwwAuthenticate(challengeEx.response?.headers['www-authenticate']);
  const bearer = challenges.find(c => c.scheme.toLowerCase() === 'bearer');
  const resourceMetadataUrl = bearer?.params.resource_metadata;
  if (challengeEx.error) {
    challengeFindings.push({ level: 'error', text: `Request failed: ${challengeEx.error}` });
  } else if (status !== 401) {
    challengeFindings.push({
      level: status && status < 300 ? 'info' : 'warn',
      text:
        status && status < 300
          ? `The server answered ${status} without credentials, so it does not appear to require OAuth.`
          : `Expected 401 Unauthorized but got ${status}.`,
    });
  } else {
    if (!bearer) {
      challengeFindings.push({ level: 'warn', text: '401 without a Bearer WWW-Authenticate challenge.' });
    }
    if (bearer && !resourceMetadataUrl) {
      challengeFindings.push({
        level: 'warn',
        text: 'The challenge has no resource_metadata parameter, so the well-known URLs must be guessed (RFC 9728 s3.1).',
      });
    }
    if (resourceMetadataUrl) {
      challengeFindings.push({ level: 'info', text: `resource_metadata: ${resourceMetadataUrl}` });
    }
    if (bearer?.params.scope) {
      challengeFindings.push({ level: 'info', text: `Challenge scope: ${bearer.params.scope}` });
    }
  }
  const challengeOk = status === 401 && !!bearer;
  steps.push({
    id: 'challenge',
    title: 'Unauthenticated request',
    status: challengeEx.error ? 'error' : challengeOk ? (resourceMetadataUrl ? 'ok' : 'warn') : status && status < 300 ? 'skipped' : 'warn',
    summary: challengeEx.error ? 'No response' : `${status} ${bearer ? 'with Bearer challenge' : 'no Bearer challenge'}`,
    exchanges: [challengeEx],
    findings: challengeFindings,
  });
  const stop = (from: OAuthStep['id'], reason: string) => {
    const order: OAuthStep['id'][] = ['protected-resource', 'authorization-server'];
    for (const id of order.slice(order.indexOf(from))) {
      steps.push({ id, title: STEP_TITLES[id], status: 'skipped', summary: reason, exchanges: [], findings: [] });
    }
  };
  if (status !== 401) {
    stop('protected-resource', status && status < 300 ? 'Server does not require OAuth' : 'No challenge to follow');
    return { serverUrl: url, steps };
  }

  // Step 2: protected resource metadata, from the challenge when given, else the well-known candidates.
  const prm = await fetchMetadata(resourceMetadataUrl ? [resourceMetadataUrl] : protectedResourceCandidates(url));
  const prmFindings: OAuthFinding[] = [];
  const authServers = Array.isArray(prm.metadata?.authorization_servers)
    ? (prm.metadata.authorization_servers as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  if (!prm.metadata) {
    prmFindings.push({ level: 'error', text: 'No protected resource metadata document found at any candidate URL.' });
  } else {
    prmFindings.push({ level: 'info', text: `resource: ${String(prm.metadata.resource ?? '(missing)')}` });
    if (authServers.length === 0) {
      prmFindings.push({ level: 'error', text: 'authorization_servers is missing or empty.' });
    } else {
      prmFindings.push({ level: 'info', text: `authorization_servers: ${authServers.join(', ')}` });
      if (authServers.length > 1) {
        prmFindings.push({ level: 'info', text: 'More than one authorization server listed. This prototype follows the first.' });
      }
    }
    if (Array.isArray(prm.metadata.scopes_supported)) {
      prmFindings.push({ level: 'info', text: `scopes_supported: ${(prm.metadata.scopes_supported as string[]).join(', ')}` });
    }
  }
  const prmOk = !!prm.metadata && authServers.length > 0;
  steps.push({
    id: 'protected-resource',
    title: STEP_TITLES['protected-resource'],
    status: prmOk ? 'ok' : 'error',
    summary: prmOk ? `${authServers.length} authorization server${authServers.length === 1 ? '' : 's'}` : 'Not found',
    exchanges: prm.exchanges,
    findings: prmFindings,
  });
  if (!prmOk) {
    stop('authorization-server', 'No authorization server to look up');
    return { serverUrl: url, steps };
  }

  // Step 3: authorization server metadata for the first issuer.
  const issuer = authServers[0];
  const asm = await fetchMetadata(authorizationServerCandidates(issuer));
  const asmFindings: OAuthFinding[] = [];
  if (!asm.metadata) {
    asmFindings.push({ level: 'error', text: `No authorization server metadata found for ${issuer}.` });
  } else if (asm.metadata.issuer !== issuer) {
    asmFindings.push({
      level: 'error',
      text: `The metadata issuer (${String(asm.metadata.issuer)}) does not match the issuer it was fetched for (${issuer}). RFC 8414 requires an exact match.`,
    });
  } else {
    asmFindings.push({ level: 'info', text: `issuer: ${issuer}` });
  }
  // The capability verdict is part of this step: what a client needs from the document (PKCE, registration, iss).
  const verdict = asm.metadata ? buildVerdict(asm.metadata as AuthServerMetadata) : [];
  const findings = [...asmFindings, ...verdict];
  const hasError = findings.some(f => f.level === 'error');
  steps.push({
    id: 'authorization-server',
    title: STEP_TITLES['authorization-server'],
    status: hasError ? 'error' : findings.some(f => f.level === 'warn') ? 'warn' : 'ok',
    summary: !asm.metadata
      ? 'Not found'
      : hasError
        ? `Found, but a client could not proceed (${asm.url})`
        : `Found, a client can proceed (${asm.url})`,
    exchanges: asm.exchanges,
    findings,
  });
  if (!asm.metadata || hasError) {
    return { serverUrl: url, steps };
  }
  const prmScopes = Array.isArray(prm.metadata?.scopes_supported) ? (prm.metadata.scopes_supported as string[]).join(' ') : undefined;
  return {
    serverUrl: url,
    steps,
    context: {
      serverUrl: url,
      resource: typeof prm.metadata?.resource === 'string' ? prm.metadata.resource : undefined,
      scope: bearer?.params.scope ?? prmScopes,
      authorizationServer: asm.metadata as AuthServerMetadata,
    },
  };
};

export const STEP_TITLES: Record<OAuthStep['id'], string> = {
  challenge: 'Unauthenticated request',
  'protected-resource': 'Protected resource metadata',
  'authorization-server': 'Authorization server metadata',
  registration: 'Client registration',
  authorize: 'Authorize in browser',
  callback: 'Authorization response',
};
