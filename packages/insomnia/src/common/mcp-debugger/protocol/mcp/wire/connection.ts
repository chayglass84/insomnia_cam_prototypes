import { propagateAbort, timeoutSignal } from "../../lib/timeoutSignal";

import { protocolError } from "../../errors";
import {
  createIdGenerator,
  isJsonRpcLike,
  type JsonRpcEnvelope,
  PendingRequests,
} from "../../jsonrpc";
import type { Connection, ProtocolId, Routing } from "../../Protocol";
import type { TraceSink } from "../../TraceEvent";
import type { MessageMeta, MessageSink, SendOptions, Transport } from "../../Transport";
import type { DeclaredCapabilities } from "../introspect/introspect";
import type { TraceEventFactory } from "../traceEvents";
import { requestHeadersFor } from "../wireformat/headers";

/**
 * Timeout for fire-and-forget notifications (notifications/initialized,
 * notifications/cancelled, the -32601 reply to an unsupported peer request).
 * Shared by the wire substrate here and `MCPHTTPProtocol`'s best-effort sends.
 */
export const BEST_EFFORT_TIMEOUT_MS = 2_000;

/**
 * Timeout for the best-effort DELETE that tears down a server session — used by
 * `disconnect` (the class) and by `handshake.validateVersion` when it abandons a
 * version-mismatched session. Lives here with the other shared wire/teardown
 * timeouts so both the wire substrate and the handshake import one literal.
 */
export const DISCONNECT_DELETE_TIMEOUT_MS = 5_000;

/**
 * Placeholder transport for the connection scaffold built before negotiation
 * picks the real one. `negotiateAndInitialize` overwrites `conn.transport`
 * before the first send, so these throw only on a programming error.
 */
const UNSET_TRANSPORT: Transport = {
  kind: "http-streamable",
  send: () => Promise.reject(new Error("transport not yet established")),
  close: () => Promise.resolve(),
};

export type MCPConnection = Connection & {
  readonly url: string;
  /**
   * How this connection reaches its server, forwarded to every proxyFetch made
   * on its behalf (transports, handshake, session DELETE) so relay-routed
   * traffic rides the local socket and hosted traffic never does — the lookup
   * is per connection, never inferred from the target URL.
   */
  readonly routing?: Routing;
  readonly getRequestHeaders: () => Record<string, string>;
  readonly abort: AbortController;
  readonly pending: PendingRequests;
  /**
   * Per-request AbortControllers for cancellable in-flight invocations, keyed by
   * JSON-RPC request id. Only `invoke` registers here (introspect/connect do not),
   * so a request is user-cancellable iff it has an entry. `invoke` removes its entry
   * on settle; `cancel` aborts the controller to tear the request down.
   */
  readonly inflight: Map<number, AbortController>;
  // Set once the transport is built, and once the initialize reply lands. The
  // connection is populated in two phases during connect(): the wire-level
  // fields up front so inbound frames have somewhere to route, the negotiated
  // fields after initialize succeeds.
  transport: Transport;
  protocolVersion: string;
  capabilities: DeclaredCapabilities;
  sessionId: string | undefined;
  getNextId: () => number;
  nextServerEventId: () => number;
};

export function currentOrigin(): string | null {
  return typeof globalThis.location !== "undefined" ? globalThis.location.origin : null;
}

/** Build an AbortController that aborts when `parent` aborts (incl. a pre-aborted parent). */
export function chainAbort(parent?: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (parent) {
    const detach = propagateAbort(parent, ctrl);
    // If we abort for our own reason (disconnect/teardown) before `parent` fires,
    // drop the parent listener so it doesn't retain this controller for the
    // lifetime of a (possibly long-lived) caller signal.
    ctrl.signal.addEventListener("abort", detach, { once: true });
  }
  return ctrl;
}

/**
 * Run `fn` under a `ms`-millisecond timeout chained to `parent`. If the
 * timeout fires (vs the parent aborting for another reason), the thrown
 * AbortError is re-classified as a `connection-timeout` ProtocolException
 * naming `url`. Other errors propagate unchanged. Always clears the timer.
 */
export async function withTimeout<T>(
  parent: AbortSignal,
  ms: number,
  url: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = timeoutSignal(ms, parent);
  try {
    return await fn(timeout.signal);
  } catch (e) {
    if (timeout.timedOut()) {
      throw protocolError({
        kind: "connection-timeout",
        message: `Timed out after ${ms}ms reaching ${url}`,
        url,
        timeoutMs: ms,
      });
    }
    throw e;
  } finally {
    timeout.clear();
  }
}

/**
 * Build the connection scaffold before the transport exists, so the message
 * sink can close over it. `transport` is a placeholder that throws if used;
 * `negotiateAndInitialize` overwrites it with the real transport before the
 * first send. The negotiated fields start empty and are filled by `connect`
 * once initialize returns.
 */
export function newConnection(
  protocolId: ProtocolId,
  url: string,
  getRequestHeaders: () => Record<string, string>,
  abort: AbortController,
  routing?: Routing,
): MCPConnection {
  let nextServerEventCounter = 1;
  return {
    __brand: "Connection",
    protocolId,
    transport: UNSET_TRANSPORT,
    url,
    routing,
    getRequestHeaders,
    protocolVersion: "",
    capabilities: {},
    abort,
    pending: new PendingRequests(),
    inflight: new Map(),
    sessionId: undefined,
    // id 1 is reserved for the handshake; operations start at 2. Loads on
    // the legacy path only: `initialize` goes out as id 1 through PendingRequests,
    // so an operation reusing 1 while it is in flight would settle its waiter. The
    // stateless path has no `initialize` (2026-07-28 removes it) and its
    // `server/discover` probe never registers a waiter, so the gap is inert there.
    getNextId: createIdGenerator(2),
    nextServerEventId: () => nextServerEventCounter++,
  };
}

/** A settled JSON-RPC reply plus the transport metadata it arrived with. */
export type SettledReply = {
  envelope: JsonRpcEnvelope;
  responseHeaders?: Record<string, string>;
};

/**
 * Register a pending waiter for the matched-id reply, send the payload, and
 * await the reply. The transport's `onMessage` sink resolves the waiter (via
 * `handleMessage`) when the id-matched terminal frame arrives. Exported so
 * `introspect.ts` can share the same correlation path.
 */
export async function sendRequest(
  conn: MCPConnection,
  id: number,
  payload: unknown,
  opts: SendOptions = {},
): Promise<SettledReply> {
  const signal = opts.signal;
  return new Promise<SettledReply>((resolve, reject) => {
    // Cleanups run on whichever settle path fires first — including the normal
    // sink-resolve path, where the abort listener never fires and would
    // otherwise linger on a (long-lived) signal.
    const cleanups: Array<() => void> = [];
    const detach = () => {
      for (const c of cleanups) c();
      cleanups.length = 0;
    };
    conn.pending.register(id, {
      resolve: (v, meta) => {
        detach();
        resolve({ envelope: v, responseHeaders: meta?.responseHeaders });
      },
      reject: (e) => {
        detach();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    });
    const rejectWith = (e: unknown) => {
      detach();
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    if (signal) {
      const abortReason = () => {
        const reason: unknown = signal.reason;
        return reason instanceof Error ? reason : new Error("Request aborted");
      };
      if (signal.aborted) {
        conn.pending.delete(id);
        rejectWith(abortReason());
        return;
      }
      const onSignalAbort = () => {
        if (conn.pending.delete(id)) rejectWith(abortReason());
      };
      signal.addEventListener("abort", onSignalAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onSignalAbort));
    }

    conn.transport.send(payload, opts).catch((e: unknown) => {
      if (conn.pending.delete(id)) rejectWith(e);
    });
  });
}

/**
 * Route one inbound message from the transport's `onMessage` sink: a JSON-RPC
 * batch array is dispatched element by element; an id-matched `result`/`error`
 * resolves the corresponding pending waiter; an id + `method` frame is a
 * peer-initiated request (traced + rejected with -32601); a method-only frame
 * is a peer notification (traced as srv-N). The transport's `onMessage` sink
 * (wired by `connectionSink`) routes every inbound frame through here.
 */
function handleMessage(
  conn: MCPConnection,
  message: unknown,
  trace: TraceEventFactory,
  onTrace?: TraceSink,
  meta?: MessageMeta,
): void {
  // Legacy servers may answer a single request with a JSON-RPC batch array;
  // unwrap so each reply still reaches its waiter instead of being dropped.
  if (Array.isArray(message)) {
    for (const element of message) handleMessage(conn, element, trace, onTrace, meta);
    return;
  }
  if (!isJsonRpcLike(message)) return;
  const env = message;

  // Matched reply to an outstanding request
  if (env.id !== undefined && ("result" in env || "error" in env)) {
    conn.pending.settle(env, meta);
    return;
  }

  // Peer-initiated request → trace + reply via transport.send.
  if (env.id !== undefined && typeof env.method === "string") {
    // Namespace the trace correlationId (like serverNotification's `srv-N`) so a
    // server request id can't collide with the client's own JSON-RPC id-space —
    // otherwise the reply twin would flip an unrelated in-flight client request of
    // the same id. The wire reply below still echoes the real env.id.
    const correlationId = `srv-${conn.nextServerEventId()}`;
    onTrace?.(trace.serverRequest(correlationId, env.method, env.params));
    // Both replies are traced as the client's own outbound twin so the server
    // request doesn't read as unanswered.
    if (env.method === "ping") {
      // `ping` is the one server→client request every MCP client MUST answer with
      // an empty result, regardless of negotiated capabilities (spec: Ping).
      onTrace?.(trace.clientResponse(correlationId, {}));
      void sendPeerReply(conn, { jsonrpc: "2.0", id: env.id, result: {} });
    } else {
      // Every other peer request targets a capability this client never
      // advertised, so it's a JSON-RPC method-not-found.
      const message = `Method "${env.method}" is not supported by this client`;
      onTrace?.(trace.clientError(correlationId, { code: -32601, message }));
      void sendPeerReply(conn, { jsonrpc: "2.0", id: env.id, error: { code: -32601, message } });
    }
    return;
  }

  // Peer notification → trace as srv-N
  if (typeof env.method === "string") {
    onTrace?.(trace.serverNotification(`srv-${conn.nextServerEventId()}`, env.method, env.params));
  }
}

/**
 * Best-effort reply to a peer-initiated request — the empty result for a `ping`,
 * or the -32601 for a capability this client never advertised. Failing to reply
 * doesn't affect our own in-flight calls, so it's logged, not thrown.
 */
function sendPeerReply(conn: MCPConnection, reply: unknown): Promise<void> {
  return conn.transport
    .send(reply, {
      signal: AbortSignal.timeout(BEST_EFFORT_TIMEOUT_MS),
      headers: requestHeadersFor(conn),
    })
    .catch((e: unknown) => {
      console.warn("[mcp] failed to reply to peer request (non-fatal)", e);
    });
}

/**
 * The transport message sink bound to `conn`: `onMessage` dispatches inbound
 * frames via `handleMessage`; `onClose` fires when the transport's standing
 * inbound stream ends on its own (vs our own `disconnect`) — it trips
 * `conn.abort` and rejects the outstanding waiters so in-flight requests fail
 * fast instead of hanging to their per-call timeout, and the dead connection is
 * observable. Wired at transport construction. Exported so tests can wire a
 * connection built without going through `MCPHTTPProtocol.connect`.
 */
export function connectionSink(
  conn: MCPConnection,
  trace: TraceEventFactory,
  onTrace?: TraceSink,
): { onMessage: MessageSink; onClose: () => void } {
  return {
    onMessage: (message, meta) => handleMessage(conn, message, trace, onTrace, meta),
    onClose: () => {
      if (conn.abort.signal.aborted) return;
      conn.abort.abort(new DOMException("server closed the connection", "AbortError"));
      conn.pending.rejectAll(
        protocolError({ kind: "disconnected", message: "Connection closed by server" }),
      );
    },
  };
}
