/**
 * Tagged-union error shapes returned (or thrown) by Protocol and
 * Transport implementations. Consumers exhaust-match on `kind`.
 *
 * Rule for adding a variant: each `kind` must be (a) deterministically
 * distinguishable at the point of failure, and (b) actionable — the user
 * or a renderer does something different for it. Opaque failures collapse
 * into `UnknownError`.
 */

/** We control the timeout, so this is the one network failure mode we can identify. */
export type ConnectionTimeoutError = {
  kind: "connection-timeout";
  message: string;
  url: string;
  timeoutMs: number;
};

/**
 * Heuristic: a cross-origin `fetch` rejected with a `TypeError` and no
 * response. Browsers don't expose CORS rejections directly; we infer it.
 */
export type CORSError = {
  kind: "cors";
  message: string;
  url: string;
  cause?: unknown;
};

/** Server responded, but the body wasn't valid JSON or wasn't a JSON-RPC shape. */
export type SchemaParseError = {
  kind: "schema-parse";
  message: string;
  url?: string;
  cause?: unknown;
};

/** Server negotiated an MCP protocol version we don't support. */
export type ProtocolVersionMismatchError = {
  kind: "protocol-version-mismatch";
  message: string;
  serverVersion?: string;
  supported: string[];
};

/** Catch-all network/transport failure (unreachable host, mixed content, etc.). */
export type TransportError = {
  kind: "transport";
  message: string;
  url?: string;
  cause?: unknown;
  /** Set when the failure carried an HTTP status (e.g. a 5xx) rather than a bare
   *  network error — lets a renderer show the real code instead of "request failed". */
  status?: number;
  /** 4348: response body / headers of the failing HTTP reply, surfaced in the trace. */
  httpBody?: string;
  httpResponseHeaders?: Record<string, string>;
};

/** The wire format explicitly carried an error (e.g. a JSON-RPC error object). */
export type ProtocolRemoteError = {
  kind: "protocol-remote";
  message: string;
  code?: number;
  data?: unknown;
};

/**
 * The server rejected the credentials (HTTP 401/403). Distinct from a transport
 * failure and actionable: the user fixes or re-enters their auth, rather than
 * retrying the network.
 */
export type AuthError = {
  kind: "auth";
  message: string;
  url?: string;
  status?: number;
  /**
   * Value of the upstream `WWW-Authenticate` header from the 401, carried
   * through so the OAuth flow can read its `resource_metadata` parameter
   * (RFC 9728) and discover the auth server's issuer cross-origin.
   */
  wwwAuthenticate?: string;
  /** 4348: response body / headers of the failing HTTP reply, surfaced in the trace. */
  httpBody?: string;
  httpResponseHeaders?: Record<string, string>;
};

/**
 * The connection was closed by the client (user disconnect or teardown).
 * Distinguishes a user-initiated termination from a transport failure so the
 * trace doesn't mislabel a normal close as "network request failed".
 */
export type DisconnectedError = {
  kind: "disconnected";
  message: string;
};

/**
 * The server returned 404 in response to a request carrying an `Mcp-Session-Id`.
 * Per MCP 2025-11-25 Session Management, the client MUST start a new session —
 * surface as a distinct, actionable kind rather than a transport error.
 */
export type SessionExpiredError = {
  kind: "session-expired";
  message: string;
  url?: string;
  status?: number;
};

/**
 * The proxy refused this server address. Keep this distinct from generic transport
 * failures so the UI can explain reachability.
 */
export type TargetBlockedError = {
  kind: "target-blocked";
  message: string;
  url?: string;
  status?: number;
};

/** The relay process is not reachable at this loopback address (the tokenless liveness probe rejected). */
export type RelayNotRunningError = {
  kind: "relay-not-running";
  message: string;
  url?: string;
};

/** The relay answered but rejected the token (the tokenless liveness probe resolved against its 401). */
export type RelayTokenRejectedError = {
  kind: "relay-token-rejected";
  message: string;
  url?: string;
};

export type ProtocolError =
  | ConnectionTimeoutError
  | CORSError
  | SchemaParseError
  | ProtocolVersionMismatchError
  | TransportError
  | ProtocolRemoteError
  | AuthError
  | DisconnectedError
  | SessionExpiredError
  | TargetBlockedError
  | RelayNotRunningError
  | RelayTokenRejectedError;

/**
 * The HTTP status a failure carried, or undefined if none. A present status means
 * the server actually responded at the HTTP layer (401/403/404/5xx) — a genuine
 * server reply — vs. a no-bytes failure (timeout, CORS, network, disconnect).
 *
 * Reads the `status` field structurally rather than enumerating kinds, so a new
 * status-bearing variant is recognized as a server reply automatically instead of
 * silently degrading to a no-response diagnostic.
 */
function httpStatusOf(error: ProtocolError): number | undefined {
  return "status" in error && typeof error.status === "number" ? error.status : undefined;
}

/**
 * Kinds that mean the server actually sent us bytes even though no HTTP status
 * rode along: a JSON-RPC error from the peer, a successful reply we rejected for
 * its negotiated version, or a reply whose body didn't parse. (HTTP-status
 * failures are covered by `httpStatusOf`.)
 */
const SERVER_REPLY_KINDS = new Set<ProtocolError["kind"]>([
  "protocol-remote",
  "protocol-version-mismatch",
  "schema-parse",
]);

/**
 * Whether `error` represents a genuine reply the server sent — an HTTP-status
 * error, a JSON-RPC error, or a response we received but rejected — vs. a no-bytes
 * failure (timeout, CORS, network, disconnect). This is the single decision both
 * `connect` and `invoke` make on a caught failure: a reply becomes an error trace
 * row; a no-bytes failure becomes a no-response diagnostic.
 */
export function isServerReply(error: ProtocolError): boolean {
  return httpStatusOf(error) !== undefined || SERVER_REPLY_KINDS.has(error.kind);
}

/** Throwable wrapper so protocol errors keep a stack trace and `instanceof` works. */
export class ProtocolException extends Error {
  readonly error: ProtocolError;
  constructor(error: ProtocolError) {
    super(error.message);
    this.name = "ProtocolException";
    this.error = error;
  }
}

export function isProtocolException(e: unknown): e is ProtocolException {
  return e instanceof ProtocolException;
}

/** Convenience constructor: `throw protocolError({ kind: "cors", ... })`. */
export function protocolError(error: ProtocolError): ProtocolException {
  return new ProtocolException(error);
}

/**
 * Thrown by a transport for a non-OK HTTP status, carrying the status and url so
 * the protocol can decide on fallback and the classifier can preserve the code.
 * Lives here (not in a transport) so `classify` reads it without depending on
 * `transports/`; transports import it from this protocol-level home.
 */
export class HTTPStatusError extends Error {
  readonly status: number;
  readonly url: string;
  /** Value of the upstream `WWW-Authenticate` response header, if present. */
  readonly wwwAuthenticate?: string;
  /** 4348: the (truncated) response body and headers, so a failed request is inspectable in the trace. */
  readonly body?: string;
  readonly responseHeaders?: Record<string, string>;

  constructor(
    status: number,
    url: string,
    wwwAuthenticate?: string,
    body?: string,
    responseHeaders?: Record<string, string>,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HTTPStatusError";
    this.status = status;
    this.url = url;
    this.wwwAuthenticate = wwwAuthenticate;
    this.body = body;
    this.responseHeaders = responseHeaders;
  }
}

/**
 * The backend proxy returned its own { error, message } envelope (4xx/5xx),
 * distinct from a non-OK status relayed from the upstream server.
 */
export class ProxyEnvelopeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly target: string;

  constructor(code: string, message: string, status: number, target: string) {
    super(message);
    this.name = "ProxyEnvelopeError";
    this.code = code;
    this.status = status;
    this.target = target;
  }
}

/**
 * The abort reason raised when the client tears a connection down on purpose
 * (`disconnect`). A typed reason (vs a magic `DOMException("disconnect")`
 * message) lets `classify` recognize an intentional close structurally rather
 * than by string-matching. Extends Error so it carries a stack and reads
 * sensibly if it ever surfaces as a rejection.
 */
export class DisconnectError extends Error {
  constructor(message = "Connection closed by client") {
    super(message);
    this.name = "DisconnectError";
  }
}

/**
 * Raised to abort an in-flight request because the *user* cancelled it (vs. a
 * timeout or a disconnect). Carries the human reason in `message`; it is the
 * signal `MCPHTTPProtocol.invoke` reads off the abort to choose the cancelled
 * trace path and send `notifications/cancelled`.
 */
export class CancelledByUser extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CancelledByUser";
  }
}
