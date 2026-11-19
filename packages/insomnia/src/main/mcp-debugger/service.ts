import { isProtocolException } from '~/common/mcp-debugger/protocol/errors';
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
  capabilities: Capability[];
  warnings: IntrospectionWarning[];
  trace: TraceEvent[];
  seq: number;
  /** replay correlationId -> the correlationId of the call it was replayed from (S2). */
  replays: Record<string, string>;
}

const MAX_TRACE_EVENTS = 5000;
const sessions = new Map<string, Session>();

const sessionFor = (requestId: string): Session => {
  let s = sessions.get(requestId);
  if (!s) {
    s = { protocol: new MCPHTTPProtocol(), status: 'disconnected', capabilities: [], warnings: [], trace: [], seq: 0, replays: {} };
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

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface McpDebuggerConnectOptions {
  requestId: string;
  url: string;
  /** Already template-rendered, auth headers included (the renderer reuses the existing connect-param rendering). */
  headers: { name: string; value: string; disabled?: boolean }[];
  protocolVersion?: string;
}

export interface McpDebuggerState {
  status: McpDebuggerStatus;
  error?: string;
  /** Set only when the failure is a protocol mismatch; the UI shows a banner for it. Every other failure is trace-only. */
  protocolIssue?: string;
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
  s.capabilities = [];
  s.warnings = [];
  const sink = sinkFor(s);
  const headerRecord = Object.fromEntries(headers.filter(h => !h.disabled && h.name).map(h => [h.name, h.value]));
  const config: MCPConnectConfig = {
    url,
    authMode: 'none', // auth is already folded into `headers` by the renderer
    getRequestHeaders: () => headerRecord,
    protocolVersion: isVersionChoice(options.protocolVersion) ? options.protocolVersion : 'auto',
  };
  try {
    s.conn = await s.protocol.connect(config, s.abort.signal, sink);
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
const run = (requestId: string, invocation: Invocation, replayOf?: string): { correlationId: string } => {
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
}: {
  requestId: string;
  invocation: Invocation;
  /** correlationId of the trace call this edits and replays, if any. */
  replayOf?: string;
}) => run(requestId, invocation, replayOf);

export const cancel = ({ requestId, correlationId }: { requestId: string; correlationId: string }) => {
  const s = sessionFor(requestId);
  if (s.conn) {
    s.protocol.cancel(s.conn, correlationId, 'Cancelled by user');
  }
};

export const closeAll = () => {
  for (const requestId of sessions.keys()) {
    void disconnect({ requestId });
  }
};
