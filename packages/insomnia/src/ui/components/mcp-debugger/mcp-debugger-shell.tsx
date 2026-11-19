import type { McpRequest } from 'insomnia-data';
import React, { useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { capabilityKey } from '~/common/mcp-debugger/protocol/mcp/capabilities/methods';
import type { Capability } from '~/common/mcp-debugger/protocol/Protocol';
import {
  useWorkspaceLoaderData,
  WORKSPACE_CONTENT_WRAPPER,
} from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { ErrorBoundary } from '~/ui/components/error-boundary';
import { OrganizationTabList } from '~/ui/components/tabs/tab-list';
import WorkspacePaneHeader from '~/ui/components/workspace/workspace-pane-header';
import { useGitVCSVersion } from '~/ui/hooks/use-vcs-version';

import { CapabilitySidebar } from './capability-sidebar';
import { McpDebuggerUrlBar } from './mcp-debugger-url-bar';
import { McpDebuggerRequestPane } from './request-pane';
import { McpTracePane } from './trace-pane';
import { useMcpDebugger } from './use-mcp-debugger';

/**
 * Task 4348 S1: the replacement MCP client shell for HTTP requests (stdio still uses the legacy McpPane until a later
 * slice). One shell for every protocol version: what differs per version comes from ProtocolProfile, not from forks.
 */
export const McpDebuggerShell = ({ request }: { request: McpRequest }) => {
  const { activeEnvironment, activeGlobalEnvironment, vcsVersion } = useWorkspaceLoaderData()!;
  const gitVersion = useGitVCSVersion();
  const { state, trace, clearTrace } = useMcpDebugger(request._id);
  const [selected, setSelected] = useState<Capability | null>(null);
  const isConnected = state.status === 'connected';
  const uniqueKey = `${activeEnvironment?._id}::${activeEnvironment?.modified}::${activeGlobalEnvironment?._id}::${activeGlobalEnvironment?.modified}::${request._id}::${gitVersion}::${vcsVersion}::${isConnected}`;

  return (
    <div className="flex h-full flex-col" data-testid="mcp-debugger-shell">
      <OrganizationTabList currentPage="mcp" />
      <WorkspacePaneHeader hasSettings />
      <header className="flex h-(--line-height-sm) shrink-0 items-stretch border-b border-solid border-(--hl-md) bg-(--color-bg) text-(--color-font)">
        <McpDebuggerUrlBar
          request={request}
          environmentId={activeEnvironment?._id || ''}
          state={state}
          uniqueKey={uniqueKey}
        />
      </header>
      {/* Every connect failure lands in the trace; only a protocol mismatch also gets this banner. */}
      {state.protocolIssue && (
        <div
          className="flex items-center gap-2 border-b border-solid border-(--hl-md) bg-amber-500/10 px-3 py-1.5 text-xs text-amber-500"
          data-testid="mcp-protocol-issue"
        >
          <i className="fa fa-triangle-exclamation" />
          <span>{state.protocolIssue}</span>
        </div>
      )}
      <PanelGroup
        autoSaveId="insomnia-sidebar"
        id={WORKSPACE_CONTENT_WRAPPER}
        className="new-sidebar min-h-0 w-full flex-1 text-(--color-font)"
        direction="horizontal"
      >
        <Panel id="sidebar" className="sidebar theme--sidebar" maxSize={40} minSize={10} collapsible>
          <CapabilitySidebar
            capabilities={state.capabilities}
            protocolVersion={state.protocolVersion}
            isConnected={isConnected}
            selectedKey={selected ? capabilityKey(selected) : null}
            onSelect={setSelected}
          />
        </Panel>
        <PanelResizeHandle className="h-full w-px bg-(--hl-md)" />
        <Panel className="flex flex-col">
          <PanelGroup autoSaveId="mcp-debugger-panels" id="mcp-debugger-panels" direction="vertical">
            <Panel id="mcp-debugger-request" order={1} minSize={15} className="pane-one theme--pane">
              <ErrorBoundary showAlert>
                <McpDebuggerRequestPane
                  request={request}
                  capability={selected}
                  isConnected={isConnected}
                  uniqueKey={uniqueKey}
                />
              </ErrorBoundary>
            </Panel>
            <PanelResizeHandle className="h-px w-full bg-(--hl-md)" />
            <Panel id="mcp-debugger-trace" order={2} minSize={15} className="pane-two theme--pane">
              <ErrorBoundary showAlert>
                <McpTracePane requestId={request._id} trace={trace} onClear={clearTrace} />
              </ErrorBoundary>
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  );
};
