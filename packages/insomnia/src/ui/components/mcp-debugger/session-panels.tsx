import type { McpRequest } from 'insomnia-data';
import React, { type FC, useState } from 'react';
import { Button } from 'react-aria-components';

import type { Capability } from '~/common/mcp-debugger/protocol/Protocol';
import type { TraceEvent } from '~/common/mcp-debugger/protocol/TraceEvent';
import type { SubscriptionView, TaskView } from '~/main/mcp-debugger/service';
import { useRequestPatcher } from '~/ui/hooks/use-request';

import type { SessionTab } from './capability-sidebar';
import { SubscriptionsPanel } from './subscriptions-panel';
import { TasksPanel } from './task-card';

// Task 4348 S3: panels for the features that exist only in session-era (older) protocol versions.

const panelButton =
  'rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-sm text-(--color-font-surprise) hover:brightness-75';
const inputClass = 'w-full rounded-xs border border-solid border-(--hl-md) bg-transparent px-2 py-1 text-sm';

const PingPanel: FC<{ requestId: string }> = ({ requestId }) => (
  <div className="flex flex-col gap-3">
    <p className="text-sm text-(--hl)">
      Sends a <code>ping</code> request. The server answers with an empty result; the round trip shows in the trace.
    </p>
    <div>
      <Button
        className={panelButton}
        data-testid="mcp-ping"
        onPress={() => window.main.mcpDebugger.invokeRaw({ requestId, invocation: { method: 'ping' } })}
      >
        Send ping
      </Button>
    </div>
  </div>
);

const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

const LoggingPanel: FC<{ requestId: string }> = ({ requestId }) => {
  const [level, setLevel] = useState('info');
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-(--hl)">
        Sets the minimum log level (<code>logging/setLevel</code>). Log messages the server sends back arrive as
        notifications and show in the trace&apos;s Stream view.
      </p>
      <div className="flex items-center gap-2">
        <select
          aria-label="Log level"
          className={`${inputClass} w-40`}
          value={level}
          onChange={e => setLevel(e.target.value)}
          data-testid="mcp-log-level"
        >
          {LOG_LEVELS.map(l => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <Button
          className={panelButton}
          data-testid="mcp-set-log-level"
          onPress={() =>
            window.main.mcpDebugger.invokeRaw({ requestId, invocation: { method: 'logging/setLevel', params: { level } } })
          }
        >
          Set level
        </Button>
      </div>
    </div>
  );
};

const RootsPanel: FC<{ request: McpRequest; isConnected: boolean }> = ({ request, isConnected }) => {
  const patchRequest = useRequestPatcher();
  const roots = request.roots;
  const save = (next: McpRequest['roots']) => {
    patchRequest(request._id, { roots: next });
    // Tell the server straight away (notifications/roots/list_changed) when connected.
    if (isConnected) {
      void window.main.mcpDebugger.setRoots({ requestId: request._id, roots: next.filter(r => r.uri) });
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="mcp-roots-panel">
      <p className="text-sm text-(--hl)">
        Roots this client offers when the server asks (<code>roots/list</code>). Editing them while connected sends{' '}
        <code>notifications/roots/list_changed</code>.
      </p>
      {roots.length === 0 && <p className="text-sm text-(--hl)">No roots yet.</p>}
      {roots.map((root, index) => (
        // eslint-disable-next-line react/no-array-index-key -- roots are an unkeyed list the user edits in place
        <div key={index} className="flex items-center gap-2">
          <input
            aria-label="Root name"
            className={`${inputClass} w-40`}
            placeholder="name"
            defaultValue={root.name ?? ''}
            onBlur={e => save(roots.map((r, i) => (i === index ? { ...r, name: e.target.value } : r)))}
          />
          <input
            aria-label="Root URI"
            className={inputClass}
            placeholder="file:///path/to/project"
            defaultValue={root.uri}
            onBlur={e => save(roots.map((r, i) => (i === index ? { ...r, uri: e.target.value } : r)))}
          />
          <Button
            aria-label="Remove root"
            className="px-2 text-(--hl) hover:text-(--color-font)"
            onPress={() => save(roots.filter((_, i) => i !== index))}
          >
            <i className="fa fa-trash" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          className="rounded-xs border border-solid border-(--hl-md) px-2 py-1 text-xs hover:bg-(--hl-sm)"
          onPress={() => patchRequest(request._id, { roots: [...roots, { name: '', uri: '' }] })}
          data-testid="mcp-add-root"
        >
          Add root
        </Button>
      </div>
    </div>
  );
};

const SamplingInfoPanel: FC = () => (
  <div className="flex flex-col gap-3">
    <p className="text-sm text-(--hl)">
      Sampling is the server asking this client to generate a message (<code>sampling/createMessage</code>). Requests
      show up in the trace as pending server requests with a form to answer. A banner at the top of the trace points at
      any waiting.
    </p>
  </div>
);

export const SessionPanel: FC<{
  tab: SessionTab;
  request: McpRequest;
  isConnected: boolean;
  tasks: TaskView[];
  subscription?: SubscriptionView;
  trace: TraceEvent[];
  capabilities: Capability[];
}> = ({ tab, request, isConnected, tasks, subscription, trace, capabilities }) => (
  <div className="flex flex-col gap-3 p-(--padding-md)" data-testid={`mcp-session-panel-${tab}`}>
    <p className="font-bold capitalize">{tab}</p>
    {tab === 'ping' && <PingPanel requestId={request._id} />}
    {tab === 'logging' && <LoggingPanel requestId={request._id} />}
    {tab === 'roots' && <RootsPanel request={request} isConnected={isConnected} />}
    {tab === 'sampling' && <SamplingInfoPanel />}
    {tab === 'tasks' && <TasksPanel requestId={request._id} tasks={tasks} />}
    {tab === 'subscriptions' && (
      <SubscriptionsPanel requestId={request._id} subscription={subscription} trace={trace} capabilities={capabilities} />
    )}
  </div>
);
