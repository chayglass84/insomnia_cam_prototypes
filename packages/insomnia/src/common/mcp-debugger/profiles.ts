import { eraOfVersion, type McpEra, type McpProtocolVersion, SUPPORTED_VERSIONS } from './versions';

/**
 * Everything that differs per protocol version lives here, so the UI is one shell that swaps profiles
 * (see 4348.md "Version-adaptive UI"). Tabs/events are data, not branches scattered through components.
 *
 * PROTOTYPE-MOCK: `tabs` and `traceEventKinds` describe the INTENDED UI per version. S0 only renders them as a
 * preview list; real tabs land per slice (S1 core, S3 legacy, S4 tasks/subscriptions).
 */
export type McpDebuggerTabId =
  | 'tools'
  | 'resources'
  | 'prompts'
  | 'tasks'
  | 'subscriptions'
  | 'roots'
  | 'sampling'
  | 'logging'
  | 'ping';

export interface McpProtocolProfile {
  version: McpProtocolVersion;
  era: McpEra;
  tabs: McpDebuggerTabId[];
  /** Wire concepts that exist only in this version; the trace labels them. */
  traceEventKinds: string[];
  /** Fields the request builder shows. */
  builderFields: string[];
  /** Transports this version can use. */
  transports: ('streamable-http' | 'http-sse' | 'stdio')[];
}

const CORE_TABS: McpDebuggerTabId[] = ['tools', 'resources', 'prompts'];

const STATELESS_PROFILE: McpProtocolProfile = {
  version: '2026-07-28',
  era: 'stateless',
  tabs: [...CORE_TABS, 'tasks', 'subscriptions'],
  traceEventKinds: ['server/discover', 'input_required (MRTR)', 'tasks', 'subscriptions/listen'],
  builderFields: ['_meta', 'Mcp-Method / Mcp-Name headers', 'cache hints (ttlMs / cacheScope)'],
  transports: ['streamable-http', 'stdio'],
};

const sessionProfile = (version: McpProtocolVersion, extra: Partial<McpProtocolProfile> = {}): McpProtocolProfile => ({
  version,
  era: eraOfVersion(version),
  tabs: [...CORE_TABS, 'roots', 'sampling', 'logging', 'ping'],
  traceEventKinds: ['initialize handshake', 'Mcp-Session-Id', 'elicitation/create', 'sampling/createMessage', 'roots/list'],
  builderFields: ['Mcp-Session-Id', 'MCP-Protocol-Version header'],
  transports: ['streamable-http', 'stdio'],
  ...extra,
});

export const PROFILES: Record<McpProtocolVersion, McpProtocolProfile> = {
  '2026-07-28': STATELESS_PROFILE,
  '2025-11-25': sessionProfile('2025-11-25', { traceEventKinds: ['initialize handshake', 'Mcp-Session-Id', 'SSE resume (Last-Event-ID)', 'elicitation/create', 'sampling/createMessage', 'roots/list', 'tasks (experimental)'] }),
  '2025-06-18': sessionProfile('2025-06-18'),
  '2025-03-26': sessionProfile('2025-03-26', { tabs: [...CORE_TABS, 'roots', 'sampling', 'logging', 'ping'] }),
  '2024-11-05': sessionProfile('2024-11-05', { transports: ['http-sse', 'stdio'], traceEventKinds: ['initialize handshake', 'HTTP+SSE endpoint event', 'sampling/createMessage', 'roots/list'] }),
};

export const getProfile = (version: McpProtocolVersion): McpProtocolProfile => PROFILES[version];

export const ALL_PROFILES = SUPPORTED_VERSIONS.map(getProfile);
