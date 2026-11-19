import React, { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'react-aria-components';

import type { TraceEvent, TraceStatus } from '~/common/mcp-debugger/protocol/TraceEvent';

// Task 4348 S1 trace pane: one row per call (events grouped by correlationId), click for request/response detail.
// PROTOTYPE-MOCK: the detail view is plain JSON <pre> blocks. S2 swaps in an editor and adds edit & replay + diff.

interface Call {
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

const Json: FC<{ value: unknown }> = ({ value }) => (
  <pre className="overflow-auto rounded-xs bg-(--hl-xs) p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>
);

const CallDetail: FC<{ call: Call; onCancel: (correlationId: string) => void }> = ({ call, onCancel }) => {
  const request = call.events.find(e => e.direction === 'client-to-server' && e.awaitsReply) ?? call.events[0];
  const replies = call.events.filter(e => e !== request);
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-3 text-sm" data-testid="mcp-trace-detail">
      <div className="flex items-center justify-between">
        <strong>{call.label}</strong>
        {call.status === 'pending' && request.cancellable && (
          <Button
            className="rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)"
            onPress={() => onCancel(call.correlationId)}
          >
            Cancel request
          </Button>
        )}
      </div>
      <section>
        <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">Request</h4>
        <Json value={request.payload} />
        {request.requestHeaders && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-(--hl)">
              Request headers ({Object.keys(request.requestHeaders).length})
            </summary>
            <Json value={request.requestHeaders} />
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
          <Json value={reply.payload} />
          {reply.responseHeaders && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-(--hl)">
                Response headers ({Object.keys(reply.responseHeaders).length})
              </summary>
              <Json value={reply.responseHeaders} />
            </details>
          )}
        </section>
      ))}
    </div>
  );
};

export const McpTracePane: FC<{
  requestId: string;
  trace: TraceEvent[];
  onClear: () => void;
}> = ({ requestId, trace, onClear }) => {
  const calls = useMemo(() => groupCalls(trace), [trace]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = calls.find(c => c.correlationId === selectedId) ?? calls[0] ?? null;
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectedId(null);
  }, [requestId]);

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
          <div ref={listRef} className="w-1/2 min-w-48 overflow-y-auto border-r border-solid border-(--hl-md)" data-testid="mcp-trace-list">
            {calls.map(call => (
              <button
                key={call.correlationId}
                type="button"
                onClick={() => setSelectedId(call.correlationId)}
                data-testid="mcp-trace-row"
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-(--hl-xs) ${selected?.correlationId === call.correlationId ? 'bg-(--hl-sm)' : ''}`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[call.status]}`} title={call.status} />
                <span className="truncate">{call.label}</span>
                <span className="ml-auto shrink-0 text-xs text-(--hl)">
                  {call.durationMs !== undefined ? `${call.durationMs} ms` : '…'}
                </span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1 overflow-hidden">
            {selected && (
              <CallDetail
                call={selected}
                onCancel={correlationId => window.main.mcpDebugger.cancel({ requestId, correlationId })}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
