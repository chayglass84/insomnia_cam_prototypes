import type { ResponseHeader } from 'insomnia-data';

// Prototype (3593AI): a static registry that recognises the response headers Kong plugins add, groups them by
// plugin, and (optionally) boils each group down to ONE short summary line. To support another plugin, add an
// entry to PLUGIN_HEADER_DEFS — nothing else in the UI needs to change.
//
// PROTOTYPE SHORTCUT: detection is by header-name pattern only. Rate-limiting vs rate-limiting-advanced emit the
// same header names, so which one is shown comes from cross-checking the route's attached plugins (when known).

export interface PluginHeaderGroup {
  /** Registry key, e.g. 'rate-limiting'. */
  id: string;
  /** Display label, e.g. 'Rate Limiting'. */
  label: string;
  /** Konnect plugin names actually attached to the route that this group could belong to (may be empty/unknown). */
  pluginNames: string[];
  headers: ResponseHeader[];
  /** One-line summary, or null if the headers don't carry enough to say anything useful. */
  summary: string | null;
  /** Extra advice that needs the REQUEST too (e.g. "your Origin doesn't match"); null when there is none. */
  hint: string | null;
  /** Show the hint above the summary lines (status-code hints lead with the problem). */
  hintFirst?: boolean;
}

/** The slice of the request the registry may look at. Disabled headers are ignored by callers' convention. */
export interface PluginRequestContext {
  headers: { name: string; value: string; disabled?: boolean }[];
  /** Query parameters (used by key-auth to see whether a key was sent). */
  parameters?: { name: string; value: string; disabled?: boolean }[];
}

// All Konnect plugin UI shares the Kong lime accent. Literal Tailwind classes so Tailwind picks them up.
// Kong lime is #CCFF00 (see kong-logo.tsx).
export const KONNECT_PLUGIN_TEXT_CLASS = 'text-[#CCFF00]';

interface PluginHeaderDef {
  id: string;
  label: string;
  /** Konnect plugin names this def can represent. */
  pluginNames: string[];
  /** Names (lowercased) claimed outright. */
  matchesHeader: (lowerName: string) => boolean;
  /** Names claimed only if matchesHeader hit at least one other header (e.g. Retry-After). */
  matchesCompanionHeader?: (lowerName: string) => boolean;
  summarize: (headers: ResponseHeader[]) => string | null;
  hint?: (responseHeaders: ResponseHeader[], request: PluginRequestContext) => string | null;
  /** Advice when the plugin is attached to the route but NONE of its headers came back. `config` is the plugin's config. */
  missingHint?: (request: PluginRequestContext, config: Record<string, unknown>) => string | null;
}

const RATE_LIMIT_HEADER = /^(?:x-)?ratelimit-(limit|remaining|reset)(?:-(.+))?$/;

const WINDOW_LABELS: Record<string, string> = {
  second: 'second',
  minute: 'minute',
  hour: 'hour',
  day: 'day',
  month: 'month',
  year: 'year',
};

// rate-limiting uses names (minute/hour/…), rate-limiting-advanced uses the window size in seconds (e.g. "30").
const windowLabel = (raw: string): string => {
  if (WINDOW_LABELS[raw]) {
    return `this ${WINDOW_LABELS[raw]}`;
  }
  return /^\d+$/.test(raw) ? `per ${raw}s` : `(${raw})`;
};

const WINDOW_ORDER = ['second', 'minute', 'hour', 'day', 'month', 'year'];
const windowRank = (raw: string) => {
  const i = WINDOW_ORDER.indexOf(raw);
  return i === -1 ? 100 + (Number(raw) || 0) : i;
};

function summarizeRateLimit(headers: ResponseHeader[]): string | null {
  const remainingByWindow = new Map<string, string>();
  let plainRemaining: string | null = null;
  let retryAfter: string | null = null;
  for (const { name, value } of headers) {
    const lower = name.toLowerCase();
    if (lower === 'retry-after') {
      retryAfter = value;
      continue;
    }
    const m = RATE_LIMIT_HEADER.exec(lower);
    if (m?.[1] !== 'remaining') {
      continue;
    }
    if (m[2]) {
      remainingByWindow.set(m[2], value);
    } else {
      plainRemaining = value;
    }
  }
  const parts = [...remainingByWindow.entries()]
    .sort(([a], [b]) => windowRank(a) - windowRank(b))
    .map(([window, value]) => `${value} left ${windowLabel(window)}`);
  // Draft-standard `RateLimit-Remaining` has no window; only use it when nothing more specific exists.
  if (parts.length === 0 && plainRemaining !== null) {
    parts.push(`${plainRemaining} left`);
  }
  if (retryAfter !== null) {
    parts.push(`retry after ${retryAfter}s`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

const CORS_HEADER = /^access-control-(?:allow-|expose-|max-age$)/;

function summarizeCors(headers: ResponseHeader[]): string | null {
  const get = (name: string) => headers.find(h => h.name.toLowerCase() === `access-control-${name}`)?.value.trim();
  const origin = get('allow-origin');
  const methods = get('allow-methods');
  const parts: string[] = [];
  if (origin) {
    parts.push(origin === '*' ? 'any domain' : origin);
  }
  if (methods) {
    parts.push(methods.split(/\s*,\s*/).join('/'));
  }
  if (get('allow-credentials')?.toLowerCase() === 'true') {
    parts.push('credentials');
  }
  return parts.length > 0 ? `Allows: ${parts.join(', ')}` : null;
}

/** Value of an enabled request header, or undefined. */
export const getRequestHeader = (request: PluginRequestContext, name: string): string | undefined =>
  request.headers.find(h => !h.disabled && h.name.toLowerCase() === name.toLowerCase())?.value.trim();

// PROTOTYPE SHORTCUT: compares raw strings; a request Origin that is still a {{ template }} is skipped.
function corsHint(responseHeaders: ResponseHeader[], request: PluginRequestContext): string | null {
  const allowed = responseHeaders.find(h => h.name.toLowerCase() === 'access-control-allow-origin')?.value.trim();
  const sent = getRequestHeader(request, 'origin');
  if (!allowed) {
    return null;
  }
  if (!sent) {
    return 'Origin header missing';
  }
  if (sent.includes('{{') || allowed === '*' || allowed === sent) {
    return null;
  }
  return `Allowed origin (${allowed}) doesn't match your Origin (${sent}); a browser would block this.`;
}

function corsMissingHint(request: PluginRequestContext, config: Record<string, unknown>): string | null {
  const sent = getRequestHeader(request, 'origin');
  if (!sent) {
    return 'Origin header missing';
  }
  if (sent.includes('{{')) {
    return null;
  }
  const origins = Array.isArray(config.origins) ? config.origins.filter((o): o is string => typeof o === 'string') : [];
  return origins.length > 0
    ? `No CORS headers came back: your Origin (${sent}) isn't allowed. Allowed: ${origins.join(', ')}.`
    : `No CORS headers came back for your Origin (${sent}).`;
}

const PLUGIN_HEADER_DEFS: PluginHeaderDef[] = [
  {
    id: 'rate-limiting',
    label: 'Rate Limiting',
    pluginNames: ['rate-limiting', 'rate-limiting-advanced'],
    matchesHeader: lower => RATE_LIMIT_HEADER.test(lower),
    matchesCompanionHeader: lower => lower === 'retry-after',
    summarize: summarizeRateLimit,
  },
  {
    // PROTOTYPE SHORTCUT: header-only. The plugin sends nothing unless the request carries an Origin header.
    id: 'cors',
    label: 'CORS',
    pluginNames: ['cors'],
    matchesHeader: lower => CORS_HEADER.test(lower),
    summarize: summarizeCors,
    hint: corsHint,
    missingHint: corsMissingHint,
  },
];

/**
 * Plugins that are attached (and enabled) on the route but returned none of their headers, with advice on why.
 * `attached` null = unknown (not linked or still loading): no advice.
 */
export function getMissingPluginHints(
  responseHeaders: ResponseHeader[],
  attached: { name: string; config: Record<string, unknown> }[] | null,
  request: PluginRequestContext,
): { id: string; label: string; hint: string }[] {
  const out: { id: string; label: string; hint: string }[] = [];
  for (const def of PLUGIN_HEADER_DEFS) {
    const plugin = def.missingHint && attached?.find(p => def.pluginNames.includes(p.name));
    if (!plugin || responseHeaders.some(h => def.matchesHeader(h.name.toLowerCase()))) {
      continue;
    }
    const hint = def.missingHint!(request, plugin.config);
    if (hint) {
      out.push({ id: def.id, label: def.label, hint });
    }
  }
  return out;
}

/**
 * Groups the plugin-owned headers out of a response. `attachedPluginNames` is the set of enabled plugin names on
 * the route when known (null = unknown, e.g. not Konnect-linked or still loading): it only refines the label.
 */
export function groupPluginHeaders(
  headers: ResponseHeader[],
  attachedPluginNames: string[] | null,
  request: PluginRequestContext = { headers: [] },
): { groups: PluginHeaderGroup[]; otherHeaders: ResponseHeader[] } {
  const claimed = new Set<ResponseHeader>();
  const groups: PluginHeaderGroup[] = [];

  for (const def of PLUGIN_HEADER_DEFS) {
    const own = headers.filter(h => def.matchesHeader(h.name.toLowerCase()));
    if (own.length === 0) {
      continue;
    }
    const companions = def.matchesCompanionHeader
      ? headers.filter(h => !own.includes(h) && def.matchesCompanionHeader!(h.name.toLowerCase()))
      : [];
    const all = headers.filter(h => own.includes(h) || companions.includes(h));
    all.forEach(h => claimed.add(h));
    groups.push({
      id: def.id,
      label: def.label,
      pluginNames: (attachedPluginNames ?? []).filter(n => def.pluginNames.includes(n)),
      headers: all,
      summary: def.summarize(all),
      hint: def.hint?.(all, request) ?? null,
    });
  }

  return { groups, otherHeaders: headers.filter(h => !claimed.has(h)) };
}

// Headers a browser never lists in Access-Control-Request-Headers (forbidden, or CORS-safelisted).
const PREFLIGHT_SKIP_HEADERS = new Set([
  'origin',
  'host',
  'content-length',
  'accept',
  'accept-language',
  'accept-encoding',
  'user-agent',
  'connection',
  'cookie',
  'referer',
]);

/**
 * What a browser would send before the given request: an OPTIONS with Origin, Access-Control-Request-Method and
 * Access-Control-Request-Headers. Returns the patch to apply to a duplicate of the request (method, headers, no body).
 * `fallbackOrigin` is used when the request has no Origin of its own (e.g. the origin the CORS plugin allowed).
 */
export function buildPreflightPatch(
  request: { method: string; headers: { name: string; value: string; disabled?: boolean }[] },
  fallbackOrigin?: string,
) {
  const origin =
    getRequestHeader(request, 'origin') || (fallbackOrigin && fallbackOrigin !== '*' ? fallbackOrigin : '');
  const requestHeaderNames = [
    ...new Set(
      request.headers
        .filter(h => !h.disabled && h.name && !PREFLIGHT_SKIP_HEADERS.has(h.name.toLowerCase()))
        .map(h => h.name.toLowerCase()),
    ),
  ];
  const ours = new Set(['origin', 'access-control-request-method', 'access-control-request-headers']);
  const headers = [
    ...request.headers.filter(h => !ours.has(h.name.toLowerCase())),
    { name: 'Origin', value: origin || 'https://example.com' },
    { name: 'Access-Control-Request-Method', value: request.method },
    ...(requestHeaderNames.length > 0
      ? [{ name: 'Access-Control-Request-Headers', value: requestHeaderNames.join(',') }]
      : []),
  ];
  return { method: 'OPTIONS', headers, body: {} };
}

// ---------------------------------------------------------------------------------------------------------------
// Hint strings may wrap a word in **double asterisks** to bold it; the UI renders that (see renderHint).
// Status-code hints: plugins that leave NO response headers (key-auth, acl) but whose failures are recognisable
// from the status code plus what the request sent and how the plugin is configured.
// PROTOTYPE SHORTCUT: assumes the attached plugin caused the status (a 401 with key-auth attached is blamed on it).
// ---------------------------------------------------------------------------------------------------------------

interface StatusHintDef {
  id: string;
  label: string;
  pluginName: string;
  status: number;
  hint: (request: PluginRequestContext, config: Record<string, unknown>) => string | null;
  /** Optional detail lines (newline-separated "Lead: details"), shown under the hint in the same style as summaries. */
  summary?: (config: Record<string, unknown>) => string | null;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function keyAuthHint(request: PluginRequestContext, config: Record<string, unknown>): string | null {
  const names = stringList(config.key_names).length > 0 ? stringList(config.key_names) : ['apikey'];
  const inHeader = config.key_in_header !== false;
  const inQuery = config.key_in_query !== false;
  const lower = names.map(n => n.toLowerCase());
  const sentName =
    (inHeader &&
      request.headers.find(h => !h.disabled && lower.includes(h.name.toLowerCase()) && h.value.trim())?.name) ||
    (inQuery &&
      (request.parameters ?? []).find(p => !p.disabled && lower.includes(p.name.toLowerCase()) && p.value.trim())
        ?.name) ||
    null;
  if (sentName) {
    return `Invalid API key (**${sentName}** was sent).`;
  }
  const where = [inHeader && 'header', inQuery && 'query param'].filter(Boolean).join(' or ') || 'request';
  return `No API key. Send **${names.join('** or **')}** as a ${where}.`;
}

function aclSummary(config: Record<string, unknown>): string | null {
  const allow = stringList(config.allow);
  const deny = stringList(config.deny);
  const lines = [allow.length > 0 && `Allows: ${allow.join(', ')}`, deny.length > 0 && `Denies: ${deny.join(', ')}`];
  return lines.filter(Boolean).join('\n') || null;
}

const STATUS_HINT_DEFS: StatusHintDef[] = [
  { id: 'key-auth', label: 'Key Auth', pluginName: 'key-auth', status: 401, hint: keyAuthHint },
  {
    id: 'acl',
    label: 'ACL',
    pluginName: 'acl',
    status: 403,
    hint: () => 'You do not have access.',
    summary: aclSummary,
  },
];

/** Hints for attached plugins that explain the response's status code. `attached` null = unknown: no hints. */
export function getStatusPluginHints(
  statusCode: number,
  attached: { name: string; config: Record<string, unknown> }[] | null,
  request: PluginRequestContext,
): { id: string; label: string; hint: string; summary: string | null; hintFirst: true }[] {
  const out: { id: string; label: string; hint: string; summary: string | null; hintFirst: true }[] = [];
  for (const def of STATUS_HINT_DEFS) {
    const plugin = def.status === statusCode && attached?.find(p => p.name === def.pluginName);
    const hint = plugin ? def.hint(request, plugin.config) : null;
    if (plugin && hint) {
      out.push({
        id: def.id,
        label: def.label,
        hint,
        summary: def.summary?.(plugin.config) ?? null,
        hintFirst: true,
      });
    }
  }
  return out;
}
