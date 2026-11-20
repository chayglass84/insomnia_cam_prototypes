import type { TraceEvent } from "../TraceEvent";
import { isCancellableMethod } from "./capabilities/methods";

/** Payload for an `error` trace event. */
interface TraceErrorPayload {
  message: string;
  kind?: string;
  code?: number;
  data?: unknown;
}

/**
 * Header names whose value is a credential on the wire: the headers the auth
 * modes themselves inject (Authorization for oauth/bearer/basic, X-API-Key for
 * apiKey) plus the classic credential carriers a user can add by hand. Values
 * are redacted AT CAPTURE, before the event enters the trace store, so a
 * secret — most critically an OAuth access token the user never typed — cannot
 * reach any trace surface, live or shared. Same invariant as the OAuth flow's
 * own rows (see REQUEST_HEADER_DENYLIST in lib/oauth/proxyFetchAdapter.ts);
 * the sentinel matches shareSanitize's REDACTED so share-time sanitization and
 * the backend's hard-reject rule see an already-handled value. Names survive:
 * replay and the copy-agent-prompt header block are name-driven.
 */
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);
// Custom headers carry secrets under arbitrary names too (X-Auth-Token,
// X-Amz-Security-Token, X-Vault-Secret, ...), and these ride the relay/backend
// proxy, so the browser's forbidden-header stripping never applies — redact by
// name shape as well. Redacting a value the user typed themselves costs a
// glance at their own config; leaking one into a share is unrecoverable. Bare
// "auth" is deliberately NOT matched: WWW-Authenticate is a challenge, not a
// secret, and this debugger needs it visible.
const CREDENTIAL_NAME_PATTERN = /token|secret|password|api-?key|credential/;
export const REDACTED = "<redacted>";

function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_HEADER_NAMES.has(lower) || CREDENTIAL_NAME_PATTERN.test(lower);
}

/** Copy of `headers` with credential values redacted; never mutates the wire record. */
export function redactCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      isCredentialHeader(name) ? REDACTED : value,
    ]),
  );
}

/** Row label for a method-bearing event: the wire method plus the capability it targets. */
function methodLabel(method: string, params: unknown): string {
  const p = params as { name?: unknown; uri?: unknown } | undefined;
  const target = p?.name ?? p?.uri;
  return typeof target === "string" ? `${method} · ${target}` : method;
}

/**
 * Builders for the TraceEvents a protocol emits. `invoke`, `connect`, and
 * `introspect` all mint identically-shaped events through these so the Trace
 * UI renders them uniformly. `notification` reuses the `:request` renderer key
 * (it is an outbound message with a method) but keeps its own `messageType` so
 * the trace store does not leave it pending - it expects no response.
 * `clientError` is the `error` twin for the client's own outbound error reply
 * (e.g. the -32601 to an unsupported peer request): same `:error` renderer, but
 * `client-to-server` so the direction reads correctly. `clientResponse` is the
 * success counterpart — the empty `{}` result the client replies to a server
 * `ping` with (the spec requires a result, not an error).
 *
 * `sequence` is left provisional (0) here: it is the aggregated trace's row
 * identity and sort order, which only the store can assign, so `useTraceStore`
 * stamps the real monotonic value at append time.
 */
export function traceEventsFor(protocol: string) {
  return {
    request(
      correlationId: string,
      method: string,
      params: unknown,
      headers: Record<string, string>,
    ): TraceEvent {
      return {
        id: `evt-${correlationId}-req`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "client-to-server",
        messageType: "request",
        timestamp: new Date().toISOString(),
        payload: { method, params },
        rendererKey: `${protocol}:request`,
        label: methodLabel(method, params),
        // A client request stays pending until its terminal event lands; the
        // Trace UI's Cancel affordance reads `cancellable` off the event rather
        // than re-deriving it from the MCP method name.
        awaitsReply: true,
        cancellable: isCancellableMethod(method),
        // The headers this request was dispatched with (user-configured + auth +
        // protocol). Omitted when empty (stdio) so header-less requests stay clean.
        // Credential values are redacted at capture (see CREDENTIAL_HEADER_NAMES);
        // live views show the rest, share sanitization redacts the remainder.
        ...(Object.keys(headers).length > 0
          ? { requestHeaders: redactCredentialHeaders(headers) }
          : {}),
      };
    },
    response(
      correlationId: string,
      payload: unknown,
      responseHeaders?: Record<string, string>,
      httpStatus?: number,
    ): TraceEvent {
      return {
        id: `evt-${correlationId}-response`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "server-to-client",
        messageType: "response",
        timestamp: new Date().toISOString(),
        payload,
        rendererKey: `${protocol}:response`,
        terminalStatus: "success",
        // Same capture-time redaction as requestHeaders: a server that echoes
        // request headers back would otherwise return the credential here.
        ...(responseHeaders && Object.keys(responseHeaders).length > 0
          ? { responseHeaders: redactCredentialHeaders(responseHeaders) }
          : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      };
    },
    error(
      correlationId: string,
      payload: TraceErrorPayload,
      responseHeaders?: Record<string, string>,
      httpStatus?: number,
    ): TraceEvent {
      return {
        id: `evt-${correlationId}-error`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "server-to-client",
        messageType: "error",
        timestamp: new Date().toISOString(),
        payload,
        rendererKey: `${protocol}:error`,
        terminalStatus: "error",
        ...(responseHeaders && Object.keys(responseHeaders).length > 0
          ? { responseHeaders: redactCredentialHeaders(responseHeaders) }
          : {}),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      };
    },
    clientError(correlationId: string, payload: TraceErrorPayload): TraceEvent {
      return {
        id: `evt-${correlationId}-client-error`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "client-to-server",
        messageType: "error",
        timestamp: new Date().toISOString(),
        payload,
        rendererKey: `${protocol}:error`,
        terminalStatus: "error",
      };
    },
    clientResponse(correlationId: string, payload: unknown): TraceEvent {
      return {
        id: `evt-${correlationId}-client-response`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "client-to-server",
        messageType: "response",
        timestamp: new Date().toISOString(),
        payload,
        rendererKey: `${protocol}:response`,
        terminalStatus: "success",
      };
    },
    cancelled(correlationId: string, reason: string): TraceEvent {
      return {
        id: `evt-${correlationId}-cancelled`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "client-to-server",
        messageType: "cancelled",
        timestamp: new Date().toISOString(),
        // Rendered as the notifications/cancelled frame the client sent (the row
        // labels off this method); a terminal cancelled status also flips the
        // originating request's status — one row, not two.
        payload: { method: "notifications/cancelled", params: { reason } },
        rendererKey: `${protocol}:cancelled`,
        label: "notifications/cancelled",
        terminalStatus: "cancelled",
      };
    },
    diagnostic(correlationId: string, reason: string, label?: string): TraceEvent {
      return {
        id: `evt-${correlationId}-diagnostic`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "internal",
        messageType: "diagnostic",
        timestamp: new Date().toISOString(),
        payload: { reason },
        rendererKey: `${protocol}:diagnostic`,
        label: label ?? "no response",
        terminalStatus: "no-response",
      };
    },
    notification(correlationId: string, method: string, params: unknown): TraceEvent {
      return {
        id: `evt-${correlationId}-notification`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "client-to-server",
        messageType: "notification",
        timestamp: new Date().toISOString(),
        payload: { method, params },
        rendererKey: `${protocol}:request`,
        label: methodLabel(method, params),
      };
    },
    serverRequest(correlationId: string, method: string, params: unknown): TraceEvent {
      return {
        id: `evt-${correlationId}-srv-req`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "server-to-client",
        messageType: "request",
        timestamp: new Date().toISOString(),
        payload: { method, params },
        rendererKey: `${protocol}:request`,
        label: methodLabel(method, params),
        // Shown pending until our -32601 clientError twin settles it.
        awaitsReply: true,
      };
    },
    serverNotification(correlationId: string, method: string, params: unknown): TraceEvent {
      return {
        id: `evt-${correlationId}-srv-notification`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "server-to-client",
        messageType: "notification",
        timestamp: new Date().toISOString(),
        payload: { method, params },
        rendererKey: `${protocol}:request`,
        label: methodLabel(method, params),
      };
    },
    /**
     * Emitted when a stateless RC (2026-07-28) invocation returns
     * `resultType: "input_required"`. The originating request stays pending —
     * no `terminalStatus` here. Full elicitation UI is out of scope for now.
     * Payload is the raw result object verbatim.
     */
    inputRequired(correlationId: string, payload: unknown): TraceEvent {
      return {
        id: `evt-${correlationId}-input-required`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "server-to-client",
        messageType: "input-required",
        timestamp: new Date().toISOString(),
        payload,
        rendererKey: `${protocol}:input-required`,
        label: "Input required",
      };
    },
    /**
     * The client's answer to an `input_required` round: carries `inputResponses` back to the
     * server. Client-to-server, but NOT a request - it must not open a second pending row, and
     * it is not terminal, so the originating request stays pending until the loop resolves. The
     * answers are recorded here so the trace shows what was submitted (and sharing can gate on it).
     */
    inputResponse(correlationId: string, payload: unknown): TraceEvent {
      return {
        id: `evt-${correlationId}-input-response`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "client-to-server",
        messageType: "input-response",
        timestamp: new Date().toISOString(),
        payload,
        rendererKey: `${protocol}:input-response`,
        label: "Input submitted",
      };
    },
    /**
     * Emitted when a stateless RC (2026-07-28) `tools/call` returns a task
     * handle instead of a terminal result — the RC "tasks" extension's analog
     * of `resultType: "input_required"`. Same shape rule: the originating
     * request stays pending, so no `terminalStatus` here; the task's own
     * lifecycle (tracked in `useTaskStore`) is what eventually settles, via
     * `tasks/get`/`tasks/update` polling, not this row. Payload is the raw
     * result object verbatim.
     */
    taskCreated(correlationId: string, payload: unknown): TraceEvent {
      return {
        id: `evt-${correlationId}-task`,
        sequence: 0,
        correlationId,
        protocol,
        direction: "server-to-client",
        messageType: "task",
        timestamp: new Date().toISOString(),
        payload,
        rendererKey: `${protocol}:task`,
        label: "Task created",
      };
    },
  };
}

/** The object returned by `traceEventsFor`, a protocol's event builders. */
export type TraceEventFactory = ReturnType<typeof traceEventsFor>;
