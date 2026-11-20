import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverOAuth } from './oauth-discovery';
import { runAuthorization } from './oauth-flow';
import { exchangeCode } from './oauth-token';
import { getTrace, oauthTraceFor } from './service';

describe('OAuth calls in the trace', () => {
  let server: http.Server;
  let origin = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', origin);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
      req.resume();
      req.on('end', () => {
        if (url.pathname === '/mcp') {
          return req.headers.authorization
            ? json(200, { jsonrpc: '2.0', id: 1, result: {} })
            : json(401, {}, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/prm"` });
        }
        if (url.pathname === '/prm') {
          return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
          return json(200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
          });
        }
        if (url.pathname === '/register') {
          return json(201, { client_id: 'c1' });
        }
        if (url.pathname === '/authorize') {
          const back = new URL(url.searchParams.get('redirect_uri')!);
          back.searchParams.set('code', 'code-1');
          back.searchParams.set('state', url.searchParams.get('state')!);
          back.searchParams.set('iss', origin);
          return res.writeHead(302, { location: back.toString() }).end();
        }
        if (url.pathname === '/token') {
          return json(200, { access_token: 'secret-at', token_type: 'Bearer', expires_in: 60 });
        }
        return json(404, {});
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('records every OAuth call as its own Call, tagged, request then reply, in order', async () => {
    const requestId = 'trace-req-1';
    const trace = oauthTraceFor(requestId);
    const discovery = await discoverOAuth({ url: `${origin}/mcp`, trace });
    await runAuthorization({ requestId, context: discovery.context!, openUrl: url => void fetch(url), timeoutMs: 5000, trace });
    await exchangeCode({ requestId, trace });

    const events = getTrace({ requestId });
    expect(events.every(e => e.flow === 'oauth')).toBe(true);
    const calls = new Map<string, typeof events>();
    for (const e of events) {
      calls.set(e.correlationId, [...(calls.get(e.correlationId) ?? []), e]);
    }
    // 401 challenge, PRM, AS metadata, DCR, browser authorize, token, verify
    expect([...calls.values()].map(c => c[0].label?.split(' · ')[0])).toEqual([
      'Unauthenticated request',
      'Protected resource metadata',
      'Authorization server metadata',
      'Client registration',
      'Authorize in browser',
      'Token exchange',
      'Call the MCP server with the token',
    ]);
    for (const call of calls.values()) {
      expect(call).toHaveLength(2);
      expect(call[0]).toMatchObject({ direction: 'client-to-server', awaitsReply: true });
      expect(call[1].direction).toBe('server-to-client');
      expect(call[1].terminalStatus).toBeDefined();
    }
    const all = [...calls.values()];
    const [challenge, browser, verify] = [all[0], all[4], all[6]];
    expect(challenge[1].terminalStatus).toBe('error'); // the expected 401 is still an error row
    expect(browser[1]).toMatchObject({ messageType: 'redirect', terminalStatus: 'success' });
    expect((browser[1].payload as { redirected_to_loopback: { code: string } }).redirected_to_loopback.code).toBe('code-1');
    // credential headers are redacted at capture
    expect(verify[0].requestHeaders?.authorization ?? verify[0].requestHeaders?.Authorization).toBe('<redacted>');
  });

  it('settles a cancelled browser leg as cancelled', async () => {
    const requestId = 'trace-req-2';
    const trace = oauthTraceFor(requestId);
    const discovery = await discoverOAuth({ url: `${origin}/mcp`, trace });
    await runAuthorization({ requestId, context: discovery.context!, openUrl: () => {}, timeoutMs: 150, trace });
    const browser = getTrace({ requestId }).filter(e => e.label?.startsWith('Authorize in browser'));
    expect(browser.map(e => e.terminalStatus)).toEqual([undefined, 'no-response']);
  });
});
