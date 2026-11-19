import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as service from './service';

// Integration tests against the session-era mock (packages/insomnia-smoke-test/server/mcp-debugger/mock-legacy-server.mjs).
const PORT = 18_791;
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
  const script = path.resolve(__dirname, '../../../../insomnia-smoke-test/server/mcp-debugger/mock-legacy-server.mjs');
  child = spawn(process.execPath, [script], { env: { ...process.env, MOCK_LEGACY_PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) {
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('legacy mock did not start');
});
afterAll(() => child.kill());

const connect = (requestId: string, pathname: string, protocolVersion: string) =>
  service.connect({ requestId, url: `${base}${pathname}`, headers: [], protocolVersion });

const echo = async (requestId: string) => {
  const state = service.getState({ requestId });
  const capability = state.capabilities.find(c => c.metadata.name === 'echo')!;
  const { correlationId } = service.invokeCapability({ requestId, capability, args: { message: 'hi' } });
  await waitFor(() => service.getTrace({ requestId }).some(e => e.correlationId === correlationId && e.terminalStatus));
  return service.getTrace({ requestId }).find(e => e.correlationId === correlationId && e.terminalStatus)!;
};

describe('session-era servers', () => {
  it.each(['2025-11-25', '2025-06-18', '2025-03-26'])('connects pinned to %s over Streamable HTTP and calls a tool', async version => {
    const requestId = `req_${version}`;
    const state = await connect(requestId, '/mcp', version);
    expect(state.status).toBe('connected');
    expect(state.protocolVersion).toBe(version);
    expect((await echo(requestId)).terminalStatus).toBe('success');
    await service.disconnect({ requestId });
  });

  it('auto picks the newest session version', async () => {
    const state = await connect('req_auto_mcp', '/mcp', 'auto');
    expect(state.protocolVersion).toBe('2025-11-25');
    await service.disconnect({ requestId: 'req_auto_mcp' });
  });

  it('reports a protocol issue when the server answers an older pin with a different version', async () => {
    const state = await connect('req_old_pin', '/mcp', '2024-11-05');
    expect(state.status).toBe('error');
    expect(state.protocolIssue).toBe(`The MCP server ${base}/mcp does not support protocol 2024-11-05.`);
  });
});

describe('HTTP+SSE (2024-11-05)', () => {
  it('connects pinned to 2024-11-05 through the SSE transport and calls a tool', async () => {
    const requestId = 'req_sse_pinned';
    const state = await connect(requestId, '/sse', '2024-11-05');
    expect(state.status).toBe('connected');
    expect(state.protocolVersion).toBe('2024-11-05');
    expect((await echo(requestId)).terminalStatus).toBe('success');
    await service.disconnect({ requestId });
  });

  it('auto falls back from Streamable HTTP to SSE', async () => {
    const state = await connect('req_sse_auto', '/sse', 'auto');
    expect(state.status).toBe('connected');
    expect(state.protocolVersion).toBe('2024-11-05');
    await service.disconnect({ requestId: 'req_sse_auto' });
  });
});

describe('server-initiated requests (session era)', () => {
  const connectWithRoots = async (requestId: string, version = 'auto') => {
    const state = await service.connect({
      requestId,
      url: `${base}/mcp`,
      headers: [],
      protocolVersion: version,
      roots: [{ name: 'proj', uri: 'file:///work/proj' }],
    });
    expect(state.status).toBe('connected');
  };
  const callTool = (requestId: string, name: string) => {
    const capability = service.getState({ requestId }).capabilities.find(c => c.metadata.name === name)!;
    return service.invokeCapability({ requestId, capability, args: {} }).correlationId;
  };
  const settled = (requestId: string, correlationId: string) =>
    service.getTrace({ requestId }).find(e => e.correlationId === correlationId && e.terminalStatus);
  /** A server-initiated request still waiting for our answer. */
  const pendingServerRequest = (requestId: string, method: string) =>
    service
      .getTrace({ requestId })
      .find(
        (e, _i, all) =>
          e.direction === 'server-to-client' &&
          e.awaitsReply &&
          (e.payload as { method?: string }).method === method &&
          !all.some(x => x.correlationId === e.correlationId && x.terminalStatus),
      );
  const toolText = (requestId: string, correlationId: string) =>
    JSON.stringify((settled(requestId, correlationId)!.payload as { content: unknown }).content);

  it('advertises roots/sampling (and elicitation from 2025-06-18) in initialize', async () => {
    for (const [version, expectElicitation] of [['2025-11-25', true], ['2025-03-26', false]] as const) {
      const requestId = `req_caps_${version}`;
      await connectWithRoots(requestId, version);
      const init = service.getTrace({ requestId }).find(e => (e.payload as { method?: string }).method === 'initialize')!;
      const caps = (init.payload as { params: { capabilities: Record<string, unknown> } }).params.capabilities;
      expect(caps).toMatchObject({ roots: { listChanged: true }, sampling: {} });
      expect('elicitation' in caps).toBe(expectElicitation);
      await service.disconnect({ requestId });
    }
  });

  it('answers roots/list from the configured roots', async () => {
    const requestId = 'req_roots';
    await connectWithRoots(requestId);
    const call = callTool(requestId, 'ask-roots');
    await waitFor(() => settled(requestId, call) !== undefined);
    expect(toolText(requestId, call)).toContain('file:///work/proj');
    await service.disconnect({ requestId });
  });

  it('holds a sampling request until it is answered, then returns the answer to the server', async () => {
    const requestId = 'req_sampling';
    await connectWithRoots(requestId);
    const call = callTool(requestId, 'ask-sampling');
    await waitFor(() => pendingServerRequest(requestId, 'sampling/createMessage') !== undefined);
    expect(settled(requestId, call)).toBeUndefined(); // the tool call is blocked on us
    await service.respondPeerRequest({
      requestId,
      correlationId: pendingServerRequest(requestId, 'sampling/createMessage')!.correlationId,
      result: { role: 'assistant', content: { type: 'text', text: 'hello from the human' }, model: 'me' },
    });
    await waitFor(() => settled(requestId, call) !== undefined);
    expect(toolText(requestId, call)).toContain('hello from the human');
    expect(pendingServerRequest(requestId, 'sampling/createMessage')).toBeUndefined();
    await service.disconnect({ requestId });
  });

  it('answers an elicitation, and a decline reaches the server as the user wrote it', async () => {
    const requestId = 'req_elicit';
    await connectWithRoots(requestId);
    const call = callTool(requestId, 'ask-elicit');
    await waitFor(() => pendingServerRequest(requestId, 'elicitation/create') !== undefined);
    await service.respondPeerRequest({
      requestId,
      correlationId: pendingServerRequest(requestId, 'elicitation/create')!.correlationId,
      result: { action: 'accept', content: { name: 'Cam' } },
    });
    await waitFor(() => settled(requestId, call) !== undefined);
    expect(toolText(requestId, call)).toContain('Cam');
    await service.disconnect({ requestId });
  });
});
