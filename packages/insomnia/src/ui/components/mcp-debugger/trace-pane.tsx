import React, { type FC, useEffect, useMemo, useState } from 'react';
import { Button, Focusable, Tooltip, TooltipTrigger } from 'react-aria-components';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useLocalStorage } from 'react-use';

import {
  buildElicitationContinuation,
  type InputResponses,
  parseInputRequired,
} from '~/common/mcp-debugger/protocol/mcp/elicitation';
import type { TraceEvent, TraceStatus } from '~/common/mcp-debugger/protocol/TraceEvent';
import { SUPPORTED_VERSIONS } from '~/common/mcp-debugger/versions';
import type { TaskView } from '~/main/mcp-debugger/service';
import { Dropdown, DropdownItem, DropdownSection, ItemContent } from '~/ui/components/base/dropdown';

import { buildCurl } from './curl-command';
import { JsonView } from './json-view';
import { diffJson, type DiffLine, hasChanges } from './line-diff';
import { InputRequiredResponder } from './mrtr-form';
import { fromEditable, type OAuthWireRequest, singleUseNote, toEditable } from './oauth-replay';
import { SegmentedToggle } from './segmented-toggle';
import { ElicitationResponder, SamplingResponder, type ServerRequestOutcome } from './server-request-forms';
import { TaskCard } from './task-card';

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
  /** Set when the call was replayed over another protocol version (S3). */
  via?: string;
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
        via: events[0].via,
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

/** The call is paused on an `input_required` result (multi round-trip request) and waiting for the user's answers. */
const pendingInputRequired = (call: Call) => {
  const last = call.events.at(-1);
  return call.status === 'pending' && last?.messageType === 'input-required' ? parseInputRequired(last.payload) : null;
};

/** A call can be edited and replayed when it is a client request other than the connect handshake. */
const isReplayable = (call: Call) => {
  const request = requestEventOf(call);
  const method = (request.payload as { method?: unknown } | undefined)?.method;
  return (
    request.flow === undefined &&
    request.direction === 'client-to-server' &&
    request.awaitsReply === true &&
    typeof method === 'string' &&
    method !== 'initialize' &&
    method !== 'server/discover'
  );
};

/**
 * S5d: an OAuth call made over plain HTTP can be edited and sent again, connected or not (OAuth happens before Connect).
 * The browser leg (the authorize URL Insomnia opened) is not replayable: sending it would only re-open the consent page.
 */
const isOAuthReplayable = (call: Call) => {
  const request = requestEventOf(call);
  const { method, url } = (request.payload ?? {}) as { method?: unknown; url?: unknown };
  return (
    request.flow === 'oauth' &&
    request.direction === 'client-to-server' &&
    typeof method === 'string' &&
    typeof url === 'string' &&
    call.status !== 'pending' &&
    !call.label.startsWith('Authorize in browser') &&
    !call.events.some(e => e.messageType === 'redirect')
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

/** Editor for an OAuth call: method, url, headers and body (a form body is shown as one key per parameter). */
const OAuthReplayEditor: FC<{
  request: TraceEvent;
  onSend: (request: OAuthWireRequest) => void;
  onClose: () => void;
}> = ({ request, onSend, onClose }) => {
  const [text, setText] = useState(() => JSON.stringify(toEditable(request.payload, request.requestHeaders), null, 2));
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    const result = fromEditable(text);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    setError(null);
    onSend(result.request);
  };

  return (
    <section className="flex flex-col gap-2 rounded-xs border border-solid border-(--hl-md) p-2" data-testid="mcp-oauth-replay-editor">
      <h4 className="text-xs font-bold text-(--hl) uppercase">Edit &amp; replay</h4>
      <p className="text-xs text-(--hl)">
        Sent exactly as written to the URL below, so you can drop a parameter, change a value or point it somewhere else.
        A form body is shown one key per parameter and re-encoded on send. An Authorization header shown as{' '}
        <code>&lt;redacted&gt;</code> is filled in with the current token; delete it to send without one.
      </p>
      <textarea
        aria-label="Edit OAuth request"
        className="h-56 w-full rounded-xs border border-solid border-(--hl-md) bg-transparent p-2 font-mono text-xs"
        value={text}
        onChange={e => setText(e.target.value)}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button
          className="rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-xs text-(--color-font-surprise)"
          onPress={send}
          data-testid="mcp-oauth-replay-send"
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
  onSubmitInput: (call: Call, inputResponses: InputResponses, requestState: unknown) => void;
  currentVersion?: string;
  tasks: TaskView[];
  requestId: string;
  onReplayVersion: (call: Call, version: string) => Promise<string | undefined>;
  onReplayOAuth: (call: Call, request: OAuthWireRequest) => Promise<string | undefined>;
  onSelect: (correlationId: string) => void;
}> = ({ call, original, isConnected, serverUrl, onCancel, onReplay, onRespond, currentVersion, tasks, requestId, onReplayVersion, onReplayOAuth, onSubmitInput, onSelect }) => {
  const request = requestEventOf(call);
  const replies = call.events.filter(e => e !== request);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState<string[] | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const oauthReplayable = isOAuthReplayable(call);

  useEffect(() => {
    setEditing(false);
    setCopied(null);
    setVersionError(null);
    setOAuthError(null);
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

  const oauthWire = (event: TraceEvent) => toEditable(event.payload, event.requestHeaders);
  const requestDiff = original
    ? request.flow === 'oauth'
      ? diffJson(oauthWire(requestEventOf(original)), oauthWire(request))
      : diffJson(wireRequestOf(requestEventOf(original)), wireRequestOf(request))
    : null;
  const originalTerminal = original ? terminalEventOf(original) : undefined;
  const terminal = terminalEventOf(call);
  const responseDiff =
    originalTerminal && terminal ? diffJson(originalTerminal.payload, terminal.payload) : null;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm" data-testid="mcp-trace-detail">
      <div className="flex items-center justify-between gap-2">
        <strong className="flex min-w-0 items-center gap-2">
          {request.flow === 'oauth' && <OAuthChip />}
          <CallLabel label={call.label} />
          {call.via && <VersionChip version={call.via} />}
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
          {serverUrl && !request.flow && request.direction === 'client-to-server' && request.awaitsReply && (
            <Button
              className="rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)"
              onPress={copyCurl}
              data-testid="mcp-copy-curl"
            >
              {copied ? 'Copied' : 'Copy cURL'}
            </Button>
          )}
          {isReplayable(call) && isConnected && (
            <Dropdown
              triggerButton={
                <Button
                  className="rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)"
                  data-testid="mcp-replay-on-version"
                >
                  Replay on… <i className="fa fa-caret-down" />
                </Button>
              }
              placement="bottom end"
            >
              <DropdownSection>
                {SUPPORTED_VERSIONS.filter(v => v !== (call.via ?? currentVersion)).map(version => (
                  <DropdownItem key={version}>
                    <ItemContent
                      label={version}
                      onClick={async () => {
                        setVersionError(null);
                        setVersionError((await onReplayVersion(call, version)) ?? null);
                      }}
                    />
                  </DropdownItem>
                ))}
              </DropdownSection>
            </Dropdown>
          )}
          {(isReplayable(call) || oauthReplayable) && (
            <Button
              className="rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm) disabled:opacity-50"
              isDisabled={!isConnected && !oauthReplayable}
              onPress={() => setEditing(true)}
              data-testid="mcp-edit-replay"
            >
              Edit &amp; replay
            </Button>
          )}
        </div>
      </div>
      {versionError && (
        <p className="text-xs text-amber-500" data-testid="mcp-version-replay-error">
          {versionError} The failed handshake is in the trace.
        </p>
      )}
      {(() => {
        const task = tasks.find(t => t.correlationId === call.correlationId);
        return task ? <TaskCard requestId={requestId} task={task} /> : null;
      })()}
      {(() => {
        const prompt = pendingInputRequired(call);
        return prompt ? (
          <InputRequiredResponder
            prompt={prompt}
            onSubmit={inputResponses => onSubmitInput(call, inputResponses, prompt.requestState)}
          />
        ) : null;
      })()}
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
      {oauthReplayable && singleUseNote(request.payload) && (
        <p className="text-xs text-amber-500" data-testid="mcp-oauth-single-use-note">
          {singleUseNote(request.payload)}
        </p>
      )}
      {oauthError && (
        <p className="text-xs text-amber-500" data-testid="mcp-oauth-replay-error">
          {oauthError}
        </p>
      )}
      {editing && oauthReplayable && (
        <OAuthReplayEditor
          request={request}
          onClose={() => setEditing(false)}
          onSend={async edited => {
            setEditing(false);
            setOAuthError(null);
            setOAuthError((await onReplayOAuth(call, edited)) ?? null);
          }}
        />
      )}
      {editing && !oauthReplayable && (
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

/** Marks a call that was sent over a different protocol version than the session's own. */
const VersionChip: FC<{ version: string }> = ({ version }) => (
  <TooltipTrigger delay={200}>
    <Focusable>
      <span
        role="img"
        aria-label={`Sent over protocol ${version}`}
        className="shrink-0 rounded-xs border border-solid border-(--hl-sm) px-1 font-mono text-[0.65rem] text-(--hl)"
        data-testid="mcp-version-chip"
      >
        {version}
      </span>
    </Focusable>
    <Tooltip
      offset={8}
      className="max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none"
    >
      Replayed over protocol {version}, a different version than this session. Compare it with the original.
    </Tooltip>
  </TooltipTrigger>
);

/** Marks a call or event that belongs to an OAuth sign-in rather than to the MCP connection itself. */
const OAuthChip: FC = () => (
  <TooltipTrigger delay={200}>
    <Focusable>
      <span
        role="img"
        aria-label="OAuth"
        className="shrink-0 rounded-xs bg-(--hl-md) px-1.5 py-px text-[0.65rem] font-semibold text-(--color-font)"
        data-testid="mcp-oauth-chip"
      >
        OAuth
      </span>
    </Focusable>
    <Tooltip
      offset={8}
      className="max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none"
    >
      Part of an OAuth sign-in (Discover OAuth). Not an MCP message: it talks to the server's authorization endpoints.
    </Tooltip>
  </TooltipTrigger>
);

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
/** The HTTP status a reply arrived with: stamped on the event by the transport, else carried in an error payload. */
export const responseCodeOf = (event?: TraceEvent): number | undefined => {
  if (!event) {
    return undefined;
  }
  const fromPayload = (event.payload as { status?: unknown } | undefined)?.status;
  return event.httpStatus ?? (typeof fromPayload === 'number' ? fromPayload : undefined);
};

/** Right-hand side of a Calls or Stream row: the response code (green below 400, red from 400) then the response time. */
const ResultMeta: FC<{ code?: number; durationMs?: number; fallback?: string }> = ({ code, durationMs, fallback }) => (
  <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-(--hl)" data-testid="mcp-row-result">
    {code !== undefined && (
      <span className={`font-mono ${code >= 400 ? 'text-red-500' : 'text-green-500'}`} data-testid="mcp-row-code">
        {code}
      </span>
    )}
    <span>{durationMs !== undefined ? `${durationMs} ms` : fallback}</span>
  </span>
);

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
  currentVersion?: string;
  tasks: TaskView[];
  onClear: () => void;
}> = ({ requestId, trace, isConnected, replays, serverUrl, currentVersion, tasks, onClear }) => {
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
  const waiting = calls.find(c => isWaitingServerRequest(c) || pendingInputRequired(c));

  /** Answer an `input_required` result: retry the original call with the answers, threaded under the same row. */
  const submitInput = (call: Call, inputResponses: InputResponses, requestState: unknown) => {
    const original = wireRequestOf(requestEventOf(call));
    const invocation = buildElicitationContinuation(
      { method: original.method as string, params: original.params },
      inputResponses,
      requestState,
      call.correlationId,
    );
    window.main.mcpDebugger.invokeRaw({ requestId, invocation }).catch(err => {
      console.error('[mcp-debugger] submitting input failed', err);
    });
  };

  /** S5d: send an edited OAuth call; the reply shows up as a new OAuth Call linked to the original. */
  const replayOAuth = async (call: Call, edited: OAuthWireRequest): Promise<string | undefined> => {
    // Row labels are "<step title> · METHOD path"; the main process re-appends the method and path.
    const label = call.label.includes(' · ') ? call.label.slice(0, call.label.lastIndexOf(' · ')) : call.label;
    try {
      const { correlationId, error } = await window.main.mcpDebugger.replayOAuthCall({
        requestId,
        replayOf: call.correlationId,
        label,
        method: edited.method,
        url: edited.url,
        headers: edited.headers,
        body: edited.body,
      });
      if (correlationId) {
        setSelectedId(correlationId);
      }
      return error;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  /** Replay a call's method and params over another protocol version; resolves to an error message, if any. */
  const replayOnVersion = async (call: Call, version: string): Promise<string | undefined> => {
    const wire = wireRequestOf(requestEventOf(call));
    try {
      const { correlationId, error } = await window.main.mcpDebugger.replayOnVersion({
        requestId,
        invocation: { method: wire.method as string, params: wire.params },
        version,
        replayOf: call.correlationId,
      });
      if (correlationId) {
        setSelectedId(correlationId);
      }
      return error;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

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
        <PanelGroup autoSaveId="mcp-debugger-trace-split" id="mcp-debugger-trace-split" direction="vertical" className="min-h-0 flex-1">
          <Panel id="mcp-trace-list" order={1} defaultSize={40} minSize={15}>
          <div className="h-full overflow-y-auto" data-testid="mcp-trace-list">
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
                  {call.via && <VersionChip version={call.via} />}
                  {call.events[0].flow === 'oauth' && <OAuthChip />}
                  <CallLabel label={call.label} />
                  <ResultMeta
                    code={responseCodeOf(terminalEventOf(call))}
                    durationMs={call.durationMs}
                    fallback={call.status === 'pending' ? 'pending…' : 'notification'}
                  />
                </button>
              ))}
            {mode === 'stream' &&
              stream.map(event => {
                const call = callById.get(event.correlationId);
                const isRequest = event.direction === 'client-to-server';
                // A reply that settles a call shows how long the call took, with its response code, like the Calls row.
                const replyDuration =
                  call && !isRequest && event.terminalStatus !== undefined ? Date.parse(event.timestamp) - Date.parse(call.startedAt) : undefined;
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
                    {event.flow === 'oauth' && <OAuthChip />}
                    <CallLabel label={call?.label ?? event.label ?? event.messageType} />
                    {event.via && <VersionChip version={event.via} />}
                    {replyDuration !== undefined && <ResultMeta code={responseCodeOf(event)} durationMs={replyDuration} />}
                  </button>
                );
              })}
          </div>
          </Panel>
          <PanelResizeHandle className="h-px w-full bg-(--hl-md)" />
          <Panel id="mcp-trace-detail" order={2} minSize={15}>
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            {mode === 'calls' && selected && (
              <CallDetail
                call={selected}
                original={original}
                isConnected={isConnected}
                serverUrl={serverUrl}
                onCancel={correlationId => window.main.mcpDebugger.cancel({ requestId, correlationId })}
                onReplay={replay}
                onRespond={respond}
                onSubmitInput={submitInput}
                currentVersion={currentVersion}
                tasks={tasks}
                requestId={requestId}
                onReplayVersion={replayOnVersion}
                onReplayOAuth={replayOAuth}
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
          </Panel>
        </PanelGroup>
      )}
    </div>
  );
};
