import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tooltip, TooltipTrigger } from 'react-aria-components';

import { parseUiResourceContent } from '~/common/mcp-debugger/protocol/apps/detectUi';
import type { UiResource } from '~/common/mcp-debugger/protocol/apps/types';
import type { Capability } from '~/common/mcp-debugger/protocol/Protocol';

import { type AppRequest, clampHeight, decideAppRequest, initialAppNotifications } from './app-bridge';
import { buildAppSrcdoc } from './app-srcdoc';
import { JsonView } from './json-view';
import { PrototypeMock } from './prototype-mock';

// Task 4348 S7a: the MCP Apps pane. For a tool that declares `_meta.ui.resourceUri`, "Run & render" reads that ui://
// resource, calls the tool with the current Params and renders the app in a sandboxed iframe, answering the app's ui/*
// messages through app-bridge.ts. Reads and calls (including ones the app makes itself) go through the same relay as
// everything else, so they show in the Trace.

const purpleButton =
  'shrink-0 rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-sm text-(--color-font-surprise) hover:brightness-75 disabled:opacity-50';
const tooltipClass =
  'max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none';
const MAX_LOG = 200;

interface LogLine {
  id: number;
  dir: 'app → host' | 'host → app' | 'note';
  text: string;
  payload?: unknown;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

const prefersDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

export const AppPanel: FC<{
  requestId: string;
  capability: Capability;
  /** The current Params as an object, or null when they cannot be read (the Params tab shows why). */
  getArgs: () => Record<string, unknown> | null;
  capabilities: Capability[];
}> = ({ requestId, capability, getArgs, capabilities }) => {
  const uri = capability.ui?.resourceUri ?? '';
  const toolName = capability.metadata.name;
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [resource, setResource] = useState<UiResource | null>(null);
  const [height, setHeight] = useState(260);
  const [runKey, setRunKey] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const logId = useRef(0);
  // What the message handler needs, kept in a ref so the handler does not go stale between renders.
  const session = useRef<{ args: Record<string, unknown>; result: unknown }>({ args: {}, result: undefined });

  const addLog = useCallback((dir: LogLine['dir'], text: string, payload?: unknown) => {
    setLog(prev => [...prev.slice(-(MAX_LOG - 1)), { id: ++logId.current, dir, text, payload }]);
  }, []);

  // A different tool starts from a clean slate.
  useEffect(() => {
    setPhase('idle');
    setError(null);
    setResource(null);
    setLog([]);
  }, [uri, toolName]);

  const run = async () => {
    const args = getArgs();
    if (!args) {
      setError('The Params are not valid JSON; fix them on the Params tab first.');
      setPhase('error');
      return;
    }
    setPhase('loading');
    setError(null);
    setLog([]);
    const read = await window.main.mcpDebugger.relay({ requestId, invocation: { method: 'resources/read', params: { uri } } });
    if (read.error) {
      setError(`Could not read ${uri}: ${read.error.message}`);
      setPhase('error');
      return;
    }
    const parsed = parseUiResourceContent(uri, (read.result as { contents?: unknown[] } | undefined)?.contents?.[0]);
    if ('error' in parsed) {
      setError(parsed.error);
      setPhase('error');
      return;
    }
    const call = await window.main.mcpDebugger.relay({ requestId, invocation: { method: 'tools/call', params: { name: toolName, arguments: args } } });
    if (call.error) {
      addLog('note', `The tool call failed, so the app starts without a result: ${call.error.message}`);
    }
    session.current = { args, result: call.result };
    setResource(parsed);
    setHeight(260);
    setRunKey(k => k + 1);
    setPhase('ready');
  };

  const post = useCallback(
    (message: Record<string, unknown>) => {
      // The iframe has an opaque origin, so the only valid target origin is "*".
      iframeRef.current?.contentWindow?.postMessage(message, '*');
      addLog('host → app', String(message.method ?? ('error' in message ? 'error response' : 'response')), message);
    },
    [addLog],
  );

  useEffect(() => {
    if (!resource) {
      return;
    }
    const onMessage = async (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const m = event.data as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> } | null;
      if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') {
        return;
      }
      if (typeof m.method !== 'string') {
        addLog('app → host', 'response', m);
        return;
      }
      addLog('app → host', m.method, m);
      if (m.id === undefined) {
        if (m.method === 'ui/notifications/initialized') {
          for (const notification of initialAppNotifications(session.current.args, session.current.result)) {
            post(notification);
          }
        } else if (m.method === 'ui/notifications/size-changed') {
          const next = clampHeight(m.params?.height);
          if (next !== null) {
            setHeight(next);
          }
        }
        return;
      }
      const decision = decideAppRequest({ id: m.id, method: m.method, params: m.params } as AppRequest, {
        toolName,
        theme: prefersDark() ? 'dark' : 'light',
        tools: capabilities,
      });
      if (decision.kind === 'reply') {
        if (decision.log) {
          addLog('note', decision.log, m.params);
        }
        post({ jsonrpc: '2.0', id: m.id, result: decision.result });
      } else if (decision.kind === 'error') {
        post({ jsonrpc: '2.0', id: m.id, error: { code: decision.code, message: decision.message } });
      } else {
        const outcome = await window.main.mcpDebugger.relay({ requestId, invocation: { method: decision.method, params: decision.params } });
        post(
          outcome.error
            ? { jsonrpc: '2.0', id: m.id, error: { code: outcome.error.code ?? -32_000, message: outcome.error.message, data: outcome.error.data } }
            : { jsonrpc: '2.0', id: m.id, result: outcome.result ?? {} },
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [resource, runKey, addLog, post, toolName, capabilities, requestId]);

  return (
    <div className="flex flex-col gap-3 p-(--padding-md)" data-testid="mcp-app-panel">
      <PrototypeMock reason="A subset of the MCP Apps dialect (SEP-1865): the app runs in a sandboxed iframe with a CSP built from what the server declared. Links, downloads, display modes and permissions are declined, and the separate sandbox-proxy origin is not built.">
        <div className="flex flex-wrap items-center gap-2">
          <TooltipTrigger delay={200}>
            <Button className={purpleButton} onPress={run} isDisabled={phase === 'loading'} data-testid="mcp-app-run">
              {phase === 'loading' ? 'Rendering…' : phase === 'ready' ? 'Run & render again' : 'Run & render'}
            </Button>
            <Tooltip offset={8} className={tooltipClass}>
              Reads {uri}, calls {toolName} with the current Params and renders the app with the result. Both calls appear in
              the Trace, and so does anything the app calls itself.
            </Tooltip>
          </TooltipTrigger>
          <span className="truncate font-mono text-xs text-(--hl)">{uri}</span>
        </div>
      </PrototypeMock>
      {error && (
        <p className="text-sm text-red-500" data-testid="mcp-app-error">
          {error}
        </p>
      )}
      {resource && phase === 'ready' && (
        <>
          <iframe
            key={runKey}
            ref={iframeRef}
            title={`MCP App: ${toolName}`}
            // Never allow-same-origin: the app is the server's HTML, it must not reach Insomnia's storage or window.
            sandbox="allow-scripts"
            srcDoc={buildAppSrcdoc(resource)}
            style={{ height }}
            className="w-full rounded-xs border border-solid border-(--hl-md) bg-white"
            data-testid="mcp-app-frame"
          />
          <details className="text-xs">
            <summary className="cursor-pointer text-(--hl)">What the server declared for this app</summary>
            <div className="mt-1 flex flex-col gap-1">
              <p className="text-(--hl)">
                {resource.byteSize.toLocaleString()} bytes. Declared network access (CSP):{' '}
                {resource.csp ? '' : 'none, so the app has no network access.'}
              </p>
              {resource.csp && <JsonView value={resource.csp} />}
              {resource.permissions && (
                <p className="text-amber-500">
                  Requests {Object.keys(resource.permissions).join(', ')}; the debugger grants none of these.
                </p>
              )}
              {resource.pinnedDomain && <p className="text-(--hl)">Asks for a pinned origin ({resource.pinnedDomain}); ignored here.</p>}
            </div>
          </details>
        </>
      )}
      {log.length > 0 && (
        <details open className="text-xs" data-testid="mcp-app-log">
          <summary className="cursor-pointer text-(--hl)">Messages between the app and the debugger ({log.length})</summary>
          <div className="mt-1 flex max-h-64 flex-col overflow-y-auto rounded-xs border border-solid border-(--hl-md)">
            {log.map(line => (
              <details key={line.id} className="border-b border-solid border-(--hl-sm) px-2 py-1 last:border-b-0">
                <summary className="flex cursor-pointer items-baseline gap-2">
                  <span className="w-20 shrink-0 text-(--hl)">{line.dir}</span>
                  <span className={line.dir === 'note' ? 'text-amber-500' : 'font-mono'}>{line.text}</span>
                </summary>
                {line.payload !== undefined && <JsonView value={line.payload} />}
              </details>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};
