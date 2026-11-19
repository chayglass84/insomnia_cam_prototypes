import { fuzzyMatchAll } from 'insomnia-data/common';
import React, { type FC, useMemo, useState } from 'react';
import { Input, SearchField } from 'react-aria-components';

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
export type SessionTab = 'ping' | 'logging' | 'roots' | 'sampling';
const SESSION_TABS: Partial<Record<McpDebuggerTabId, { id: SessionTab; label: string }>> = {
  ping: { id: 'ping', label: 'Ping' },
  logging: { id: 'logging', label: 'Logging' },
  roots: { id: 'roots', label: 'Roots' },
  sampling: { id: 'sampling', label: 'Sampling' },
};

// Still to build (slice S4): shown as visible mock rows.
const MOCK_TABS: Partial<Record<McpDebuggerTabId, string>> = {
  tasks: 'Tasks (slice S4)',
  subscriptions: 'Subscriptions (slice S4)',
};

export const CapabilitySidebar: FC<{
  capabilities: Capability[];
  protocolVersion?: string;
  selectedKey: string | null;
  onSelect: (capability: Capability) => void;
  selectedSession: SessionTab | null;
  onSelectSession: (tab: SessionTab) => void;
  isConnected: boolean;
}> = ({ capabilities, protocolVersion, selectedKey, onSelect, selectedSession, onSelectSession, isConnected }) => {
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
  const mockTabs = profile ? profile.tabs.filter(t => MOCK_TABS[t]) : [];
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
                <span className="truncate">{c.metadata.name}</span>
              </button>
            );
          })}
        {isConnected && sessionTabs.length > 0 && (
          <section className="mt-3 border-t border-solid border-(--hl-md) pt-1" data-testid="mcp-session-tabs">
            {sessionTabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onSelectSession(tab.id)}
                data-testid={`mcp-session-${tab.id}`}
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-(--hl-xs) ${selectedSession === tab.id ? 'bg-(--hl-sm)' : ''}`}
              >
                <span className={`${CHIP_BASE} border-(--hl-md) text-(--hl)`}>Sess</span>
                <span className="truncate">{tab.label}</span>
              </button>
            ))}
          </section>
        )}
        {isConnected && mockTabs.length > 0 && (
          <section className="mt-3 border-t border-dashed border-amber-500/50 p-3" data-testid="mcp-mock-tabs">
            <h4 className="mb-1 text-xs font-bold text-amber-500 uppercase">Not built yet · {protocolVersion}</h4>
            {mockTabs.map(t => (
              <p key={t} className="py-0.5 text-xs text-(--hl)">
                {MOCK_TABS[t]}
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
};
