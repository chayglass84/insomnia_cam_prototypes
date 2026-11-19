import type { AuthTypeOAuth2, McpRequest } from 'insomnia-data';
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { useLatest } from 'react-use';

import {
  DEFAULT_VERSION_CHOICE,
  isVersionChoice,
  type McpVersionChoice,
  SUPPORTED_VERSIONS,
} from '~/common/mcp-debugger/versions';
import { getConfidentialBasicAuthHeaderValue } from '~/common/network/sensitive-value-collector';
import { getDataFromKVPair } from '~/common/utils/environment-utils';
import type { McpDebuggerState } from '~/main/mcp-debugger/service';
import { _buildBearerHeader } from '~/network/authentication';
import { getBasicAuthHeader } from '~/network/basic-auth/get-header';
import { getBearerAuthHeader } from '~/network/bearer-auth/get-header';
import { OneLineEditor, type OneLineEditorHandle } from '~/ui/components/.client/codemirror/one-line-editor';
import { Dropdown, DropdownItem, DropdownSection, ItemContent } from '~/ui/components/base/dropdown';
import { useRequestPatcher } from '~/ui/hooks/use-request';
import { tryToInterpolateRequestAndCollectSensitiveValues } from '~/ui/utils/try-interpolate';

import { createKeybindingsHandler, useDocBodyKeyboardShortcuts } from '../keydown-binder';

// Task 4348 S1 URL bar for HTTP MCP requests: URL + protocol version picker + Connect/Disconnect, wired to
// window.main.mcpDebugger instead of the old SDK client. Template rendering and auth-header building are copied from
// the old mcp-url-bar.tsx (which now only serves stdio requests).
// PROTOTYPE-MOCK: OAuth 2 uses the legacy getOAuth2Token path here; the stepped OAuth debugger is slice S5.


export const McpDebuggerUrlBar = ({
  request,
  environmentId,
  state,
  uniqueKey,
}: {
  request: McpRequest;
  environmentId: string;
  state: McpDebuggerState;
  uniqueKey: string;
}) => {
  const patchRequest = useRequestPatcher();
  const editorRef = useRef<OneLineEditorHandle>(null);
  const [isStarting, setIsStarting] = useState(false);
  const isConnected = state.status === 'connected';
  const isConnecting = state.status === 'connecting' || isStarting;
  const canEdit = !isConnected && !isConnecting;
  const choice: McpVersionChoice = isVersionChoice(request.protocolVersion)
    ? request.protocolVersion
    : DEFAULT_VERSION_CHOICE;

  // Once Auto has resolved against a server, show what it picked, e.g. "Auto (2026-07-28)".
  const triggerLabel = choice === 'auto' ? (state.protocolVersion ? `Auto (${state.protocolVersion})` : 'Auto') : choice;

  useLayoutEffect(() => {
    editorRef.current?.focusEnd();
  }, []);

  const buildConnectParams = useCallback(async () => {
    const result = await tryToInterpolateRequestAndCollectSensitiveValues({
      request,
      environmentId,
      payload: {
        url: request.url,
        headers: request.headers,
        authentication: request.authentication,
        env: getDataFromKVPair(request.env).data,
      },
    });
    if (!result) {
      return null;
    }
    const { rendered, sensitiveValues } = result;
    const { authentication, headers } = rendered;
    if (!authentication.disabled) {
      try {
        if (authentication.type === 'basic') {
          const { username, password, useISO88591 } = authentication;
          headers.push(getBasicAuthHeader(username, password, useISO88591 ? 'latin1' : 'utf8'));
          const confidential = getConfidentialBasicAuthHeaderValue(sensitiveValues, authentication);
          if (confidential) {
            sensitiveValues.push(confidential);
          }
        } else if (authentication.type === 'bearer' && authentication.token) {
          headers.push(getBearerAuthHeader(authentication.token, authentication.prefix));
        } else if (authentication.type === 'apikey') {
          headers.push({ name: authentication.key, value: authentication.value });
        } else if (authentication.type === 'oauth2') {
          const token = await window.main.getOAuth2Token(request._id, authentication as AuthTypeOAuth2);
          const header = token ? _buildBearerHeader(token.accessToken, authentication.tokenPrefix) : null;
          if (header) {
            headers.push(header);
          }
        }
      } catch (error) {
        console.error('[mcp-debugger] failed to build auth header', error);
      }
    }
    return { url: rendered.url, headers };
  }, [environmentId, request]);

  const connectWith = useCallback(
    async (versionChoice: McpVersionChoice) => {
      setIsStarting(true);
      try {
        const params = await buildConnectParams();
        if (!params) {
          return;
        }
        const next = await window.main.mcpDebugger.connect({
          requestId: request._id,
          url: params.url,
          headers: params.headers,
          protocolVersion: versionChoice,
          roots: request.roots,
        });
        // A failed connect is already in the trace (and the shell shows a banner for protocol mismatches).
        if (next.status === 'error') {
          console.warn('[mcp-debugger] connect failed:', next.error);
        }
      } catch (err) {
        // Only an IPC-level failure lands here (nothing reached the trace).
        console.error('[mcp-debugger] connect threw', err);
      } finally {
        setIsStarting(false);
      }
    },
    [buildConnectParams, request._id, request.roots],
  );

  const handleSubmit = useCallback(async () => {
    if (isConnecting) {
      return;
    }
    if (isConnected) {
      await window.main.mcpDebugger.disconnect({ requestId: request._id });
      return;
    }
    await connectWith(choice);
  }, [choice, connectWith, isConnected, isConnecting, request._id]);

  // The version can't change mid-session, so picking one while connected reconnects with it.
  const selectVersion = async (version: McpVersionChoice) => {
    patchRequest(request._id, { protocolVersion: version });
    if (isConnected) {
      await window.main.mcpDebugger.disconnect({ requestId: request._id });
      await connectWith(version);
    }
  };
  const handleSubmitRef = useLatest(handleSubmit);

  useDocBodyKeyboardShortcuts({
    request_send: () => handleSubmitRef.current(),
    request_focusUrl: () => editorRef.current?.selectAll(),
  });

  return (
    <>
      <div className="flex items-center gap-1 pl-2">
        <span className="text-xs text-(--hl)">MCP Spec</span>
        <Dropdown
          triggerButton={
            <Button
              aria-label="MCP protocol version"
              className={`flex items-center gap-1 ${isConnecting ? 'cursor-not-allowed opacity-30' : ''}`}
              data-testid="mcp-version-picker"
            >
              <span>{triggerLabel}</span> <i className="fa fa-caret-down space-left" />
            </Button>
          }
          placement="bottom start"
          isDisabled={isConnecting}
        >
          <DropdownSection>
            {(['auto', ...SUPPORTED_VERSIONS] as McpVersionChoice[]).map(v => (
              <DropdownItem key={v}>
                <ItemContent
                  label={v === 'auto' ? 'Auto (detect from server)' : v}
                  isSelected={v === choice}
                  onClick={() => selectVersion(v)}
                />
              </DropdownItem>
            ))}
          </DropdownSection>
        </Dropdown>
      </div>
      <form
        className="flex min-w-0 flex-1"
        onSubmit={event => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <div className="box-border h-full w-full px-(--padding-md)">
          <OneLineEditor
            id="mcp-url-bar"
            key={uniqueKey}
            historyKey={`mcp-url-bar::${request._id}`}
            ref={editorRef}
            onKeyDown={createKeybindingsHandler({ Enter: () => handleSubmitRef.current() })}
            readOnly={!canEdit}
            defaultValue={request.url}
            onChange={url => patchRequest(request._id, { url })}
            type="text"
          />
        </div>
        <div className="flex p-1">
          {isConnected ? (
            <button
              type="submit"
              className="rounded-xs bg-(--color-danger) px-(--padding-md) text-center text-(--color-font-danger) hover:brightness-75"
              data-testid="mcp-disconnect"
            >
              Disconnect
            </button>
          ) : (
            <button
              type="submit"
              disabled={isConnecting}
              className="rounded-xs bg-(--color-surprise) px-(--padding-md) text-center text-(--color-font-surprise) hover:brightness-75 disabled:opacity-60"
              data-testid="mcp-connect"
            >
              {isConnecting ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </form>
    </>
  );
};
