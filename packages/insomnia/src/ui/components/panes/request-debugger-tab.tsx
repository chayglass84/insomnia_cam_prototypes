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

const OWNER_STYLE: Record<TimeOwner, { label: string; color: string }> = {
  // Kong brand lime — same #CCFF00 as the KongLogo mark.
  kong: { label: 'Kong', color: '#CCFF00' },
  upstream: { label: 'Upstream', color: 'var(--color-info)' },
  client: { label: 'Client / network', color: 'var(--hl-xl)' },
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

// Paints [leftPct, leftPct+widthPct] of the track in `color`, transparent
// elsewhere, as a single background-image (see the waterfall bar comment).
function barGradient(leftPct: number, widthPct: number, color: string): string {
  const start = Math.min(Math.max(leftPct, 0), 100);
  const end = Math.min(start + widthPct, 100);
  return `linear-gradient(to right, transparent ${start}%, ${color} ${start}%, ${color} ${end}%, transparent ${end}%)`;
}

// PROTOTYPE: flowchart-style alternative to the waterfall. Same real span
// tree (see buildRows), but each span is a box in a top-to-bottom chain with
// its share of the total time; click a box to expand its child spans (e.g.
// access -> plugins) as a nested chain. Unlike the waterfall it ignores
// concurrency/offsets: it shows "where did the time go", not "when".
interface FlowNode {
  row: SpanRow;
  children: FlowNode[];
}

// rows are DFS pre-order with depth, so the tree falls out of a depth-indexed stack.
function buildFlow(rows: SpanRow[]): FlowNode[] {
  const stack: FlowNode[] = [];
  rows.forEach(row => {
    const node: FlowNode = { row, children: [] };
    stack[row.depth] = node;
    stack.length = row.depth + 1;
    if (row.depth > 0) {
      stack[row.depth - 1].children.push(node);
    }
  });
  return stack[0]?.children ?? [];
}

// Plugin spans are named `kong.<phase>.plugin.<name>` (see labelFor). Counted
// at any depth so every box with a plugin somewhere beneath it can say so.
function countPlugins(node: FlowNode): number {
  const self = /^kong\.\w+\.plugin\./.test(node.row.span.name) ? 1 : 0;
  return node.children.reduce((sum, child) => sum + countPlugins(child), self);
}

function FlowChain({
  nodes,
  totalMs,
  expandedIds,
  onToggle,
}: {
  nodes: FlowNode[];
  totalMs: number;
  expandedIds: Set<string>;
  onToggle: (spanId: string) => void;
}) {
  return (
    <div className="flex flex-col items-stretch">
      {nodes.map((node, index) => {
        const { span, durationMs: ms } = node.row;
        const pct = totalMs > 0 ? (ms / totalMs) * 100 : 0;
        // Only worth expanding when there's a real sequence to show; a lone
        // child would just repeat its parent's time.
        const isExpandable = node.children.length > 1;
        // A plugin span is itself the plugin, so only count ones strictly beneath it.
        const pluginCount = countPlugins(node) - (/^kong\.\w+\.plugin\./.test(span.name) ? 1 : 0);
        const isExpanded = isExpandable && expandedIds.has(span.span_id);
        return (
          <React.Fragment key={span.span_id}>
            {index > 0 && <div className="self-center text-(--hl)">↓</div>}
            <div className="overflow-hidden rounded-xs border border-solid border-(--hl-md)">
              {/* Not `disabled` for the plain boxes: browsers grey out a disabled
                  button's text, which made their numbers hard to read. */}
              <button
                type="button"
                onClick={() => isExpandable && onToggle(span.span_id)}
                className={`flex w-full items-stretch gap-3 pr-3 text-left ${isExpandable ? 'hover:bg-(--hl-xs)' : 'cursor-default'}`}
                title={span.name}
              >
                <span
                  className="w-1.5 shrink-0 self-stretch"
                  style={{ backgroundColor: OWNER_STYLE[ownerFor(span.name)].color }}
                />
                <span className="flex min-w-0 flex-1 items-center gap-2 py-4">
                  <span className="w-[1ch] shrink-0 text-(--hl)">{isExpandable ? (isExpanded ? '▼' : '▶') : ''}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{labelFor(span.name)}</span>
                    {pluginCount > 0 && (
                      <span
                        className="mt-0.5 self-start truncate rounded-xs px-1.5 text-xs font-medium text-black"
                        style={{ backgroundColor: OWNER_STYLE.kong.color }}
                      >
                        {pluginCount} Konnect plugin{pluginCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  {isExpandable && <span className="shrink-0 text-xs text-(--hl)">{node.children.length} steps</span>}
                  <span className="shrink-0 tabular-nums">{fmtMs(ms)}</span>
                  <span className="w-14 shrink-0 text-right font-semibold tabular-nums">{pct.toFixed(1)}%</span>
                </span>
              </button>
              {isExpanded && (
                <div className="border-t border-solid border-(--hl-sm) bg-(--hl-xs) py-2 pr-2 pl-8">
                  <FlowChain nodes={node.children} totalMs={totalMs} expandedIds={expandedIds} onToggle={onToggle} />
                </div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function FlowView({ rows, totalMs }: { rows: SpanRow[]; totalMs: number }) {
  const nodes = useMemo(() => buildFlow(rows), [rows]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const onToggle = (spanId: string) =>
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  return <FlowChain nodes={nodes} totalMs={totalMs} expandedIds={expandedIds} onToggle={onToggle} />;
}

function TraceView({ trace }: { trace: DebuggerTrace }) {
  const { rows, totalMs } = useMemo(() => buildRows(trace.spans), [trace.spans]);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [detailSpanId, setDetailSpanId] = useState<string | null>(null);
  const [view, setView] = useState<'waterfall' | 'flow'>('flow');
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

  // WATERFALL PAINT BUG (first paint blank until an unrelated click): see
  // the comment on the bar element below for history and the current attempt.
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
                style={{
                  width: `${(summary[owner] / summary.total) * 100}%`,
                  backgroundColor: OWNER_STYLE[owner].color,
                }}
                title={`${OWNER_STYLE[owner].label}: ${fmtMs(summary[owner])}`}
              />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {(['kong', 'upstream', 'client'] as const).map(owner => (
              <span key={owner} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2.5 rounded-xs"
                  style={{ backgroundColor: OWNER_STYLE[owner].color }}
                />
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
      <div className="mt-2.5 shrink-0 border-t border-solid border-(--hl-sm)" />
      <div className="mt-2.5 mb-3 flex shrink-0 self-start overflow-hidden rounded-xs border border-solid border-(--hl-md)">
        {(['flow', 'waterfall'] as const).map(v => (
          <button
            type="button"
            key={v}
            onClick={() => setView(v)}
            className={`px-3 py-1 capitalize ${view === v ? 'bg-(--hl-sm) font-semibold text-(--color-font)' : 'text-(--hl) hover:bg-(--hl-xs)'}`}
          >
            {v}
          </button>
        ))}
      </div>
      {view === 'flow' && <FlowView key={trace.traceId} rows={rows} totalMs={totalMs} />}
      <div className={view === 'flow' ? 'hidden' : undefined}>
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
                {/* Waterfall bar. HISTORY: the bar used to be a child element (absolute,
                    then percentage-width flex children) inside a rounded,
                    `overflow-hidden` track, and on first paint it often didn't
                    render until any unrelated click/re-render, even though the
                    label/duration text and the Total header (same numbers) were
                    right. Absolute positioning, and a forced reflow, didn't help,
                    so it was never a wrong-value or layout-timing problem.
                    2026-10-14 attempt 4: the bar is now ONE element painted as a
                    gradient background — no child boxes, no percentage widths to
                    resolve against a flexed parent, no rounded overflow clip
                    around children. DID NOT FIX IT (user click-tested, same
                    symptom), so the cause is outside this element (tab-panel
                    reveal timing, resizable-panel width assignment, or
                    something Electron-specific). Accepted as "good enough" for
                    the prototype; a real fix needs a devtools performance
                    recording (first paint vs post-click repaint), not another
                    style change. */}
                <div
                  className={`h-4 flex-1 rounded-xs border border-solid bg-(--hl-sm) ${
                    isBottleneck ? 'border-(--color-font)' : 'border-(--hl-sm)'
                  }`}
                  style={{
                    backgroundImage: barGradient(
                      leftPct,
                      widthPct,
                      row.depth === 0 ? 'var(--hl-lg)' : OWNER_STYLE[ownerFor(row.span.name)].color,
                    ),
                  }}
                  title={`${row.span.name}: ${fmtMs(row.durationMs)}`}
                />
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

function fmtAgo(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins} min ago`;
  }
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`;
}

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

  // Only for the "x min ago" text — this session can be hours old, since it
  // lives at the workspace level and outlives the tab. Coarse tick is enough.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const isRunning = status === 'in_progress';
  // The window has elapsed but Konnect hasn't reported `completed_at` yet
  // (poll cadence + its own lag), so we're still `in_progress`. Say so
  // instead of counting past the end ("32s / 30s").
  const isFinishing = isRunning && durationSecs != null && elapsedSecs >= durationSecs;
  return (
    <div className="flex shrink-0 flex-col border-b border-solid border-(--hl-md)">
      {startedAt && (
        <div className="flex flex-wrap items-baseline gap-x-2 border-b border-solid border-(--hl-sm) px-3 py-1.5">
          <span className="text-(--hl)">Session started</span>
          <span className="font-semibold">
            {new Date(startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })}
          </span>
          <span className="text-xs text-(--hl)">({fmtAgo(now - startedAt)})</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
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
            {isFinishing
              ? 'Wrapping up — waiting for Konnect to finish the session…'
              : `Capturing… ${elapsedSecs}s / ${durationSecs}s`}
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
