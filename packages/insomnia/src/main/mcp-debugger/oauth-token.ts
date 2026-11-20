import { exchange, type OAuthContext, type OAuthExchange, type OAuthFinding, type OAuthStep, type OAuthTrace, STEP_TITLES } from './oauth-discovery';
import { parseWwwAuthenticate } from './oauth-discovery';
import { takePendingExchange } from './oauth-flow';

// Task 4348 S5c: Step 3 of the OAuth wizard. Exchange the authorization code for tokens, prove the access token works by
// calling the MCP server with it, and refresh it. Tokens are held in main-process memory per request.
// PROTOTYPE-MOCK: tokens are in memory only (lost on restart), not stored per issuer, and nothing feeds them into the
// connection yet. Tokens and codes are shown raw in the exchanges, since this is a debugger.

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  clientId: string;
  context: OAuthContext;
}
const tokens = new Map<string, TokenSet>();

export const hasToken = ({ requestId }: { requestId: string }) => tokens.has(requestId);
export const clearToken = ({ requestId }: { requestId: string }) => {
  tokens.delete(requestId);
};

const step = (id: OAuthStep['id'], status: OAuthStep['status'], summary: string, findings: OAuthFinding[], exchanges: OAuthExchange[] = []): OAuthStep => ({
  id,
  title: STEP_TITLES[id],
  status,
  summary,
  exchanges,
  findings,
});

const form = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Turn a token endpoint response into a token set plus findings, or an error step. */
export const readTokenResponse = (
  ex: OAuthExchange,
  previous: { refreshToken?: string; requestedScope?: string },
): { tokenSet?: Pick<TokenSet, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scope'>; findings: OAuthFinding[] } => {
  const body = ex.response?.body as TokenResponse | undefined;
  if (ex.error || !ex.response || ex.response.status >= 300 || !body?.access_token) {
    const detail = ex.error ?? `${ex.response?.status}: ${body?.error_description ?? body?.error ?? 'no access_token in the response'}`;
    return { findings: [{ level: 'error', text: `The token endpoint refused the request (${detail}).` }] };
  }
  const findings: OAuthFinding[] = [];
  if (body.token_type?.toLowerCase() === 'bearer') {
    findings.push({ level: 'info', text: 'token_type is Bearer.' });
  } else {
    findings.push({ level: 'error', text: `token_type is ${String(body.token_type)}; MCP clients send Bearer tokens.` });
  }
  findings.push(
    body.expires_in === undefined
      ? { level: 'warn', text: 'No expires_in, so the lifetime is unknown.' }
      : { level: 'info', text: `Expires in ${body.expires_in} s.` },
  );
  if (body.scope !== undefined) {
    findings.push({ level: 'info', text: `Granted scope: ${body.scope || '(none)'}` });
    if (previous.requestedScope && body.scope !== previous.requestedScope) {
      findings.push({ level: 'warn', text: `Requested scope "${previous.requestedScope}" but the server granted "${body.scope}".` });
    }
  }
  const refreshToken = body.refresh_token ?? previous.refreshToken;
  findings.push(
    body.refresh_token
      ? { level: 'info', text: previous.refreshToken ? 'A new refresh token was issued (rotation).' : 'A refresh token was issued.' }
      : previous.refreshToken
        ? { level: 'info', text: 'No new refresh token, so the old one stays valid.' }
        : { level: 'warn', text: 'No refresh token: the user must authorize again when this token expires.' },
  );
  return {
    tokenSet: {
      accessToken: body.access_token,
      refreshToken,
      expiresAt: body.expires_in === undefined ? undefined : Date.now() + body.expires_in * 1000,
      scope: body.scope,
    },
    findings,
  };
};

/** Call the MCP server with the bearer token and say what came back, including step-up hints on a 403. */
export const verifyToken = async (accessToken: string, serverUrl: string, trace?: OAuthTrace): Promise<OAuthStep> => {
  const ex = await exchange(
    'POST',
    serverUrl,
    { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Insomnia', version: '0-prototype' } },
    },
    { trace, label: STEP_TITLES.verify },
  );
  const status = ex.response?.status;
  if (ex.error) {
    return step('verify', 'error', 'No response', [{ level: 'error', text: ex.error }], [ex]);
  }
  if (status !== undefined && status < 300) {
    return step('verify', 'ok', `${status}: the server accepted the token`, [{ level: 'info', text: 'The MCP server answered the initialize request with this token.' }], [ex]);
  }
  const challenge = parseWwwAuthenticate(ex.response?.headers['www-authenticate']).find(c => c.scheme.toLowerCase() === 'bearer');
  const reason = challenge?.params.error;
  const findings: OAuthFinding[] = [];
  if (status === 403 && reason === 'insufficient_scope') {
    findings.push({
      level: 'warn',
      text: `Step-up needed: the server wants scope "${challenge?.params.scope ?? '(not stated)'}". Authorize again requesting it.`,
    });
    return step('verify', 'warn', '403 insufficient_scope', findings, [ex]);
  }
  findings.push({ level: 'error', text: `The server answered ${status}${reason ? ` (error=${reason}${challenge?.params.error_description ? `: ${challenge.params.error_description}` : ''})` : ''}.` });
  return step('verify', 'error', `${status}: the server rejected the token`, findings, [ex]);
};

export const exchangeCode = async ({ requestId, trace }: { requestId: string; trace?: OAuthTrace }): Promise<OAuthStep[]> => {
  const pending = takePendingExchange(requestId);
  if (!pending) {
    return [step('token', 'error', 'No authorization code', [{ level: 'error', text: 'Authorize in Step 2 first. A code can only be used once.' }])];
  }
  const { context } = pending;
  const endpoint = context.authorizationServer.token_endpoint;
  if (!endpoint) {
    return [step('token', 'error', 'No token_endpoint', [{ level: 'error', text: 'The server metadata has no token_endpoint.' }])];
  }
  const ex = await exchange(
    'POST',
    endpoint,
    { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    form({
      grant_type: 'authorization_code',
      code: pending.code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      resource: context.resource,
    }),
    { trace, label: STEP_TITLES.token },
  );
  const { tokenSet, findings } = readTokenResponse(ex, { requestedScope: context.scope });
  const tokenStep = step('token', findings.some(f => f.level === 'error') ? 'error' : findings.some(f => f.level === 'warn') ? 'warn' : 'ok', tokenSet ? 'Token issued' : 'Rejected', findings, [ex]);
  if (!tokenSet || tokenStep.status === 'error') {
    return [tokenStep];
  }
  tokens.set(requestId, { ...tokenSet, clientId: pending.clientId, context });
  tokenStep.tokens = tokenSet;
  return [tokenStep, await verifyToken(tokenSet.accessToken, context.serverUrl, trace)];
};

export const refreshToken = async ({ requestId, trace }: { requestId: string; trace?: OAuthTrace }): Promise<OAuthStep[]> => {
  const current = tokens.get(requestId);
  if (!current) {
    return [step('refresh', 'error', 'No token', [{ level: 'error', text: 'Get a token first.' }])];
  }
  if (!current.refreshToken) {
    return [step('refresh', 'error', 'No refresh token', [{ level: 'error', text: 'The server did not issue a refresh token, so the user has to authorize again.' }])];
  }
  const endpoint = current.context.authorizationServer.token_endpoint;
  if (!endpoint) {
    return [step('refresh', 'error', 'No token_endpoint', [{ level: 'error', text: 'The server metadata has no token_endpoint.' }])];
  }
  const ex = await exchange(
    'POST',
    endpoint,
    { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    form({ grant_type: 'refresh_token', refresh_token: current.refreshToken, client_id: current.clientId, resource: current.context.resource }),
    { trace, label: STEP_TITLES.refresh },
  );
  const { tokenSet, findings } = readTokenResponse(ex, { refreshToken: current.refreshToken, requestedScope: current.scope });
  if (!tokenSet) {
    const invalid = (ex.response?.body as TokenResponse | undefined)?.error === 'invalid_grant';
    if (invalid) {
      tokens.delete(requestId);
      findings.push({ level: 'error', text: 'invalid_grant: the refresh token is no longer valid. The user has to authorize again (Step 2).' });
    }
    return [step('refresh', 'error', invalid ? 'Refresh token rejected' : 'Rejected', findings, [ex])];
  }
  tokens.set(requestId, { ...current, ...tokenSet });
  const refreshStep = step('refresh', findings.some(f => f.level === 'warn') ? 'warn' : 'ok', 'Token refreshed', findings, [ex]);
  refreshStep.tokens = tokenSet;
  return [refreshStep, await verifyToken(tokenSet.accessToken, current.context.serverUrl, trace)];
};
