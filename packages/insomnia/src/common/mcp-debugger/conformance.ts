import { type McpProtocolVersion, STATELESS_VERSION, SUPPORTED_VERSIONS } from './versions';

// Task 4348 S6b: the conformance report. Pure types, judgments and the verdict, so they can be unit tested without a
// network; the probing lives in main/mcp-debugger/conformance.ts. The point is to tell a developer quickly whether a
// server speaks the newest MCP spec, where it does not, and where it only looks current but behaves like an older
// protocol, so nobody burns a day chasing a server that is a year out of date. Isomorphic (no window, no Node).
// PROTOTYPE-MOCK: the checks encode our reading of the 2026-07-28 and older specs; they are signals, not a certified test suite.

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'skipped';
export type CheckGroup = 'modern' | 'session' | 'transport' | 'auth';

/** One HTTP exchange behind a check, shown on demand so every verdict can be verified by eye. */
export interface ConformanceProbe {
  request: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response?: { status: number; headers: Record<string, string>; body: unknown };
  error?: string;
}

export interface ConformanceCheck {
  id: string;
  group: CheckGroup;
  title: string;
  status: CheckStatus;
  detail: string;
  /** The protocol version the check ran against, when it is version specific. */
  version?: string;
  probe?: ConformanceProbe;
}

/** `via-sse` = accepted over the legacy HTTP+SSE transport rather than a POST. */
export type VersionOutcome = 'accepted' | 'via-sse' | 'counter-offered' | 'rejected' | 'unknown';
export interface VersionResult {
  version: McpProtocolVersion;
  outcome: VersionOutcome;
  note: string;
}

export type VerdictLevel = 'current' | 'behind' | 'legacy-transport' | 'auth-blocked' | 'unreachable' | 'unknown';
export interface ConformanceVerdict {
  level: VerdictLevel;
  headline: string;
  detail: string;
  newestAccepted?: McpProtocolVersion;
  /** Whole months between the newest version the server accepts and the newest version we know. */
  monthsBehind?: number;
}

export interface ConformanceReport {
  url: string;
  ranAt: string;
  versions: VersionResult[];
  checks: ConformanceCheck[];
  verdict: ConformanceVerdict;
}

export const NEWEST_VERSION = SUPPORTED_VERSIONS[0];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const jsonRpcResult = (body: unknown): Record<string, unknown> | undefined =>
  isRecord(body) && isRecord(body.result) ? body.result : undefined;

export const jsonRpcError = (body: unknown): { code: number; message: string; data?: unknown } | undefined => {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== 'number') {
    return undefined;
  }
  return { code: body.error.code, message: String(body.error.message ?? ''), data: body.error.data };
};

/** Whole months from one `YYYY-MM-DD` spec version to a later one. */
export const monthsBetween = (older: string, newer: string): number => {
  const [y1, m1, d1] = older.split('-').map(Number);
  const [y2, m2, d2] = newer.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
};

const makeCheck = (
  id: string,
  group: CheckGroup,
  title: string,
  status: CheckStatus,
  detail: string,
  extra: Pick<ConformanceCheck, 'version' | 'probe'> = {},
): ConformanceCheck => ({ id, group, title, status, detail, ...extra });
export { makeCheck };

/** `serverInfo`, `capabilities` and (for discover) `supportedVersions` are what every handshake result must carry. */
export const checkHandshakeShape = (
  group: CheckGroup,
  idPrefix: string,
  result: Record<string, unknown>,
  extra: Pick<ConformanceCheck, 'version' | 'probe'>,
  opts: { requireSupportedVersions?: boolean } = {},
): ConformanceCheck[] => {
  const problems: string[] = [];
  const serverInfo = result.serverInfo;
  if (!isRecord(serverInfo) || typeof serverInfo.name !== 'string' || typeof serverInfo.version !== 'string') {
    problems.push('serverInfo with a string name and version is missing');
  }
  if (!isRecord(result.capabilities)) {
    problems.push('capabilities is not an object');
  }
  if (opts.requireSupportedVersions && (!Array.isArray(result.supportedVersions) || result.supportedVersions.some(v => typeof v !== 'string'))) {
    problems.push('supportedVersions is not an array of strings');
  }
  if (!opts.requireSupportedVersions && typeof result.protocolVersion !== 'string') {
    problems.push('protocolVersion is not a string');
  }
  return [
    makeCheck(
      `${idPrefix}-shape`,
      group,
      'Handshake result has the required fields',
      problems.length === 0 ? 'pass' : 'fail',
      problems.length === 0 ? 'serverInfo, capabilities and the version fields are all present.' : `${problems.join('; ')}.`,
      extra,
    ),
  ];
};

const LIST_KEYS: Record<string, { key: string; required: string[] }> = {
  'tools/list': { key: 'tools', required: ['name', 'inputSchema'] },
  'resources/list': { key: 'resources', required: ['uri', 'name'] },
  'prompts/list': { key: 'prompts', required: ['name'] },
};

/** Check the shape of a list result (`tools/list`, `resources/list`, `prompts/list`). */
export const checkListResult = (
  method: string,
  group: CheckGroup,
  result: Record<string, unknown> | undefined,
  error: { code: number; message: string } | undefined,
  extra: Pick<ConformanceCheck, 'version' | 'probe'>,
  idPrefix: string,
): ConformanceCheck => {
  const spec = LIST_KEYS[method];
  const id = `${idPrefix}-${method.replace('/', '-')}`;
  const title = `${method} returns a well-formed list`;
  if (error) {
    return makeCheck(id, group, title, 'fail', `The server advertises this capability but answered with error ${error.code}: ${error.message}`, extra);
  }
  const items = result?.[spec.key];
  if (!Array.isArray(items)) {
    return makeCheck(id, group, title, 'fail', `The result has no "${spec.key}" array.`, extra);
  }
  const bad = items.findIndex(item => !isRecord(item) || spec.required.some(field => !(field in item)));
  if (bad !== -1) {
    return makeCheck(id, group, title, 'fail', `Entry ${bad} in "${spec.key}" is missing one of: ${spec.required.join(', ')}.`, extra);
  }
  if (method === 'tools/list') {
    const badSchema = items.findIndex(t => !isRecord((t as Record<string, unknown>).inputSchema) || (t as { inputSchema: Record<string, unknown> }).inputSchema.type !== 'object');
    if (badSchema !== -1) {
      return makeCheck(id, group, title, 'warn', `Tool ${badSchema} has an inputSchema that is not a JSON Schema object (type: "object").`, extra);
    }
  }
  return makeCheck(id, group, title, 'pass', `${items.length} ${spec.key} returned, all with the required fields.`, extra);
};

/** The list methods a server's declared capabilities say it supports. */
export const listMethodsFor = (capabilities: unknown): string[] => {
  const caps = isRecord(capabilities) ? capabilities : {};
  return (['tools', 'resources', 'prompts'] as const).filter(name => name in caps).map(name => `${name}/list`);
};

/** What the server answered to a deliberately unknown method: `-32601` is the only correct answer. */
export const checkUnknownMethod = (
  group: CheckGroup,
  idPrefix: string,
  status: number | undefined,
  body: unknown,
  extra: Pick<ConformanceCheck, 'version' | 'probe'>,
): ConformanceCheck => {
  const error = jsonRpcError(body);
  const title = 'Unknown methods are rejected with -32601';
  if (error?.code === -32_601) {
    return makeCheck(`${idPrefix}-unknown-method`, group, title, 'pass', 'Method not found (-32601), as the spec requires.', extra);
  }
  if (error) {
    return makeCheck(`${idPrefix}-unknown-method`, group, title, 'warn', `Answered with ${error.code} (${error.message}) instead of -32601.`, extra);
  }
  return makeCheck(
    `${idPrefix}-unknown-method`,
    group,
    title,
    'warn',
    status !== undefined && status >= 400 ? `Answered HTTP ${status} without a JSON-RPC error body.` : 'The server accepted a method that does not exist.',
    extra,
  );
};

/**
 * Turn everything we learned into one plain-language verdict. `reachable` is false when no probe got any HTTP answer;
 * `authBlocked` when the server demanded credentials we did not have, so nothing else could be judged.
 */
export const summarizeConformance = ({
  versions,
  checks,
  reachable,
  authBlocked,
}: {
  versions: VersionResult[];
  checks: ConformanceCheck[];
  reachable: boolean;
  authBlocked: boolean;
}): ConformanceVerdict => {
  if (!reachable) {
    return { level: 'unreachable', headline: 'The server did not answer', detail: 'No probe got an HTTP response. Check the URL, the network and any proxy or TLS settings.' };
  }
  if (authBlocked) {
    return {
      level: 'auth-blocked',
      headline: 'The server requires authentication',
      detail: 'It refused the probes with 401/403, so its protocol version could not be judged. Add credentials (or run the OAuth debugger) and run this again. The auth checks below still ran.',
    };
  }
  const accepted = SUPPORTED_VERSIONS.find(v => versions.some(r => r.version === v && (r.outcome === 'accepted' || r.outcome === 'via-sse')));
  const newestAccepted = accepted;
  const problems = checks.filter(c => c.status === 'fail').length;
  const warnings = checks.filter(c => c.status === 'warn').length;
  const tally = `${problems} failing check${problems === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'}`;
  if (!newestAccepted) {
    return {
      level: 'unknown',
      headline: 'Answered, but not with a protocol version Insomnia supports',
      detail: 'The server responded, yet accepted none of 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26 or 2024-11-05. It may not be an MCP server at this URL, or may speak an unreleased version.',
    };
  }
  if (newestAccepted === STATELESS_VERSION) {
    // Sessions are the clearest sign of a server that adopted the new endpoint without dropping the old model.
    const oldHabits = checks.some(c => c.id === 'm-no-session' && c.status === 'warn');
    return {
      level: 'current',
      headline: `Speaks the newest protocol (${NEWEST_VERSION})`,
      detail:
        problems + warnings === 0
          ? 'Every check passed.'
          : `${tally}.${oldHabits ? ' It still uses sessions, which looks like older-protocol behavior carried over, so it may be only partly migrated.' : ''}`,
      newestAccepted,
      monthsBehind: 0,
    };
  }
  const monthsBehind = monthsBetween(newestAccepted, NEWEST_VERSION);
  const onlySse = versions.find(r => r.version === newestAccepted)?.outcome === 'via-sse';
  if (onlySse && newestAccepted === '2024-11-05') {
    return {
      level: 'legacy-transport',
      headline: 'Only the deprecated HTTP+SSE transport (2024-11-05)',
      detail: `Newest accepted: 2024-11-05 over HTTP+SSE, about ${monthsBehind} months behind ${NEWEST_VERSION}. Modern clients use Streamable HTTP; expect to have to migrate this server rather than debug around it.`,
      newestAccepted,
      monthsBehind,
    };
  }
  return {
    level: 'behind',
    headline: `Out of date: newest protocol accepted is ${newestAccepted}`,
    detail: `About ${monthsBehind} months behind ${NEWEST_VERSION}. It has no server/discover, stateless requests, multi round-trip input, tasks or subscriptions, so features from the newest spec will not work against it. ${tally}.`,
    newestAccepted,
    monthsBehind,
  };
};
