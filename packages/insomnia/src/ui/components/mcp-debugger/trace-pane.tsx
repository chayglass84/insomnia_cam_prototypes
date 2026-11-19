import React, { type FC, useEffect, useMemo, useState } from 'react';
import { Button, Focusable, Tooltip, TooltipTrigger } from 'react-aria-components';

import type { TraceEvent, TraceStatus } from '~/common/mcp-debugger/protocol/TraceEvent';

import { JsonView } from './json-view';
import { diffJson, type DiffLine, hasChanges } from './line-diff';

// Task 4348 trace pane: one row per call (events grouped by correlationId), click for request/response detail.
// S2: "Edit & replay" on any request row (raw JSON-RPC editor), replay rows link to their original, and request /
// response diffs show what the edit changed.
// PROTOTYPE-MOCK: details are plain JSON <pre> blocks (the editor is a textarea). Replays re-send method + params;
// the protocol re-applies its own _meta keys and headers, so those can't be overridden yet.

export interface Call {
  correlationId: string;
  events: TraceEvent[];
  label: string;
  status: TraceStatus;
  startedAt: string;
  durationMs?: number;
  firstSequence: number;
}

const STATUS_STYLE: Record<TraceStatus, string> = {
  pending: 'bg-amber-500',
  success: 'bg-green-500',
  error: 'bg-red-500',
  cancelled: 'bg-gray-500',
  'no-response': 'bg-gray-500',
};

export const groupCalls = (trace: TraceEvent[]): Call[] => {
  const byId = new Map<string, TraceEvent[]>();
  for (const event of trace) {
    byId.set(event.correlationId, [...(byId.get(event.correlationId) ?? []), event]);
  }
  return [...byId.entries()]
    .map(([correlationId, events]) => {
      const request = events.find(e => e.awaitsReply) ?? events[0];
      const terminal = [...events].reverse().find(e => e.terminalStatus);
      return {
        correlationId,
        events,
        label: request.label ?? request.messageType,
        status: terminal?.terminalStatus ?? (request.awaitsReply ? 'pending' : 'success'),
        startedAt: request.timestamp,
        durationMs: terminal ? Date.parse(terminal.timestamp) - Date.parse(request.timestamp) : undefined,
        firstSequence: events[0].sequence,
      } satisfies Call;
    })
    .sort((a, b) => b.firstSequence - a.firstSequence);
};

const requestEventOf = (call: Call) =>
  call.events.find(e => e.direction === 'client-to-server' && e.awaitsReply) ?? call.events[0];
const terminalEventOf = (call: Call) => [...call.events].reverse().find(e => e.terminalStatus);

/** A call can be edited and replayed when it is a client request other than the connect handshake. */
const isReplayable = (call: Call) => {
  const request = requestEventOf(call);
  const method = (request.payload as { method?: unknown } | undefined)?.method;
  return (
    request.direction === 'client-to-server' &&
    request.awaitsReply === true &&
    typeof method === 'string' &&
    method !== 'initialize' &&
    method !== 'server/discover'
  );
};

const DiffView: FC<{ title: string; lines: DiffLine[] }> = ({ title, lines }) => (
  <section data-testid="mcp-diff">
    <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">{title}</h4>
    {hasChanges(lines) ? (
      <pre className="overflow-auto rounded-xs bg-(--hl-xs) p-2 text-xs">
        {lines.map((line, i) => (
          <div
            // eslint-disable-next-line react/no-array-index-key -- diff lines have no identity
            key={i}
            className={
              line.kind === 'add'
                ? 'bg-green-500/20 text-green-500'
                : line.kind === 'remove'
                  ? 'bg-red-500/20 text-red-500'
                  : 'text-(--hl)'
            }
          >
            {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
            {line.text}
          </div>
        ))}
      </pre>
    ) : (
      <p className="text-xs text-(--hl)">No differences.</p>
    )}
  </section>
);

const ReplayEditor: FC<{
  request: TraceEvent;
  onSend: (invocation: { method: string; params?: unknown }) => void;
  onClose: () => void;
}> = ({ request, onSend, onClose }) => {
  const [text, setText] = useState(() => JSON.stringify(request.payload, null, 2));
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    try {
      const parsed = JSON.parse(text) as { method?: unknown; params?: unknown };
      if (typeof parsed.method !== 'string' || !parsed.method) {
        setError('"method" must be a non-empty string');
        return;
      }
      setError(null);
      onSend({ method: parsed.method, params: parsed.params });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-xs border border-solid border-(--hl-md) p-2" data-testid="mcp-replay-editor">
      <h4 className="text-xs font-bold text-(--hl) uppercase">Edit &amp; replay</h4>
      <textarea
        aria-label="Edit request"
        className="h-48 w-full rounded-xs border border-solid border-(--hl-md) bg-transparent p-2 font-mono text-xs"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button
          className="rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-xs text-(--color-font-surprise)"
          onPress={send}
          data-testid="mcp-replay-send"
        >
          Send
        </Button>
        <Button className="rounded-xs border border-solid border-(--hl-md) px-2 py-1 text-xs hover:bg-(--hl-sm)" onPress={onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
};

const CallDetail: FC<{
  call: Call;
  original?: Call;
  isConnected: boolean;
  onCancel: (correlationId: string) => void;
  onReplay: (call: Call, invocation: { method: string; params?: unknown }) => void;
  onSelect: (correlationId: string) => void;
}> = ({ call, original, isConnected, onCancel, onReplay, onSelect }) => {
  const request = requestEventOf(call);
  const replies = call.events.filter(e => e !== request);
  const [editing, setEditing] = useState(false);

  useEffect(() => setEditing(false), [call.correlationId]);

  const requestDiff = original ? diffJson(requestEventOf(original).payload, request.payload) : null;
  const originalTerminal = original ? terminalEventOf(original) : undefined;
  const terminal = terminalEventOf(call);
  const responseDiff =
    originalTerminal && terminal ? diffJson(originalTerminal.payload, terminal.payload) : null;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm" data-testid="mcp-trace-detail">
      <div className="flex items-center justify-between gap-2">
        <strong className="truncate">{call.label}</strong>
        <div className="flex shrink-0 items-center gap-2">
          {call.status === 'pending' && request.cancellable && (
            <Button
              className="rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)"
              onPress={() => onCancel(call.correlationId)}
            >
              Cancel request
            </Button>
          )}
          {isReplayable(call) && (
            <Button
              className="rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm) disabled:opacity-50"
              isDisabled={!isConnected}
              onPress={() => setEditing(true)}
              data-testid="mcp-edit-replay"
            >
              Edit &amp; replay
            </Button>
          )}
        </div>
      </div>
      {original && (
        <p className="text-xs text-(--hl)" data-testid="mcp-replay-of">
          Replay of{' '}
          <button type="button" className="underline" onClick={() => onSelect(original.correlationId)}>
            {original.label}
          </button>
        </p>
      )}
      {!isConnected && isReplayable(call) && <p className="text-xs text-(--hl)">Connect to replay this request.</p>}
      {editing && (
        <ReplayEditor
          request={request}
          onClose={() => setEditing(false)}
          onSend={invocation => {
            setEditing(false);
            onReplay(call, invocation);
          }}
        />
      )}
      <section>
        <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">Request</h4>
        <JsonView value={request.payload} />
        {request.requestHeaders && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-(--hl)">
              Request headers ({Object.keys(request.requestHeaders).length})
            </summary>
            <JsonView value={request.requestHeaders} />
          </details>
        )}
      </section>
      {replies.length === 0 && <p className="text-(--hl)">Waiting for a response…</p>}
      {replies.map(reply => (
        <section key={reply.id}>
          <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">
            {reply.direction === 'server-to-client' ? 'Server' : 'Client'} · {reply.messageType}
            {reply.terminalStatus && ` · ${reply.terminalStatus}`}
          </h4>
          <JsonView value={reply.payload} />
          {reply.responseHeaders && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-(--hl)">
                Response headers ({Object.keys(reply.responseHeaders).length})
              </summary>
              <JsonView value={reply.responseHeaders} />
            </details>
          )}
        </section>
      ))}
      {requestDiff && <DiffView title="Request changes vs original" lines={requestDiff} />}
      {responseDiff && <DiffView title="Response changes vs original" lines={responseDiff} />}
    </div>
  );
};

export const McpTracePane: FC<{
  requestId: string;
  trace: TraceEvent[];
  isConnected: boolean;
  replays: Record<string, string>;
  onClear: () => void;
}> = ({ requestId, trace, isConnected, replays, onClear }) => {
  const calls = useMemo(() => groupCalls(trace), [trace]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = calls.find(c => c.correlationId === selectedId) ?? calls[0] ?? null;
  const original = selected && replays[selected.correlationId] ? calls.find(c => c.correlationId === replays[selected.correlationId]) : undefined;

  useEffect(() => {
    setSelectedId(null);
  }, [requestId]);

  const replay = async (call: Call, invocation: { method: string; params?: unknown }) => {
    try {
      const { correlationId } = await window.main.mcpDebugger.invokeRaw({
        requestId,
        invocation,
        replayOf: call.correlationId,
      });
      if (correlationId) {
        setSelectedId(correlationId);
      }
    } catch (err) {
      console.error('[mcp-debugger] replay failed', err);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mcp-trace-pane">
      <div className="flex h-(--line-height-sm) shrink-0 items-center justify-between border-b border-solid border-(--hl-md) px-2">
        <span className="text-xs font-bold text-(--hl) uppercase">Trace · {calls.length} calls</span>
        <Button className="text-xs text-(--hl) hover:text-(--color-font)" onPress={onClear} isDisabled={calls.length === 0}>
          Clear
        </Button>
      </div>
      {calls.length === 0 ? (
        <p className="p-4 text-sm text-(--hl)">Connect to a server to see protocol traffic here.</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-1/2 min-w-48 overflow-y-auto border-r border-solid border-(--hl-md)" data-testid="mcp-trace-list">
            {calls.map(call => (
              <button
                key={call.correlationId}
                type="button"
                onClick={() => setSelectedId(call.correlationId)}
                data-testid="mcp-trace-row"
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-(--hl-xs) ${selected?.correlationId === call.correlationId ? 'bg-(--hl-sm)' : ''}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[call.status]}`} title={call.status} />
                {replays[call.correlationId] && (
                  <TooltipTrigger delay={200}>
                    <Focusable>
                      <span
                        role="img"
                        aria-label="Replayed call"
                        className="shrink-0 rounded-xs border border-solid border-(--hl-sm) px-1 text-[0.65rem] text-(--hl)"
                        data-testid="mcp-replay-badge"
                      >
                        ↻
                      </span>
                    </Focusable>
                    <Tooltip
                      offset={8}
                      className="max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none"
                    >
                      Replayed: an edited copy of an earlier call. Open it to compare against the original.
                    </Tooltip>
                  </TooltipTrigger>
                )}
                <span className="truncate">{call.label}</span>
                <span className="ml-auto shrink-0 text-xs text-(--hl)">
                  {call.durationMs !== undefined ? `${call.durationMs} ms` : '…'}
                </span>
              </button>
            ))}
          </div>
          <div className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
            {selected && (
              <CallDetail
                call={selected}
                original={original}
                isConnected={isConnected}
                onCancel={correlationId => window.main.mcpDebugger.cancel({ requestId, correlationId })}
                onReplay={replay}
                onSelect={setSelectedId}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
