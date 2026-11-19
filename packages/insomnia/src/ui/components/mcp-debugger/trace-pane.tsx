import React, { type FC, useEffect, useMemo, useState } from 'react';
import { Button, Focusable, Tooltip, TooltipTrigger } from 'react-aria-components';
import { useLocalStorage } from 'react-use';

import type { TraceEvent, TraceStatus } from '~/common/mcp-debugger/protocol/TraceEvent';

import { buildCurl } from './curl-command';
import { JsonView } from './json-view';
import { diffJson, type DiffLine, hasChanges } from './line-diff';
import { SegmentedToggle } from './segmented-toggle';
import { ElicitationResponder, SamplingResponder, type ServerRequestOutcome } from './server-request-forms';

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

/** Server-initiated requests the user answers by hand (the service holds the reply until then). */
const HELD_SERVER_METHODS = new Set(['sampling/createMessage', 'elicitation/create']);
const isWaitingServerRequest = (call: Call) => {
  const request = requestEventOf(call);
  const method = (request.payload as { method?: string } | undefined)?.method;
  return (
    request.direction === 'server-to-client' && call.status === 'pending' && method !== undefined && HELD_SERVER_METHODS.has(method)
  );
};

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

/** What the replay editor edits: the request exactly as it goes on the wire (S2: method, params incl. `_meta`, headers). */
interface ReplayRequest {
  method: string;
  params?: unknown;
  headers: Record<string, string>;
}

/** The wire request of a trace request event, in the shape the editor and the request diff both use. */
const wireRequestOf = (event: TraceEvent) => ({
  ...(event.payload as { method?: unknown; params?: unknown }),
  headers: event.requestHeaders ?? {},
});

const ReplayEditor: FC<{
  request: TraceEvent;
  onSend: (invocation: ReplayRequest) => void;
  onClose: () => void;
}> = ({ request, onSend, onClose }) => {
  const [text, setText] = useState(() => JSON.stringify(wireRequestOf(request), null, 2));
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    try {
      const parsed = JSON.parse(text) as { method?: unknown; params?: unknown; headers?: unknown };
      if (typeof parsed.method !== 'string' || !parsed.method) {
        setError('"method" must be a non-empty string');
        return;
      }
      const headers = parsed.headers ?? {};
      if (typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== 'string')) {
        setError('"headers" must be an object of string values');
        return;
      }
      setError(null);
      onSend({ method: parsed.method, params: parsed.params, headers: headers as Record<string, string> });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON');
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-xs border border-solid border-(--hl-md) p-2" data-testid="mcp-replay-editor">
      <h4 className="text-xs font-bold text-(--hl) uppercase">Edit &amp; replay</h4>
      <p className="text-xs text-(--hl)">
        Sent exactly as written: params go out untouched (including <code>_meta</code>) and these headers replace the
        protocol&apos;s. Credential values shown as <code>&lt;redacted&gt;</code> are filled in from the connection;
        delete a header to send without it.
      </p>
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
  serverUrl?: string;
  onCancel: (correlationId: string) => void;
  onReplay: (call: Call, invocation: ReplayRequest) => void;
  onRespond: (call: Call, outcome: ServerRequestOutcome) => void;
  onSelect: (correlationId: string) => void;
}> = ({ call, original, isConnected, serverUrl, onCancel, onReplay, onRespond, onSelect }) => {
  const request = requestEventOf(call);
  const replies = call.events.filter(e => e !== request);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState<string[] | null>(null);

  useEffect(() => {
    setEditing(false);
    setCopied(null);
  }, [call.correlationId]);

  const copyCurl = async () => {
    if (!serverUrl) {
      return;
    }
    const wire = wireRequestOf(request) as { method: string; params?: unknown; headers: Record<string, string> };
    const { command, envVars } = buildCurl({ url: serverUrl, method: wire.method, params: wire.params, headers: wire.headers });
    try {
      await navigator.clipboard.writeText(command);
      setCopied(envVars);
    } catch (err) {
      console.error('[mcp-debugger] copy failed', err);
    }
  };

  const requestDiff = original ? diffJson(wireRequestOf(requestEventOf(original)), wireRequestOf(request)) : null;
  const originalTerminal = original ? terminalEventOf(original) : undefined;
  const terminal = terminalEventOf(call);
  const responseDiff =
    originalTerminal && terminal ? diffJson(originalTerminal.payload, terminal.payload) : null;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm" data-testid="mcp-trace-detail">
      <div className="flex items-center justify-between gap-2">
        <strong className="flex min-w-0">
          <CallLabel label={call.label} />
        </strong>
        <div className="flex shrink-0 items-center gap-2">
          {call.status === 'pending' && request.cancellable && (
            <Button
              className="rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)"
              onPress={() => onCancel(call.correlationId)}
            >
              Cancel request
            </Button>
          )}
          {serverUrl && request.direction === 'client-to-server' && request.awaitsReply && (
            <Button
              className="rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)"
              onPress={copyCurl}
              data-testid="mcp-copy-curl"
            >
              {copied ? 'Copied' : 'Copy cURL'}
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
      {isWaitingServerRequest(call) &&
        ((request.payload as { method?: string }).method === 'elicitation/create' ? (
          <ElicitationResponder
            params={(request.payload as { params?: { message?: string; requestedSchema?: never } }).params}
            onRespond={outcome => onRespond(call, outcome)}
          />
        ) : (
          <SamplingResponder
            params={(request.payload as { params?: unknown }).params}
            onRespond={outcome => onRespond(call, outcome)}
          />
        ))}
      {copied && copied.length > 0 && (
        <p className="text-xs text-(--hl)" data-testid="mcp-curl-note">
          Credentials are not copied. Set {copied.map(v => `$${v}`).join(', ')} in your shell before running it.
        </p>
      )}
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

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
/** Local time with milliseconds, e.g. 13:04:09.042. */
export const formatTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const ReplayBadge: FC = () => (
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
);

const STATUS_TOOLTIP: Record<TraceStatus, string> = {
  pending: 'Pending: sent, still waiting for the server to answer',
  success: 'Success: the server answered with a result',
  error: 'Error: the call failed (see the detail for the status and body)',
  cancelled: 'Cancelled: you cancelled this request before it finished',
  'no-response': 'No response: the server never answered',
};

/** The coloured status dot, with a tooltip saying what the colour means. `neutral` explains the grey dot. */
const StatusDot: FC<{ status?: TraceStatus; neutral?: string }> = ({ status, neutral = 'No final status for this message' }) => (
  <TooltipTrigger delay={200}>
    <Focusable>
      <span
        role="img"
        aria-label={status ?? 'no status'}
        className={`h-2 w-2 shrink-0 rounded-full ${status ? STATUS_STYLE[status] : 'bg-(--hl-md)'}`}
        data-testid="mcp-status-dot"
      />
    </Focusable>
    <Tooltip
      offset={8}
      className="max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none"
    >
      {status ? STATUS_TOOLTIP[status] : neutral}
    </Tooltip>
  </TooltipTrigger>
);

/** Stream direction arrow: requests and responses get different colours so they scan apart. */
const Arrow: FC<{ isRequest: boolean }> = ({ isRequest }) => (
  <span
    className={`shrink-0 ${isRequest ? 'text-(--color-surprise)' : 'text-(--color-info)'}`}
    title={isRequest ? 'Request (client to server)' : 'Response (server to client)'}
    data-testid={isRequest ? 'mcp-arrow-request' : 'mcp-arrow-response'}
  >
    {isRequest ? '→' : '←'}
  </span>
);

/** "tools/call · echo" -> the method in the normal font, the tool/resource/prompt name in monospace. */
const CallLabel: FC<{ label: string }> = ({ label }) => {
  const [method, ...rest] = label.split(' · ');
  const name = rest.join(' · ');
  return (
    <span className="truncate">
      {method}
      {name && (
        <>
          {' · '}
          <span className="font-mono text-xs" data-testid="mcp-label-name">
            {name}
          </span>
        </>
      )}
    </span>
  );
};

const Time: FC<{ iso: string }> = ({ iso }) => (
  <span className="shrink-0 font-mono text-xs text-(--hl) tabular-nums" data-testid="mcp-trace-time">
    {formatTime(iso)}
  </span>
);

const StreamEventDetail: FC<{ event: TraceEvent; call?: Call; onShowCall: (correlationId: string) => void }> = ({
  event,
  call,
  onShowCall,
}) => (
  <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm" data-testid="mcp-stream-detail">
    <div className="flex items-center justify-between gap-2">
      <strong className="flex min-w-0 items-center gap-1">
        <Arrow isRequest={event.direction === 'client-to-server'} />
        <CallLabel label={call?.label ?? event.label ?? event.messageType} />
      </strong>
      {call && (
        <Button
          className="shrink-0 rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)"
          onPress={() => onShowCall(event.correlationId)}
          data-testid="mcp-show-call"
        >
          Show call
        </Button>
      )}
    </div>
    <p className="text-xs text-(--hl)">
      {event.direction} · {event.messageType}
      {event.terminalStatus && ` · ${event.terminalStatus}`} · {formatTime(event.timestamp)}
    </p>
    <JsonView value={event.payload} />
    {(event.requestHeaders || event.responseHeaders) && (
      <details>
        <summary className="cursor-pointer text-xs text-(--hl)">Headers</summary>
        <JsonView value={event.requestHeaders ?? event.responseHeaders} />
      </details>
    )}
  </div>
);

type TraceMode = 'calls' | 'stream';

export const McpTracePane: FC<{
  requestId: string;
  trace: TraceEvent[];
  isConnected: boolean;
  replays: Record<string, string>;
  serverUrl?: string;
  onClear: () => void;
}> = ({ requestId, trace, isConnected, replays, serverUrl, onClear }) => {
  // Calls: one row per request/response pair, newest request first. Stream: every message, newest received first.
  const [storedMode, setStoredMode] = useLocalStorage<TraceMode>('mcp-debugger:trace-mode', 'calls');
  const mode: TraceMode = storedMode === 'stream' ? 'stream' : 'calls';
  const calls = useMemo(() => groupCalls(trace), [trace]);
  const stream = useMemo(() => [...trace].sort((a, b) => b.sequence - a.sequence), [trace]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const selected = calls.find(c => c.correlationId === selectedId) ?? calls[0] ?? null;
  const selectedEvent = stream.find(e => e.id === selectedEventId) ?? stream[0] ?? null;
  const original =
    selected && replays[selected.correlationId]
      ? calls.find(c => c.correlationId === replays[selected.correlationId])
      : undefined;
  const callById = useMemo(() => new Map(calls.map(c => [c.correlationId, c])), [calls]);

  useEffect(() => {
    setSelectedId(null);
    setSelectedEventId(null);
  }, [requestId]);

  const respond = async (call: Call, outcome: ServerRequestOutcome) => {
    try {
      await window.main.mcpDebugger.respondPeerRequest({ requestId, correlationId: call.correlationId, ...outcome });
    } catch (err) {
      console.error('[mcp-debugger] responding to the server request failed', err);
    }
  };
  const waiting = calls.find(isWaitingServerRequest);

  const replay = async (call: Call, invocation: ReplayRequest) => {
    try {
      const { correlationId } = await window.main.mcpDebugger.invokeRaw({
        requestId,
        invocation: { method: invocation.method, params: invocation.params },
        exactHeaders: invocation.headers,
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
      <div className="flex h-(--line-height-sm) shrink-0 items-center justify-between gap-2 border-b border-solid border-(--hl-md) px-2">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-(--hl) uppercase">Trace</span>
          <SegmentedToggle
            label="Trace view"
            testIdPrefix="mcp-trace-mode"
            value={mode}
            onChange={setStoredMode}
            options={[
              { id: 'calls', label: 'Calls' },
              { id: 'stream', label: 'Stream' },
            ]}
          />
        </div>
        <Button className="text-xs text-(--hl) hover:text-(--color-font)" onPress={onClear} isDisabled={calls.length === 0}>
          Clear
        </Button>
      </div>
      {waiting && (
        <div
          className="flex items-center gap-2 border-b border-solid border-(--hl-md) bg-amber-500/10 px-2 py-1 text-xs text-amber-500"
          data-testid="mcp-waiting-server-request"
        >
          <i className="fa fa-hourglass-half" />
          <span>The server is waiting for your answer: {waiting.label}</span>
          <Button
            className="ml-auto underline"
            onPress={() => {
              setStoredMode('calls');
              setSelectedId(waiting.correlationId);
            }}
          >
            Open
          </Button>
        </div>
      )}
      {calls.length === 0 ? (
        <p className="p-4 text-sm text-(--hl)">Connect to a server to see protocol traffic here.</p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-1/2 min-w-48 overflow-y-auto border-r border-solid border-(--hl-md)" data-testid="mcp-trace-list">
            {mode === 'calls' &&
              calls.map(call => (
                <button
                  key={call.correlationId}
                  type="button"
                  onClick={() => setSelectedId(call.correlationId)}
                  data-testid="mcp-trace-row"
                  className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-(--hl-xs) ${selected?.correlationId === call.correlationId ? 'bg-(--hl-sm)' : ''}`}
                >
                  <StatusDot status={call.status} />
                  <Time iso={call.startedAt} />
                  {replays[call.correlationId] && <ReplayBadge />}
                  <CallLabel label={call.label} />
                  <span className="ml-auto shrink-0 text-xs text-(--hl)">
                    {call.durationMs !== undefined ? `${call.durationMs} ms` : 'pending…'}
                  </span>
                </button>
              ))}
            {mode === 'stream' &&
              stream.map(event => {
                const call = callById.get(event.correlationId);
                const isRequest = event.direction === 'client-to-server';
                // A request row is amber while its call is still waiting; replies show their own outcome.
                const status: TraceStatus | undefined = event.terminalStatus ?? (event.awaitsReply && call?.status === 'pending' ? 'pending' : undefined);
                return (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => setSelectedEventId(event.id)}
                    data-testid="mcp-stream-row"
                    className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-(--hl-xs) ${selectedEvent?.id === event.id ? 'bg-(--hl-sm)' : ''}`}
                  >
                    <StatusDot status={status} neutral={isRequest ? 'Request sent' : 'Message received'} />
                    <Time iso={event.timestamp} />
                    <Arrow isRequest={isRequest} />
                    <CallLabel label={call?.label ?? event.label ?? event.messageType} />
                  </button>
                );
              })}
          </div>
          <div className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
            {mode === 'calls' && selected && (
              <CallDetail
                call={selected}
                original={original}
                isConnected={isConnected}
                serverUrl={serverUrl}
                onCancel={correlationId => window.main.mcpDebugger.cancel({ requestId, correlationId })}
                onReplay={replay}
                onRespond={respond}
                onSelect={setSelectedId}
              />
            )}
            {mode === 'stream' && selectedEvent && (
              <StreamEventDetail
                event={selectedEvent}
                call={callById.get(selectedEvent.correlationId)}
                onShowCall={correlationId => {
                  setSelectedId(correlationId);
                  setStoredMode('calls');
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
