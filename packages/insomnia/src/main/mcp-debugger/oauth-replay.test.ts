import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverOAuth } from './oauth-discovery';
import { runAuthorization } from './oauth-flow';
import { exchangeCode } from './oauth-token';
import * as service from './service';

// Integration tests against the real mocks (S5d): an OAuth call from the trace is sent again as edited, the reply is a new
// OAuth Call linked to the original, and a redacted Authorization header is filled in from the wizard's token.
const AS_PORT = 19_011;
const MCP_PORT = 18_807;
const AS = `http://127.0.0.1:${AS_PORT}`;
const MCP = `http://127.0.0.1:${MCP_PORT}`;
const children: ChildProcess[] = [];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

const signIn = async (requestId: string) => {
  const discovery = await discoverOAuth({ url: `${MCP}/oauth-protected`, trace: service.oauthTraceFor(requestId) });
  await runAuthorization({ requestId, trace: service.oauthTraceFor(requestId), context: discovery.context!, openUrl: url => void fetch(url), timeoutMs: 5000 });
  return exchangeCode({ requestId, trace: service.oauthTraceFor(requestId) });
};

const requestOf = (requestId: string, startsWith: string) =>
  service
    .getTrace({ requestId })
    .find(e => e.flow === 'oauth' && e.direction === 'client-to-server' && e.label?.startsWith(startsWith))!;

const replyOf = (requestId: string, correlationId: string) =>
  service.getTrace({ requestId }).find(e => e.correlationId === correlationId && e.direction === 'server-to-client')!;

describe('OAuth call replay', () => {
  it('re-sends an authorization code and shows the single-use rejection as a linked OAuth call', async () => {
    const requestId = 'replay-code';
    await signIn(requestId);
    const original = requestOf(requestId, 'Token exchange');
    const payload = original.payload as { method: string; url: string; body: string };
    expect(payload.body).toContain('grant_type=authorization_code');

    const { correlationId, error } = await service.replayOAuthCall({
      requestId,
      replayOf: original.correlationId,
      label: 'Token exchange',
      method: payload.method,
      url: payload.url,
      headers: original.requestHeaders!,
      body: payload.body,
    });
    expect(error).toBeUndefined();
    expect(service.getState({ requestId }).replays[correlationId!]).toBe(original.correlationId);
    const reply = replyOf(requestId, correlationId!);
    expect(reply.httpStatus).toBe(400);
    expect(JSON.stringify(reply.payload)).toContain('invalid_grant');
  });

  it('sends an edited body (a dropped code_verifier) and shows how the server reacts', async () => {
    const requestId = 'replay-edited';
    await signIn(requestId);
    const original = requestOf(requestId, 'Token exchange');
    const payload = original.payload as { method: string; url: string; body: string };
    const form = new URLSearchParams(payload.body);
    form.delete('code_verifier');
    const { correlationId } = await service.replayOAuthCall({
      requestId,
      replayOf: original.correlationId,
      label: 'Token exchange',
      method: payload.method,
      url: payload.url,
      headers: original.requestHeaders!,
      body: form.toString(),
    });
    expect((replyOf(requestId, correlationId!).payload as { body?: unknown }).body).toBeDefined();
    expect(replyOf(requestId, correlationId!).httpStatus).toBeGreaterThanOrEqual(400);
    expect(String((requestOf(requestId, 'Token exchange').payload as { body: string }).body)).toContain('code_verifier');
  });

  it('fills a redacted Authorization header with the wizard token so the verify call can be replayed', async () => {
    const requestId = 'replay-verify';
    await signIn(requestId);
    const original = requestOf(requestId, 'Call the MCP server with the token');
    expect(original.requestHeaders!.authorization).toBe('<redacted>');
    const payload = original.payload as { method: string; url: string; body: unknown };
    const { correlationId } = await service.replayOAuthCall({
      requestId,
      replayOf: original.correlationId,
      label: 'Call the MCP server with the token',
      method: payload.method,
      url: payload.url,
      headers: original.requestHeaders!,
      body: payload.body,
    });
    expect(replyOf(requestId, correlationId!).httpStatus).toBe(200);
  });

  it('refuses a non-http url', async () => {
    const result = await service.replayOAuthCall({ requestId: 'replay-bad', replayOf: 'x', label: 'x', method: 'GET', url: 'file:///etc/passwd', headers: {} });
    expect(result.error).toMatch(/http/);
  });
});
