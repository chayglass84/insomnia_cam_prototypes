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
}

// All Konnect plugin UI shares the Kong lime accent. Literal Tailwind classes so Tailwind picks them up.
export const KONNECT_PLUGIN_BORDER_CLASS = 'border-l-lime-500';
export const KONNECT_PLUGIN_CHIP_CLASS = 'bg-lime-500/20 text-lime-600';

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

const PLUGIN_HEADER_DEFS: PluginHeaderDef[] = [
  {
    id: 'rate-limiting',
    label: 'Rate Limiting',
    pluginNames: ['rate-limiting', 'rate-limiting-advanced'],
    matchesHeader: lower => RATE_LIMIT_HEADER.test(lower),
    matchesCompanionHeader: lower => lower === 'retry-after',
    summarize: summarizeRateLimit,
  },
];

/**
 * Groups the plugin-owned headers out of a response. `attachedPluginNames` is the set of enabled plugin names on
 * the route when known (null = unknown, e.g. not Konnect-linked or still loading): it only refines the label.
 */
export function groupPluginHeaders(
  headers: ResponseHeader[],
  attachedPluginNames: string[] | null,
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
    });
  }

  return { groups, otherHeaders: headers.filter(h => !claimed.has(h)) };
}
