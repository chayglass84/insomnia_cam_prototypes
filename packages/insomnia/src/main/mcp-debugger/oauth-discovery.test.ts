import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authorizationServerCandidates,
  buildVerdict,
  discoverOAuth,
  parseWwwAuthenticate,
  protectedResourceCandidates,
} from './oauth-discovery';

describe('parseWwwAuthenticate', () => {
  it('reads quoted and bare params', () => {
    const [c] = parseWwwAuthenticate('Bearer realm="mcp", resource_metadata="https://x.test/.well-known/oauth-protected-resource", error=invalid_token');
    expect(c.scheme).toBe('Bearer');
    expect(c.params).toEqual({ realm: 'mcp', resource_metadata: 'https://x.test/.well-known/oauth-protected-resource', error: 'invalid_token' });
  });
  it('handles a bare scheme and empty input', () => {
    expect(parseWwwAuthenticate('Bearer')).toEqual([{ scheme: 'Bearer', params: {} }]);
    expect(parseWwwAuthenticate(undefined)).toEqual([]);
  });
});

describe('candidate URLs', () => {
  it('probes path-aware then bare for protected resource metadata', () => {
    expect(protectedResourceCandidates('https://h.test/mcp')).toEqual([
      'https://h.test/.well-known/oauth-protected-resource/mcp',
      'https://h.test/.well-known/oauth-protected-resource',
    ]);
    expect(protectedResourceCandidates('https://h.test/')).toEqual(['https://h.test/.well-known/oauth-protected-resource']);
  });
  it('orders authorization server candidates', () => {
    expect(authorizationServerCandidates('https://as.test')).toEqual([
      'https://as.test/.well-known/oauth-authorization-server',
      'https://as.test/.well-known/openid-configuration',
    ]);
    expect(authorizationServerCandidates('https://as.test/t1')[0]).toBe('https://as.test/.well-known/oauth-authorization-server/t1');
  });
});

describe('buildVerdict', () => {
  it('errors when PKCE support is not advertised', () => {
    const f = buildVerdict({ authorization_endpoint: 'a', token_endpoint: 't' });
    expect(f.some(x => x.level === 'error' && x.text.includes('code_challenge_methods_supported'))).toBe(true);
  });
  it('is clean for a full-featured server', () => {
    const f = buildVerdict({
      authorization_endpoint: 'a',
      token_endpoint: 't',
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(f.every(x => x.level === 'info')).toBe(true);
  });
  it('warns when no registration route and no iss support', () => {
    const f = buildVerdict({ authorization_endpoint: 'a', token_endpoint: 't', code_challenge_methods_supported: ['S256'] });
    expect(f.filter(x => x.level === 'warn')).toHaveLength(2);
  });
});

describe('discoverOAuth against a local server', () => {
  let server: http.Server;
  let origin = '';
  let omitAsMetadata = false;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/mcp') {
        return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/prm"` });
      }
      if (req.url === '/open') {
        return json(200, { ok: true });
      }
      if (req.url === '/prm') {
        return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      }
      if (req.url === '/.well-known/oauth-authorization-server' && !omitAsMetadata) {
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ['S256'],
          registration_endpoint: `${origin}/register`,
        });
      }
      return json(404, {});
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('walks challenge, PRM and AS metadata with its verdict', async () => {
    const result = await discoverOAuth({ url: `${origin}/mcp` });
    expect(result.steps.map(s => [s.id, s.status])).toEqual([
      ['challenge', 'ok'],
      ['protected-resource', 'ok'],
      ['authorization-server', 'warn'],
    ]);
    // path-aware probing: AS metadata was a single hit at the bare origin form
    expect(result.steps[2].exchanges[0].request.url).toBe(`${origin}/.well-known/oauth-authorization-server`);
  });

  it('stops after the first step when the server needs no OAuth', async () => {
    const result = await discoverOAuth({ url: `${origin}/open` });
    expect(result.steps[0].status).toBe('skipped');
    expect(result.steps.slice(1).every(s => s.status === 'skipped')).toBe(true);
  });

  it('reports a missing authorization server document', async () => {
    omitAsMetadata = true;
    const result = await discoverOAuth({ url: `${origin}/mcp` });
    omitAsMetadata = false;
    expect(result.steps[2].status).toBe('error');
    expect(result.steps).toHaveLength(3);
    expect(result.steps[2].summary).toBe('Not found');
    expect(result.steps[2].exchanges).toHaveLength(2);
  });
});
