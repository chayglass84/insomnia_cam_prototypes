import React, { useMemo, useState } from 'react';

import type { KonnectDebugSpan } from '../../../konnect/api';
import { type DebuggerTrace, useKonnectDebuggerContext } from '../../hooks/use-konnect-debugger';

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

function TraceView({ trace }: { trace: DebuggerTrace }) {
  const { rows, totalMs } = useMemo(() => buildRows(trace.spans), [trace.spans]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [detailSpanId, setDetailSpanId] = useState<string | null>(null);
  const root = rows[0]?.span;
  const status = root?.attributes['http.response.status_code'];
  const method = root?.attributes['http.request.method'];
  const route = root?.attributes['http.route'];

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
                    className={`h-full shrink-0 rounded-xs ${isBottleneck ? 'bg-(--color-warning)' : 'bg-(--color-success)'}`}
                    style={{ width: `${widthPct}%` }}
                    title={`${row.span.name}: ${fmtMs(row.durationMs)}`}
                  />
                </div>
                <div className={`w-20 shrink-0 text-right tabular-nums ${isBottleneck ? 'font-bold text-(--color-warning)' : 'text-(--hl)'}`}>
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

export const RequestDebuggerTab = () => {
  const ctx = useKonnectDebuggerContext();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  if (!ctx || ctx.debuggerState.status === 'not-linked') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(--hl)">
        <span>This project isn't linked to a Konnect control plane.</span>
        <span className="text-xs">The debugger only works for projects synced from Kong Konnect.</span>
      </div>
    );
  }

  const { status, traces } = ctx.debuggerState;

  if (status === 'idle' || status === 'starting') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(--hl)">
        <span>Use the Konnect Debugger panel in the bottom-left corner to start a capture.</span>
      </div>
    );
  }

  if (status === 'error' && traces.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(--hl)">
        <span>The last debug session failed — see the panel in the bottom-left corner.</span>
      </div>
    );
  }

  // status is 'in_progress', 'completed', or 'error'-with-partial-results
  // (an error mid-session doesn't discard whatever was already captured).
  if (traces.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(--hl)">
        <span className="text-sm">
          {status === 'in_progress' ? 'Waiting for the first matching request…' : 'No matching requests were captured during the session.'}
        </span>
        <span className="text-xs">
          {status === 'in_progress'
            ? 'Send any request against this control plane now — results appear here live.'
            : 'Start another session from the panel in the bottom-left corner.'}
        </span>
        {status === 'in_progress' && (
          <button
            type="button"
            onClick={ctx.debuggerState.stop}
            className="mt-2 shrink-0 rounded-xs bg-(--color-danger) px-3 py-1 text-xs font-medium text-(--color-font-danger)"
          >
            Stop debugging
          </button>
        )}
      </div>
    );
  }

  const selected = traces.find(t => t.traceId === selectedTraceId) ?? traces[0];

  return (
    <div className="flex h-full w-full">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-solid border-(--hl-md)">
        <div className="flex items-start justify-between gap-2 p-2">
          <div>
            <span className="text-xs font-bold text-(--hl) uppercase">
              Captured ({traces.length}){status === 'in_progress' && ' — live'}
            </span>
            {/* Sessions are control-plane-wide now, not filtered to this
                request's route — see use-konnect-debugger.ts. */}
            <p className="mt-0.5 text-xs text-(--hl)">Across the whole control plane, not just this request.</p>
          </div>
          {status === 'in_progress' && (
            <button
              type="button"
              onClick={ctx.debuggerState.stop}
              className="shrink-0 rounded-xs bg-(--color-danger) px-2 py-1 text-xs font-medium text-(--color-font-danger)"
            >
              Stop
            </button>
          )}
        </div>
        {traces.map(trace => (
          <button
            type="button"
            key={trace.traceId}
            onClick={() => setSelectedTraceId(trace.traceId)}
            className={`block w-full border-b border-solid border-(--hl-md) px-2 py-2 text-left ${
              trace.traceId === selected.traceId ? 'bg-(--hl-xs)' : 'hover:bg-(--hl-xs)'
            }`}
          >
            <div className="truncate font-mono">{trace.traceId.slice(0, 12)}…</div>
            <div className="text-xs text-(--hl)">{fmtMs(trace.durationMs)}</div>
          </button>
        ))}
      </div>
      <TraceView trace={selected} />
    </div>
  );
};
