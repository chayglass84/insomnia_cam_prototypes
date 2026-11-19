import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as service from './service';

// Integration test against Ardi's ported mock server (packages/insomnia-smoke-test/server/mcp-debugger).
const PORT = 18_787;
const base = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;

const waitFor = async (check: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) {
      throw new Error('timed out');
    }
    await new Promise(r => setTimeout(r, 25));
  }
};

beforeAll(async () => {
  const script = path.resolve(__dirname, '../../../../insomnia-smoke-test/server/mcp-debugger/mock-mcp-server.mjs');
  child = spawn(process.execPath, [script], { env: { ...process.env, MOCK_MCP_PORT: String(PORT) }, stdio: 'ignore' });
  await waitFor(() => child.pid !== undefined);
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) {
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('mock server did not start');
});
afterAll(() => child.kill());

describe('mcp-debugger service', () => {
  it('connects statelessly, lists capabilities and calls a tool', async () => {
    const requestId = 'req_stateless';
    const state = await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    expect(state.status).toBe('connected');
    expect(state.protocolVersion).toBe('2026-07-28');
    const echo = state.capabilities.find(c => c.metadata.name === 'echo');
    expect(echo).toBeDefined();

    service.invokeCapability({ requestId, capability: echo!, args: { message: 'hi' } });
    const callRequest = () => service.getTrace({ requestId }).find(e => e.label === 'tools/call · echo');
    await waitFor(() => callRequest() !== undefined);
    await waitFor(() =>
      service.getTrace({ requestId }).some(e => e.correlationId === callRequest()!.correlationId && e.terminalStatus === 'success'),
    );
    await service.disconnect({ requestId });
    expect(service.getState({ requestId }).status).toBe('disconnected');
  });

  it('connects to a session-era server via the initialize handshake', async () => {
    const requestId = 'req_legacy';
    const state = await service.connect({ requestId, url: `${base}/legacy`, headers: [], protocolVersion: 'auto' });
    expect(state.status).toBe('connected');
    expect(state.protocolVersion).toBe('2025-11-25');
    await service.disconnect({ requestId });
  });

  it('reports a connect failure without throwing', async () => {
    const state = await service.connect({ requestId: 'req_bad', url: `${base}/nope`, headers: [], protocolVersion: 'auto' });
    expect(state.status).toBe('error');
    expect(state.error).toBeTruthy();
  });

  it('replays an edited call, linking it to the original', async () => {
    const requestId = 'req_replay';
    await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    const call = (message: string, replayOf?: string) =>
      service.invokeRaw({ requestId, invocation: { method: 'tools/call', params: { name: 'echo', arguments: { message } } }, replayOf });
    const first = call('one');
    const second = call('two', first.correlationId);
    expect(first.correlationId).toBeTruthy();
    expect(second.correlationId).not.toBe(first.correlationId);
    expect(service.getState({ requestId }).replays[second.correlationId]).toBe(first.correlationId);
    await waitFor(() =>
      [first, second].every(c => service.getTrace({ requestId }).some(e => e.correlationId === c.correlationId && e.terminalStatus === 'success')),
    );
    await service.disconnect({ requestId });
  });

  it('keeps a slow call pending, then settles it (and cancel settles it as cancelled)', async () => {
    const requestId = 'req_pending';
    await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    const slow = (delayMs: number) =>
      service.invokeRaw({
        requestId,
        invocation: { method: 'tools/call', params: { name: 'slow-echo', arguments: { message: 'zzz', delayMs } } },
      }).correlationId;
    const statusOf = (id: string) => service.getTrace({ requestId }).find(e => e.correlationId === id && e.terminalStatus)?.terminalStatus;

    const finishing = slow(400);
    expect(statusOf(finishing)).toBeUndefined(); // pending: request sent, nothing terminal yet
    await waitFor(() => statusOf(finishing) === 'success');

    const cancelled = slow(5000);
    expect(statusOf(cancelled)).toBeUndefined();
    service.cancel({ requestId, correlationId: cancelled });
    await waitFor(() => statusOf(cancelled) !== undefined);
    expect(statusOf(cancelled)).toBe('cancelled');
    await service.disconnect({ requestId });
  });

  describe('failures', () => {
    const errorEvent = (requestId: string) => service.getTrace({ requestId }).find(e => e.terminalStatus === 'error');

    it('flags a protocol issue for a pinned session version against a stateless server, and proposes the pinned version', async () => {
      const requestId = 'req_pin_mismatch';
      const state = await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: '2025-03-26' });
      expect(state.protocolIssue).toBe(`The MCP server ${base}/stateless does not support protocol 2025-03-26.`);
      const init = service.getTrace({ requestId }).find(e => e.direction === 'client-to-server');
      expect((init!.payload as { params: { protocolVersion: string } }).params.protocolVersion).toBe('2025-03-26');
      // The HTTP status is in the trace, not only in a banner.
      expect(errorEvent(requestId)!.payload).toMatchObject({ kind: 'transport', status: 400 });
    });

    it('flags a protocol issue for stateless pinned against a session-era server', async () => {
      const state = await service.connect({ requestId: 'req_stateless_pin', url: `${base}/legacy`, headers: [], protocolVersion: '2026-07-28' });
      expect(state.protocolIssue).toBe(`The MCP server ${base}/legacy does not support protocol 2026-07-28.`);
    });

    it('keeps auth failures trace-only (no protocol banner) with status and response details', async () => {
      const requestId = 'req_auth';
      const state = await service.connect({ requestId, url: `${base}/protected`, headers: [], protocolVersion: 'auto' });
      expect(state.status).toBe('error');
      expect(state.protocolIssue).toBeUndefined();
      expect(errorEvent(requestId)!.payload).toMatchObject({ kind: 'auth', status: 401 });
    });
  });
});
