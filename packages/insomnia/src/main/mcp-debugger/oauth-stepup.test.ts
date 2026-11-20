import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OAuthContext } from './oauth-discovery';
import { runAuthorization, unionScopes } from './oauth-flow';
import { exchangeCode, storedScope, verifyToken } from './oauth-token';

describe('unionScopes', () => {
  it('keeps order, drops duplicates and blanks', () => {
    expect(unionScopes('read', 'admin')).toBe('read admin');
    expect(unionScopes('read write', 'write admin')).toBe('read write admin');
    expect(unionScopes(undefined, 'admin')).toBe('admin');
    expect(unionScopes()).toBeUndefined();
    expect(unionScopes('  ', '')).toBeUndefined();
  });
});

describe('step-up against a local server', () => {
  let server: http.Server;
  let origin = '';
  let lastScope: string | null = null;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', origin);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
      req.resume();
      req.on('end', () => {
        if (url.pathname === '/register') {
          return json(201, { client_id: 'c1' });
        }
        if (url.pathname === '/authorize') {
          lastScope = url.searchParams.get('scope');
          const back = new URL(url.searchParams.get('redirect_uri')!);
          back.searchParams.set('code', `code-for-${lastScope}`);
          back.searchParams.set('state', url.searchParams.get('state')!);
          back.searchParams.set('iss', origin);
          return res.writeHead(302, { location: back.toString() }).end();
        }
        if (url.pathname === '/token') {
          return json(200, { access_token: `at-${lastScope}`, token_type: 'Bearer', expires_in: 60, scope: lastScope });
        }
        if (url.pathname === '/mcp') {
          const token = req.headers.authorization ?? '';
          return token.includes('admin')
            ? json(200, { jsonrpc: '2.0', id: 1, result: {} })
            : json(403, {}, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="admin"' });
        }
        return json(404, {});
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const context = (): OAuthContext => ({
    serverUrl: `${origin}/mcp`,
    resource: `${origin}/mcp`,
    scope: 'read',
    authorizationServer: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      authorization_response_iss_parameter_supported: true,
    },
  });
  const authorize = (requestId: string, scope?: string) =>
    runAuthorization({ requestId, context: context(), scope, openUrl: url => void fetch(url), timeoutMs: 5000 });

  it('a 403 insufficient_scope becomes a step-up hint carrying the wanted scope', async () => {
    const step = await verifyToken('at-read', `${origin}/mcp`);
    expect(step.status).toBe('warn');
    expect(step.stepUp).toEqual({ scope: 'admin' });
  });

  it('asks again with the broader scope and ends up with a token the server accepts', async () => {
    await authorize('su-1');
    const first = await exchangeCode({ requestId: 'su-1' });
    expect(first[1].stepUp?.scope).toBe('admin');
    expect(storedScope({ requestId: 'su-1' })).toBe('read');

    const steps = await authorize('su-1', unionScopes(storedScope({ requestId: 'su-1' }), first[1].stepUp?.scope));
    expect(steps.at(-1)?.status).toBe('ok');
    expect(lastScope).toBe('read admin');
    const second = await exchangeCode({ requestId: 'su-1' });
    // amber on the token step is only the missing refresh token (this server issues none)
    expect(second.map(s => [s.id, s.status])).toEqual([
      ['token', 'warn'],
      ['verify', 'ok'],
    ]);
    expect(storedScope({ requestId: 'su-1' })).toBe('read admin');
  });

  it('registration reports the client_id so the UI can offer to save it', async () => {
    const steps = await authorize('su-2');
    expect(steps[0].clientId).toBe('c1');
  });
});
