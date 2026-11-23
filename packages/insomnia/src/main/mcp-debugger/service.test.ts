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

  describe('exact replay (edited _meta and headers)', () => {
    const callEcho = (requestId: string, opts: { exactHeaders?: Record<string, string>; params?: unknown } = {}) =>
      service.invokeRaw({
        requestId,
        invocation: {
          method: 'tools/call',
          params: opts.params ?? { name: 'echo', arguments: { message: 'x' } },
        },
        exactHeaders: opts.exactHeaders,
      }).correlationId;
    const settled = (requestId: string, id: string) =>
      service.getTrace({ requestId }).find(e => e.correlationId === id && e.terminalStatus);
    const requestEvent = (requestId: string, id: string) =>
      service.getTrace({ requestId }).find(e => e.correlationId === id && e.awaitsReply)!;

    it('sends the headers exactly as written (a deleted Mcp-Name header makes the server reject it)', async () => {
      const requestId = 'req_exact_headers';
      await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
      const normal = callEcho(requestId);
      await waitFor(() => settled(requestId, normal)?.terminalStatus === 'success');

      const headers = { ...requestEvent(requestId, normal).requestHeaders };
      expect(headers['Mcp-Name']).toBe('echo');
      delete headers['Mcp-Name'];
      // Start from the traced wire request (params include the injected _meta), as the editor does.
      const wireParams = (requestEvent(requestId, normal).payload as { params: unknown }).params;
      const edited = callEcho(requestId, { params: wireParams, exactHeaders: headers });
      await waitFor(() => settled(requestId, edited) !== undefined);
      expect(settled(requestId, edited)!.terminalStatus).toBe('error');
      expect(JSON.stringify(settled(requestId, edited)!.payload)).toContain('Mcp-Name');
      expect(requestEvent(requestId, edited).requestHeaders).not.toHaveProperty('Mcp-Name');
      await service.disconnect({ requestId });
    });

    it('leaves an edited _meta untouched and traces the params as actually sent', async () => {
      const requestId = 'req_exact_meta';
      await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
      const normal = callEcho(requestId);
      await waitFor(() => settled(requestId, normal) !== undefined);
      // Normal calls now trace the wire params, including the injected _meta.
      const sent = requestEvent(requestId, normal).payload as { params: { _meta: Record<string, unknown> } };
      expect(sent.params._meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');

      const params = { name: 'echo', arguments: { message: 'x' }, _meta: { custom: 'kept' } };
      const edited = callEcho(requestId, { params, exactHeaders: requestEvent(requestId, normal).requestHeaders });
      const editedSent = requestEvent(requestId, edited).payload as { params: { _meta: Record<string, unknown> } };
      expect(editedSent.params._meta).toEqual({ custom: 'kept' });
      await service.disconnect({ requestId });
    });

    it('fills credential values shown as redacted back in from the connection, and honours deleting them', async () => {
      const requestId = 'req_exact_auth';
      await service.connect({
        requestId,
        url: `${base}/protected`,
        headers: [{ name: 'Authorization', value: 'Bearer good-token' }],
        protocolVersion: 'auto',
      });
      const normal = callEcho(requestId);
      await waitFor(() => settled(requestId, normal)?.terminalStatus === 'success');
      const headers = { ...requestEvent(requestId, normal).requestHeaders };
      expect(headers.Authorization).toBe('<redacted>');

      const replayed = callEcho(requestId, { exactHeaders: headers });
      await waitFor(() => settled(requestId, replayed) !== undefined);
      expect(settled(requestId, replayed)!.terminalStatus).toBe('success'); // marker was swapped for the real token

      delete headers.Authorization;
      const noAuth = callEcho(requestId, { exactHeaders: headers });
      await waitFor(() => settled(requestId, noAuth) !== undefined);
      expect(settled(requestId, noAuth)!.terminalStatus).toBe('error'); // sent without credentials -> 401
      await service.disconnect({ requestId });
    });
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

describe('multi round-trip requests (input_required)', () => {
  it('surfaces input_required as a pending call, and a continuation completes it', async () => {
    const requestId = 'req_mrtr';
    await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    const { correlationId } = service.invokeRaw({
      requestId,
      invocation: { method: 'tools/call', params: { name: 'ask-input', arguments: {} } },
    });
    const events = () => service.getTrace({ requestId }).filter(e => e.correlationId === correlationId);
    await waitFor(() => events().some(e => e.messageType === 'input-required'));
    expect(events().some(e => e.terminalStatus)).toBe(false); // still pending

    const prompt = events().find(e => e.messageType === 'input-required')!.payload as {
      inputRequests: Record<string, unknown>;
      requestState: unknown;
    };
    expect(Object.keys(prompt.inputRequests)).toEqual(['who']);
    const original = events().find(e => e.awaitsReply && e.direction === 'client-to-server')!.payload as {
      method: string;
      params: Record<string, unknown>;
    };
    service.invokeRaw({
      requestId,
      invocation: {
        method: original.method,
        correlationId, // thread the retry under the same call
        params: {
          ...original.params,
          inputResponses: { who: { action: 'accept', content: { name: 'Cam' } } },
          requestState: prompt.requestState,
        },
      },
    });
    await waitFor(() => events().some(e => e.terminalStatus === 'success'));
    expect(JSON.stringify(events().find(e => e.terminalStatus)!.payload)).toContain('Hello, Cam!');
    expect(events().some(e => e.messageType === 'input-response')).toBe(true);
    await service.disconnect({ requestId });
  });
});

describe('tasks (io.modelcontextprotocol/tasks)', () => {
  // Poll fast: the server advertises 10 ms, and the production floor is 2 s.
  const originalPoll = { ...service.taskPollConfig };
  beforeAll(() => Object.assign(service.taskPollConfig, { minMs: 15, defaultMs: 20, maxMs: 40, backoff: 1 }));
  afterAll(() => Object.assign(service.taskPollConfig, originalPoll));

  const start = async (requestId: string, tool: string) => {
    await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    const { correlationId } = service.invokeRaw({
      requestId,
      invocation: { method: 'tools/call', params: { name: tool, arguments: {} } },
    });
    await waitFor(() => service.getState({ requestId }).tasks.length === 1);
    return { correlationId, task: () => service.getState({ requestId }).tasks[0] };
  };
  const callStatus = (requestId: string, correlationId: string) =>
    service.getTrace({ requestId }).find(e => e.correlationId === correlationId && e.terminalStatus)?.terminalStatus;
  const count = (requestId: string, method: string) =>
    service.getTrace({ requestId }).filter(e => e.awaitsReply && (e.payload as { method?: string }).method === method).length;

  it('polls a task to completion and settles the originating call with its result', async () => {
    const requestId = 'req_task_ok';
    const { correlationId, task } = await start(requestId, 'quick-success-task');
    expect(callStatus(requestId, correlationId)).toBeUndefined(); // the call is pending while the task works
    await waitFor(() => task().status === 'completed');
    expect(JSON.stringify(task().result)).toContain('quick task done');
    await waitFor(() => callStatus(requestId, correlationId) === 'success');
    expect(task().polling).toBe(false);
    await service.disconnect({ requestId });
  });

  it('settles the call as an error when the task fails', async () => {
    const requestId = 'req_task_fail';
    const { correlationId, task } = await start(requestId, 'failed-task');
    await waitFor(() => task().status === 'failed');
    expect(task().error).toMatchObject({ message: 'task failed' });
    await waitFor(() => callStatus(requestId, correlationId) === 'error');
    await service.disconnect({ requestId });
  });

  it('stops polling on a fatal tasks/get error (an expired task) and fails the task', async () => {
    const requestId = 'req_task_expired';
    const { correlationId, task } = await start(requestId, 'expired-task');
    await waitFor(() => task().status === 'failed');
    await waitFor(() => callStatus(requestId, correlationId) === 'error');
    expect(task().polling).toBe(false);
    await service.disconnect({ requestId });
  });

  it('cancels a working task: the task and its call both end cancelled', async () => {
    const requestId = 'req_task_cancel';
    const { correlationId, task } = await start(requestId, 'cancellable-task');
    await waitFor(() => count(requestId, 'tasks/get') >= 1);
    service.taskAction({ requestId, taskId: task().taskId, action: 'cancel' });
    await waitFor(() => task().status === 'cancelled');
    await waitFor(() => callStatus(requestId, correlationId) === 'cancelled');
    await service.disconnect({ requestId });
  });

  it('pauses and resumes polling', async () => {
    const requestId = 'req_task_pause';
    const { task } = await start(requestId, 'cancellable-task'); // stays working forever
    await waitFor(() => count(requestId, 'tasks/get') >= 1);
    service.taskAction({ requestId, taskId: task().taskId, action: 'pause' });
    await new Promise(r => setTimeout(r, 60)); // let any in-flight poll land
    const paused = count(requestId, 'tasks/get');
    await new Promise(r => setTimeout(r, 150));
    expect(count(requestId, 'tasks/get')).toBe(paused);
    expect(task().paused).toBe(true);
    service.taskAction({ requestId, taskId: task().taskId, action: 'resume' });
    await waitFor(() => count(requestId, 'tasks/get') > paused);
    service.taskAction({ requestId, taskId: task().taskId, action: 'cancel' });
    await service.disconnect({ requestId });
  });

  it('stops polling at input_required, then completes after tasks/update', async () => {
    const requestId = 'req_task_input';
    const { correlationId, task } = await start(requestId, 'input-required-task');
    await waitFor(() => task().status === 'input_required');
    expect(Object.keys(task().inputRequests ?? {})).toEqual(['confirmation']);
    await new Promise(r => setTimeout(r, 80));
    const polled = count(requestId, 'tasks/get');
    await new Promise(r => setTimeout(r, 120));
    expect(count(requestId, 'tasks/get')).toBe(polled); // not polling while waiting for the user

    service.taskAction({ requestId, taskId: task().taskId, action: 'update', inputs: { confirmation: { proceed: 'yes' } } });
    await waitFor(() => task().status === 'completed');
    await waitFor(() => callStatus(requestId, correlationId) === 'success');
    await service.disconnect({ requestId });
  });
});

describe('subscriptions/listen', () => {
  const trigger = (requestId: string, args: Record<string, unknown>) => {
    service.invokeRaw({
      requestId,
      invocation: { method: 'tools/call', params: { name: 'trigger-change', arguments: args } },
    });
  };
  const notifications = (requestId: string, method: string) =>
    service
      .getTrace({ requestId })
      .filter(e => e.messageType === 'notification' && (e.payload as { method?: string }).method === method);

  it('opens a stream, records what the server acknowledged, and delivers the opted-in notifications', async () => {
    const requestId = 'req_listen';
    await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    service.subscribe({
      requestId,
      notifications: {
        toolsListChanged: true,
        promptsListChanged: true, // the mock does not honor this one
        resourceSubscriptions: ['file:///project/config.json'],
      },
    });
    await waitFor(() => service.getState({ requestId }).subscription?.status === 'active');
    const sub = service.getState({ requestId }).subscription!;
    expect(sub.subscriptionId).toBeDefined();
    expect(sub.acknowledged).toEqual({
      toolsListChanged: true,
      resourceSubscriptions: ['file:///project/config.json'],
    }); // promptsListChanged was omitted by the server

    trigger(requestId, { kind: 'tools' });
    await waitFor(() => notifications(requestId, 'notifications/tools/list_changed').length === 1);
    const delivered = notifications(requestId, 'notifications/tools/list_changed')[0].payload as {
      params: { _meta: Record<string, unknown> };
    };
    expect(delivered.params._meta['io.modelcontextprotocol/subscriptionId']).toBe(sub.subscriptionId);

    trigger(requestId, { kind: 'resource-updated', uri: 'file:///project/config.json' });
    await waitFor(() => notifications(requestId, 'notifications/resources/updated').length === 1);
    expect(notifications(requestId, 'notifications/resources/updated')[0].payload).toMatchObject({
      params: { uri: 'file:///project/config.json' },
    });

    // A type that was not acknowledged is never delivered.
    trigger(requestId, { kind: 'prompts' });
    await new Promise(r => setTimeout(r, 150));
    expect(notifications(requestId, 'notifications/prompts/list_changed')).toHaveLength(0);

    service.unsubscribe({ requestId });
    await waitFor(() => service.getState({ requestId }).subscription?.status === 'cancelled');
    await service.disconnect({ requestId });
  });

  it('trigger-change: a uri alone means a resource update, and a non-matching uri reaches no one', async () => {
    const requestId = 'req_listen_uri';
    await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    service.subscribe({
      requestId,
      notifications: { toolsListChanged: true, resourceSubscriptions: ['file:///project/config.json'] },
    });
    await waitFor(() => service.getState({ requestId }).subscription?.status === 'active');
    const reply = async (args: Record<string, unknown>) => {
      const { correlationId } = service.invokeRaw({
        requestId,
        invocation: { method: 'tools/call', params: { name: 'trigger-change', arguments: args } },
      });
      await waitFor(() => service.getTrace({ requestId }).some(e => e.correlationId === correlationId && e.terminalStatus));
      return JSON.stringify(service.getTrace({ requestId }).find(e => e.correlationId === correlationId && e.terminalStatus)!.payload);
    };
    expect(await reply({ uri: 'file:///project/config.json' })).toContain('kind=resource-updated');
    await waitFor(() => notifications(requestId, 'notifications/resources/updated').length === 1);
    expect(await reply({ uri: 'file:///made/up.txt' })).toContain('notified 0 listener(s)');
    expect(notifications(requestId, 'notifications/resources/updated')).toHaveLength(1);
    expect(notifications(requestId, 'notifications/tools/list_changed')).toHaveLength(0);
    service.unsubscribe({ requestId });
    await service.disconnect({ requestId });
  });

  it('refuses a second subscription while one is open', async () => {
    const requestId = 'req_listen_twice';
    await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    service.subscribe({ requestId, notifications: { toolsListChanged: true } });
    expect(() => service.subscribe({ requestId, notifications: { toolsListChanged: true } })).toThrow(/Already subscribed/);
    service.unsubscribe({ requestId });
    await service.disconnect({ requestId });
  });
});

describe('mcp-debugger relay (MCP Apps)', () => {
  it('relays an app-style call and resolves its result', async () => {
    const requestId = 'req_relay';
    const state = await service.connect({ requestId, url: `${base}/stateless`, headers: [], protocolVersion: 'auto' });
    const chart = state.capabilities.find(c => c.metadata.name === 'ui-chart');
    expect(chart?.ui?.resourceUri).toBe('ui://mock/app');

    const read = await service.relay({ requestId, invocation: { method: 'resources/read', params: { uri: 'ui://mock/app' } } });
    expect(read.error).toBeUndefined();
    expect(JSON.stringify(read.result)).toContain('text/html;profile=mcp-app');

    const call = await service.relay({ requestId, invocation: { method: 'tools/call', params: { name: 'echo', arguments: { message: 'from the app' } } } });
    expect(JSON.stringify(call.result)).toContain('from the app');
    // Both calls are in the trace like any other.
    expect(service.getTrace({ requestId }).some(e => e.label === 'resources/read · ui://mock/app')).toBe(true);

    // A failed call comes back as `error` (a tool failing comes back as a normal result with isError). This mock answers an
    // unknown method with HTTP 400.
    const bad = await service.relay({ requestId, invocation: { method: 'insomnia/unknown-method', params: {} } });
    expect(bad.error?.message).toMatch(/HTTP 400/);
    await service.disconnect({ requestId });
    expect((await service.relay({ requestId, invocation: { method: 'ping' } })).error?.message).toBe('Not connected');
  });
});
