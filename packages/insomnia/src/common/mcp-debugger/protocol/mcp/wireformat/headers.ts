import { isStatelessConnection } from "../era";
import type { MCPConnection } from "../wire/connection";
import { withStatelessMeta } from "./params";

/**
 * Per-call options for header injection on stateless RC (2026-07-28) requests.
 * `method` sets `Mcp-Method` (required on all stateless requests); `name` sets
 * `Mcp-Name` (required for tools/call, resources/read, prompts/get — sourced
 * from params.name or params.uri). `paramHeaders` carries the already-encoded
 * `Mcp-Param-{Name}: value` entries for x-mcp-header mirroring.
 */
export type McpCallOpts = {
  method?: string;
  name?: string;
  paramHeaders?: Record<string, string>;
};

/**
 * Build the request headers for one MCP call. Stateless RC (2026-07-28) sends
 * MCP-Protocol-Version + Mcp-Method + optional Mcp-Name + Mcp-Param-* entries.
 * Legacy (initialize-based) sends Mcp-Session-Id + MCP-Protocol-Version.
 *
 * Auth headers come from `conn.getRequestHeaders()`, read fresh on every call so a
 * refreshed OAuth access token is picked up by the next request. This is why
 * auth lives here and not on the transport: the transport would otherwise have
 * to snapshot a token at connect time and go stale across a refresh.
 */
export function requestHeadersFor(conn: MCPConnection, opts?: McpCallOpts): Record<string, string> {
  const headers: Record<string, string> = { ...conn.getRequestHeaders() };
  if (isStatelessConnection(conn)) {
    if (conn.protocolVersion) headers["MCP-Protocol-Version"] = conn.protocolVersion;
    if (opts?.method) headers["Mcp-Method"] = opts.method;
    if (opts?.name) headers["Mcp-Name"] = opts.name;
    if (opts?.paramHeaders) Object.assign(headers, opts.paramHeaders);
  } else {
    if (conn.sessionId) headers["Mcp-Session-Id"] = conn.sessionId;
    if (conn.protocolVersion) headers["MCP-Protocol-Version"] = conn.protocolVersion;
  }
  return headers;
}

/**
 * Build stateless routing headers for the `server/discover` probe — called
 * before a connection exists, so `conn` isn't available yet.
 */
export function probeHeadersFor(version: string, method: string): Record<string, string> {
  return { "MCP-Protocol-Version": version, "Mcp-Method": method };
}

/**
 * Build the wire payload + headers for a fire-and-forget JSON-RPC notification
 * (e.g. `notifications/cancelled`, `notifications/initialized`). On a stateless
 * connection the spec requires the same per-request metadata as a request:
 * `_meta` (protocol version / client identity) in the body and the mirrored
 * `Mcp-Method` header. On a legacy connection neither applies — the frame is the
 * bare notification with session/version headers. Centralizes the era split so
 * every notification sender is correct by construction.
 */
export function notificationFrame(
  conn: MCPConnection,
  method: string,
  params: Record<string, unknown>,
): { payload: unknown; headers: Record<string, string> } {
  if (isStatelessConnection(conn)) {
    return {
      payload: { jsonrpc: "2.0", method, params: withStatelessMeta(conn.protocolVersion, params) },
      headers: requestHeadersFor(conn, { method }),
    };
  }
  return {
    payload: { jsonrpc: "2.0", method, params },
    headers: requestHeadersFor(conn),
  };
}
