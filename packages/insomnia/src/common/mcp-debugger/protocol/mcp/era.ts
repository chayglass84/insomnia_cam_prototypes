import { STATELESS_VERSION } from "./negotiate/versions";
import type { MCPConnection } from "./wire/connection";

/**
 * The stateless-vs-legacy era split is the single biggest concept in this client,
 * so it gets one home here rather than being re-derived (via `protocolVersion ===
 * STATELESS_VERSION`) across the wireformat, connection, and protocol layers.
 *
 * The stateless RC era (2026-07-28+) uses stateless HTTP: no `initialize`
 * handshake, no session id, and per-request `_meta` + mirrored headers. The legacy
 * era (2025-11-25 and earlier) uses the `initialize` handshake and a session id.
 */
export function isStatelessConnection(conn: MCPConnection): boolean {
  return conn.protocolVersion === STATELESS_VERSION;
}
