import { isProtocolException } from '~/common/mcp-debugger/protocol/errors';
import type { MCPInvocation } from '~/common/mcp-debugger/protocol/mcp/capabilities/methods';
import { type MCPConnectConfig,MCPHTTPProtocol } from '~/common/mcp-debugger/protocol/mcp/MCPHTTPProtocol';
import { buildTasksCancel, buildTasksGet, buildTasksUpdate } from '~/common/mcp-debugger/protocol/mcp/tasks/taskMethods';
import { isTaskTerminal, parseTaskHandle, type TaskRecord } from '~/common/mcp-debugger/protocol/mcp/tasks/taskModel';
import { redactCredentialHeaders, REDACTED, traceEventsFor } from '~/common/mcp-debugger/protocol/mcp/traceEvents';
import type { Capability, Connection, IntrospectionWarning,Invocation } from '~/common/mcp-debugger/protocol/Protocol';
import type { TraceEvent } from '~/common/mcp-debugger/protocol/TraceEvent';
import { isVersionChoice } from '~/common/mcp-debugger/versions';

import { exchange, type OAuthExchange, type OAuthTrace } from './oauth-discovery';
import { canRefresh, currentAccessToken, isExpired, ownsAccessToken, refreshToken } from './oauth-token';

// Task 4348 S1: the main-process home of the ported Ardi MCPHTTPProtocol. One Session per MCP request id.
// PROTOTYPE-MOCK: sessions and traces are in-memory only (lost on app restart); S2 persists runs for replay.
// PROTOTYPE-MOCK: the renderer polls getState/getTrace (see use-mcp-debugger.ts) instead of receiving pushed events.

export type McpDebuggerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface Session {
  protocol: MCPHTTPProtocol;
  conn?: Connection;
  abort?: AbortController;
  status: McpDebuggerStatus;
  error?: string;
  protocolIssue?: string;
  oauthRequired?: boolean;
  /** Bumped each time Insomnia swaps in a refreshed OAuth token on this connection, so the UI can update the Auth tab. */
  oauthRefresh?: { seq: number; accessToken: string };
  url?: string;
  capabilities: Capability[];
  warnings: IntrospectionWarning[];
  trace: TraceEvent[];
  seq: number;
  /** replay correlationId -> the correlationId of the call it was replayed from (S2). */
  replays: Record<string, string>;
  /** Roots offered to the server when it asks roots/list (S3; configured on the request, editable while connected). */
  roots: { name?: string; uri: string }[];
  /** Headers of the last connect, reused when a call is replayed over another protocol version (S3). */
  headerRecord?: Record<string, string>;
  /** Tasks (S4): created by a tools/call that returned a task handle, then polled until terminal. */
  tasks: Map<string, TrackedTask>;
  taskTimers: Map<string, ReturnType<typeof setTimeout>>;
  taskIntervals: Map<string, number>;
  /** correlationId of a tasks/get|update|cancel call we issued -> the task it concerns. */
  taskCalls: Map<string, string>;
  /** The active `subscriptions/listen` stream, if any (S4). One at a time in this prototype. */
  subscription?: SubscriptionView;
}

const MAX_TRACE_EVENTS = 5000;
const sessions = new Map<string, Session>();

const sessionFor = (requestId: string): Session => {
  let s = sessions.get(requestId);
  if (!s) {
    s = { protocol: new MCPHTTPProtocol(), status: 'disconnected', capabilities: [], warnings: [], trace: [], seq: 0, replays: {}, roots: [], tasks: new Map(), taskTimers: new Map(), taskIntervals: new Map(), taskCalls: new Map(), subscription: undefined };
    sessions.set(requestId, s);
  }
  return s;
};

const sinkFor = (s: Session) => (event: TraceEvent) => {
  // Event ids repeat across rounds of one call (e.g. a second input_required), so make them unique per event.
  s.trace.push({ ...event, id: `${event.id}~${s.seq + 1}`, sequence: ++s.seq });
  observeTaskEvent(s, event);
  observeSubscriptionEvent(s, event);
  if (s.trace.length > MAX_TRACE_EVENTS) {
    s.trace.splice(0, s.trace.length - MAX_TRACE_EVENTS);
  }
};

// ---------- OAuth in the trace (S5) ----------
// Every OAuth call (discovery probes, registration, the browser redirect, token, refresh, the verifying MCP call) is its
// own Call in the trace, so each request and response is inspectable, tagged `flow: 'oauth'`. Credential headers are
// redacted at capture like every other event; bodies are shown as-is (the wizard shows the tokens in full anyway).
let oauthCallSeq = 0;
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? '?…' : '');
  } catch {
    return url;
  }
};

export const oauthTraceFor = (requestId: string, replayOf?: string): OAuthTrace => (label, request) => {
  const s = sessionFor(requestId);
  const sink = sinkFor(s);
  const correlationId = `oauth-${++oauthCallSeq}`;
  if (replayOf) {
    s.replays[correlationId] = replayOf;
  }
  const rowLabel = `${label} · ${request.method} ${pathOf(request.url)}`;
  const base = { sequence: 0, correlationId, protocol: 'mcp', flow: 'oauth' as const, label: rowLabel };
  sink({
    ...base,
    id: `evt-${correlationId}-req`,
    direction: 'client-to-server',
    messageType: 'request',
    timestamp: new Date().toISOString(),
    payload: { method: request.method, url: request.url, ...(request.body === undefined ? {} : { body: request.body }) },
    rendererKey: 'oauth:request',
    awaitsReply: true,
    ...(Object.keys(request.headers).length > 0 ? { requestHeaders: redactCredentialHeaders(request.headers) } : {}),
  });
  const reply = (event: Pick<TraceEvent, 'messageType' | 'payload' | 'terminalStatus'> & Partial<TraceEvent>) =>
    sink({
      ...base,
      id: `evt-${correlationId}-reply`,
      direction: 'server-to-client',
      timestamp: new Date().toISOString(),
      rendererKey: 'oauth:response',
      ...event,
    });
  return {
    end: (ex: OAuthExchange) => {
      if (ex.error || !ex.response) {
        reply({ messageType: 'error', payload: { error: ex.error ?? 'No response' }, terminalStatus: 'error' });
        return;
      }
      reply({
        messageType: 'response',
        payload: { status: ex.response.status, ...(ex.response.body === undefined ? {} : { body: ex.response.body }) },
        terminalStatus: ex.response.status < 400 ? 'success' : 'error',
        responseHeaders: redactCredentialHeaders(ex.response.headers),
        httpStatus: ex.response.status,
      });
    },
    redirect: (params, ok) =>
      reply({ messageType: 'redirect', payload: { redirected_to_loopback: params }, terminalStatus: ok ? 'success' : 'error' }),
    fail: (status, message) => reply({ messageType: 'error', payload: { error: message }, terminalStatus: status }),
  };
};

/**
 * S5d: send an edited copy of an OAuth call (any method, url, headers, body) and show the reply as a new OAuth Call linked
 * to the original, so the existing request/response diff compares them. It goes through `exchange()` with the trace tap, so
 * it is captured exactly like the wizard's own calls. Credential headers the trace redacted (`<redacted>`) are filled in
 * from the token the wizard holds (Authorization) or dropped, so replaying the verify call works without leaking the token.
 */
export const replayOAuthCall = async ({
  requestId,
  replayOf,
  label,
  method,
  url,
  headers,
  body,
}: {
  requestId: string;
  replayOf: string;
  label: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}): Promise<{ correlationId?: string; error?: string }> => {
  if (!/^https?:\/\//i.test(url)) {
    return { error: 'The URL must start with http:// or https://' };
  }
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== REDACTED) {
      sent[name] = value;
    } else if (name.toLowerCase() === 'authorization') {
      const token = currentAccessToken(requestId);
      if (token) {
        sent[name] = `Bearer ${token}`;
      }
    }
  }
  const trace = oauthTraceFor(requestId, replayOf);
  let correlationId: string | undefined;
  const tap: OAuthTrace = (l, r) => {
    const handle = trace(l, r);
    correlationId = `oauth-${oauthCallSeq}`;
    return handle;
  };
  await exchange(method, url, sent, body, { trace: tap, label });
  return { correlationId };
};

// HTTP statuses a server returns to a handshake it does not understand (e.g. `initialize` sent to a stateless server).
const HANDSHAKE_MISMATCH_STATUSES = new Set([400, 404, 405, 406]);

/**
 * A protocol mismatch is either an explicit version-mismatch error or, for a pinned version, a handshake the server
 * rejected as unintelligible. 401/403 and everything else stay trace-only.
 */
const protocolIssueOf = (err: unknown, url: string, versionChoice?: string): string | undefined => {
  if (!isProtocolException(err)) {
    return undefined;
  }
  const pinned = isVersionChoice(versionChoice) && versionChoice !== 'auto' ? versionChoice : undefined;
  const e = err.error as { kind: string; status?: number };
  const mismatch =
    e.kind === 'protocol-version-mismatch' ||
    (pinned !== undefined && e.kind === 'transport' && e.status !== undefined && HANDSHAKE_MISMATCH_STATUSES.has(e.status));
  if (!mismatch) {
    return undefined;
  }
  return pinned
    ? `The MCP server ${url} does not support protocol ${pinned}.`
    : `The MCP server ${url} does not support any protocol version Insomnia supports.`;
};

/** A 401 whose WWW-Authenticate offers Bearer: the sign that the server is OAuth-protected. */
export const isOAuthChallenge = (err: unknown): boolean => {
  if (!isProtocolException(err)) {
    return false;
  }
  const e = err.error as { kind: string; status?: number; wwwAuthenticate?: string };
  return e.kind === 'auth' && e.status === 401 && /\bbearer\b/i.test(e.wwwAuthenticate ?? '');
};

/** Server-initiated requests the UI answers by hand. */
const HELD_PEER_METHODS = new Set(['sampling/createMessage', 'elicitation/create']);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface McpDebuggerConnectOptions {
  requestId: string;
  url: string;
  /** Already template-rendered, auth headers included (the renderer reuses the existing connect-param rendering). */
  headers: { name: string; value: string; disabled?: boolean }[];
  protocolVersion?: string;
  /** Roots to offer when the server asks (session-era versions). */
  roots?: { name?: string; uri: string }[];
}

export interface McpDebuggerState {
  status: McpDebuggerStatus;
  error?: string;
  /** Set only when the failure is a protocol mismatch; the UI shows a banner for it. Every other failure is trace-only. */
  protocolIssue?: string;
  /** The URL of the last connect attempt (after template rendering). */
  url?: string;
  protocolVersion?: string;
  serverName?: string;
  capabilities: Capability[];
  warnings: IntrospectionWarning[];
  lastSequence: number;
  replays: Record<string, string>;
  tasks: TaskView[];
  subscription?: SubscriptionView;
  /** The last connect failed with a 401 Bearer challenge, so the server probably wants OAuth (UI offers discovery). */
  oauthRequired?: boolean;
  /** A token Insomnia refreshed on this connection (S5): bumps `seq` so the UI can write it to the Auth tab. */
  oauthRefresh?: { seq: number; accessToken: string };
}

export const getState = ({ requestId }: { requestId: string }): McpDebuggerState => {
  const s = sessionFor(requestId);
  return {
    status: s.status,
    error: s.error,
    protocolIssue: s.protocolIssue,
    url: s.url,
    protocolVersion: s.conn?.protocolVersion,
    serverName: s.conn?.serverName,
    capabilities: s.capabilities,
    warnings: s.warnings,
    lastSequence: s.seq,
    replays: s.replays,
    subscription: s.subscription,
    oauthRequired: s.oauthRequired,
    oauthRefresh: s.oauthRefresh,
    tasks: [...s.tasks.values()].map(t => ({
      ...t,
      polling: s.taskTimers.has(t.taskId),
    })),
  };
};

export const getTrace = ({ requestId, afterSequence = 0 }: { requestId: string; afterSequence?: number }) =>
  sessionFor(requestId).trace.filter(e => e.sequence > afterSequence);

export const clearTrace = ({ requestId }: { requestId: string }) => {
  const s = sessionFor(requestId);
  s.trace = [];
  s.replays = {};
};

// ---------- OAuth token upkeep (S5) ----------
// When the connection's Authorization header carries a token the OAuth wizard issued, Insomnia keeps it alive: it
// refreshes an expired token before Connect, and after a call fails with 401 it refreshes and retries once. Every step
// shows in the trace (the refresh as OAuth calls, the retry as a replay of the failed call). An Authorization header
// the user set by hand is never touched. Concurrent 401s share one refresh.
const refreshLocks = new Map<string, Promise<boolean>>();

const refreshHeaderToken = (requestId: string, s: Session): Promise<boolean> => {
  const inflight = refreshLocks.get(requestId);
  if (inflight) {
    return inflight;
  }
  const attempt = (async () => {
    const headers = s.headerRecord;
    const key = headers && Object.keys(headers).find(name => name.toLowerCase() === 'authorization');
    if (!headers || !key) {
      return false;
    }
    const token = headers[key].replace(/^Bearer\s+/i, '');
    if (!ownsAccessToken(requestId, token)) {
      return false;
    }
    let next = currentAccessToken(requestId);
    if (next === token) {
      // The header holds the newest token and it was refused or has expired: really refresh.
      if (!canRefresh(requestId)) {
        return false;
      }
      const steps = await refreshToken({ requestId, trace: oauthTraceFor(requestId) });
      if (steps[0]?.status === 'error') {
        return false;
      }
      next = currentAccessToken(requestId);
    }
    if (!next) {
      return false;
    }
    headers[key] = `Bearer ${next}`;
    s.oauthRefresh = { seq: (s.oauthRefresh?.seq ?? 0) + 1, accessToken: next };
    return true;
  })().finally(() => refreshLocks.delete(requestId));
  refreshLocks.set(requestId, attempt);
  return attempt;
};

export const connect = async (options: McpDebuggerConnectOptions): Promise<McpDebuggerState> => {
  const { requestId, url, headers } = options;
  const s = sessionFor(requestId);
  if (s.status === 'connecting') {
    return getState({ requestId });
  }
  s.abort?.abort();
  s.abort = new AbortController();
  s.status = 'connecting';
  s.error = undefined;
  s.protocolIssue = undefined;
  s.oauthRequired = false;
  s.url = url;
  void closeAlts(requestId);
  clearTasks(s);
  s.subscription = undefined;
  s.roots = (options.roots ?? []).filter(r => r.uri);
  s.capabilities = [];
  s.warnings = [];
  const sink = sinkFor(s);
  const headerRecord = Object.fromEntries(headers.filter(h => !h.disabled && h.name).map(h => [h.name, h.value]));
  s.headerRecord = headerRecord;
  // A token the wizard issued that has already expired: refresh it first (visible as OAuth calls) so Connect just works.
  if (s.headerRecord && isExpired(requestId, 1000)) {
    await refreshHeaderToken(requestId, s);
  }
  const config: MCPConnectConfig = {
    url,
    authMode: 'none', // auth is already folded into `headers` by the renderer
    getRequestHeaders: () => headerRecord,
    protocolVersion: isVersionChoice(options.protocolVersion) ? options.protocolVersion : 'auto',
  };
  try {
    s.conn = await s.protocol.connect(config, s.abort.signal, sink);
    const conn = s.conn;
    // S3: roots are answered from the configured list; sampling and elicitation are held until the UI answers
    // (respondPeerRequest). Anything else keeps the protocol's automatic -32601.
    s.protocol.setPeerRequestHandler(conn, request => {
      if (request.method === 'roots/list') {
        queueMicrotask(() =>
          void s.protocol
            .respondToPeerRequest(conn, request.correlationId, { result: { roots: s.roots } }, sink)
            .catch(err => console.warn('[mcp-debugger] roots reply failed', err)),
        );
        return true;
      }
      return HELD_PEER_METHODS.has(request.method);
    });
    const result = await s.protocol.introspect(s.conn, s.abort.signal, sink);
    s.capabilities = result.capabilities;
    s.warnings = result.warnings;
    s.status = 'connected';
  } catch (err) {
    s.status = 'error';
    s.error = isProtocolException(err) ? err.message : messageOf(err);
    s.protocolIssue = protocolIssueOf(err, url, options.protocolVersion);
    s.oauthRequired = isOAuthChallenge(err);
    s.conn = undefined;
  }
  return getState({ requestId });
};

export const disconnect = async ({ requestId }: { requestId: string }): Promise<McpDebuggerState> => {
  const s = sessionFor(requestId);
  await closeAlts(requestId);
  clearTasks(s);
  s.subscription = undefined;
  if (s.conn) {
    try {
      await s.protocol.disconnect(s.conn, sinkFor(s));
    } catch (err) {
      console.warn('[mcp-debugger] disconnect failed', err);
    }
  }
  s.abort?.abort();
  s.conn = undefined;
  s.status = 'disconnected';
  return getState({ requestId });
};

/** Returns the new call's correlationId (captured from its request event, which is emitted synchronously). */
const run = (requestId: string, invocation: MCPInvocation, replayOf?: string, isRetry = false): { correlationId: string } => {
  const s = sessionFor(requestId);
  if (!s.conn || s.status !== 'connected') {
    throw new Error('Not connected');
  }
  const base = sinkFor(s);
  let correlationId = '';
  const sink = (event: TraceEvent) => {
    if (!correlationId && event.direction === 'client-to-server' && event.awaitsReply) {
      correlationId = event.correlationId;
      if (replayOf) {
        s.replays[correlationId] = replayOf;
      }
    }
    base(event);
    // A 401 on a call that carried a wizard-issued token: refresh it and retry once (not for hand-built exact headers).
    const payload = event.payload as { kind?: string; status?: number } | undefined;
    if (
      !isRetry &&
      !invocation.exact &&
      event.correlationId === correlationId &&
      event.direction === 'server-to-client' &&
      event.terminalStatus === 'error' &&
      payload?.kind === 'auth' &&
      payload.status === 401
    ) {
      void refreshHeaderToken(requestId, s)
        .then(refreshed => (refreshed ? run(requestId, invocation, correlationId, true) : undefined))
        .catch(err => console.warn('[mcp-debugger] refresh and retry failed', err));
    }
  };
  // Fire and forget: progress and the terminal result arrive through the trace. `invoke` traces its own errors.
  void s.protocol.invoke(s.conn, invocation, s.abort?.signal, sink).catch(err => console.warn('[mcp-debugger] invoke failed', err));
  return { correlationId };
};

export const invokeCapability = ({
  requestId,
  capability,
  args,
}: {
  requestId: string;
  capability: Capability;
  args: Record<string, unknown>;
}) => run(requestId, sessionFor(requestId).protocol.buildInvocation(capability, args));

/** Send any JSON-RPC method + params (the raw path S2's edit-and-replay builds on). */
export const invokeRaw = ({
  requestId,
  invocation,
  replayOf,
  exactHeaders,
}: {
  requestId: string;
  invocation: Invocation;
  /** correlationId of the trace call this edits and replays, if any. */
  replayOf?: string;
  /** Send exactly `invocation.params` with exactly these headers (no protocol-managed `_meta` or headers added). */
  exactHeaders?: Record<string, string>;
}) => run(requestId, exactHeaders ? { ...invocation, exact: { headers: exactHeaders } } : invocation, replayOf);

/**
 * S7a: send one call and RESOLVE its outcome (unlike `invokeRaw`, whose result only arrives in the trace). Built for MCP
 * Apps: the app asks the host to call a tool or read a resource and needs the answer back. Traced like any other call.
 */
export const relay = async ({
  requestId,
  invocation,
}: {
  requestId: string;
  invocation: Invocation;
}): Promise<{ result?: unknown; error?: { code?: number; message: string; data?: unknown } }> => {
  const s = sessionFor(requestId);
  if (!s.conn || s.status !== 'connected') {
    return { error: { message: 'Not connected' } };
  }
  try {
    return { result: await s.protocol.relayCall!(s.conn, invocation, s.abort?.signal, sinkFor(s)) };
  } catch (err) {
    if (isProtocolException(err)) {
      const e = err.error as { message?: string; code?: number; data?: unknown };
      return { error: { message: e.message ?? messageOf(err), code: e.code, data: e.data } };
    }
    return { error: { message: messageOf(err) } };
  }
};

export const cancel = ({ requestId, correlationId }: { requestId: string; correlationId: string }) => {
  const alt = parseAltCorrelation(correlationId);
  if (alt) {
    const entry = alts.get(`${requestId}|${alt.version}`);
    if (entry) {
      entry.protocol.cancel(entry.conn, alt.id, 'Cancelled by user');
    }
    return;
  }
  const s = sessionFor(requestId);
  if (s.conn) {
    s.protocol.cancel(s.conn, correlationId, 'Cancelled by user');
  }
};

/** Answer a held server-initiated request (sampling / elicitation) with a result or a JSON-RPC error. */
export const respondPeerRequest = async ({
  requestId,
  correlationId,
  result,
  error,
}: {
  requestId: string;
  correlationId: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}) => {
  const s = sessionFor(requestId);
  if (!s.conn) {
    throw new Error('Not connected');
  }
  await s.protocol.respondToPeerRequest(s.conn, correlationId, error ? { error } : { result }, sinkFor(s));
};

/** Update the roots offered to the server and tell it they changed (notifications/roots/list_changed). */
export const setRoots = async ({
  requestId,
  roots,
}: {
  requestId: string;
  roots: { name?: string; uri: string }[];
}) => {
  const s = sessionFor(requestId);
  s.roots = roots.filter(r => r.uri);
  if (s.conn && s.status === 'connected') {
    await s.protocol.notify(s.conn, 'notifications/roots/list_changed');
  }
};

// ---------- tasks (S4) ----------
// `io.modelcontextprotocol/tasks`: a tools/call may return a task handle (resultType "task"). The service tracks the
// task, polls tasks/get on a timer until it is terminal (stopping while input_required, resuming after tasks/update),
// and settles the originating call's trace row from the task's final status, as Ardi's UI did.
// Ported from Ardi's taskPoller.ts + useTaskStore.ts, folded into one main-process tracker.

export interface TrackedTask extends TaskRecord {
  /** The trace correlationId of the tools/call that created the task. */
  correlationId: string;
  result?: unknown;
  error?: unknown;
  paused: boolean;
}
export interface TaskView extends TrackedTask {
  /** A poll is scheduled. */
  polling: boolean;
}

// Poll cadence: servers advertise pollIntervalMs; clamp it, and back off while the status does not change. Mutable so
// tests can run it fast.
export const taskPollConfig = { minMs: 2000, defaultMs: 3000, maxMs: 30_000, backoff: 1.5 };

// -32602 (invalid/unknown/expired taskId) and -32003 (tasks capability missing) are fatal to polling.
const FATAL_TASK_ERROR_CODES = new Set([-32_602, -32_003]);
const taskTrace = traceEventsFor('mcp-http');

const clampPoll = (ms: number) => Math.min(Math.max(ms, taskPollConfig.minMs), taskPollConfig.maxMs);

const stopTaskTimer = (s: Session, taskId: string) => {
  const timer = s.taskTimers.get(taskId);
  if (timer) {
    clearTimeout(timer);
  }
  s.taskTimers.delete(taskId);
};

function clearTasks(s: Session) {
  for (const timer of s.taskTimers.values()) {
    clearTimeout(timer);
  }
  s.taskTimers.clear();
  s.taskIntervals.clear();
  s.taskCalls.clear();
  s.tasks.clear();
}

/** Issue a tasks/* call, remembering which task its reply belongs to. */
function callTaskMethod(s: Session, taskId: string, invocation: Invocation) {
  if (!s.conn || s.status !== 'connected') {
    return;
  }
  const base = sinkFor(s);
  let seen = false;
  const sink = (event: TraceEvent) => {
    if (!seen && event.direction === 'client-to-server' && event.awaitsReply) {
      seen = true;
      s.taskCalls.set(event.correlationId, taskId);
    }
    base(event);
  };
  void s.protocol
    .invoke(s.conn, invocation, s.abort?.signal, sink)
    .catch(err => console.warn('[mcp-debugger] task call failed', err));
}

function scheduleTaskPoll(s: Session, taskId: string, restart = false) {
  const task = s.tasks.get(taskId);
  stopTaskTimer(s, taskId);
  if (!task || task.paused || isTaskTerminal(task.status) || task.status === 'input_required') {
    return;
  }
  const base = clampPoll(task.pollIntervalMs ?? taskPollConfig.defaultMs);
  const previous = s.taskIntervals.get(taskId);
  const interval = restart || previous === undefined ? base : Math.min(previous * taskPollConfig.backoff, taskPollConfig.maxMs);
  s.taskIntervals.set(taskId, interval);
  s.taskTimers.set(
    taskId,
    setTimeout(() => {
      s.taskTimers.delete(taskId);
      callTaskMethod(s, taskId, buildTasksGet(taskId));
    }, interval),
  );
}

/** Settle the originating tools/call row from the task's final status. */
function settleTaskCall(s: Session, task: TrackedTask) {
  const sink = sinkFor(s);
  if (task.status === 'completed') {
    sink(taskTrace.response(task.correlationId, { taskId: task.taskId, status: 'completed', result: task.result }));
  } else if (task.status === 'cancelled') {
    sink(taskTrace.cancelled(task.correlationId, 'Task cancelled'));
  } else {
    const error = (task.error ?? {}) as { code?: number; message?: string };
    sink(
      taskTrace.error(task.correlationId, {
        kind: 'task',
        message: error.message ?? task.statusMessage ?? 'Task failed',
        ...(error.code === undefined ? {} : { code: error.code }),
      }),
    );
  }
}

function applyTaskReply(s: Session, taskId: string, payload: unknown) {
  const existing = s.tasks.get(taskId);
  const parsed = parseTaskHandle(payload);
  if (!existing || !parsed || isTaskTerminal(existing.status)) {
    return; // a task never leaves a terminal status
  }
  const extra = payload as { result?: unknown; error?: unknown };
  const statusChanged = parsed.status !== existing.status;
  const next: TrackedTask = {
    ...existing,
    ...parsed,
    result: extra.result ?? existing.result,
    error: extra.error ?? existing.error,
  };
  s.tasks.set(taskId, next);
  if (isTaskTerminal(next.status)) {
    stopTaskTimer(s, taskId);
    settleTaskCall(s, next);
  } else {
    scheduleTaskPoll(s, taskId, statusChanged);
  }
}

function failTask(s: Session, taskId: string, error: { code?: number; message?: string }) {
  const existing = s.tasks.get(taskId);
  if (!existing || isTaskTerminal(existing.status)) {
    return;
  }
  stopTaskTimer(s, taskId);
  const next: TrackedTask = { ...existing, status: 'failed', error };
  s.tasks.set(taskId, next);
  settleTaskCall(s, next);
}

/** Called for every trace event of a session: picks up task handles and the replies to our task calls. */
function observeTaskEvent(s: Session, event: TraceEvent) {
  if (event.messageType === 'task') {
    const handle = parseTaskHandle(event.payload);
    if (handle && !s.tasks.has(handle.taskId)) {
      s.tasks.set(handle.taskId, { ...handle, correlationId: event.correlationId, paused: false });
      scheduleTaskPoll(s, handle.taskId, true);
    }
    return;
  }
  const taskId = s.taskCalls.get(event.correlationId);
  if (!taskId || event.direction !== 'server-to-client') {
    return;
  }
  if (event.messageType === 'response') {
    applyTaskReply(s, taskId, event.payload);
  } else if (event.messageType === 'error') {
    const payload = event.payload as { code?: number; message?: string };
    if (payload.code !== undefined && FATAL_TASK_ERROR_CODES.has(payload.code)) {
      failTask(s, taskId, payload);
    }
  }
}

export const taskAction = ({
  requestId,
  taskId,
  action,
  inputs,
}: {
  requestId: string;
  taskId: string;
  action: 'pause' | 'resume' | 'refresh' | 'cancel' | 'update';
  /** For `update`: the answers, keyed like the task's inputRequests. */
  inputs?: Record<string, unknown>;
}) => {
  const s = sessionFor(requestId);
  const task = s.tasks.get(taskId);
  if (!task) {
    throw new Error('Unknown task');
  }
  switch (action) {
    case 'pause': {
      task.paused = true;
      stopTaskTimer(s, taskId);
      break;
    }
    case 'resume': {
      task.paused = false;
      callTaskMethod(s, taskId, buildTasksGet(taskId));
      break;
    }
    case 'refresh': {
      callTaskMethod(s, taskId, buildTasksGet(taskId));
      break;
    }
    case 'cancel': {
      callTaskMethod(s, taskId, buildTasksCancel(taskId));
      break;
    }
    case 'update': {
      // Answering input_required: send tasks/update, then poll again (polling stops while input is pending).
      task.paused = false;
      callTaskMethod(s, taskId, buildTasksUpdate(taskId, { inputs: inputs ?? {} }));
      break;
    }
    default: {
      break;
    }
  }
};

// ---------- subscriptions (S4) ----------
// `subscriptions/listen` (2026-07-28): a POST whose response is a long-lived SSE stream of the change notifications the
// client opted in to. The first message is `notifications/subscriptions/acknowledged` naming the subset the server
// agreed to; every notification after it carries `_meta["io.modelcontextprotocol/subscriptionId"]`. Closing the stream
// ends the subscription. Not in Ardi (it only mentions the method in comments), so this is new work against the spec.

export interface SubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
}
export interface SubscriptionView {
  /** The trace correlationId of the listen call. */
  correlationId: string;
  requested: SubscriptionFilter;
  /** What the server agreed to (from the acknowledgement); undefined until it arrives. */
  acknowledged?: SubscriptionFilter;
  subscriptionId?: string | number;
  status: 'subscribing' | 'active' | 'ended' | 'cancelled' | 'error';
}

const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId';
const ACK_METHOD = 'notifications/subscriptions/acknowledged';

function observeSubscriptionEvent(s: Session, event: TraceEvent) {
  const sub = s.subscription;
  if (!sub) {
    return;
  }
  const payload = event.payload as { method?: string; params?: { _meta?: Record<string, unknown>; notifications?: SubscriptionFilter } };
  if (event.messageType === 'notification' && payload?.method === ACK_METHOD) {
    s.subscription = {
      ...sub,
      acknowledged: payload.params?.notifications ?? {},
      subscriptionId: payload.params?._meta?.[SUBSCRIPTION_ID_KEY] as string | number | undefined,
      status: 'active',
    };
    return;
  }
  if (event.correlationId === sub.correlationId && event.terminalStatus) {
    const status = event.terminalStatus === 'success' ? 'ended' : event.terminalStatus === 'cancelled' ? 'cancelled' : 'error';
    s.subscription = { ...sub, status };
  }
}

export const subscribe = ({ requestId, notifications }: { requestId: string; notifications: SubscriptionFilter }) => {
  const s = sessionFor(requestId);
  if (s.subscription && (s.subscription.status === 'subscribing' || s.subscription.status === 'active')) {
    throw new Error('Already subscribed. Stop the current subscription first.');
  }
  const { correlationId } = run(requestId, {
    method: 'subscriptions/listen',
    params: { notifications },
    longLived: true,
  });
  s.subscription = { correlationId, requested: notifications, status: 'subscribing' };
};

export const unsubscribe = ({ requestId }: { requestId: string }) => {
  const s = sessionFor(requestId);
  if (s.conn && s.subscription) {
    s.protocol.cancel(s.conn, s.subscription.correlationId, 'Unsubscribed');
  }
};

// ---------- cross-version replay (S3) ----------
// A call is replayed over a second, temporary connection to the same server pinned to another protocol version. Its
// events are folded into the main session's trace (correlationId `xv-<version>-<id>`, `via` set) and linked to the
// original with `replays`, so the existing diff and replay UI work unchanged.
// PROTOTYPE-MOCK: the second connection offers no sampling/elicitation/roots (the protocol auto-rejects those) and
// is not introspected; it lives until the main session disconnects or reconnects.

interface AltSession {
  protocol: MCPHTTPProtocol;
  conn: Connection;
  abort: AbortController;
}
const alts = new Map<string, AltSession>();

const parseAltCorrelation = (correlationId: string) => {
  const match = /^xv-(\d{4}-\d{2}-\d{2})-(.+)$/.exec(correlationId);
  return match ? { version: match[1], id: match[2] } : null;
};

const closeAlts = async (requestId: string) => {
  for (const [key, alt] of alts) {
    if (key.startsWith(`${requestId}|`)) {
      alts.delete(key);
      alt.abort.abort();
      await alt.protocol.disconnect(alt.conn).catch(() => {});
    }
  }
};

const withoutMeta = (params: unknown) => {
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const { _meta, ...rest } = params as Record<string, unknown>;
    return rest;
  }
  return params;
};

export const replayOnVersion = async ({
  requestId,
  invocation,
  version,
  replayOf,
}: {
  requestId: string;
  invocation: Invocation;
  version: string;
  replayOf: string;
}): Promise<{ correlationId?: string; error?: string }> => {
  const base = sessionFor(requestId);
  if (!base.url || !base.headerRecord) {
    return { error: 'Connect first' };
  }
  if (!isVersionChoice(version) || version === 'auto') {
    return { error: `Unknown protocol version ${version}` };
  }
  const headerRecord = base.headerRecord;
  const prefix = `xv-${version}-`;
  const forward = (event: TraceEvent) => {
    base.trace.push({
      ...event,
      id: `${prefix}${event.id}`,
      correlationId: `${prefix}${event.correlationId}`,
      sequence: ++base.seq,
      via: version,
    });
  };

  const key = `${requestId}|${version}`;
  let alt = alts.get(key);
  if (!alt) {
    const protocol = new MCPHTTPProtocol();
    const abort = new AbortController();
    const handshake: TraceEvent[] = [];
    try {
      const conn = await protocol.connect(
        { url: base.url, authMode: 'none', getRequestHeaders: () => headerRecord, protocolVersion: version },
        abort.signal,
        event => handshake.push(event),
      );
      alt = { protocol, conn, abort };
      alts.set(key, alt);
    } catch (err) {
      // Show why the other version could not be reached right in the trace.
      handshake.forEach(forward);
      return { error: protocolIssueOf(err, base.url, version) ?? messageOf(err) };
    }
  }

  let correlationId = '';
  const sink = (event: TraceEvent) => {
    if (!correlationId && event.direction === 'client-to-server' && event.awaitsReply) {
      correlationId = `${prefix}${event.correlationId}`;
      base.replays[correlationId] = replayOf;
    }
    forward(event);
  };
  void alt.protocol
    .invoke(alt.conn, { method: invocation.method, params: withoutMeta(invocation.params) }, alt.abort.signal, sink)
    .catch(err => console.warn('[mcp-debugger] cross-version invoke failed', err));
  return { correlationId };
};

export const closeAll = () => {
  for (const requestId of sessions.keys()) {
    void disconnect({ requestId });
  }
};
