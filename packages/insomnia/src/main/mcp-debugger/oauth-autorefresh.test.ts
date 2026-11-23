import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverOAuth } from './oauth-discovery';
import { runAuthorization } from './oauth-flow';
import { exchangeCode } from './oauth-token';
import * as service from './service';

// Integration tests against the real mocks (authorization server + MCP server): a wizard-issued token that expires is
// refreshed, either before Connect or after a call fails with 401, and the retry is visible as a replay.
const AS_PORT = 19_001;
const MCP_PORT = 18_797;
const AS = `http://127.0.0.1:${AS_PORT}`;
const MCP = `http://127.0.0.1:${MCP_PORT}`;
const children: ChildProcess[] = [];

const waitFor = async (check: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error('timed out');
    }
    await new Promise(r => setTimeout(r, 25));
  }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const setFlags = (flags: object) => fetch(`${AS}/admin/flags`, { method: 'POST', body: JSON.stringify(flags) });

beforeAll(async () => {
  const dir = path.resolve(__dirname, '../../../../insomnia-smoke-test/server/mcp-debugger');
  children.push(
    spawn(process.execPath, [path.join(dir, 'mock-authorization-server.mjs')], {
      env: { ...process.env, MOCK_AUTHORIZATION_SERVER_PORT: String(AS_PORT), MOCK_MCP_ORIGIN: MCP, MOCK_AUTH_CONSENT: '0' },
      stdio: 'ignore',
    }),
    spawn(process.execPath, [path.join(dir, 'mock-mcp-server.mjs')], {
      env: { ...process.env, MOCK_MCP_PORT: String(MCP_PORT), MOCK_AUTHORIZATION_SERVER_ORIGIN: AS },
      stdio: 'ignore',
    }),
  );
  for (const url of [`${AS}/health`, `${MCP}/health`]) {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(url)).ok) {
          break;
        }
      } catch {}
      await sleep(50);
    }
  }
});
afterAll(() => children.forEach(child => child.kill()));

/** Runs the whole wizard against the mocks and returns the first access token (a 2 s token when `short`). */
const signIn = async (requestId: string, short: boolean) => {
  await setFlags({ shortTtl: short });
  const discovery = await discoverOAuth({ url: `${MCP}/oauth-protected` });
  await runAuthorization({ requestId, context: discovery.context!, openUrl: url => void fetch(url), timeoutMs: 5000 });
  const steps = await exchangeCode({ requestId });
  return steps[0].tokens!.accessToken;
};

const oauthLabels = (requestId: string) =>
  service
    .getTrace({ requestId })
    .filter(e => e.flow === 'oauth' && e.direction === 'client-to-server')
    .map(e => e.label?.split(' · ')[0]);

describe('OAuth token upkeep', () => {
  it('serves just the echo tool once signed in (the OAuth-protected endpoint is a simple server)', async () => {
    const requestId = 'ar-echo-only';
    const token = await signIn(requestId, false);
    const state = await service.connect({ requestId, url: `${MCP}/oauth-protected`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });
    expect(state.status).toBe('connected');
    expect(state.capabilities.map(c => c.metadata.name)).toEqual(['echo']);
    await service.disconnect({ requestId });
  });

  it('after a 401 refreshes the wizard token and retries the call once, visibly', async () => {
    const requestId = 'ar-1';
    const token = await signIn(requestId, true);
    const state = await service.connect({ requestId, url: `${MCP}/oauth-protected`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });
    expect(state.status).toBe('connected');
    await sleep(2400); // the 2 s token is now expired
    await setFlags({ shortTtl: false });

    const echo = service.getState({ requestId }).capabilities.find(c => c.metadata.name === 'echo')!;
    const { correlationId } = service.invokeCapability({ requestId, capability: echo, args: { message: 'hi' } });
    await waitFor(() => Object.values(service.getState({ requestId }).replays).includes(correlationId));

    const after = service.getState({ requestId });
    const retryId = Object.entries(after.replays).find(([, original]) => original === correlationId)![0];
    await waitFor(() => service.getTrace({ requestId }).some(e => e.correlationId === retryId && e.terminalStatus));
    const terminal = (id: string) => service.getTrace({ requestId }).find(e => e.correlationId === id && e.terminalStatus)!;
    expect(terminal(correlationId)).toMatchObject({ terminalStatus: 'error', payload: { status: 401 } });
    expect(terminal(retryId).terminalStatus).toBe('success');
    expect(terminal(retryId).httpStatus).toBe(200); // the transport stamps the response code on the reply
    expect(oauthLabels(requestId)).toContain('Refresh the token');
    expect(after.oauthRefresh?.seq).toBe(1);
    expect(after.oauthRefresh?.accessToken).not.toBe(token);
    // a second call now just works, no further refresh
    const second = service.invokeCapability({ requestId, capability: echo, args: { message: 'again' } });
    await waitFor(() => service.getTrace({ requestId }).some(e => e.correlationId === second.correlationId && e.terminalStatus));
    expect(terminal(second.correlationId).terminalStatus).toBe('success');
    expect(service.getState({ requestId }).oauthRefresh?.seq).toBe(1);
    await service.disconnect({ requestId });
  });

  it('refreshes an expired token before Connect', async () => {
    const requestId = 'ar-2';
    const token = await signIn(requestId, true);
    await sleep(2400);
    await setFlags({ shortTtl: false });
    const state = await service.connect({ requestId, url: `${MCP}/oauth-protected`, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] });
    expect(state.status).toBe('connected');
    expect(state.oauthRefresh?.seq).toBe(1);
    expect(oauthLabels(requestId)).toContain('Refresh the token');
    await service.disconnect({ requestId });
  });

  it('leaves a hand-written token alone', async () => {
    const requestId = 'ar-3';
    await signIn(requestId, false);
    const state = await service.connect({ requestId, url: `${MCP}/oauth-protected`, headers: [{ name: 'Authorization', value: 'Bearer not-ours' }] });
    expect(state.status).toBe('error');
    expect(state.oauthRefresh).toBeUndefined();
    expect(oauthLabels(requestId)).not.toContain('Refresh the token');
  });
});
