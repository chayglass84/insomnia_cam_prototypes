import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OAuthContext, OAuthExchange } from './oauth-discovery';
import { runAuthorization } from './oauth-flow';
import { exchangeCode, readTokenResponse, refreshToken, verifyToken } from './oauth-token';

const ex = (status: number, body: unknown, headers: Record<string, string> = {}): OAuthExchange => ({
  request: { method: 'POST', url: 'http://t/token', headers: {} },
  response: { status, headers, body },
  durationMs: 1,
});

describe('readTokenResponse', () => {
  it('reads a good response', () => {
    const { tokenSet, findings } = readTokenResponse(ex(200, { access_token: 'a', token_type: 'Bearer', expires_in: 60, refresh_token: 'r', scope: 'read' }), { requestedScope: 'read' });
    expect(tokenSet?.accessToken).toBe('a');
    expect(tokenSet?.refreshToken).toBe('r');
    expect(findings.every(f => f.level === 'info')).toBe(true);
  });
  it('flags a wrong token type, narrowed scope and a missing refresh token', () => {
    const { findings } = readTokenResponse(ex(200, { access_token: 'a', token_type: 'MAC', expires_in: 60, scope: 'read' }), { requestedScope: 'read write' });
    expect(findings.some(f => f.level === 'error' && f.text.includes('MAC'))).toBe(true);
    expect(findings.some(f => f.level === 'warn' && f.text.includes('granted'))).toBe(true);
    expect(findings.some(f => f.level === 'warn' && f.text.includes('No refresh token'))).toBe(true);
  });
  it('turns an error response into a finding', () => {
    const { tokenSet, findings } = readTokenResponse(ex(400, { error: 'invalid_grant', error_description: 'bad code' }), {});
    expect(tokenSet).toBeUndefined();
    expect(findings[0].text).toContain('bad code');
  });
  it('keeps the old refresh token when none is rotated in', () => {
    const { tokenSet } = readTokenResponse(ex(200, { access_token: 'b', token_type: 'Bearer', expires_in: 1 }), { refreshToken: 'old' });
    expect(tokenSet?.refreshToken).toBe('old');
  });
});

describe('token flow against a local server', () => {
  let server: http.Server;
  let origin = '';
  let mcpMode: 'ok' | 'scope' | 'reject' = 'ok';
  let refreshMode: 'ok' | 'invalid' = 'ok';
  let lastTokenBody: URLSearchParams | undefined;
  let issued = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', origin);
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
          res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
        if (url.pathname === '/register') {
          return json(201, { client_id: 'dcr-test' });
        }
        if (url.pathname === '/authorize') {
          const back = new URL(url.searchParams.get('redirect_uri')!);
          back.searchParams.set('code', 'code-1');
          back.searchParams.set('state', url.searchParams.get('state')!);
          back.searchParams.set('iss', origin);
          return res.writeHead(302, { location: back.toString() }).end();
        }
        if (url.pathname === '/token') {
          lastTokenBody = new URLSearchParams(raw);
          if (lastTokenBody.get('grant_type') === 'refresh_token' && refreshMode === 'invalid') {
            return json(400, { error: 'invalid_grant' });
          }
          issued += 1;
          return json(200, { access_token: `at-${issued}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${issued}` });
        }
        if (url.pathname === '/mcp') {
          if (mcpMode === 'ok') {
            return json(200, { jsonrpc: '2.0', id: 1, result: {} });
          }
          if (mcpMode === 'scope') {
            return json(403, {}, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="admin"' });
          }
          return json(401, {}, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
        }
        return res.writeHead(404).end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const context = (): OAuthContext => ({
    serverUrl: `${origin}/mcp`,
    resource: `${origin}/mcp`,
    authorizationServer: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      authorization_response_iss_parameter_supported: true,
    },
  });
  const authorize = (requestId: string) =>
    runAuthorization({ requestId, context: context(), openUrl: url => void fetch(url), timeoutMs: 5000 });

  it('exchanges the code with the PKCE verifier, then verifies the token against the MCP server', async () => {
    mcpMode = 'ok';
    await authorize('t1');
    const steps = await exchangeCode({ requestId: 't1' });
    expect(steps.map(s => [s.id, s.status])).toEqual([
      ['token', 'ok'],
      ['verify', 'ok'],
    ]);
    expect(lastTokenBody?.get('grant_type')).toBe('authorization_code');
    expect(lastTokenBody?.get('code')).toBe('code-1');
    expect(lastTokenBody?.get('code_verifier')).toBeTruthy();
    expect(lastTokenBody?.get('resource')).toBe(`${origin}/mcp`);
  });

  it('only lets a code be used once', async () => {
    await authorize('t2');
    await exchangeCode({ requestId: 't2' });
    const again = await exchangeCode({ requestId: 't2' });
    expect(again[0].status).toBe('error');
    expect(again[0].summary).toBe('No authorization code');
  });

  it('refreshes and rotates, and drops the token on invalid_grant', async () => {
    mcpMode = 'ok';
    await authorize('t3');
    await exchangeCode({ requestId: 't3' });
    const steps = await refreshToken({ requestId: 't3' });
    expect(steps.map(s => [s.id, s.status])).toEqual([
      ['refresh', 'ok'],
      ['verify', 'ok'],
    ]);
    expect(lastTokenBody?.get('grant_type')).toBe('refresh_token');
    refreshMode = 'invalid';
    const failed = await refreshToken({ requestId: 't3' });
    refreshMode = 'ok';
    expect(failed[0].summary).toBe('Refresh token rejected');
    expect((await refreshToken({ requestId: 't3' }))[0].summary).toBe('No token');
  });

  it('explains a 403 insufficient_scope as step-up and a 401 as rejection', async () => {
    mcpMode = 'scope';
    const scope = await verifyToken('x', `${origin}/mcp`);
    expect(scope.status).toBe('warn');
    expect(scope.findings[0].text).toContain('admin');
    mcpMode = 'reject';
    const rejected = await verifyToken('x', `${origin}/mcp`);
    mcpMode = 'ok';
    expect(rejected.status).toBe('error');
    expect(rejected.findings[0].text).toContain('invalid_token');
  });
});
