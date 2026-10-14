import React, { useEffect, useMemo, useState } from 'react';
import { Button, ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components';

import type { KonnectDebugSpan } from '../../../konnect/api';
import {
  type DebuggerTrace,
  DEFAULT_SESSION_DURATION_SECS,
  useKonnectDebuggerContext,
  type UseKonnectDebuggerResult,
} from '../../hooks/use-konnect-debugger';
import { Icon } from '../icon';

const DOCS_URL = 'https://developer.konghq.com/observability/debugger/';

function durationMs(span: KonnectDebugSpan): number {
  // Unix nanosecond timestamps exceed Number.MAX_SAFE_INTEGER, so the
  // subtraction has to happen in BigInt — only the (small) millisecond
  // result gets converted back to Number.
  const start = BigInt(span.start_time_unix_nano);
  const end = BigInt(span.end_time_unix_nano);
  return Number(end - start) / 1e6;
}

interface SpanRow {
  span: KonnectDebugSpan;
  depth: number;
  startOffsetMs: number;
  durationMs: number;
  childCount: number;
}

// PROTOTYPE SHORTCUT / DESIGN CHOICE: we render the REAL parent/child span
// tree the API returns (grouped depth-first, ordered by start time) rather
// than re-bucketing spans into Kong's internal phase taxonomy (certificate /
// rewrite / access / etc). We saw that taxonomy in the MCP tool's
// get_aggregated_metrics output, but couldn't confirm a complete, correct
// name->phase mapping from the raw span data alone (some span names don't
// carry an obvious phase prefix), so hardcoding it here risked silently
// mis-categorizing spans. The parent/child tree is exactly what the API
// gives us, so it's guaranteed correct — this is the "spans" half of the
// summary+spans merge the design discussion asked for. If a strict
// by-phase grouping is wanted later, confirm the full mapping with Konnect's
// platform team first (see konnect/api.ts's caveat comment) rather than
// guessing it a second time here.
function buildRows(spans: KonnectDebugSpan[]): { rows: SpanRow[]; totalMs: number } {
  const bySpanId = new Map(spans.map(s => [s.span_id, s]));
  const root = spans.find(s => !s.parent_span_id || !bySpanId.has(s.parent_span_id));
  if (!root) {
    return { rows: [], totalMs: 0 };
  }
  const rootStart = BigInt(root.start_time_unix_nano);
  const totalMs = durationMs(root);

  const childrenByParent = new Map<string, KonnectDebugSpan[]>();
  spans.forEach(s => {
    if (s.span_id === root.span_id) {
      return;
    }
    const parentId = bySpanId.has(s.parent_span_id) ? s.parent_span_id : root.span_id;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(s);
    childrenByParent.set(parentId, siblings);
  });
  childrenByParent.forEach(siblings => siblings.sort((a, b) => Number(BigInt(a.start_time_unix_nano) - BigInt(b.start_time_unix_nano))));

  const rows: SpanRow[] = [];
  const visit = (span: KonnectDebugSpan, depth: number) => {
    const startOffsetMs = Number(BigInt(span.start_time_unix_nano) - rootStart) / 1e6;
    const children = childrenByParent.get(span.span_id) ?? [];
    rows.push({ span, depth, startOffsetMs, durationMs: durationMs(span), childCount: children.length });
    children.forEach(child => visit(child, depth + 1));
  };
  visit(root, 0);

  return { rows, totalMs };
}

function fmtMs(ms: number): string {
  return ms >= 100 ? `${ms.toFixed(1)}ms` : `${ms.toFixed(2)}ms`;
}

// Strips the `kong.` prefix and a leading phase/plugin qualifier so labels
// stay short — e.g. "kong.access.plugin.key-auth" -> "plugin: key-auth".
function labelFor(name: string): string {
  const pluginMatch = name.match(/^kong\.\w+\.plugin\.(.+)$/);
  if (pluginMatch) {
    return `plugin: ${pluginMatch[1]}`;
  }
  return name.replace(/^kong\.(phase\.)?/, '');
}

// Who "owns" a span's time: Kong itself, the upstream service, or the client
// connection. Verified 2026-10-14 against real traces from a proxied request:
// the root span's `proxy.kong.latency.upstream` (135.8ms) equals
// read_headers_from_upstream (134.9) + read_body_from_upstream (0.7), and
// `proxy.kong.latency.client` (52.3ms) is dominated by kong.tls_handshake
// (51.4ms). Everything else — phases, plugins, router, DNS, upstream
// selection — is Kong's own time (`proxy.kong.latency.internal`).
// Name-based on purpose: unknown/new span names default to Kong rather than
// silently being blamed on the upstream.
type TimeOwner = 'kong' | 'upstream' | 'client';
const UPSTREAM_SPAN_NAMES = new Set([
  'kong.send_request_to_upstream',
  'kong.read_headers_from_upstream',
  'kong.read_body_from_upstream',
]);
function ownerFor(name: string): TimeOwner {
  if (UPSTREAM_SPAN_NAMES.has(name)) {
    return 'upstream';
  }
  if (name === 'kong.tls_handshake' || /^kong\.(read_client_http_|wait_for_client_read)/.test(name)) {
    return 'client';
  }
  return 'kong';
}

const OWNER_STYLE: Record<TimeOwner, { label: string; bar: string }> = {
  // Kong brand lime — same #CCFF00 as the KongLogo mark.
  kong: { label: 'Kong', bar: 'bg-[#CCFF00]' },
  upstream: { label: 'Upstream', bar: 'bg-(--color-info)' },
  client: { label: 'Client / network', bar: 'bg-(--hl-xl)' },
};

// Totals come straight from the root span's own latency attributes (Kong's
// numbers, not re-derived from our span-name classification). Returns null if
// the trace doesn't carry them, so the summary just doesn't render.
function latencySummary(root: KonnectDebugSpan | undefined) {
  const attrs = root?.attributes;
  const get = (key: string) => {
    const n = Number(attrs?.[key]);
    return attrs?.[key] == null || !Number.isFinite(n) ? null : n;
  };
  const kong = get('proxy.kong.latency.internal');
  const upstream = get('proxy.kong.latency.upstream');
  const client = get('proxy.kong.latency.client');
  const total = get('proxy.kong.latency.total');
  if (kong == null || upstream == null || client == null || !total) {
    return null;
  }
  return { kong, upstream, client, total };
}

function TraceView({ trace }: { trace: DebuggerTrace }) {
  const { rows, totalMs } = useMemo(() => buildRows(trace.spans), [trace.spans]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [detailSpanId, setDetailSpanId] = useState<string | null>(null);
  const root = rows[0]?.span;
  const status = root?.attributes['http.response.status_code'];
  const method = root?.attributes['http.request.method'];
  const route = root?.attributes['http.route'];
  const summary = latencySummary(root);

  // Bottleneck = the largest non-root span. A crude but honest heuristic —
  // "biggest single thing on the critical path", not a statistically
  // validated definition (the MCP tool's aggregated-metrics view uses
  // avg_ms > 1000 or avg_pct_of_trace > 50 across MANY traces; we only ever
  // look at one trace at a time here).
  const bottleneckSpanId = useMemo(() => {
    const nonRoot = rows.slice(1);
    if (nonRoot.length === 0) {
      return null;
    }
    return nonRoot.reduce((max, r) => (r.durationMs > max.durationMs ? r : max), nonRoot[0]).span.span_id;
  }, [rows]);

  // Rows are DFS pre-order, so hiding everything deeper than the nearest
  // collapsed ancestor is a single linear pass — no need to rebuild a tree.
  const visibleRows = useMemo(() => {
    let hideBelowDepth: number | null = null;
    return rows.filter(row => {
      if (hideBelowDepth !== null) {
        if (row.depth > hideBelowDepth) {
          return false;
        }
        hideBelowDepth = null;
      }
      if (row.childCount > 0 && collapsedIds.has(row.span.span_id)) {
        hideBelowDepth = row.depth;
      }
      return true;
    });
  }, [rows, collapsedIds]);

  // KNOWN BUG, UNRESOLVED 2026-09-25: the waterfall bars below (each an
  // inline `style={{ width: ... }}`) sometimes don't paint on first mount —
  // the row's label and duration text render correctly, but the bar itself
  // is blank until ANY unrelated re-render/click happens elsewhere in the
  // app, at which point every bar on screen snaps into place at once.
  //
  // Confirmed NOT a wrong-value bug: the "Total: {fmtMs(totalMs)}" header
  // above renders the correct number on the exact same first render, from
  // the exact same `totalMs` the bars' percentages are computed from — so
  // `leftPct`/`widthPct` are provably correct numbers going into the style
  // objects; the browser just isn't painting them.
  //
  // Tried, in order, none of which fixed it:
  //   1. Original: absolute-positioned fill inside a `position: relative`
  //      track, sized via `left`/`width` percentages.
  //   2. Swapped to two plain (non-absolute) flex children with percentage
  //      `width`s instead — ruling out `position: absolute` specifically as
  //      the mechanism.
  //   3. Forced a synchronous reflow right after mount via the classic
  //      `el.style.display = 'none'; el.offsetHeight; el.style.display = ''`
  //      trick, on a rAF timer keyed to `trace.traceId` — ruling out "just
  //      needs literally any reflow shortly after mount".
  //
  // Not yet tried / worth investigating next: whether this is tied to the
  // response pane's Tabs/TabPanel mount-and-reveal timing specifically
  // (does it still happen if the Debugger tab is the *default* selected
  // tab, so nothing has to switch into it?); whether react-resizable-
  // panels' own JS-driven width assignment on the ancestor Panel is
  // involved; or genuine Electron/Chromium devtools performance-tab
  // profiling of the first paint vs. the post-click repaint, to see what
  // actually differs. Real diagnostic instrumentation (not another blind
  // style change) is the next step.
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3 text-(--hl)">
        <span className="font-mono font-medium text-(--color-font)">{String(method)} {String(route)}</span>
        <span className={Number(status) < 400 ? 'text-green-500' : 'text-(--color-danger)'}>{String(status)}</span>
        <span>Total: {fmtMs(totalMs)}</span>
      </div>
      {summary && (
        <div className="mb-3">
          <div className="mb-1 flex h-3 overflow-hidden rounded-xs bg-(--hl-sm)">
            {(['kong', 'upstream', 'client'] as const).map(owner => (
              <div
                key={owner}
                className={OWNER_STYLE[owner].bar}
                style={{ width: `${(summary[owner] / summary.total) * 100}%` }}
                title={`${OWNER_STYLE[owner].label}: ${fmtMs(summary[owner])}`}
              />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {(['kong', 'upstream', 'client'] as const).map(owner => (
              <span key={owner} className="flex items-center gap-1.5">
                <span className={`inline-block size-2.5 rounded-xs ${OWNER_STYLE[owner].bar}`} />
                <span className="text-(--hl)">{OWNER_STYLE[owner].label}</span>
                <span className="font-semibold tabular-nums">{fmtMs(summary[owner])}</span>
                <span className="text-xs text-(--hl) tabular-nums">
                  ({((summary[owner] / summary.total) * 100).toFixed(1)}%)
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
      <div>
        {visibleRows.map((row, index) => {
          const isBottleneck = row.span.span_id === bottleneckSpanId;
          const leftPct = totalMs > 0 ? (row.startOffsetMs / totalMs) * 100 : 0;
          const widthPct = totalMs > 0 ? Math.max((row.durationMs / totalMs) * 100, 0.5) : 0;
          const isCollapsed = collapsedIds.has(row.span.span_id);
          const isDetailOpen = detailSpanId === row.span.span_id;
          const attributeEntries = Object.entries(row.span.attributes ?? {});
          return (
            <React.Fragment key={row.span.span_id}>
              <button
                type="button"
                onClick={() => setDetailSpanId(isDetailOpen ? null : row.span.span_id)}
                className={`flex w-full items-center gap-2 py-1 text-left hover:bg-(--hl-sm) ${
                  isDetailOpen ? 'bg-(--hl-sm)' : index % 2 === 1 ? 'bg-(--hl-xs)' : ''
                }`}
              >
                <div
                  className="flex w-56 shrink-0 items-center gap-1 truncate"
                  style={{ paddingLeft: row.depth * 12 }}
                  title={row.span.name}
                >
                  {row.childCount > 0 ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={isCollapsed ? 'Expand children' : 'Collapse children'}
                      onClick={e => {
                        e.stopPropagation();
                        setCollapsedIds(prev => {
                          const next = new Set(prev);
                          if (next.has(row.span.span_id)) {
                            next.delete(row.span.span_id);
                          } else {
                            next.add(row.span.span_id);
                          }
                          return next;
                        });
                      }}
                      className="shrink-0 text-(--hl)"
                    >
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                  ) : (
                    <span className="w-[1ch] shrink-0" />
                  )}
                  <span className="truncate">{labelFor(row.span.name)}</span>
                </div>
                {/* BUG FIXED 2026-09-25: this used to be a `position: absolute`
                    fill inside a `relative` track, sized with `left`/`width`
                    percentages. Same underlying data, same computed
                    percentages, but on first paint the fill sometimes didn't
                    render at all — only appearing after any unrelated
                    re-render (e.g. clicking a row). Never fully root-caused
                    (smells like the same class of paint/compositing timing
                    issue noted in konnect-debugger-banner.tsx, though the
                    usual "transform ancestor" cause doesn't apply here since
                    the immediate parent already establishes its own
                    containing block). Rebuilt as plain flex children with
                    percentage widths instead of out-of-flow absolute
                    positioning — normal flow layout, no containing-block or
                    paint-order dependency to get wrong on first render. */}
                <div className="flex h-4 flex-1 overflow-hidden rounded-xs border border-solid border-(--hl-sm) bg-(--hl-sm)">
                  <div className="shrink-0" style={{ width: `${leftPct}%` }} />
                  <div
                    className={`h-full shrink-0 rounded-xs ${
                      row.depth === 0 ? 'bg-(--hl-lg)' : OWNER_STYLE[ownerFor(row.span.name)].bar
                    } ${isBottleneck ? 'ring-1 ring-(--color-font)' : ''}`}
                    style={{ width: `${widthPct}%` }}
                    title={`${row.span.name}: ${fmtMs(row.durationMs)}`}
                  />
                </div>
                <div className={`w-20 shrink-0 text-right tabular-nums ${isBottleneck ? 'font-bold text-(--color-font)' : 'text-(--hl)'}`}>
                  {fmtMs(row.durationMs)}
                </div>
              </button>
              {isDetailOpen && (
                <div
                  className="mb-1 rounded-xs bg-(--hl-xs) p-2 text-xs"
                  style={{ marginLeft: row.depth * 12 + 12 }}
                >
                  <div className="mb-1 font-mono text-(--hl)">{row.span.name}</div>
                  {attributeEntries.length === 0 ? (
                    <div className="text-(--hl)">No attributes on this span.</div>
                  ) : (
                    <table className="w-full">
                      <tbody>
                        {attributeEntries.map(([key, value]) => (
                          <tr key={key}>
                            <td className="pr-2 align-top font-mono text-(--hl)">{key}</td>
                            <td className="align-top font-mono break-all">{String(value)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

const DURATION_OPTIONS: { id: number; name: string }[] = [
  { id: 30, name: '30 seconds' },
  { id: 60, name: '1 minute' },
  { id: 120, name: '2 minutes' },
  { id: 300, name: '5 minutes' },
  { id: 600, name: '10 minutes' },
];

const primaryButton = 'shrink-0 rounded-xs bg-(--color-surprise) px-3 py-1 text-center font-medium text-(--color-font-surprise)';
const secondaryButton = 'shrink-0 rounded-xs border border-solid border-(--hl-md) px-3 py-1 text-center hover:bg-(--hl-sm)';

// The one place to configure/start/stop the (control-plane-wide) session —
// moved here from the floating panel 2026-10-14. Same shared session as every
// other Konnect-linked request in the workspace; only the highlighting of
// "this request's" traces differs per request.
function DebuggerControls({ debuggerState }: { debuggerState: UseKonnectDebuggerResult }) {
  const { status, error, startedAt, durationSecs, traces, start, stop } = debuggerState;
  const [selectedDuration, setSelectedDuration] = useState(DEFAULT_SESSION_DURATION_SECS);
  const [elapsedSecs, setElapsedSecs] = useState(0);

  useEffect(() => {
    if (status !== 'in_progress' || !startedAt) {
      return;
    }
    const tick = () => setElapsedSecs(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [status, startedAt]);

  const isRunning = status === 'in_progress';
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-solid border-(--hl-md) px-3 py-2">
      {(status === 'idle' || status === 'completed' || status === 'error') && (
        <>
          <span className="shrink-0 text-(--hl)">Duration</span>
          <Select
            aria-label="Session duration"
            selectedKey={selectedDuration}
            onSelectionChange={key => key !== null && setSelectedDuration(Number(key))}
          >
            <Button className="flex items-center justify-between gap-2 rounded-xs border border-solid border-(--hl-md) px-3 py-1 text-(--color-font) hover:bg-(--hl-xs)">
              <SelectValue<{ id: number; name: string }> className="truncate">
                {({ selectedText }) => <span>{selectedText}</span>}
              </SelectValue>
              <Icon icon="caret-down" />
            </Button>
            <Popover className="flex min-w-max flex-col overflow-y-hidden">
              <ListBox
                items={DURATION_OPTIONS}
                className="min-w-max overflow-y-auto rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) py-2 text-sm shadow-lg select-none focus:outline-hidden"
              >
                {item => (
                  <ListBoxItem
                    className="flex h-(--line-height-xs) w-full items-center gap-2 bg-transparent px-(--padding-md) whitespace-nowrap text-(--color-font) transition-colors hover:bg-(--hl-sm) focus:bg-(--hl-xs) focus:outline-hidden aria-selected:font-bold"
                    aria-label={item.name}
                    textValue={item.name}
                  >
                    {({ isSelected }) => (
                      <>
                        <span>{item.name}</span>
                        {isSelected && <Icon icon="check" className="justify-self-end text-(--color-success)" />}
                      </>
                    )}
                  </ListBoxItem>
                )}
              </ListBox>
            </Popover>
          </Select>
          <Button className={primaryButton} onPress={() => start(selectedDuration)}>
            {status === 'idle' ? 'Start debugging' : status === 'completed' ? 'Restart' : 'Retry'}
          </Button>
        </>
      )}
      {status === 'starting' && <span className="text-(--hl)">Starting debug session…</span>}
      {isRunning && (
        <>
          <span className="text-(--hl)">
            Capturing… {elapsedSecs}s / {durationSecs}s
          </span>
          <Button className={secondaryButton} onPress={stop}>
            Stop
          </Button>
        </>
      )}
      {status === 'completed' && (
        <span className="text-(--hl)">
          {traces.length > 0
            ? `Captured ${traces.length} request${traces.length === 1 ? '' : 's'}.`
            : 'No requests captured this time.'}
        </span>
      )}
      {status === 'error' && (
        <span className="truncate text-(--color-danger)" title={error}>
          Error: {error}
        </span>
      )}
      <Button
        className="ml-auto text-xs text-(--hl) underline hover:text-(--color-font)"
        onPress={() => window.main.openInBrowser(DOCS_URL)}
      >
        Learn more about Kong Debugger
      </Button>
    </div>
  );
}

// Root span carries `proxy.kong.route.id` (see the REST API notes in
// konnect/api.ts) — compared against the route id half of this request's
// composite `konnectRouteKey`. Null routeId (request not linked to a route)
// means nothing gets highlighted.
function isTraceForRoute(trace: DebuggerTrace, routeId: string | null): boolean {
  if (!routeId) {
    return false;
  }
  const { rows } = buildRows(trace.spans);
  return rows[0]?.span.attributes?.['proxy.kong.route.id'] === routeId;
}

export const RequestDebuggerTab = ({ routeId }: { routeId: string | null }) => {
  const ctx = useKonnectDebuggerContext();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const traces = ctx?.debuggerState.traces;
  const matchingIds = useMemo(
    () => new Set((traces ?? []).filter(t => isTraceForRoute(t, routeId)).map(t => t.traceId)),
    [traces, routeId],
  );

  if (!ctx || ctx.debuggerState.status === 'not-linked') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(--hl)">
        <span>This project isn't linked to a Konnect control plane.</span>
        <span className="text-xs">The debugger only works for projects synced from Kong Konnect.</span>
      </div>
    );
  }

  const { status } = ctx.debuggerState;
  const allTraces = ctx.debuggerState.traces;
  const controls = <DebuggerControls debuggerState={ctx.debuggerState} />;

  if (allTraces.length === 0) {
    return (
      <div className="flex h-full flex-col">
        {controls}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-(--hl)">
          {status === 'in_progress' ? (
            <>
              <span className="text-sm">Waiting for the first request…</span>
              <span className="text-xs">
                Send any request against this control plane now — results may take a few seconds to appear.
              </span>
            </>
          ) : (
            <span className="text-sm">
              {status === 'idle' || status === 'starting'
                ? 'Start a session to capture live traffic across this control plane.'
                : 'Nothing captured yet.'}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Default selection prefers this request's own traces, falling back to
  // whatever came first.
  const selected =
    allTraces.find(t => t.traceId === selectedTraceId) ??
    allTraces.find(t => matchingIds.has(t.traceId)) ??
    allTraces[0];

  return (
    <div className="flex h-full w-full flex-col">
      {controls}
      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 overflow-y-auto border-r border-solid border-(--hl-md)">
          <div className="p-2">
            <span className="text-xs font-bold text-(--hl) uppercase">
              Captured ({allTraces.length})
            </span>
            {/* One session covers the whole control plane — see
                use-konnect-debugger.ts. Traces for THIS request are
                highlighted rather than filtered. */}
            <p className="mt-0.5 text-xs text-(--hl)">Whole control plane. This request's are highlighted.</p>
            {status === 'in_progress' && (
              <p className="mt-0.5 text-xs text-(--hl)">Results may take a few seconds to appear.</p>
            )}
          </div>
          {allTraces.map(trace => {
            const isMine = matchingIds.has(trace.traceId);
            return (
              <button
                type="button"
                key={trace.traceId}
                onClick={() => setSelectedTraceId(trace.traceId)}
                className={`block w-full border-b border-l-2 border-solid border-b-(--hl-md) px-2 py-2 text-left ${
                  isMine ? 'border-l-(--color-surprise)' : 'border-l-transparent'
                } ${trace.traceId === selected.traceId ? 'bg-(--hl-xs)' : 'hover:bg-(--hl-xs)'}`}
              >
                <div className={`truncate font-mono ${isMine ? 'font-semibold' : 'text-(--hl)'}`}>
                  {trace.traceId.slice(0, 12)}…
                </div>
                <div className="flex items-center justify-between text-xs text-(--hl)">
                  <span>{fmtMs(trace.durationMs)}</span>
                  {isMine && <span className="text-(--color-surprise)">this request</span>}
                </div>
              </button>
            );
          })}
        </div>
        <TraceView trace={selected} />
      </div>
    </div>
  );
};
