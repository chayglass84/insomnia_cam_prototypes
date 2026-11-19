import { isProtocolException } from '~/common/mcp-debugger/protocol/errors';
import type { MCPInvocation } from '~/common/mcp-debugger/protocol/mcp/capabilities/methods';
import { type MCPConnectConfig,MCPHTTPProtocol } from '~/common/mcp-debugger/protocol/mcp/MCPHTTPProtocol';
import type { Capability, Connection, IntrospectionWarning,Invocation } from '~/common/mcp-debugger/protocol/Protocol';
import type { TraceEvent } from '~/common/mcp-debugger/protocol/TraceEvent';
import { isVersionChoice } from '~/common/mcp-debugger/versions';

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
}

const MAX_TRACE_EVENTS = 5000;
const sessions = new Map<string, Session>();

const sessionFor = (requestId: string): Session => {
  let s = sessions.get(requestId);
  if (!s) {
    s = { protocol: new MCPHTTPProtocol(), status: 'disconnected', capabilities: [], warnings: [], trace: [], seq: 0, replays: {}, roots: [] };
    sessions.set(requestId, s);
  }
  return s;
};

const sinkFor = (s: Session) => (event: TraceEvent) => {
  s.trace.push({ ...event, sequence: ++s.seq });
  if (s.trace.length > MAX_TRACE_EVENTS) {
    s.trace.splice(0, s.trace.length - MAX_TRACE_EVENTS);
  }
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
  };
};

export const getTrace = ({ requestId, afterSequence = 0 }: { requestId: string; afterSequence?: number }) =>
  sessionFor(requestId).trace.filter(e => e.sequence > afterSequence);

export const clearTrace = ({ requestId }: { requestId: string }) => {
  const s = sessionFor(requestId);
  s.trace = [];
  s.replays = {};
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
  s.url = url;
  void closeAlts(requestId);
  s.roots = (options.roots ?? []).filter(r => r.uri);
  s.capabilities = [];
  s.warnings = [];
  const sink = sinkFor(s);
  const headerRecord = Object.fromEntries(headers.filter(h => !h.disabled && h.name).map(h => [h.name, h.value]));
  s.headerRecord = headerRecord;
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
    s.conn = undefined;
  }
  return getState({ requestId });
};

export const disconnect = async ({ requestId }: { requestId: string }): Promise<McpDebuggerState> => {
  const s = sessionFor(requestId);
  await closeAlts(requestId);
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
const run = (requestId: string, invocation: MCPInvocation, replayOf?: string): { correlationId: string } => {
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
