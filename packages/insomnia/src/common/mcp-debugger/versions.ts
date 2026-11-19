// Ported from Ardi (kong-insomnia/ai-debugger) web/frontend/src/protocol/mcp/negotiate/versions.ts.
// Isomorphic (no window/Node imports): used by main and renderer.

/** MCP protocol versions we accept, newest first. */
export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type McpProtocolVersion = (typeof SUPPORTED_VERSIONS)[number];

/** What the user can pick: a fixed version, or Auto (probe `server/discover`, fall back to `initialize`). */
export type McpVersionChoice = 'auto' | McpProtocolVersion;
export const DEFAULT_VERSION_CHOICE: McpVersionChoice = 'auto';

/** The stateless version: no `initialize` handshake, no session id, per-request `_meta`. */
export const STATELESS_VERSION = '2026-07-28' as const;

export type McpEra = 'stateless' | 'session';

export const eraOfVersion = (version: McpProtocolVersion): McpEra => (version === STATELESS_VERSION ? 'stateless' : 'session');

export const isSupportedVersion = (value: unknown): value is McpProtocolVersion =>
  typeof value === 'string' && (SUPPORTED_VERSIONS as readonly string[]).includes(value);

export const isVersionChoice = (value: unknown): value is McpVersionChoice => value === 'auto' || isSupportedVersion(value);
