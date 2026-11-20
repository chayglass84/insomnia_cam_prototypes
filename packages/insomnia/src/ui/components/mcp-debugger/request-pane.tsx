import type { RJSFSchema } from '@rjsf/utils';
import type { McpRequest } from 'insomnia-data';
import React, { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';

import type { AuthTypes } from '~/common/constants';
import { capabilityKey } from '~/common/mcp-debugger/protocol/mcp/capabilities/methods';
import type { Capability } from '~/common/mcp-debugger/protocol/Protocol';
import type { TraceEvent } from '~/common/mcp-debugger/protocol/TraceEvent';
import type { SubscriptionView, TaskView } from '~/main/mcp-debugger/service';
import { getAuthObjectOrNull } from '~/network/authentication';
import { AuthWrapper } from '~/ui/components/editors/auth/auth-wrapper';
import { RequestHeadersEditor } from '~/ui/components/editors/request-headers-editor';
import { InsomniaRjsfForm, type InsomniaRjsfFormHandle } from '~/ui/components/rjsf';

import type { SessionTab } from './capability-sidebar';
import { OAuthDiscoverButton } from './oauth-discovery-panel';
import { PrototypeMock } from './prototype-mock';
import { SegmentedToggle } from './segmented-toggle';
import { SessionPanel } from './session-panels';

// Task 4348 S1 request pane: Params (schema form or raw JSON) / Auth / Headers for the selected capability.
// PROTOTYPE-MOCK: params live in component state per capability (not persisted to McpPayload); S2 persists runs.

const supportedAuthTypes: AuthTypes[] = ['basic', 'oauth2', 'bearer', 'apikey'];
const SEND_LABEL = { tool: 'Call Tool', resource: 'Read Resource', prompt: 'Get Prompt' } as const;
const tabClass =
  'flex h-full shrink-0 cursor-pointer items-center gap-2 px-3 py-1 text-(--hl) outline-hidden select-none hover:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font)';

export const McpDebuggerRequestPane: FC<{
  request: McpRequest;
  capability: Capability | null;
  session: SessionTab | null;
  tasks: TaskView[];
  subscription?: SubscriptionView;
  trace: TraceEvent[];
  capabilities: Capability[];
  isConnected: boolean;
  uniqueKey: string;
  onOpenOAuth: () => void;
}> = ({ request, capability, session, tasks, subscription, trace, capabilities, isConnected, uniqueKey, onOpenOAuth }) => {
  const [tab, setTab] = useState<'params' | 'auth' | 'headers'>('params');
  const [argsByCapability, setArgsByCapability] = useState<Record<string, Record<string, unknown>>>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('{}');
  const [rawError, setRawError] = useState<string | null>(null);
  const formRef = useRef<InsomniaRjsfFormHandle>(null);
  const key = capability ? capabilityKey(capability) : '';
  const args = argsByCapability[key] ?? {};
  const requestAuth = getAuthObjectOrNull(request.authentication);
  const authActive = requestAuth !== null && requestAuth?.type !== 'none';
  const headersCount = request.headers.filter(h => !h.disabled).length;

  const schema = useMemo(() => (capability?.schema ?? { type: 'object', properties: {} }) as RJSFSchema, [capability]);
  const hasParams = capability?.type !== 'resource';

  // Keep the raw editor in step when the selection changes or the form edits the args.
  useEffect(() => {
    setRawText(JSON.stringify(args, null, 2));
    setRawError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only on selection / mode change
  }, [key, rawMode]);

  const setArgs = (next: Record<string, unknown>) => setArgsByCapability(prev => ({ ...prev, [key]: next }));

  const send = async () => {
    if (!capability) {
      return;
    }
    formRef.current?.validate(); // surface validation, but never block sending: this is a debugger
    let toSend = args;
    if (rawMode) {
      try {
        toSend = JSON.parse(rawText || '{}');
        setRawError(null);
      } catch (err) {
        setRawError(err instanceof Error ? err.message : 'Invalid JSON');
        return;
      }
    }
    await window.main.mcpDebugger.invokeCapability({ requestId: request._id, capability, args: toSend });
  };

  const lockedBanner = isConnected && (
    <p className="notice info no-margin-top m-(--padding-md)">
      Locked while connected. Disconnect to change these settings.
    </p>
  );

  return (
    <Tabs
      aria-label="MCP request tabs"
      className="flex h-full w-full flex-col"
      selectedKey={tab}
      onSelectionChange={k => setTab(k as typeof tab)}
    >
      <TabList className="flex h-(--line-height-sm) w-full shrink-0 items-center border-b border-solid border-(--hl-md)">
        <Tab id="params" className={tabClass}>
          Params
        </Tab>
        <Tab id="auth" className={tabClass}>
          Auth
          {authActive && <span className="h-2 w-2 rounded-full bg-green-500" />}
        </Tab>
        <Tab id="headers" className={tabClass}>
          Headers
          {headersCount > 0 && <span className="text-xs">{headersCount}</span>}
        </Tab>
      </TabList>
      <TabPanel id="params" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!isConnected ? (
          <p className="notice info m-(--padding-md)">Connect to an MCP server to build requests.</p>
        ) : session ? (
          <SessionPanel
            tab={session}
            request={request}
            isConnected={isConnected}
            tasks={tasks}
            subscription={subscription}
            trace={trace}
            capabilities={capabilities}
          />
        ) : !capability ? (
          <p className="notice info m-(--padding-md)">Select a tool, resource or prompt from the list.</p>
        ) : (
          <div className="flex flex-col gap-3 p-(--padding-md)">
            {/* The toggle is first and fixed-width so it stays put while the tool name/description change size. */}
            <div className="flex items-center gap-3">
              {hasParams && (
                <SegmentedToggle
                  label="Params view"
                  testIdPrefix="mcp-params-mode"
                  value={rawMode ? 'json' : 'form'}
                  onChange={mode => setRawMode(mode === 'json')}
                  options={[
                    { id: 'json', label: 'JSON' },
                    { id: 'form', label: 'Form' },
                  ]}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-bold">{capability.metadata.name}</p>
                <p className="text-sm text-(--hl)">{capability.metadata.description}</p>
              </div>
              <Button
                className="shrink-0 rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-(--color-font-surprise)"
                onPress={send}
                data-testid="mcp-send"
              >
                {SEND_LABEL[capability.type]}
              </Button>
            </div>
            {capability.type === 'resource' && (
              <p className="text-sm">uri: {String(capability.metadata.uri ?? capability.id)}</p>
            )}
            {hasParams && !rawMode && (
              <InsomniaRjsfForm
                key={key}
                ref={formRef}
                formData={args}
                onChange={setArgs}
                schema={schema}
                showErrorList={false}
                focusOnFirstError
              />
            )}
            {hasParams && rawMode && (
              <div className="flex flex-col gap-1">
                <textarea
                  aria-label="Raw JSON arguments"
                  className="h-48 w-full rounded-xs border border-solid border-(--hl-md) bg-transparent p-2 font-mono text-xs"
                  value={rawText}
                  onChange={e => {
                    setRawText(e.target.value);
                    try {
                      setArgs(JSON.parse(e.target.value || '{}'));
                      setRawError(null);
                    } catch (err) {
                      setRawError(err instanceof Error ? err.message : 'Invalid JSON');
                    }
                  }}
                />
                {rawError && <p className="text-xs text-red-500">{rawError} (send is blocked until the JSON parses)</p>}
              </div>
            )}
            <PrototypeMock
              inline={false}
              reason="Editing and replaying any call from the trace arrives in slice S2. For now this builds a fresh call."
            />
          </div>
        )}
      </TabPanel>
      <TabPanel id="auth" className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
        {lockedBanner}
        <AuthWrapper
          key={uniqueKey}
          authentication={request.authentication}
          disabled={isConnected}
          authTypes={supportedAuthTypes}
          hideInherit
          addToHeaderOnly
          belowToolbar={!authActive || requestAuth?.type === 'bearer' ? <OAuthDiscoverButton onOpen={onOpenOAuth} isDisabled={!request.url} /> : undefined}
        />
      </TabPanel>
      <TabPanel id="headers" className="w-full flex-1 overflow-y-auto">
        {lockedBanner}
        <RequestHeadersEditor
          key={uniqueKey}
          headers={request.headers}
          bulk={false}
          isDisabled={isConnected}
          requestType="McpRequest"
          disableUserAgentHeader={request.disableUserAgentHeader}
        />
      </TabPanel>
    </Tabs>
  );
};
