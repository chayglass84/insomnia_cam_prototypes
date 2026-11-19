import {
  DisconnectError,
  HTTPStatusError,
  isProtocolException,
  protocolError,
  ProtocolException,
  ProxyEnvelopeError,
} from "../../errors";

interface ClassifyContext {
  url: string;
  origin: string | null;
  /** Whether the request that failed carried an Mcp-Session-Id header.
   *  Used to disambiguate a 404 as session-expired vs a generic not-found. */
  hadSessionId?: boolean;
}

function isMixedContent(url: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return origin.startsWith("https:") && new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

const PROXY_PROTOCOL_REMOTE_ERROR_CODES = new Set([
  "invalid_target",
  "invalid_method",
  "invalid_headers",
  "invalid_request",
  "request_too_large",
]);

const PROXY_TRANSPORT_ERROR_CODES = new Set([
  "target_unreachable",
  "upstream_error",
  "upstream_protocol_error",
]);

function classifyProxyError(err: ProxyEnvelopeError): ProtocolException {
  const asTransport = (message: string): ProtocolException =>
    protocolError({
      kind: "transport",
      message,
      url: err.target,
      cause: err,
      status: err.status,
    });

  if (err.code === "target_blocked") {
    return protocolError({
      kind: "target-blocked",
      message: `The target address is blocked by the proxy (${err.target})`,
      url: err.target,
      status: err.status,
    });
  }

  if (err.code === "proxy_overloaded") {
    return asTransport(`${err.message} (retry later)`);
  }

  if (PROXY_PROTOCOL_REMOTE_ERROR_CODES.has(err.code)) {
    return protocolError({
      kind: "protocol-remote",
      message: err.message,
    });
  }

  if (PROXY_TRANSPORT_ERROR_CODES.has(err.code)) {
    return asTransport(err.message);
  }

  return asTransport(err.message);
}

/**
 * Stateless RC error codes from the MCP 2026-07-28 draft spec schema:
 * https://github.com/modelcontextprotocol/specification/blob/main/schema/draft/schema.ts
 *
 * -32004 UNSUPPORTED_PROTOCOL_VERSION and -32003 MISSING_REQUIRED_CLIENT_CAPABILITY
 * are defined as named constants in schema.ts. -32001 HeaderMismatch appears only in
 * the binding prose (not in schema.ts), so it is recognized defensively.
 */
const STATELESS_JSONRPC_ERROR_CODES = new Set([-32004, -32003, -32001]);

/**
 * Returns true if the JSON-RPC error body indicates the server is a stateless
 * RC (2026-07-28) server — used by `discoverStateless` to distinguish a stateless
 * server that rejected our request from a legacy 400/404/405.
 */
export function isStatelessJsonRpcError(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  const err = obj["error"];
  if (err === null || typeof err !== "object") return false;
  const code = (err as Record<string, unknown>)["code"];
  return typeof code === "number" && STATELESS_JSONRPC_ERROR_CODES.has(code);
}

/** Node's fetch hides the real reason in `err.cause` (e.g. ECONNREFUSED, ENOTFOUND, certificate errors). */
function networkCauseDetail(err: TypeError): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `: ${detail}` : "";
}

/** Normalize any failure raised while talking to a server into a ProtocolException. */
export function classifyFetchError(err: unknown, ctx: ClassifyContext): ProtocolException {
  if (isProtocolException(err)) return err;

  if (err instanceof ProxyEnvelopeError) {
    return classifyProxyError(err);
  }

  if (err instanceof DisconnectError) {
    return protocolError({
      kind: "disconnected",
      message: "Connection closed by client",
    });
  }

  if (err instanceof HTTPStatusError && (err.status === 401 || err.status === 403)) {
    return protocolError({
      kind: "auth",
      message: `Authentication failed (HTTP ${err.status}) - check the credentials for ${ctx.url}`,
      url: ctx.url,
      status: err.status,
      wwwAuthenticate: err.wwwAuthenticate,
      httpBody: err.body,
      httpResponseHeaders: err.responseHeaders,
    });
  }

  if (err instanceof HTTPStatusError && err.status === 404 && ctx.hadSessionId) {
    return protocolError({
      kind: "session-expired",
      message: `The server reported the session expired (HTTP 404). Reconnect to start a new session for ${ctx.url}`,
      url: ctx.url,
      status: err.status,
    });
  }

  // Any other HTTP status (notably 5xx) the server actually returned: keep the
  // code on the transport error so a 503 reads as a server error with its code,
  // distinct from a bare network/TypeError failure.
  if (err instanceof HTTPStatusError) {
    return protocolError({
      kind: "transport",
      message: `Server returned HTTP ${err.status} (${err.url})`,
      url: ctx.url,
      status: err.status,
      cause: err,
      httpBody: err.body,
      httpResponseHeaders: err.responseHeaders,
    });
  }

  if (err instanceof TypeError) {
    if (isMixedContent(ctx.url, ctx.origin)) {
      return protocolError({
        kind: "transport",
        message: `Blocked as mixed content: cannot reach an http:// server from an https page (${ctx.url})`,
        url: ctx.url,
        cause: err,
      });
    }
    // PROTOTYPE-MOCK: Ardi ran in a browser, where any cross-origin fetch TypeError is most likely CORS. In Insomnia
    // the request runs in Electron's main process (no CORS), so a TypeError is a real network failure. The "cors"
    // branch was removed here and the underlying cause (e.g. ECONNREFUSED) is surfaced instead.
    return protocolError({
      kind: "transport",
      message: `Network request failed (${ctx.url})${networkCauseDetail(err)}`,
      url: ctx.url,
      cause: err,
    });
  }

  return protocolError({
    kind: "transport",
    message: err instanceof Error ? err.message : `Failed to reach ${ctx.url}`,
    url: ctx.url,
    cause: err,
  });
}
