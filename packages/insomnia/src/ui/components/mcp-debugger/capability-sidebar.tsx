import { fuzzyMatchAll } from 'insomnia-data/common';
import React, { type FC, useMemo, useState } from 'react';
import { Focusable, Input, SearchField, Tooltip, TooltipTrigger } from 'react-aria-components';

import { NEWEST_VERSION } from '~/common/mcp-debugger/conformance';
import { isLegacyOnlyTab } from '~/common/mcp-debugger/deprecations';
import { getProfile, type McpDebuggerTabId } from '~/common/mcp-debugger/profiles';
import { capabilityKey } from '~/common/mcp-debugger/protocol/mcp/capabilities/methods';
import type { Capability, CapabilityType } from '~/common/mcp-debugger/protocol/Protocol';
import { isSupportedVersion } from '~/common/mcp-debugger/versions';

// Task 4348 S1 capability sidebar: groups the typed capability registry (tools/resources/prompts) and shows the
// negotiated version's profile tabs that are not built yet as visible mock rows.

const GROUPS: { type: CapabilityType; label: string }[] = [
  { type: 'tool', label: 'Tools' },
  { type: 'resource', label: 'Resources' },
  { type: 'prompt', label: 'Prompts' },
];

const CHIP_BASE =
  'flex w-10 shrink-0 items-center justify-center rounded-xs border border-solid border-(--hl-sm) text-[0.65rem]';
// Same chips and colors as the legacy MCP sidebar.
const CHIPS: Record<CapabilityType, { label: string; className: string }> = {
  tool: {
    label: 'Tool',
    className: 'bg-[rgba(var(--color-success-rgb),0.5)] text-(--color-font-success)',
  },
  resource: {
    label: 'Res',
    className: 'bg-[rgba(var(--color-surprise-rgb),0.5)] text-(--color-font-surprise)',
  },
  prompt: {
    label: 'Prompt',
    className: 'bg-[rgba(var(--color-info-rgb),0.5)] text-(--color-font-info)',
  },
};

// Session-era (legacy) panels that exist only in the older protocol versions. Built in S3.
export type SessionTab = 'ping' | 'logging' | 'roots' | 'sampling' | 'tasks' | 'subscriptions';
const SESSION_TABS: Partial<Record<McpDebuggerTabId, { id: SessionTab; label: string; chip?: string }>> = {
  ping: { id: 'ping', label: 'Ping' },
  logging: { id: 'logging', label: 'Logging' },
  roots: { id: 'roots', label: 'Roots' },
  sampling: { id: 'sampling', label: 'Sampling' },
  // The tasks extension (2026-07-28): same kind of non-capability panel, so it lives in this section too.
  tasks: { id: 'tasks', label: 'Tasks', chip: 'Ext' },
  subscriptions: { id: 'subscriptions', label: 'Subscriptions', chip: 'Ext' },
};

export const CapabilitySidebar: FC<{
  capabilities: Capability[];
  protocolVersion?: string;
  selectedKey: string | null;
  onSelect: (capability: Capability) => void;
  selectedSession: SessionTab | null;
  onSelectSession: (tab: SessionTab) => void;
  /** Tasks still running, shown next to the Tasks entry. */
  activeTaskCount: number;
  subscriptionActive: boolean;
  isConnected: boolean;
}> = ({ capabilities, protocolVersion, selectedKey, onSelect, selectedSession, onSelectSession, activeTaskCount, subscriptionActive, isConnected }) => {
  const [filter, setFilter] = useState('');
  const visible = useMemo(
    () =>
      capabilities.filter(c =>
        filter ? Boolean(fuzzyMatchAll(filter, [c.metadata.name, c.metadata.description || ''])?.indexes) : true,
      ),
    [capabilities, filter],
  );
  // Tools, then resources, then prompts, in server order within each.
  const ordered = useMemo(() => GROUPS.flatMap(({ type }) => visible.filter(c => c.type === type)), [visible]);
  const profile = isSupportedVersion(protocolVersion) ? getProfile(protocolVersion) : null;
  const sessionTabs = profile ? profile.tabs.flatMap(t => SESSION_TABS[t] ?? []) : [];

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="mcp-capability-sidebar">
      <div className="p-(--padding-sm)">
        <SearchField aria-label="Filter capabilities" className="relative" value={filter} onChange={setFilter}>
          <Input
            placeholder="Filter"
            className="w-full rounded-xs border border-solid border-(--hl-md) bg-transparent px-2 py-1 text-sm"
          />
        </SearchField>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!isConnected && <p className="p-3 text-sm text-(--hl)">Connect to list tools, resources and prompts.</p>}
        {isConnected && capabilities.length === 0 && (
          <p className="p-3 text-sm text-(--hl)">This server lists no tools, resources or prompts.</p>
        )}
        {isConnected && capabilities.length > 0 && ordered.length === 0 && (
          <p className="p-3 text-sm text-(--hl)">No matches.</p>
        )}
        {/* One flat list: the chip says what each entry is, so no group headings. Rows use the trace list's spacing. */}
        {isConnected &&
          ordered.map(c => {
            const key = capabilityKey(c);
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSelect(c)}
                data-testid={`mcp-capability-${key}`}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-(--hl-xs) ${selectedKey === key ? 'bg-(--hl-sm)' : ''}`}
              >
                <span className={`${CHIP_BASE} ${CHIPS[c.type].className}`}>{CHIPS[c.type].label}</span>
                {c.ui?.resourceUri && (
                  <span className={`${CHIP_BASE} border-(--hl-md) text-(--hl)`} title="This tool has an app view (see its App tab)">
                    App
                  </span>
                )}
                <span className="truncate">{c.metadata.name}</span>
              </button>
            );
          })}
        {isConnected && sessionTabs.length > 0 && (
          <section className="mt-3 border-t border-solid border-(--hl-md) pt-1" data-testid="mcp-session-tabs">
            {sessionTabs.some(tab => isLegacyOnlyTab(tab.id as McpDebuggerTabId)) && (
              <TooltipTrigger delay={200}>
                <Focusable>
                  <p className="px-2 py-1 text-[0.65rem] font-semibold tracking-wide text-amber-500 uppercase" data-testid="mcp-legacy-tabs-note">
                    Session-era panels · not in {NEWEST_VERSION}
                  </p>
                </Focusable>
                <Tooltip
                  offset={8}
                  className="max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none"
                >
                  Panels marked Sess exist only in session-era protocol versions ({protocolVersion}). The newest version,{' '}
                  {NEWEST_VERSION}, has no such panel in Insomnia. Tasks and Subscriptions, marked Ext, are newer.
                </Tooltip>
              </TooltipTrigger>
            )}
            {sessionTabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onSelectSession(tab.id)}
                data-testid={`mcp-session-${tab.id}`}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-(--hl-xs) ${selectedSession === tab.id ? 'bg-(--hl-sm)' : ''}`}
              >
                <span className={`${CHIP_BASE} border-(--hl-md) text-(--hl)`}>{tab.chip ?? 'Sess'}</span>
                <span className="truncate">{tab.label}</span>
                {tab.id === 'subscriptions' && subscriptionActive && (
                  <span className="ml-auto text-xs text-green-500" title="A subscription stream is open">
                    live
                  </span>
                )}
                {tab.id === 'tasks' && activeTaskCount > 0 && (
                  <span className="ml-auto text-xs text-amber-500" title="Tasks still running">
                    {activeTaskCount} active
                  </span>
                )}
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
};
