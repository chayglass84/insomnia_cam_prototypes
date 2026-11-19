import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getProfile } from '~/common/mcp-debugger/profiles';
import { eraOfVersion, SUPPORTED_VERSIONS } from '~/common/mcp-debugger/versions';

import { probeMcpServer } from './probe';

const rpc = (res: http.ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const msg = JSON.parse(raw);
      if (req.url === '/stateless' && msg.method === 'server/discover') {
        return rpc(res, { jsonrpc: '2.0', id: msg.id, result: { supportedVersions: ['2026-07-28'], capabilities: {}, serverInfo: { name: 'stateless-mock', version: '1' } } });
      }
      if (req.url === '/legacy') {
        if (msg.method === 'initialize') {
          return rpc(res, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'legacy-mock', version: '1' } } });
        }
        return rpc(res, { jsonrpc: '2.0', id: msg.id, error: { code: -32_601, message: 'not found' } });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('probeMcpServer', () => {
  it('detects the stateless era via server/discover', async () => {
    const result = await probeMcpServer({ url: `${base}/stateless` });
    expect(result).toMatchObject({ ok: true, era: 'stateless', version: '2026-07-28' });
    expect(result.exchanges.map(e => e.step)).toEqual(['server/discover']);
  });

  it('falls back to initialize for a session-era server', async () => {
    const result = await probeMcpServer({ url: `${base}/legacy` });
    expect(result).toMatchObject({ ok: true, era: 'session', version: '2025-11-25' });
    expect(result.exchanges.map(e => e.step)).toEqual(['server/discover', 'initialize']);
  });

  it('reports no endpoint when neither probe lands', async () => {
    const result = await probeMcpServer({ url: `${base}/nope` });
    expect(result.ok).toBe(false);
  });
});

describe('profiles', () => {
  it('has a profile per supported version, with legacy-only tabs absent from 2026-07-28', () => {
    for (const v of SUPPORTED_VERSIONS) {
      expect(getProfile(v).era).toBe(eraOfVersion(v));
    }
    expect(getProfile('2026-07-28').tabs).toEqual(expect.arrayContaining(['tasks', 'subscriptions']));
    expect(getProfile('2026-07-28').tabs).not.toContain('roots');
    expect(getProfile('2025-11-25').tabs).toEqual(expect.arrayContaining(['roots', 'sampling', 'logging', 'ping']));
  });
});
