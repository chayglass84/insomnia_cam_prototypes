import React, { type FC, useMemo, useState } from 'react';
import { Button } from 'react-aria-components';

import type { Capability } from '~/common/mcp-debugger/protocol/Protocol';
import type { TraceEvent } from '~/common/mcp-debugger/protocol/TraceEvent';
import type { SubscriptionFilter, SubscriptionView } from '~/main/mcp-debugger/service';

import { formatTime } from './trace-pane';

// Task 4348 S4: `subscriptions/listen` (MCP 2026-07-28). One long-lived stream carrying the change notifications you
// opted in to. The server's acknowledgement names the subset it honors, so a type it left out is shown here rather than
// silently never arriving.

const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId';
const ACK_METHOD = 'notifications/subscriptions/acknowledged';

const TYPES: { key: keyof Omit<SubscriptionFilter, 'resourceSubscriptions'>; label: string }[] = [
  { key: 'toolsListChanged', label: 'Tools list changed' },
  { key: 'promptsListChanged', label: 'Prompts list changed' },
  { key: 'resourcesListChanged', label: 'Resources list changed' },
];

const smallButton = 'rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)';
const primaryButton = 'rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-sm text-(--color-font-surprise) hover:brightness-75';

/** Notifications delivered on a subscription stream (not the acknowledgement), newest first. */
export const subscriptionEvents = (trace: TraceEvent[]) =>
  trace
    .filter(e => {
      const p = e.payload as { method?: string; params?: { _meta?: Record<string, unknown> } } | undefined;
      return e.messageType === 'notification' && p?.method !== ACK_METHOD && p?.params?._meta?.[SUBSCRIPTION_ID_KEY] !== undefined;
    })
    .reverse();

const statusText = (sub?: SubscriptionView) => {
  switch (sub?.status) {
    case 'subscribing': {
      return 'Subscribing…';
    }
    case 'active': {
      return `Listening (subscription ${sub.subscriptionId ?? '?'})`;
    }
    case 'ended': {
      return 'The server ended the subscription.';
    }
    case 'cancelled': {
      return 'Stopped.';
    }
    case 'error': {
      return 'The subscription failed. See the call in the trace.';
    }
    default: {
      return 'Not subscribed.';
    }
  }
};

export const SubscriptionsPanel: FC<{
  requestId: string;
  subscription?: SubscriptionView;
  trace: TraceEvent[];
  capabilities: Capability[];
}> = ({ requestId, subscription, trace, capabilities }) => {
  const [selected, setSelected] = useState<Record<string, boolean>>({
    toolsListChanged: true,
    promptsListChanged: true,
    resourcesListChanged: true,
  });
  const [uris, setUris] = useState('');
  const [error, setError] = useState<string | null>(null);
  const events = useMemo(() => subscriptionEvents(trace).slice(0, 100), [trace]);
  const open = subscription?.status === 'subscribing' || subscription?.status === 'active';
  const resourceUris = capabilities.filter(c => c.type === 'resource').map(c => String(c.metadata.uri ?? c.id));
  const uriList = uris
    .split('\n')
    .map(u => u.trim())
    .filter(Boolean);

  const start = async () => {
    setError(null);
    const notifications: SubscriptionFilter = {};
    for (const { key } of TYPES) {
      if (selected[key]) {
        notifications[key] = true;
      }
    }
    if (uriList.length > 0) {
      notifications.resourceSubscriptions = uriList;
    }
    try {
      await window.main.mcpDebugger.subscribe({ requestId, notifications });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const verdict = (key: keyof SubscriptionFilter) => {
    const asked = subscription?.requested[key];
    const requested = Array.isArray(asked) ? asked.length > 0 : Boolean(asked);
    if (!requested) {
      return null;
    }
    if (!subscription?.acknowledged) {
      return 'waiting';
    }
    return subscription.acknowledged[key] ? 'honored' : 'omitted';
  };
  const verdicts = [...TYPES.map(t => ({ key: t.key, label: t.label })), { key: 'resourceSubscriptions' as const, label: 'Resource updates' }]
    .map(t => ({ ...t, verdict: verdict(t.key) }))
    .filter(t => t.verdict);

  return (
    <div className="flex flex-col gap-3" data-testid="mcp-subscriptions-panel">
      <p className="text-sm text-(--hl)">
        Opens one long-lived stream (<code>subscriptions/listen</code>) and delivers the change notifications you opt
        in to. The server answers with the subset it honors.
      </p>
      <fieldset disabled={open} className="m-0 flex flex-col gap-2 border-0 p-0">
        {TYPES.map(({ key, label }) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(selected[key])}
              onChange={e => setSelected(s => ({ ...s, [key]: e.target.checked }))}
              data-testid={`mcp-sub-${key}`}
            />
            {label}
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm">
          Resource URIs to watch (one per line)
          <textarea
            className="h-20 w-full rounded-xs border border-solid border-(--hl-md) bg-transparent p-2 font-mono text-xs"
            value={uris}
            onChange={e => setUris(e.target.value)}
            placeholder="file:///project/config.json"
            data-testid="mcp-sub-uris"
          />
        </label>
        {resourceUris.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {resourceUris.slice(0, 12).map(uri => (
              <Button
                key={uri}
                className={`${smallButton} font-mono`}
                onPress={() => setUris(current => (uriList.includes(uri) ? current : [...uriList, uri].join('\n')))}
              >
                + {uri}
              </Button>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex items-center gap-3">
        {open ? (
          <Button className={primaryButton} onPress={() => window.main.mcpDebugger.unsubscribe({ requestId })} data-testid="mcp-unsubscribe">
            Stop listening
          </Button>
        ) : (
          <Button className={primaryButton} onPress={start} data-testid="mcp-subscribe">
            Start listening
          </Button>
        )}
        <span className="text-xs text-(--hl)" data-testid="mcp-sub-status">
          {statusText(subscription)}
        </span>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {verdicts.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="mcp-sub-verdicts">
          {verdicts.map(v => (
            <span
              key={v.key}
              className={`rounded-xs border border-solid px-1.5 py-0.5 text-xs ${v.verdict === 'omitted' ? 'border-amber-500 text-amber-500' : 'border-(--hl-md) text-(--hl)'}`}
              title={v.verdict === 'omitted' ? 'The server did not honor this opt-in, so these notifications will not arrive' : undefined}
            >
              {v.label}: {v.verdict === 'omitted' ? 'not honored by the server' : v.verdict}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-1" data-testid="mcp-sub-events">
        <h4 className="text-xs font-bold text-(--hl) uppercase">Notifications received ({events.length})</h4>
        {events.length === 0 && <p className="text-xs text-(--hl)">Nothing yet. Call the trigger-change tool to see one.</p>}
        {events.map(event => {
          const p = event.payload as { method: string; params?: { uri?: string } };
          return (
            <div key={event.id} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-(--hl) tabular-nums">{formatTime(event.timestamp)}</span>
              <span className="font-mono">{p.method}</span>
              {p.params?.uri && <span className="truncate font-mono text-(--hl)">{p.params.uri}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
};
