import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OAuthContext } from './oauth-discovery';
import { checkAuthorizationResponse, pkcePair, runAuthorization } from './oauth-flow';
import crypto from 'node:crypto';

describe('pkcePair', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('checkAuthorizationResponse', () => {
  const expected = { state: 's1', issuer: 'https://as.test', issAdvertised: true };
  it('accepts a clean response', () => {
    const f = checkAuthorizationResponse({ code: 'c', state: 's1', iss: 'https://as.test' }, expected);
    expect(f.some(x => x.level === 'error' || x.level === 'warn')).toBe(false);
  });
  it('rejects a state mismatch', () => {
    expect(checkAuthorizationResponse({ code: 'c', state: 'nope', iss: 'https://as.test' }, expected).some(x => x.level === 'error' && x.text.includes('state'))).toBe(true);
  });
  it('rejects a wrong iss', () => {
    expect(checkAuthorizationResponse({ code: 'c', state: 's1', iss: 'https://evil.test' }, expected).some(x => x.level === 'error' && x.text.includes('mix-up'))).toBe(true);
  });
  it('errors on a missing iss when advertised, warns when not', () => {
    expect(checkAuthorizationResponse({ code: 'c', state: 's1' }, expected).some(x => x.level === 'error')).toBe(true);
    expect(checkAuthorizationResponse({ code: 'c', state: 's1' }, { ...expected, issAdvertised: false }).some(x => x.level === 'warn')).toBe(true);
  });
  it('surfaces an error response', () => {
    expect(checkAuthorizationResponse({ error: 'access_denied', state: 's1', iss: 'https://as.test' }, expected).some(x => x.text.includes('access_denied'))).toBe(true);
  });
});

describe('runAuthorization against a local authorization server', () => {
  let server: http.Server;
  let origin = '';
  let tamperIss = false;
  let seen: URLSearchParams | undefined;
  let registerBody: Record<string, unknown> | undefined;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/register') {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          registerBody = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ client_id: 'dcr-test' }));
        });
        return;
      }
      if (url.pathname === '/authorize') {
        seen = url.searchParams;
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'abc123xyz');
        back.searchParams.set('state', url.searchParams.get('state')!);
        back.searchParams.set('iss', tamperIss ? 'https://evil.test' : origin);
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const context = (): OAuthContext => ({
    serverUrl: `${origin}/mcp`,
    resource: `${origin}/mcp`,
    scope: 'read write',
    authorizationServer: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      authorization_response_iss_parameter_supported: true,
    },
  });
  // Stands in for the browser: follow the authorize URL's redirect chain.
  const browser = async (url: string) => {
    void fetch(url, { redirect: 'follow' });
  };

  it('registers, authorizes and validates the response', async () => {
    tamperIss = false;
    const steps = await runAuthorization({ requestId: 'r1', context: context(), openUrl: browser, timeoutMs: 5000 });
    expect(steps.map(s => [s.id, s.status])).toEqual([
      ['registration', 'ok'],
      ['authorize', 'ok'],
      ['callback', 'ok'],
    ]);
    expect(registerBody?.redirect_uris).toHaveLength(1);
    expect(seen?.get('code_challenge_method')).toBe('S256');
    expect(seen?.get('resource')).toBe(`${origin}/mcp`);
    expect(seen?.get('scope')).toBe('read write');
    expect(seen?.get('client_id')).toBe('dcr-test');
  });

  it('fails the callback step on a tampered iss', async () => {
    tamperIss = true;
    const steps = await runAuthorization({ requestId: 'r2', context: context(), openUrl: browser, timeoutMs: 5000 });
    tamperIss = false;
    expect(steps[2].status).toBe('error');
    expect(steps[2].findings.some(f => f.text.includes('mix-up'))).toBe(true);
  });

  it('uses a pre-registered client_id without registering', async () => {
    registerBody = undefined;
    const steps = await runAuthorization({ requestId: 'r3', context: context(), clientId: 'my-client', openUrl: browser, timeoutMs: 5000 });
    expect(registerBody).toBeUndefined();
    expect(steps[0].summary).toBe('Pre-registered client_id');
    expect(seen?.get('client_id')).toBe('my-client');
  });

  it('times out when the browser never calls back', async () => {
    const steps = await runAuthorization({ requestId: 'r4', context: context(), openUrl: () => {}, timeoutMs: 200 });
    expect(steps[2].status).toBe('error');
    expect(steps[2].summary).toContain('No authorization response');
  });

  it('errors clearly when there is no way to register', async () => {
    const ctx = context();
    delete ctx.authorizationServer.registration_endpoint;
    const steps = await runAuthorization({ requestId: 'r5', context: ctx, openUrl: browser, timeoutMs: 1000 });
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('error');
  });
});
