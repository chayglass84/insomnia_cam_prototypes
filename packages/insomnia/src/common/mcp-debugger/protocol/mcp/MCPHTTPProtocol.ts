import { MCP_TASKS_PROXY_URL } from "../config";
import { timeoutSignal } from "../lib/timeoutSignal";

import {
  CancelledByUser,
  DisconnectError,
  isProtocolException,
  isServerReply,
  protocolError,
} from "../errors";
import { type JsonRpcEnvelope } from "../jsonrpc";
import type {
  Capability,
  ConnectConfig,
  Connection,
  IntrospectionResult,
  Invocation,
  Protocol,
  ProtocolId,
  RecordingKey,
  Routing,
} from "../Protocol";
import type { TraceEvent, TraceSink } from "../TraceEvent";
import { headersToRecord, HTTPTransport } from "../transports/HTTPTransport";
import { proxyFetch } from "../transports/proxyFetch";
import {
  capabilityKey as mcpCapabilityKey,
  invocationForCapability,
  type MCPInvocation,
  recordingKeyForEvent as mcpRecordingKeyForEvent,
  resultLevelError,
} from "./capabilities/methods";
import { parseInputRequired } from "./elicitation";
import { isStatelessConnection } from "./era";
import { introspect, type RpcCall } from "./introspect/introspect";
import {
  CONNECT_TIMEOUT_MS,
  discoverStateless,
  INITIALIZE_REQUEST,
  initializeParams,
  negotiateAndInitialize,
  validateVersion,
} from "./negotiate/handshake";
import { shouldFallBackToLegacy, STATELESS_VERSION } from "./negotiate/versions";
import { pickServerIcon } from "./serverIcon";
import { TASKS_CANCEL, TASKS_GET, TASKS_UPDATE } from "./tasks/taskMethods";
import { isTaskResult } from "./tasks/taskModel";
import { REDACTED, traceEventsFor } from "./traceEvents";
import { classifyFetchError } from "./wire/classify";
import {
  BEST_EFFORT_TIMEOUT_MS,
  chainAbort,
  connectionSink,
  currentOrigin,
  DISCONNECT_DELETE_TIMEOUT_MS,
  type MCPConnection,
  newConnection,
  type PeerOutcome,
  replyToPeerRequest,
  sendRequest,
  type SettledReply,
  withTimeout,
} from "./wire/connection";
import { notificationFrame, requestHeadersFor } from "./wireformat/headers";
import { withStatelessMeta } from "./wireformat/params";

/**
 * MCP-specific connect config: extends the base with a protocol version pin.
 * `"auto"` (default) probes `server/discover`; a specific version forces that
 * era with no fallback. Kept here rather than in the base `ConnectionOptions`
 * because version semantics are MCP-specific.
 */
export interface MCPConnectConfig extends ConnectConfig {
  protocolVersion?:
    | "auto"
    | "2026-07-28"
    | "2025-11-25"
    | "2025-06-18"
    | "2025-03-26"
    | "2024-11-05";
}

export { SUPPORTED_VERSIONS } from "./negotiate/versions";

/** 4348: trace payload for a failed handshake, including the HTTP status/body when the server replied. */
function failureTrace(failure: { error: { kind: string; message: string } }) {
  const e = failure.error as {
    kind: string;
    message: string;
    status?: number;
    httpBody?: string;
    httpResponseHeaders?: Record<string, string>;
  };
  return {
    payload: {
      kind: e.kind,
      message: e.message,
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.httpBody ? { body: e.httpBody } : {}),
    },
    responseHeaders: e.httpResponseHeaders,
  };
}

const INVOKE_TIMEOUT_MS = 30_000;
const INTROSPECT_TIMEOUT_MS = 30_000;

/**
 * Trace correlation ids for the two exchanges one connect can make. These MUST
 * stay distinct, for a reason the wire does not show.
 *
 * Both handshakes really do go out as JSON-RPC id 1 (`handshake.ts`), and that
 * is spec-legal: an id "MUST NOT match the ID of any other request the sender
 * has issued and not yet received a response for" — uniqueness among in-flight
 * requests only, and the probe always settles before `initialize` is issued.
 * The trace is what needs more: it groups by (connection, session,
 * correlationId), which assumes an id is unique for the life of a connection.
 * So on "auto" — probe fails, `initialize` retries — one shared id folds both
 * exchanges into a single call whose request is the probe and whose terminal
 * frame is the probe's error, hiding the initialize that succeeded.
 *
 * The probe is named rather than numbered for the same reason `srv-N` is: it
 * stays out of the wire id-space the trace cannot disambiguate. Nothing is
 * lost by not mirroring its wire id — that id is inert (`discoverStateless`
 * reads the HTTP response body directly and never correlates on it), and
 * 2026-07-28 removes `initialize` outright, so the RC path has no handshake
 * slot to mirror in the first place.
 *
 * `initialize` keeps "1": that is its real wire id, the slot
 * `createIdGenerator(2)` reserves by starting operations at 2, and the id old
 * shared snapshots were written with.
 */
const DISCOVER_CORRELATION_ID = "discover";
const INITIALIZE_CORRELATION_ID = "1";

export class MCPHTTPProtocol implements Protocol<MCPConnectConfig> {
  readonly id: ProtocolId = "mcp-http";
  private readonly trace = traceEventsFor(this.id);

  async connect(
    config: MCPConnectConfig,
    signal?: AbortSignal,
    onTrace?: TraceSink,
  ): Promise<Connection> {
    const { url } = config;
    const abort = chainAbort(signal);
    const getRequestHeaders: () => Record<string, string> =
      config.getRequestHeaders ?? (() => ({}));
    const versionPin = config.protocolVersion ?? "auto";

    // Stateless RC: no initialize handshake, no session id.
    // Forced when pinned to STATELESS_VERSION; auto-detected via server/discover
    // when "auto" (the default). Legacy pins skip the probe entirely.
    const shouldProbe = versionPin === "auto" || versionPin === STATELESS_VERSION;

    if (shouldProbe) {
      try {
        return await this.connectStateless(url, config.routing, getRequestHeaders, abort, onTrace);
      } catch (e) {
        // Forced stateless pin — never fall back to legacy.
        if (versionPin === STATELESS_VERSION) {
          // If the server rejected our version specifically (would have fallen back in
          // auto mode), surface a clear unsupported-version message instead of the raw
          // negotiation error. Other failures (CORS, network, auth) keep their own message.
          if (isProtocolException(e) && shouldFallBackToLegacy(e)) {
            throw protocolError({
              kind: "protocol-version-mismatch",
              message: `The MCP server ${url} does not support protocol ${STATELESS_VERSION}.`,
              serverVersion: undefined,
              supported: [],
            });
          }
          throw e;
        }
        // "auto": connectStateless wraps every failure as a ProtocolException before
        // rethrowing (so the trace error event fires). `shouldFallBackToLegacy`
        // decides the era split — a legacy-status probe, a non-RC discover body, or a
        // version-mismatch advertising a legacy version we support all fall through to
        // initialize; a genuine stateless error (-32003, CORS, network, timeout) is
        // surfaced as-is.
        if (!isProtocolException(e) || !shouldFallBackToLegacy(e)) throw e;
      }
    }

    // 4348: a pinned legacy version is proposed in `initialize` and must be the one the server agrees to.
    const pinnedLegacy = versionPin === "auto" ? undefined : versionPin; // stateless pins never reach here
    return this.connectLegacy(url, config.routing, getRequestHeaders, abort, onTrace, pinnedLegacy);
  }

  async invoke(
    connection: Connection,
    invocation: MCPInvocation,
    signal?: AbortSignal,
    onTrace?: TraceSink,
  ): Promise<void> {
    // A foreign connection is a caller bug, never traced — reject, don't swallow.
    this.requireConnection(connection);
    // Fire-and-report: same wire path as relayCall, but the outcome lives only
    // in the trace — every failure relayCall throws was already traced there.
    try {
      await this.relayCall(connection, invocation, signal, onTrace);
    } catch {
      /* already traced */
    }
  }

  /**
   * Send one call to the server, trace its lifecycle, and resolve its result.
   * The single wire path for both callers: `invoke` (Ardi-issued, outcome
   * consumed via the trace alone) delegates here and swallows, while MCP Apps
   * relays call this directly — a View's requester needs the result/failure
   * back, not just the trace.
   */
  async relayCall(
    connection: Connection,
    invocation: MCPInvocation,
    signal?: AbortSignal,
    onTrace?: TraceSink,
  ): Promise<unknown> {
    const conn = this.requireConnection(connection);
    const id = conn.getNextId();
    // A continuation (an elicitation answer) carries the originating call's correlationId so its
    // events thread under that one pending row; a fresh call traces under its own new wire id. The
    // wire id is always fresh - only the trace correlationId is reused.
    const correlationId = invocation.correlationId ?? String(id);
    const { payload, headers } = this.prepareCall(conn, id, invocation);
    if (invocation.correlationId) {
      // Resubmission: record the submitted answers as an input-response (client-to-server but NOT a
      // request, so it opens no second pending row), then reuse the normal result path below - a
      // terminal result settles the original row; another input_required keeps it pending. The
      // answers were folded into params by buildElicitationContinuation; surface just those (the
      // arguments and opaque requestState are already visible on the originating request row).
      const answers = (invocation.params as { inputResponses?: unknown } | undefined)
        ?.inputResponses;
      onTrace?.(this.trace.inputResponse(correlationId, { inputResponses: answers }));
    } else {
      // 4348: trace the params as actually sent (including the injected `_meta` on stateless), so an edit starts from
      // the real wire request.
      const requestEvent = this.trace.request(correlationId, invocation.method, payload.params, headers);
      onTrace?.(invocation.longLived ? { ...requestEvent, cancellable: true } : requestEvent);
    }

    const userAbort = new AbortController();
    conn.inflight.set(id, userAbort);
    const sources: AbortSignal[] = [userAbort.signal, conn.abort.signal];
    if (signal) sources.push(signal);
    const combined = AbortSignal.any(sources);

    // Task-poller-originated requests (`tasks/get` / `tasks/cancel`) route through
    // the dedicated Kong tasks route (permissive rate limit, no held-open
    // streams) instead of the general MCP proxy route. Sizing lives alongside
    // web/frontend/src/stores/taskPoller.ts's poll interval constants and
    // web/backend/deploy/chart/templates/kongplugin.yaml's rate limit.
    const proxyUrl =
      invocation.method === TASKS_GET || invocation.method === TASKS_CANCEL
        ? MCP_TASKS_PROXY_URL
        : undefined;

    try {
      let settled: SettledReply;
      try {
        settled = invocation.longLived
          ? await sendRequest(conn, id, payload, { signal: combined, headers })
          : await withTimeout(combined, INVOKE_TIMEOUT_MS, conn.url, (sig) =>
              sendRequest(conn, id, payload, { signal: sig, headers, proxyUrl }),
            );
      } catch (e) {
        // Trace the failure, then surface it to the caller (invoke swallows it).
        this.handleInvokeError(conn, id, correlationId, combined, e, onTrace);
        // A user cancel is not a transport failure. `handleInvokeError` already
        // traced it as `cancelled` and returned without classifying, so without
        // this a relaying caller (an App's View, which unlike `invoke` reads the
        // rejection) is handed "signal is aborted without reason" as though the
        // network had broken. Read the SIGNAL, not `e`, for the same reason
        // `handleInvokeError` does.
        if (combined.reason instanceof CancelledByUser) {
          throw protocolError({ kind: "disconnected", message: combined.reason.message });
        }
        throw isProtocolException(e)
          ? e
          : classifyFetchError(e, {
              url: conn.url,
              origin: currentOrigin(),
              hadSessionId: conn.sessionId !== undefined,
            });
      }
      const { envelope, responseHeaders, status } = settled;
      this.traceInvokeResult(
        conn,
        correlationId,
        invocation.method,
        envelope,
        onTrace,
        responseHeaders,
        status,
      );
      if (envelope.error) {
        throw protocolError({
          kind: "protocol-remote",
          message: envelope.error.message ?? `${invocation.method} failed`,
          code: envelope.error.code,
          data: envelope.error.data,
        });
      }
      // Tool-level isError results, task handles, and input_required results all
      // return verbatim: the View receives exactly what the server sent, and
      // drives its own follow-ups (tasks/get polling, elicitation resubmission).
      return envelope.result;
    } finally {
      conn.inflight.delete(id);
    }
  }

  private async connectStateless(
    url: string,
    routing: Routing | undefined,
    getRequestHeaders: () => Record<string, string>,
    abort: AbortController,
    onTrace: TraceSink | undefined,
  ): Promise<MCPConnection> {
    onTrace?.(
      this.trace.request(DISCOVER_CORRELATION_ID, "server/discover", {}, getRequestHeaders()),
    );
    const conn = newConnection(this.id, url, getRequestHeaders, abort, routing);
    try {
      const discovered = await withTimeout(abort.signal, CONNECT_TIMEOUT_MS, url, (sig) =>
        discoverStateless(url, getRequestHeaders, sig, routing),
      );
      if (!discovered.supportedVersions.includes(STATELESS_VERSION)) {
        throw protocolError({
          kind: "protocol-version-mismatch",
          message: `Server does not support MCP version ${STATELESS_VERSION}`,
          serverVersion: undefined,
          supported: discovered.supportedVersions,
        });
      }
      conn.transport = new HTTPTransport(url, {
        onMessage: connectionSink(conn, this.trace, onTrace).onMessage,
        onResponseHeaders: () => {},
        getHeaders: () => requestHeadersFor(conn),
        routing,
      });
      conn.protocolVersion = STATELESS_VERSION;
      conn.serverName = discovered.serverInfo?.name;
      conn.serverIcon = pickServerIcon(discovered.serverInfo?.icons);
      conn.capabilities = discovered.capabilities;
      conn.transportLabel = conn.transport.kind;
      // No responseHeaders here: discovery goes over a raw fetch outside the
      // transport, so there's no captured header set to stamp (unlike
      // connectLegacy's Streamable-HTTP handshake).
      onTrace?.(
        this.trace.response(DISCOVER_CORRELATION_ID, {
          protocolVersion: STATELESS_VERSION,
          ...discovered,
        }),
      );
      return conn;
    } catch (e) {
      const failure = isProtocolException(e)
        ? e
        : classifyFetchError(e, { url, origin: currentOrigin() });
      onTrace?.(
        this.trace.error(
          DISCOVER_CORRELATION_ID,
          failureTrace(failure).payload,
          failureTrace(failure).responseHeaders,
        ),
      );
      throw failure;
    }
  }

  private async connectLegacy(
    url: string,
    routing: Routing | undefined,
    getRequestHeaders: () => Record<string, string>,
    abort: AbortController,
    onTrace: TraceSink | undefined,
    pinnedVersion?: string,
  ): Promise<MCPConnection> {
    onTrace?.(
      this.trace.request(
        INITIALIZE_CORRELATION_ID,
        INITIALIZE_REQUEST.method,
        initializeParams(pinnedVersion),
        getRequestHeaders(),
      ),
    );
    const conn = newConnection(this.id, url, getRequestHeaders, abort, routing);
    const sink = connectionSink(conn, this.trace, onTrace);
    let lastHandshakeHeaders: Record<string, string> | undefined;
    const captureSession = (h: Headers) => {
      const sid = h.get("mcp-session-id");
      if (sid) conn.sessionId = sid;
      lastHandshakeHeaders = headersToRecord(h);
    };
    try {
      const initResult = await negotiateAndInitialize(
        conn,
        sink,
        url,
        getRequestHeaders,
        abort.signal,
        captureSession,
        () => requestHeadersFor(conn),
        pinnedVersion,
      );
      if (pinnedVersion && initResult.protocolVersion !== pinnedVersion) {
        await conn.transport.close().catch(() => {});
        throw protocolError({
          kind: "protocol-version-mismatch",
          message: `The MCP server ${url} does not support protocol ${pinnedVersion}.`,
          serverVersion: initResult.protocolVersion,
          supported: initResult.protocolVersion ? [initResult.protocolVersion] : [],
        });
      }
      await validateVersion(
        initResult.protocolVersion,
        conn.transport,
        conn.sessionId,
        getRequestHeaders,
        url,
        routing,
      );
      // On SSE fallback the only captured headers belong to the failed
      // Streamable HTTP probe — stamp nothing rather than the wrong response's
      // (SSETransport surfaces no per-message response headers).
      const handshakeHeaders =
        conn.transport.kind === "http-streamable" ? lastHandshakeHeaders : undefined;
      onTrace?.(this.trace.response(INITIALIZE_CORRELATION_ID, initResult, handshakeHeaders));
      conn.protocolVersion = initResult.protocolVersion ?? "";
      conn.serverName = initResult.serverInfo?.name;
      conn.serverIcon = pickServerIcon(initResult.serverInfo?.icons);
      conn.capabilities = initResult.capabilities ?? {};
      conn.transportLabel = conn.transport.kind;
      // Now that session id + protocol version are known, open the standing
      // server→client push stream. (No-op for the SSE fallback, which opened
      // its inbound stream during the handshake.)
      conn.transport.openServerStream?.();
      await this.announceInitialized(conn, onTrace);
      return conn;
    } catch (e) {
      const failure = isProtocolException(e)
        ? e
        : classifyFetchError(e, { url, origin: currentOrigin() });
      onTrace?.(
        this.trace.error(
          INITIALIZE_CORRELATION_ID,
          failureTrace(failure).payload,
          failureTrace(failure).responseHeaders,
        ),
      );
      throw failure;
    }
  }

  /** Build the wire payload and headers for one invocation. */
  private prepareCall(conn: MCPConnection, id: number, invocation: MCPInvocation) {
    if (invocation.exact) {
      const live = Object.fromEntries(
        Object.entries(conn.getRequestHeaders()).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const headers = Object.fromEntries(
        Object.entries(invocation.exact.headers).map(([name, value]) => [
          name,
          value === REDACTED ? (live[name.toLowerCase()] ?? value) : value,
        ]),
      );
      return {
        payload: { jsonrpc: "2.0" as const, id, method: invocation.method, params: invocation.params },
        headers,
      };
    }
    const stateless = isStatelessConnection(conn);
    const params = stateless
      ? withStatelessMeta(conn.protocolVersion, invocation.params)
      : invocation.params;
    const rawName =
      invocation.params != null && typeof invocation.params === "object"
        ? ((invocation.params as Record<string, unknown>).name ??
          (invocation.params as Record<string, unknown>).uri)
        : undefined;
    // Mcp-Name must match the body value exactly (spec: Server Validation).
    // Drop silently if non-string — body still carries the real value.
    const nameParam = typeof rawName === "string" ? rawName : undefined;
    const headers = requestHeadersFor(conn, {
      method: invocation.method,
      name: nameParam,
      paramHeaders: invocation.mcpParamHeaders,
    });
    return { payload: { jsonrpc: "2.0" as const, id, method: invocation.method, params }, headers };
  }

  private traceInvokeResult(
    conn: MCPConnection,
    correlationId: string,
    method: string,
    envelope: JsonRpcEnvelope,
    onTrace: TraceSink | undefined,
    responseHeaders?: Record<string, string>,
    httpStatus?: number,
  ): void {
    const result = envelope.result;
    // 2026-07-28 RC: an input_required result means the server needs more data before it can
    // complete. Surface it as a non-terminal event so the row stays pending for the elicitation
    // round; the continuation resubmits under this same correlationId.
    if (isStatelessConnection(conn) && parseInputRequired(result) !== null) {
      onTrace?.(this.trace.inputRequired(correlationId, result));
      return;
    }
    // 2026-07-28 RC "tasks" extension: a `tools/call` may return a task handle
    // instead of a terminal result — symmetric to the input_required branch
    // above. This protocol layer has no notion of connectionId/session (see
    // `Connection`'s docstring: consumers treat it as an opaque token), so it
    // only traces the handle here; `useConnectionStore`'s trace sink seeds
    // `useTaskStore` off this event — the layer that knows the connectionId/
    // session pair `useTraceStore.append` needs too.
    //
    // Excluded: `tasks/get|cancel|update` replies carry the identical `Task`
    // wire shape (`isTaskResult` has no way to tell them apart from a fresh
    // handle), but they are updates to an EXISTING task, not a new one — they
    // must fall through to the plain `trace.response` below so
    // `useConnectionStore`'s `messageType === "response"` branch runs
    // `applyTaskUpdate`/`syncTaskTraceStatus` instead of re-`upsert`ing and
    // restarting polling as if it were a brand-new task.
    const isTaskLifecycleMethod =
      method === TASKS_GET || method === TASKS_CANCEL || method === TASKS_UPDATE;
    if (isStatelessConnection(conn) && !isTaskLifecycleMethod && isTaskResult(result)) {
      onTrace?.(this.trace.taskCreated(correlationId, result));
      return;
    }
    if (envelope.error) {
      onTrace?.(
        this.trace.error(
          correlationId,
          {
            message: envelope.error.message ?? "invocation failed",
            code: envelope.error.code,
            data: envelope.error.data,
          },
          responseHeaders,
          httpStatus,
        ),
      );
      return;
    }
    const toolError = resultLevelError(method, result);
    if (toolError) {
      // A domain-level failure carried inside a successful JSON-RPC result.
      // Surface as an error row but keep the content for the UI to render.
      onTrace?.(this.trace.error(correlationId, toolError, responseHeaders, httpStatus));
    } else {
      onTrace?.(this.trace.response(correlationId, result, responseHeaders, httpStatus));
    }
  }

  private handleInvokeError(
    conn: MCPConnection,
    requestId: number,
    correlationId: string,
    combined: AbortSignal,
    e: unknown,
    onTrace: TraceSink | undefined,
  ): void {
    // User-cancel takes precedence. Read the SIGNAL's reason, not `e`: the reject
    // can race between sendRequest's abort listener and the fetch-abort rejection,
    // so `e` may be a transport AbortError, but `combined.reason` is deterministic.
    if (combined.reason instanceof CancelledByUser) {
      const reason = combined.reason.message;
      // Notify the server best-effort but don't trace it as its own row — the
      // single cancelled event below both records it and flips the request state.
      void this.sendNotification(conn, "notifications/cancelled", { requestId, reason });
      onTrace?.(this.trace.cancelled(correlationId, reason));
      return;
    }
    const ex = isProtocolException(e)
      ? e
      : classifyFetchError(e, {
          url: conn.url,
          origin: currentOrigin(),
          hadSessionId: conn.sessionId !== undefined,
        });
    // On timeout, notify the server so it can free resources.
    if (ex.error.kind === "connection-timeout") {
      this.sendCancelled(conn, requestId, "timeout", onTrace);
    }
    // A genuine server reply is an error row. A no-bytes failure (timeout, CORS,
    // network, disconnect) is a local diagnostic — never a fabricated server error.
    // (JSON-RPC error replies resolve in the try via envelope.error, never here.)
    if (isServerReply(ex.error)) {
      onTrace?.(
        this.trace.error(correlationId, failureTrace(ex).payload, failureTrace(ex).responseHeaders),
      );
    } else {
      onTrace?.(this.trace.diagnostic(correlationId, ex.error.message));
    }
  }

  async introspect(
    connection: Connection,
    signal?: AbortSignal,
    onTrace?: TraceSink,
  ): Promise<IntrospectionResult> {
    const conn = this.requireConnection(connection);
    const combined = signal ? AbortSignal.any([signal, conn.abort.signal]) : conn.abort.signal;
    try {
      return await introspect(
        this.introspectCall(conn, combined, onTrace),
        conn.capabilities,
        combined,
      );
    } catch (e) {
      if (isProtocolException(e)) throw e;
      throw classifyFetchError(e, {
        url: conn.url,
        origin: currentOrigin(),
        hadSessionId: conn.sessionId !== undefined,
      });
    }
  }

  /**
   * The `RpcCall` introspect runs each list method through: it owns id
   * allocation, tracing, the per-call timeout, and reply correlation (via the
   * connection's pending map). Resolves the JSON-RPC `result`; on a JSON-RPC
   * error it traces the error and throws a `protocol-remote` carrying the wire
   * `code` so introspect can tell a method-not-found degrade from a real failure.
   */
  private introspectCall(conn: MCPConnection, parent: AbortSignal, onTrace?: TraceSink): RpcCall {
    const stateless = isStatelessConnection(conn);
    return async (method, params, opts) => {
      const callParams = stateless ? withStatelessMeta(conn.protocolVersion, params) : params;
      const id = conn.getNextId();
      const correlationId = String(id);
      const headers = requestHeadersFor(conn, { method, name: opts?.name });
      onTrace?.(this.trace.request(correlationId, method, params, headers));

      const timeout = timeoutSignal(INTROSPECT_TIMEOUT_MS, parent);
      let settled: SettledReply;
      try {
        settled = await sendRequest(
          conn,
          id,
          { jsonrpc: "2.0", id, method, params: callParams },
          { signal: timeout.signal, headers },
        );
      } catch (e) {
        if (timeout.timedOut()) {
          throw protocolError({
            kind: "connection-timeout",
            message: `${method} timed out after ${INTROSPECT_TIMEOUT_MS}ms`,
            url: conn.url,
            timeoutMs: INTROSPECT_TIMEOUT_MS,
          });
        }
        throw e;
      } finally {
        timeout.clear();
      }
      const { envelope, responseHeaders, status } = settled;

      if (envelope.error) {
        const message = envelope.error.message ?? `${method} failed`;
        onTrace?.(
          this.trace.error(correlationId, { message, code: envelope.error.code }, responseHeaders, status),
        );
        throw protocolError({ kind: "protocol-remote", message, code: envelope.error.code });
      }
      onTrace?.(this.trace.response(correlationId, envelope.result, responseHeaders, status));
      return envelope.result;
    };
  }

  async disconnect(connection: Connection, onTrace?: TraceSink): Promise<void> {
    const conn = this.requireConnection(connection);

    // A disconnect is a client-side action, not a wire conversation — so the trace
    // shows a single local marker, never request/response rows. When the server
    // assigned a session id we still send the spec-recommended DELETE to release it,
    // but strictly best-effort: fire-and-forget, response and errors swallowed,
    // teardown never blocks on it (it uses its own timeout signal, not conn.abort).
    // Stateless Streamable HTTP has no session, so nothing goes on the wire at all.
    onTrace?.(this.trace.diagnostic("disconnect", "Connection closed by client", "disconnected"));

    if (conn.sessionId) {
      void proxyFetch({
        target: conn.url,
        method: "DELETE",
        // getRequestHeaders first so protocol headers win, matching requestHeadersFor.
        headers: {
          ...conn.getRequestHeaders(),
          "Mcp-Session-Id": conn.sessionId,
          "MCP-Protocol-Version": conn.protocolVersion,
        },
        // keepalive lets the browser complete the request even if the tab is
        // closing right after disconnect, so the server session is still released.
        keepalive: true,
        signal: AbortSignal.timeout(DISCONNECT_DELETE_TIMEOUT_MS),
        routing: conn.routing,
      }).catch(() => {
        // Best-effort session release; the local connection is torn down regardless.
      });
    }

    conn.abort.abort(new DisconnectError());
    conn.pending.rejectAll(
      protocolError({ kind: "disconnected", message: "Connection closed by client" }),
    );
    await conn.transport.close();
  }

  cancel(connection: Connection, correlationId: string, reason: string): void {
    const conn = this.requireConnection(connection);
    // The trace correlationId for a cancellable capability request is the
    // stringified JSON-RPC id. A non-numeric id (e.g. a server-event "srv-N")
    // is never a cancellable client request, so guard before the Map lookup.
    const requestId = Number(correlationId);
    if (!Number.isInteger(requestId)) return;
    const ctrl = conn.inflight.get(requestId);
    // No controller → request already settled or never cancellable. The race the
    // MCP spec calls out (cancel crossing a response) resolves to a no-op here.
    if (!ctrl) return;
    // The still-awaiting invoke owns trace emission (it captured the sink + epoch);
    // aborting is all cancel does. invoke's catch sends notifications/cancelled and
    // emits the terminal cancelled event.
    ctrl.abort(new CancelledByUser(reason));
  }

  buildInvocation(capability: Capability, args: Record<string, unknown>): Invocation {
    return invocationForCapability(capability, args);
  }

  capabilityKey(capability: Capability): string {
    return mcpCapabilityKey(capability);
  }

  recordingKeyForEvent(event: TraceEvent): RecordingKey | null {
    return mcpRecordingKeyForEvent(event);
  }

  private async announceInitialized(
    conn: MCPConnection,
    onTrace: TraceSink | undefined,
  ): Promise<void> {
    onTrace?.(this.trace.notification("initialized", "notifications/initialized", undefined));
    // Legacy-only today (announced from connectLegacy), but routed through the
    // shared notification path so it stays era-correct if ever sent on stateless.
    await this.sendNotification(conn, "notifications/initialized", {});
  }

  private requireConnection(c: Connection): MCPConnection {
    const got: string = c.protocolId;
    const want: string = this.id;
    if (got !== want) {
      throw new Error(`Connection belongs to "${got}", not "${want}"`);
    }
    return c as MCPConnection;
  }

  private sendCancelled(
    conn: MCPConnection,
    requestId: number,
    reason: string,
    onTrace?: TraceSink,
  ): void {
    // Correlate to the timed-out request so the cancelled notification lines up
    // with that call's request/error rows in the trace.
    onTrace?.(
      this.trace.notification(String(requestId), "notifications/cancelled", { requestId, reason }),
    );
    void this.sendNotification(conn, "notifications/cancelled", { requestId, reason });
  }

  /**
   * 4348 (S3): let the app answer some server-initiated requests itself. `handler` returns true to take ownership of a
   * request (it must later call `respondToPeerRequest`); false leaves Ardi's auto -32601.
   */
  setPeerRequestHandler(
    connection: Connection,
    handler: ((request: { correlationId: string; method: string; params: unknown }) => boolean) | undefined,
  ): void {
    this.requireConnection(connection).onPeerRequest = handler;
  }

  /** Answer a held server-initiated request with a result or a JSON-RPC error, settling its trace row. */
  respondToPeerRequest(
    connection: Connection,
    correlationId: string,
    outcome: PeerOutcome,
    onTrace?: TraceSink,
  ): Promise<void> {
    return replyToPeerRequest(this.requireConnection(connection), this.trace, correlationId, outcome, onTrace);
  }

  /** Send a client notification (e.g. `notifications/roots/list_changed`), best effort. */
  notify(connection: Connection, method: string, params: Record<string, unknown> = {}): Promise<void> {
    return this.sendNotification(this.requireConnection(connection), method, params);
  }

  /**
   * Send a fire-and-forget JSON-RPC notification. On a stateless connection the
   * frame carries the spec-required `_meta` (protocol version / client identity)
   * and the `Mcp-Method` header is mirrored — both REQUIRED for "all requests and
   * notifications" in the 2026-07-28 RC. `notificationFrame` handles the era split;
   * failures are logged, never thrown (the server simply may not learn it can free
   * resources).
   */
  private async sendNotification(
    conn: MCPConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const { payload, headers } = notificationFrame(conn, method, params);
    try {
      await conn.transport.send(payload, {
        signal: AbortSignal.timeout(BEST_EFFORT_TIMEOUT_MS),
        headers,
      });
    } catch (e) {
      console.warn(`[MCPHTTPProtocol] best-effort ${method} failed (non-fatal)`, e);
    }
  }
}
