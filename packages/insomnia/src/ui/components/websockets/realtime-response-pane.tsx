import classnames from 'classnames';
import type {
  McpResponse,
  RequestVersion,
  Response,
  ResponseTimelineEntry,
  SocketIOResponse,
  WebSocketResponse,
} from 'insomnia-data';
import { models, services } from 'insomnia-data';
import { deserializeNDJSON } from 'insomnia-data/common';
import React, { type FC, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Input,
  SearchField,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
  Tooltip,
  TooltipTrigger,
} from 'react-aria-components';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useParams } from 'react-router';

import type { ChatMessage } from '~/common/chat-completion';
import {
  applyChatSamplingParams,
  parseChatRequestBody,
  parseChatSamplingParams,
  serializeChatRequestBody,
} from '~/common/chat-request';
import {
  ensureIncludeUsageFlag,
  ensureStreamingBodyFlag,
  hasIncludeUsageFlag,
  hasStreamingBodyFlag,
} from '~/common/chat-streaming';
import { docsMcpAuthentication } from '~/common/documentation';
import { isPlainHttpBody } from '~/common/stream-event-log';
import { extractStreamChatMeta, getCandidatePayloadsFromEvents, type StreamMessageEvent } from '~/common/stream-summary';
import { buildQueryStringFromParams, joinUrlAndQueryString } from '~/common/utils/url/querystring';
import { showToast } from '~/ui/components/toast-notification';
import { useMcpReadyState } from '~/ui/hooks/use-mcp-ready-state';
import { useRealtimeConnectionNotifications } from '~/ui/hooks/use-realtime-connection-notifications';
import { useStreamSummary } from '~/ui/hooks/use-stream-summary';
import { recordChatTurnMeta } from '~/ui/utils/chat-turn-meta-cache';
import { consumePendingAutoConnect } from '~/ui/utils/pending-auto-connect';
import { recordProjectRecentRequest } from '~/ui/utils/recent-project-requests';
import { renderRealtimeConnectPayload } from '~/ui/utils/render-realtime-connect';

import { getSetCookieHeaders } from '../../../common/misc';
import type { McpEvent } from '../../../main/mcp/types';
import type { CurlEvent } from '../../../main/network/curl';
import type { SocketIOEvent } from '../../../main/network/socket-io';
import type { WebSocketEvent } from '../../../main/network/websocket';
import { useWorkspaceLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import {
  type RequestLoaderData,
  useRequestLoaderData,
} from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.request.$requestId';
import { useRequestConnectActionFetcher } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.request.$requestId.connect';
import { AnalyticsEvent } from '../../../ui/analytics';
import { useReadyState } from '../../hooks/use-ready-state';
import { useRealtimeConnectionEvents } from '../../hooks/use-realtime-connection-events';
import { useRequestPatcher } from '../../hooks/use-request';
import { Dropdown, DropdownItem, DropdownSection, ItemContent } from '../base/dropdown';
import { ResponseHistoryDropdown } from '../dropdowns/response-history-dropdown';
import { ErrorBoundary } from '../error-boundary';
import { Icon } from '../icon';
import { MarkdownPreview } from '../markdown-preview';
import { McpEventView } from '../mcp/event-view';
import { McpNotificationTab } from '../mcp/mcp-notification-tab';
import { Pane, PaneHeader } from '../panes/pane';
import { PlaceholderResponsePane } from '../panes/placeholder-response-pane';
import { ResponsePane } from '../panes/response-pane';
import { SocketIOEventView } from '../socket-io/event-view';
import { SvgIcon } from '../svg-icon';
import { SizeTag } from '../tags/size-tag';
import { StatusTag } from '../tags/status-tag';
import { TimeTag } from '../tags/time-tag';
import type { ChatSettingsValues } from '../viewers/chat-settings-bar';
import { ResponseChatViewer } from '../viewers/response-chat-viewer';
import { ResponseCookiesViewer } from '../viewers/response-cookies-viewer';
import { ResponseErrorViewer } from '../viewers/response-error-viewer';
import { ResponseHeadersViewer } from '../viewers/response-headers-viewer';
import { ResponseTimelineViewer } from '../viewers/response-timeline-viewer';
import { EventLogView } from './event-log-view';
import { EventView } from './event-view';

const StreamSummaryPanel: FC<{ requestId: string; streamSummary: ReturnType<typeof useStreamSummary> }> = ({
  requestId,
  streamSummary,
}) => {
  const showWarning = Boolean(streamSummary.resultPath) && streamSummary.summary.fragmentCount === 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-(--padding-sm) p-(--padding-sm)">
        <TextField
          // Uncontrolled: `key` resets the field when switching requests, but typing isn't
          // clobbered by the round-trip through patchRequestMeta -> loader revalidation
          // (same reason code-editor.tsx's filter input uses defaultValue, not value).
          key={requestId}
          aria-label="Stream summary JSONPath"
          defaultValue={streamSummary.resultPath ?? ''}
          onChange={value => {
            if (value === '') {
              streamSummary.setResultPath('');
            }
          }}
          className="w-full"
        >
          <Input
            placeholder={streamSummary.inferredPath ?? 'JSONPath, e.g. $.choices[0].delta.content'}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                streamSummary.setResultPath(e.currentTarget.value);
              }
            }}
            className="w-full rounded-sm border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1 text-(--color-font) transition-colors focus:ring-1 focus:ring-(--hl-md) focus:outline-hidden"
          />
        </TextField>
        {showWarning && (
          <TooltipTrigger>
            <Button
              aria-label="JSONPath matched no messages"
              className="flex aspect-square h-full shrink-0 items-center justify-center text-(--color-warning)"
            >
              <Icon icon="triangle-exclamation" />
            </Button>
            <Tooltip
              offset={8}
              className="max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-sm text-(--color-font) shadow-lg select-none focus:outline-hidden"
            >
              This JSONPath did not match any incoming message.
            </Tooltip>
          </TooltipTrigger>
        )}
        <Dropdown
          aria-label="Stream summary render mode dropdown"
          triggerButton={
            <Button className="tall shrink-0">
              {streamSummary.renderMarkdown ? 'Markdown' : 'Plain text'}
              <i className="fa fa-caret-down space-left" />
            </Button>
          }
        >
          <DropdownSection aria-label="Render as section" title="Render as">
            <DropdownItem aria-label="Plain text">
              <ItemContent
                icon={streamSummary.renderMarkdown ? 'empty' : 'check'}
                label="Plain text"
                onClick={() => streamSummary.setRenderMarkdown(false)}
              />
            </DropdownItem>
            <DropdownItem aria-label="Markdown">
              <ItemContent
                icon={streamSummary.renderMarkdown ? 'check' : 'empty'}
                label="Markdown"
                onClick={() => streamSummary.setRenderMarkdown(true)}
              />
            </DropdownItem>
          </DropdownSection>
        </Dropdown>
      </div>
      <div className="flex-1 overflow-auto p-(--padding-sm)">
        {streamSummary.renderMarkdown ? (
          <MarkdownPreview markdown={streamSummary.summary.summary} />
        ) : (
          <pre className="font-mono text-sm whitespace-pre-wrap text-(--color-font)">
            {streamSummary.summary.summary}
          </pre>
        )}
      </div>
    </div>
  );
};

export const RealtimeResponsePane: FC<{ requestId?: string }> = ({ requestId }) => {
  const { activeResponse, responses, requestVersions } = useRequestLoaderData()!;

  if (!activeResponse) {
    return (
      <Pane type="response">
        <PaneHeader className="justify-normal!" />
        <PlaceholderResponsePane />
      </Pane>
    );
  }
  // Prototype (3593AI): a response from a plain send (e.g. a runner run of a streaming request) has an ordinary body, not
  // an event log, so the events view would be empty. Show it in the regular response pane; its history dropdown switches
  // back to the streamed responses. Large or empty bodies are not loaded here and keep the old behaviour.
  if (requestId && models.response.isResponse(activeResponse) && isPlainHttpBody(activeResponse.bodyBuffer)) {
    return <ResponsePane activeRequestId={requestId} />;
  }
  return (
    <RealTimeActiveResponsePaneWrapper
      response={activeResponse}
      responses={responses}
      requestVersions={requestVersions}
      autoSelectLatestEvent={models.mcpResponse.isMcpResponse(activeResponse)}
    />
  );
};

type ResponseType = WebSocketResponse | Response | SocketIOResponse | McpResponse;
type EventType = CurlEvent | WebSocketEvent | SocketIOEvent | McpEvent;
type ReadyState = 'disconnected' | 'connecting' | 'connected';
interface RealtimeActiveResponsePaneProps {
  response: ResponseType;
  responses: ResponseType[];
  requestVersions: RequestVersion[];
  autoSelectLatestEvent?: boolean;
}

const RealTimeActiveResponsePaneWrapper: FC<RealtimeActiveResponsePaneProps> = props => {
  const { response } = props;
  const protocol = useMemo(() => {
    if (models.socketIOResponse.isSocketIOResponse(response)) {
      return 'socketIO';
    }
    if (models.mcpResponse.isMcpResponse(response)) {
      return 'mcp';
    }
    return response.type === 'WebSocketResponse' ? 'webSocket' : 'curl';
  }, [response]);

  if (protocol === 'mcp') {
    return <RealTimeActiveResponsePaneForMcp {...props} />;
  }
  return <RealTimeActiveResponsePaneForOthers {...props} protocol={protocol} />;
};

const RealTimeActiveResponsePaneForMcp: FC<RealtimeActiveResponsePaneProps> = props => {
  const { response } = props;
  const requestId = response.parentId;
  const readyState = useMcpReadyState({ requestId });
  return <RealtimeActiveResponsePane {...props} readyState={readyState} />;
};

const RealTimeActiveResponsePaneForOthers: FC<
  RealtimeActiveResponsePaneProps & { protocol: 'curl' | 'webSocket' | 'socketIO' }
> = props => {
  const { response, protocol } = props;
  const requestId = response.parentId;
  const readyState = useReadyState({ requestId, protocol });
  return <RealtimeActiveResponsePane {...props} readyState={readyState ? 'connected' : 'disconnected'} />;
};

const RealtimeActiveResponsePane: FC<RealtimeActiveResponsePaneProps & { readyState: ReadyState }> = ({
  response,
  responses,
  requestVersions,
  autoSelectLatestEvent,
  readyState,
}) => {
  const [selectedEvent, setSelectedEvent] = useState<EventType | null>(null);
  const [timeline, setTimeline] = useState<ResponseTimelineEntry[]>([]);
  const [clearEventsBefore, setClearEventsBefore] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [eventType, setEventType] = useState<CurlEvent['type']>();
  const isConnected = readyState === 'connected';

  const protocol = useMemo(() => {
    if (models.socketIOResponse.isSocketIOResponse(response)) {
      return 'socketIO';
    }
    if (models.mcpResponse.isMcpResponse(response)) {
      return 'mcp';
    }
    return response.type === 'WebSocketResponse' ? 'webSocket' : 'curl';
  }, [response]);

  const allEvents = useRealtimeConnectionEvents({ responseId: response._id, protocol }) as EventType[];
  const allNotifications = useRealtimeConnectionNotifications({ responseId: response._id, protocol });
  // A follow-up chat message reuses this same response's event log rather than starting a fresh
  // one, so without this cutoff the live-turn accumulator below would keep including every prior
  // turn's already-complete SSE events alongside the new turn's — showing the previous reply
  // (concatenated with whatever's arrived of the new one so far) instead of just the new turn.
  // `clearEventsBefore` is reused here from the "Clear events" timeline action below for the same
  // purpose: both mean "ignore everything logged before this point in time."
  const eventsSinceClear = useMemo(
    () => (clearEventsBefore ? allEvents.filter(event => event.timestamp > clearEventsBefore) : allEvents),
    [allEvents, clearEventsBefore],
  );
  const showStreamSummaryTab = protocol === 'curl';
  const streamSummary = useStreamSummary({
    requestId: response.parentId,
    url: response.url,
    // Only curl carries stream-summary-shaped data — never feed socketIO's/webSocket's
    // events in here mislabeled as curl, even though showStreamSummaryTab already hides
    // the UI for those.
    events: showStreamSummaryTab ? (eventsSinceClear as CurlEvent[]) : [],
  });

  // Chat-completion detection for live streaming responses: only curl (HTTP event-stream)
  // responses can be chat completions, never webSocket/socketIO/MCP.
  const { activeRequest } = useRequestLoaderData() as RequestLoaderData;
  const requestBodyText = protocol === 'curl' ? activeRequest.body?.text : undefined;
  const parsedChatRequest = useMemo(
    () => (requestBodyText ? parseChatRequestBody(requestBodyText) : null),
    [requestBodyText],
  );
  const showChatTab = protocol === 'curl' && Boolean(parsedChatRequest);
  const candidatePayloads = useMemo(
    () =>
      showChatTab
        ? getCandidatePayloadsFromEvents(
            (eventsSinceClear as CurlEvent[]).map((event): StreamMessageEvent => ({
              type: event.type,
              direction: 'direction' in event ? event.direction : '',
              data: 'data' in event ? event.data : '',
            })),
          )
        : [],
    [eventsSinceClear, showChatTab],
  );
  const streamChatMeta = useMemo(() => extractStreamChatMeta(candidatePayloads), [candidatePayloads]);
  const chatModel = streamChatMeta.model ?? parsedChatRequest?.model;

  // Chatting used to rewrite the request's saved body on every follow-up (to carry conversation
  // history to the next turn), so the Body/REST view kept drifting out from under the user just by
  // talking in the chat tab. Conversation history now lives here instead, and only covers what's
  // actually been exchanged *through this chat window* — seeded, on first render of a given
  // connection, with just the user message(s) that were actually sent to produce it (so the window
  // isn't empty right after connecting), then added to as follow-ups happen. "Clear Chat Window"
  // wipes it back to genuinely empty (not even the seeded question) rather than back to this seed.
  const [localConversation, setLocalConversation] = useState<ChatMessage[]>([]);
  // Separate from the above: only the user messages actually *typed into this chat window* via a
  // follow-up — excludes the seeded question above, which already exists in the saved body. "Save
  // as Default Body" appends only these, so it doesn't duplicate what's already saved.
  const [sessionUserMessages, setSessionUserMessages] = useState<ChatMessage[]>([]);
  // A follow-up reconnects too (see `handleSendFollowUp`), which produces its own new `response`
  // just like the very first connect does — so the reseed effect below would otherwise fire again
  // after every follow-up and silently wipe the conversation it just built. Set right before a
  // follow-up's own `connectRequestFetcher.submit`, and consumed (not watched) by the effect, so it
  // can tell "a new response I caused myself" apart from "a new response from an actual reconnect."
  const skipNextChatSeedRef = useRef(false);
  useEffect(() => {
    if (skipNextChatSeedRef.current) {
      skipNextChatSeedRef.current = false;
      return;
    }
    setLocalConversation(parsedChatRequest?.messages.filter(message => message.role === 'user') ?? []);
    setSessionUserMessages([]);
    // Reseed once per connection (new response), not on every edit to the live request body —
    // `parsedChatRequest` is read here as a one-time snapshot at connect time, intentionally not a
    // dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response._id]);

  const chatMessages = useMemo(() => {
    if (!showChatTab) {
      return [];
    }
    const assistantText = streamSummary.summary.summary;
    return assistantText
      ? [...localConversation, { role: 'assistant' as const, content: assistantText }]
      : localConversation;
  }, [showChatTab, localConversation, streamSummary.summary.summary]);

  // Keeps the per-bubble token/model footer (chat-turn-meta-cache.ts) up to date for the live turn
  // as it streams in, so the metadata is already recorded by the time a follow-up or navigation
  // moves past it.
  useEffect(() => {
    if (!showChatTab || !streamSummary.summary.summary.trim()) {
      return;
    }
    recordChatTurnMeta(streamSummary.summary.summary, {
      model: chatModel,
      usage: streamChatMeta.usage,
      stopReason: streamChatMeta.stopReason,
    });
  }, [showChatTab, streamSummary.summary.summary, chatModel, streamChatMeta.usage, streamChatMeta.stopReason]);

  const { organizationId, projectId, workspaceId } = useParams() as {
    organizationId: string;
    projectId: string;
    workspaceId: string;
  };
  const { activeWorkspace, activeEnvironment } = useWorkspaceLoaderData()!;
  const patchRequest = useRequestPatcher();
  const connectRequestFetcher = useRequestConnectActionFetcher();
  const [followUpText, setFollowUpText] = useState('');
  const isSendingFollowUp = connectRequestFetcher.state !== 'idle';
  // True from the moment a follow-up is sent until the new turn's first chunk of assistant text
  // actually arrives — drives the loading bubble below. Cleared by whichever happens first: real
  // content streaming in, the connection erroring out, or navigating to a different request.
  const [isAwaitingFollowUpReply, setIsAwaitingFollowUpReply] = useState(false);
  useEffect(() => {
    if (isAwaitingFollowUpReply && (streamSummary.summary.summary.trim() || response.error)) {
      setIsAwaitingFollowUpReply(false);
    }
  }, [isAwaitingFollowUpReply, streamSummary.summary.summary, response.error]);
  useEffect(() => {
    setIsAwaitingFollowUpReply(false);
  }, [activeRequest._id]);

  // The Accept header alone (which is all that's needed to route a request here) doesn't make a
  // provider actually stream — OpenAI/Anthropic also require a `stream: true` body flag, and a
  // request missing it sends fine but comes back as one slow blocking reply with nothing to show
  // here until it's fully done. Gemini streams via a distinct URL suffix instead of a body flag,
  // so it's excluded from this check rather than showing a banner that doesn't apply to it.
  const isMissingStreamingBodyFlag =
    showChatTab && parsedChatRequest?.format !== 'gemini' && !hasStreamingBodyFlag(requestBodyText);

  // Gateway workspaces show cost, which needs token usage; OpenAI-format streams only send it when asked.
  const isMissingIncludeUsageFlag =
    showChatTab &&
    parsedChatRequest?.format === 'openai' &&
    Boolean(activeWorkspace.konnectAiGatewayModels?.length) &&
    hasStreamingBodyFlag(requestBodyText) &&
    !hasIncludeUsageFlag(requestBodyText);

  const handleFixMissingIncludeUsage = async () => {
    const previousBody = activeRequest.body;
    const nextBodyText = ensureIncludeUsageFlag(previousBody.text);
    if (nextBodyText === null) {
      return;
    }
    const nextBody = { ...previousBody, text: nextBodyText };
    await services.request.update(activeRequest, { body: nextBody });
    patchRequest(activeRequest._id, { body: nextBody });
    showToast(
      {
        icon: 'coins',
        title: 'Added "stream_options.include_usage"',
        status: 'success',
        raised: true,
        description: (
          <span>
            Reconnect to see token usage and cost for the next reply.{' '}
            <Button
              className="underline"
              onPress={async () => {
                await services.request.update(activeRequest, { body: previousBody });
                patchRequest(activeRequest._id, { body: previousBody });
              }}
            >
              Undo
            </Button>
          </span>
        ),
      },
      { timeout: null },
    );
  };

  const handleFixMissingStreamFlag = async () => {
    const previousBody = activeRequest.body;
    const nextBodyText = ensureStreamingBodyFlag(previousBody.text);
    if (nextBodyText === null) {
      return;
    }
    const nextBody = { ...previousBody, text: nextBodyText };
    await services.request.update(activeRequest, { body: nextBody });
    patchRequest(activeRequest._id, { body: nextBody });
    showToast(
      {
        icon: 'bolt',
        title: 'Added "stream": true',
        status: 'success',
        raised: true,
        description: (
          <span>
            The request had an Accept: text/event-stream header but no "stream": true in the body —
            without it most providers send one slow blocking reply instead of real chunks.{' '}
            <Button
              className="underline"
              onPress={async () => {
                await services.request.update(activeRequest, { body: previousBody });
                patchRequest(activeRequest._id, { body: previousBody });
              }}
            >
              Undo
            </Button>
          </span>
        ),
      },
      { timeout: null },
    );
  };

  const chatSettingsValues: ChatSettingsValues = useMemo(() => {
    const samplingParams = parseChatSamplingParams(requestBodyText || '');
    return {
      model: parsedChatRequest?.model,
      systemPrompt: parsedChatRequest?.messages.find(message => message.role === 'system')?.content,
      temperature: samplingParams.temperature,
      maxTokens: samplingParams.maxTokens,
    };
  }, [parsedChatRequest, requestBodyText]);

  // Tracks that a settings edit was applied to the request body but the live connection (if any)
  // still reflects the old values — cleared once the user reconnects.
  const [settingsChangedSinceConnect, setSettingsChangedSinceConnect] = useState(false);
  // The just-applied body, read directly by reconnect rather than via `activeRequest` — the patch
  // above persists immediately, but `activeRequest` only reflects it once the router loader this
  // component reads from has revalidated, which isn't guaranteed to have happened yet by the time
  // the user reacts to the "reconnect" notice and clicks it.
  const pendingSettingsBodyRef = useRef<typeof activeRequest.body | null>(null);
  useEffect(() => {
    pendingSettingsBodyRef.current = null;
    setSettingsChangedSinceConnect(false);
  }, [activeRequest._id]);

  const handleApplyChatSettings = async (next: ChatSettingsValues) => {
    if (!parsedChatRequest) {
      return;
    }
    // Both sides must be normalized the same way before comparing — `next` already comes trimmed
    // out of the settings bar's own fields, but the *current* value (from the raw request body)
    // isn't, so comparing them as-is reported "changed" for any system prompt or model that
    // happened to have incidental surrounding whitespace, even with no actual edit.
    const normalizeText = (value?: string) => value?.trim() || undefined;
    const unchanged =
      normalizeText(next.model) === normalizeText(chatSettingsValues.model) &&
      normalizeText(next.systemPrompt) === normalizeText(chatSettingsValues.systemPrompt) &&
      next.temperature === chatSettingsValues.temperature &&
      next.maxTokens === chatSettingsValues.maxTokens;
    if (unchanged) {
      return;
    }

    const nonSystemMessages = parsedChatRequest.messages.filter(message => message.role !== 'system');
    const nextMessages: ChatMessage[] = next.systemPrompt
      ? [{ role: 'system', content: next.systemPrompt }, ...nonSystemMessages]
      : nonSystemMessages;

    let nextBodyText = serializeChatRequestBody(requestBodyText || '', parsedChatRequest.format, {
      model: next.model,
      messages: nextMessages,
    });
    nextBodyText = applyChatSamplingParams(nextBodyText, {
      temperature: next.temperature,
      maxTokens: next.maxTokens,
    });

    const nextBody = { ...activeRequest.body, text: nextBodyText };
    pendingSettingsBodyRef.current = nextBody;
    await services.request.update(activeRequest, { body: nextBody });
    patchRequest(activeRequest._id, { body: nextBody });
    setSettingsChangedSinceConnect(true);
  };

  const handleReconnectAfterSettingsChange = async () => {
    const rendered = await renderRealtimeConnectPayload({
      request: { ...activeRequest, body: pendingSettingsBodyRef.current ?? activeRequest.body },
      environmentId: activeEnvironment._id,
      workspaceId: activeWorkspace._id,
    });
    if (!rendered) {
      return;
    }
    connectRequestFetcher.submit({
      organizationId,
      projectId,
      workspaceId,
      requestId: activeRequest._id,
      connectParams: {
        url: joinUrlAndQueryString(rendered.url, buildQueryStringFromParams(rendered.parameters)),
        headers: rendered.headers,
        authentication: rendered.authentication,
        body: rendered.body,
        cookieJar: rendered.workspaceCookieJar,
        suppressUserAgent: rendered.suppressUserAgent,
      },
    });
    recordProjectRecentRequest({ projectId, requestId: activeRequest._id, workspaceId: activeWorkspace._id });
    pendingSettingsBodyRef.current = null;
    setSettingsChangedSinceConnect(false);
  };

  // Picks up the "Enable streaming" teaser's auto-connect intent (see pending-auto-connect.ts for
  // why it's deferred here rather than fired from the component that flagged it).
  useEffect(() => {
    if (protocol !== 'curl' || !consumePendingAutoConnect(activeRequest._id)) {
      return;
    }
    (async () => {
      const rendered = await renderRealtimeConnectPayload({
        request: activeRequest,
        environmentId: activeEnvironment._id,
        workspaceId: activeWorkspace._id,
      });
      if (!rendered) {
        return;
      }
      connectRequestFetcher.submit({
        organizationId,
        projectId,
        workspaceId,
        requestId: activeRequest._id,
        connectParams: {
          url: joinUrlAndQueryString(rendered.url, buildQueryStringFromParams(rendered.parameters)),
          headers: rendered.headers,
          authentication: rendered.authentication,
          body: rendered.body,
          cookieJar: rendered.workspaceCookieJar,
          suppressUserAgent: rendered.suppressUserAgent,
        },
      });
      recordProjectRecentRequest({ projectId, requestId: activeRequest._id, workspaceId: activeWorkspace._id });
    })();
    // Intentionally keyed only on the request id — this should fire once per mount for a given
    // request, not re-run on every unrelated change to activeRequest/env/workspace identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRequest._id]);

  const handleSendFollowUp = async () => {
    const text = followUpText.trim();
    // Prefer the just-applied settings body over `requestBodyText` — a settings edit persists
    // immediately, but `requestBodyText` (from `activeRequest`) only reflects it once the router
    // loader has revalidated, which isn't guaranteed to have happened yet.
    const baseBodyText = pendingSettingsBodyRef.current?.text ?? requestBodyText;
    const parsedBody = parseChatRequestBody(baseBodyText || '');
    if (!text || !parsedBody) {
      return;
    }
    // The just-finished turn's reply only ever existed as live-accumulated SSE text (this
    // component's own streamSummary), never written back into the request body — so without this,
    // every follow-up resent the history as consecutive user turns with no assistant turns between
    // them, and the model would answer the entire run-on history in one reply on the next connect.
    const previousAssistantText = streamSummary.summary.summary.trim();
    const messagesWithPreviousReply = previousAssistantText
      ? [...localConversation, { role: 'assistant' as const, content: previousAssistantText }]
      : localConversation;
    const nextConversation = [...messagesWithPreviousReply, { role: 'user' as const, content: text }];
    // `localConversation` is seeded (on connect) with the saved body's own user message(s), so it
    // already carries full history forward turn-by-turn — only the system message (deliberately
    // excluded from the seed, since it's config rather than conversation) needs adding back in here.
    const systemMessage = parsedBody.messages.find(message => message.role === 'system');
    const outgoingMessages = systemMessage ? [systemMessage, ...nextConversation] : nextConversation;
    // This body text is only ever used to render the outgoing network request below — it's
    // deliberately never persisted onto `activeRequest` (see `localConversation` above).
    const ephemeralBodyText = serializeChatRequestBody(baseBodyText || '', parsedBody.format, {
      model: parsedBody.model,
      messages: outgoingMessages,
    });
    const ephemeralBody = { ...activeRequest.body, text: ephemeralBodyText };
    setLocalConversation(nextConversation);
    setSessionUserMessages(previous => [...previous, { role: 'user', content: text }]);
    setFollowUpText('');
    pendingSettingsBodyRef.current = null;
    setSettingsChangedSinceConnect(false);

    const rendered = await renderRealtimeConnectPayload({
      request: { ...activeRequest, body: ephemeralBody },
      environmentId: activeEnvironment._id,
      workspaceId: activeWorkspace._id,
    });
    if (!rendered) {
      return;
    }
    // The previous turn's text has already been read (above) and baked into the request body as
    // history — safe to cut the live accumulator over to "only events from here on" now, so the
    // new turn's reply isn't shown concatenated after the one that just finished.
    setClearEventsBefore(Date.now());
    setIsAwaitingFollowUpReply(true);
    skipNextChatSeedRef.current = true;
    connectRequestFetcher.submit({
      organizationId,
      projectId,
      workspaceId,
      requestId: activeRequest._id,
      connectParams: {
        url: joinUrlAndQueryString(rendered.url, buildQueryStringFromParams(rendered.parameters)),
        headers: rendered.headers,
        authentication: rendered.authentication,
        body: rendered.body,
        cookieJar: rendered.workspaceCookieJar,
        suppressUserAgent: rendered.suppressUserAgent,
      },
    });
    recordProjectRecentRequest({ projectId, requestId: activeRequest._id, workspaceId: activeWorkspace._id });
  };

  // Appends every user message *typed as a follow-up* in this chat window onto the saved body's own
  // messages — deliberately user-only (no assistant replies, no system message beyond what's
  // already there), and deliberately excluding the seeded question (it's already in the saved body)
  // — so reconnecting (or resending) this request later replays those questions as context. This is
  // the only thing that writes the chat window's content back to the saved body.
  const handleSaveChatAsDefaultBody = async () => {
    if (!parsedChatRequest || sessionUserMessages.length === 0) {
      return;
    }
    const nextMessages = [...parsedChatRequest.messages, ...sessionUserMessages];
    const nextBodyText = serializeChatRequestBody(requestBodyText || '', parsedChatRequest.format, {
      model: parsedChatRequest.model,
      messages: nextMessages,
    });
    const nextBody = { ...activeRequest.body, text: nextBodyText };
    await services.request.update(activeRequest, { body: nextBody });
    patchRequest(activeRequest._id, { body: nextBody });
    // Those messages are now part of the saved body itself — clear the "pending" tracking so a
    // second Save press doesn't append them again.
    setSessionUserMessages([]);
    showToast({
      icon: 'bolt',
      title: 'Saved',
      status: 'success',
      raised: true,
      description:
        'Added this chat window\'s user messages to the request\'s default body. ' +
        'Switch away from the Body tab and back (or reselect the request) to see it refreshed there — ' +
        'the body editor only re-reads its content on remount, same as every other external body update.',
    });
  };

  // Wipes the chat window back to genuinely empty — including the seeded question and the
  // current/most recent turn's reply, which otherwise keeps showing (it lives in the live SSE event
  // log, not in `localConversation`) until a new one replaces it.
  const handleClearChatWindow = () => {
    setLocalConversation([]);
    setSessionUserMessages([]);
    setClearEventsBefore(Date.now());
    setIsAwaitingFollowUpReply(false);
    setFollowUpText('');
  };

  const handleSelection = (event: EventType) => {
    setSelectedEvent((selected: EventType | null) => (selected?._id === event._id ? null : event));
  };
  const getEventView = (selectedEvent: EventType) => {
    if (models.socketIOResponse.isSocketIOResponse(response)) {
      return <SocketIOEventView event={selectedEvent as SocketIOEvent} key={selectedEvent._id} />;
    } else if (models.mcpResponse.isMcpResponse(response)) {
      return <McpEventView event={selectedEvent as McpEvent} key={selectedEvent._id} />;
    }

    return <EventView event={selectedEvent as WebSocketEvent} key={selectedEvent._id} />;
  };

  const events = useMemo(
    () =>
      allEvents.filter(event => {
        // Filter out events that are earlier than the clearEventsBefore timestamp
        if (clearEventsBefore && event.timestamp <= clearEventsBefore) {
          return false;
        }

        // Filter out events that don't match the selected event type
        if (eventType && event.type !== eventType) {
          return false;
        }

        // Filter out events that don't match the search query
        if (searchQuery) {
          if (event.type === 'message') {
            if (protocol === 'mcp') {
              // MCP message event data can search both method and json stringified data
              const eventMethod = 'method' in event ? event.method : '';
              const eventData = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
              return (
                eventMethod.toLowerCase().includes(searchQuery.toLowerCase()) ||
                eventData.toLowerCase().includes(searchQuery.toLowerCase())
              );
            }
            return event.data.toString().toLowerCase().includes(searchQuery.toLowerCase());
          }
          if (event.type === 'error') {
            return event.message.toLowerCase().includes(searchQuery.toLowerCase());
          }
          if (event.type === 'close') {
            return event.reason.toLowerCase().includes(searchQuery.toLowerCase());
          }

          // Filter out open events
          return false;
        }

        return true;
      }),
    [allEvents, clearEventsBefore, eventType, protocol, searchQuery],
  );

  useEffect(() => {
    if (events.length > 0 && autoSelectLatestEvent) {
      setSelectedEvent(events[0]);
    }
  }, [events, autoSelectLatestEvent]);

  useEffect(() => {
    setSelectedEvent(null);
    setSearchQuery('');
    setClearEventsBefore(null);
  }, [response._id]);

  useEffect(() => {
    let isMounted = true;
    const fn = async () => {
      const content = await window.main.secureReadFile({
        path: response.timelinePath,
      });

      const timelineParsed = deserializeNDJSON(content);
      if (isMounted) {
        setTimeline(timelineParsed);
      }
    };
    fn();
    return () => {
      isMounted = false;
    };
  }, [response.timelinePath, events.length]);

  const isLongRunning =
    models.socketIOResponse.isSocketIOResponse(response) || models.mcpResponse.isMcpResponse(response);
  const hideCookies =
    models.socketIOResponse.isSocketIOResponse(response) || models.mcpResponse.isMcpResponse(response);
  const hideHeaders =
    models.socketIOResponse.isSocketIOResponse(response) ||
    (models.mcpResponse.isMcpResponse(response) && response.transportType === models.mcpRequest.TRANSPORT_TYPES.STDIO);

  const cookieHeaders = hideCookies ? [] : getSetCookieHeaders(response.headers);

  // When it is an MCP auth error, show the docs link about MCP authentication and keep the events view to be visible for better context.
  const isMCPAuthError = models.mcpResponse.isMcpResponse(response) && response.error && response.errorType === 'auth';

  return (
    <Pane type="response">
      <PaneHeader className="row-spaced">
        <div className="no-wrap scrollable scrollable--no-bars pad-left">
          {isLongRunning ? (
            <div
              data-testid="response-status-tag"
              className={classnames('px-2 py-1 capitalize', {
                'bg-success': readyState === 'connected',
                'bg-info': readyState === 'connecting',
                'bg-danger': readyState === 'disconnected',
              })}
            >
              {readyState}
            </div>
          ) : (
            <>
              <StatusTag statusCode={response.statusCode} statusMessage={response.statusMessage} />
              <TimeTag milliseconds={response.elapsedTime} steps={[]} />
              <SizeTag bytesRead={0} bytesContent={0} />
            </>
          )}
        </div>
        <ResponseHistoryDropdown activeResponse={response} requestVersions={requestVersions} responses={responses} />
      </PaneHeader>
      <Tabs
        key={response._id}
        aria-label="Request group tabs"
        className="flex h-full w-full flex-1 flex-col"
        defaultSelectedKey={
          showChatTab ? 'chat' : showStreamSummaryTab && streamSummary.inferredPath != null ? 'summary' : 'events'
        }
      >
        <TabList
          className="flex h-(--line-height-sm) w-full shrink-0 items-center overflow-x-auto border-b border-solid border-b-(--hl-md) bg-(--color-bg)"
          aria-label="Request pane tabs"
        >
          {showChatTab && (
            <Tab
              className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
              id="chat"
            >
              Chat
            </Tab>
          )}
          <Tab
            className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
            id="events"
          >
            Events
          </Tab>
          {showStreamSummaryTab && (
            <Tab
              className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
              id="summary"
            >
              Summary
            </Tab>
          )}
          {models.mcpResponse.isMcpResponse(response) && (
            <Tab
              className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
              id="notifications"
            >
              Notifications
              {allNotifications.length > 0 && (
                <span className="flex aspect-square items-center justify-between overflow-hidden rounded-lg border border-solid border-(--hl-md) p-2 text-xs">
                  {allNotifications.length}
                </span>
              )}
            </Tab>
          )}
          {!hideHeaders && (
            <Tab
              className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
              id="headers"
            >
              Headers
              {response.headers.length > 0 && (
                <span className="flex aspect-square items-center justify-between overflow-hidden rounded-lg border border-solid border-(--hl-md) p-2 text-xs">
                  {response.headers.length}
                </span>
              )}
            </Tab>
          )}
          {!hideCookies && (
            <Tab
              className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
              id="cookies"
            >
              Cookies
              {cookieHeaders.length > 0 && (
                <span className="flex aspect-square items-center justify-between overflow-hidden rounded-lg border border-solid border-(--hl-md) p-2 text-xs">
                  {cookieHeaders.length}
                </span>
              )}
            </Tab>
          )}
          <Tab
            className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
            id="timeline"
          >
            Console
          </Tab>
        </TabList>
        {showChatTab && (
          <TabPanel className="flex w-full flex-1 flex-col overflow-hidden" id="chat">
            {isMissingStreamingBodyFlag && (
              <div className="flex items-center justify-between gap-2 border-b border-solid border-(--hl-md) bg-(--hl-xs) px-3 py-2 text-sm text-(--color-font)">
                <span>
                  This request has an event-stream Accept header but no "stream": true in the body —
                  it'll send fine but come back as one slow reply instead of live chunks.
                </span>
                <Button
                  onPress={handleFixMissingStreamFlag}
                  className="shrink-0 rounded-sm border border-solid border-(--hl-sm) px-2 py-1 text-xs hover:bg-(--hl-sm)"
                >
                  Add "stream": true
                </Button>
              </div>
            )}
            {isMissingIncludeUsageFlag && (
              <div className="flex items-center justify-between gap-2 border-b border-solid border-(--hl-md) bg-(--hl-xs) px-3 py-2 text-sm text-(--color-font)">
                <span>
                  OpenAI-format streams only report tokens (and so cost) when the body has
                  "stream_options": {'{'}"include_usage": true{'}'}. Without it this chat can't show tokens or cost.
                </span>
                <Button
                  onPress={handleFixMissingIncludeUsage}
                  className="shrink-0 rounded-sm border border-solid border-(--hl-sm) px-2 py-1 text-xs hover:bg-(--hl-sm)"
                >
                  Add include_usage
                </Button>
              </div>
            )}
            <ResponseChatViewer
              summary={{
                messages: chatMessages,
                model: chatModel,
                usage: streamChatMeta.usage,
                stopReason: streamChatMeta.stopReason,
              }}
              isStreaming={isConnected}
              isLiveConversation
              isWaitingForReply={isAwaitingFollowUpReply}
              requestKey={activeRequest._id}
              format={parsedChatRequest?.format ?? 'openai'}
              settingsValues={chatSettingsValues}
              onApplySettings={handleApplyChatSettings}
              pendingSettingsNotice={
                settingsChangedSinceConnect
                  ? {
                      message: 'Settings changed — reconnect to use them.',
                      actionLabel: 'Reconnect',
                      onAction: handleReconnectAfterSettingsChange,
                    }
                  : null
              }
            />
            <div
              data-ignore-send-hotkey
              className="flex shrink-0 items-stretch gap-2 border-t border-solid border-(--hl-md) bg-(--color-bg) p-2"
            >
              <textarea
                value={followUpText}
                onChange={event => setFollowUpText(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleSendFollowUp();
                  }
                }}
                placeholder="Reply to continue the conversation…"
                rows={2}
                className="w-full flex-1 resize-y rounded-xs border border-solid border-(--hl-md) bg-(--color-bg) px-2 py-1 text-sm text-(--color-font) outline-hidden focus:border-(--hl)"
              />
              <Button
                onPress={handleSendFollowUp}
                isDisabled={!followUpText.trim() || isSendingFollowUp}
                className="rounded-sm bg-(--color-surprise) px-4 text-sm text-(--color-font-surprise) hover:opacity-90 disabled:opacity-50"
              >
                Send
              </Button>
            </div>
            <div
              data-ignore-send-hotkey
              className="flex shrink-0 items-center justify-end gap-2 border-t border-solid border-(--hl-md) bg-(--color-bg) px-2 py-1.5"
            >
              <Button
                onPress={handleClearChatWindow}
                className="rounded-sm border border-solid border-(--hl-sm) px-2 py-1 text-xs text-(--color-font) hover:bg-(--hl-sm)"
              >
                Clear Chat Window
              </Button>
              <Button
                onPress={handleSaveChatAsDefaultBody}
                isDisabled={sessionUserMessages.length === 0}
                className="rounded-sm border border-solid border-(--hl-sm) px-2 py-1 text-xs text-(--color-font) hover:bg-(--hl-sm) disabled:opacity-50"
              >
                Save as Default Body
              </Button>
            </div>
          </TabPanel>
        )}
        <TabPanel className="flex w-full flex-1 flex-col overflow-hidden" id="events">
          <PanelGroup direction="vertical" className="grid h-full w-full grid-rows-[repeat(auto-fit,minmax(0,1fr))]">
            {response.error && !isMCPAuthError ? (
              <ResponseErrorViewer
                url={response.url}
                error={response.error}
                isMcpResponse={models.mcpResponse.isMcpResponse(response)}
              />
            ) : (
              <>
                <Panel minSize={10} defaultSize={36} className="box-border flex w-full flex-1 flex-col overflow-hidden">
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: 'var(--padding-sm)',
                      gap: 'var(--padding-sm)',
                    }}
                  >
                    <select
                      disabled={protocol === 'curl'}
                      onChange={e => setEventType(e.currentTarget.value as CurlEvent['type'])}
                    >
                      <option value="">All</option>
                      <option value="message">Message</option>
                      <option value="open">Open</option>
                      <option value="close">Close</option>
                      <option value="error">Error</option>
                    </select>

                    <SearchField
                      aria-label="Events filter"
                      className="group relative w-full flex-1"
                      defaultValue={searchQuery}
                      onChange={query => {
                        setSearchQuery(query);
                      }}
                    >
                      <Input
                        placeholder="Search"
                        className="w-full rounded-sm border border-solid border-(--hl-sm) bg-(--color-bg) py-1 pr-7 pl-2 text-(--color-font) transition-colors focus:ring-1 focus:ring-(--hl-md) focus:outline-hidden"
                      />
                      <div className="absolute top-0 right-0 flex h-full items-center px-2">
                        <Button className="flex aspect-square w-5 items-center justify-center rounded-sm text-sm text-(--color-font) ring-1 ring-transparent transition-all group-data-empty:hidden hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset aria-pressed:bg-(--hl-sm)">
                          <Icon icon="close" />
                        </Button>
                      </div>
                    </SearchField>
                    <Button
                      aria-label="Create in collection"
                      className="flex aspect-square h-full items-center justify-center rounded-sm text-sm text-(--color-font) ring-1 ring-transparent transition-all hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset aria-pressed:bg-(--hl-sm)"
                      onPress={() => {
                        const lastEvent = events[0];
                        setClearEventsBefore(lastEvent.timestamp);
                      }}
                    >
                      <SvgIcon icon="prohibited" />
                    </Button>
                  </div>

                  {Boolean(events?.length) && (
                    <EventLogView
                      events={events}
                      onSelect={handleSelection}
                      selectionId={selectedEvent?._id}
                      autoSelectLatestEvent
                      protocol={protocol}
                      readyState={isConnected}
                    />
                  )}
                </Panel>
                {isMCPAuthError ? (
                  <ResponseErrorViewer
                    url={response.url}
                    error={response.error}
                    docsLink={docsMcpAuthentication}
                    showErrorDetails={false}
                    isMcpResponse
                  />
                ) : null}
                {selectedEvent && (
                  <>
                    <PanelResizeHandle className={'h-px w-full bg-(--hl-md)'} />
                    <Panel minSize={10} defaultSize={models.mcpResponse.isMcpResponse(response) ? 85 : 60}>
                      <div className="h-full flex-1">{getEventView(selectedEvent)}</div>
                    </Panel>
                  </>
                )}
              </>
            )}
          </PanelGroup>
        </TabPanel>
        {showStreamSummaryTab && (
          <TabPanel className="flex w-full flex-1 flex-col overflow-hidden" id="summary">
            <StreamSummaryPanel requestId={response.parentId} streamSummary={streamSummary} />
          </TabPanel>
        )}
        {models.mcpResponse.isMcpResponse(response) && (
          <TabPanel className="flex w-full flex-1 flex-col overflow-hidden" id="notifications">
            <McpNotificationTab allEvents={allNotifications} />
          </TabPanel>
        )}
        {!models.socketIOResponse.isSocketIOResponse(response) && (
          <>
            <TabPanel className="flex w-full flex-1 flex-col overflow-y-auto" id="headers">
              <ErrorBoundary key={response._id} errorClassName="font-error pad text-center">
                <ResponseHeadersViewer
                  headers={response.headers}
                  onCopyAll={() => {
                    window.main.trackAnalyticsEvent({ event: AnalyticsEvent.mcpResponseHeadersCopyAllClicked });
                  }}
                />
              </ErrorBoundary>
            </TabPanel>
            <TabPanel className="flex w-full flex-1 flex-col overflow-y-auto" id="cookies">
              <ErrorBoundary key={response._id} errorClassName="font-error pad text-center">
                <ResponseCookiesViewer
                  cookiesSent={response.settingSendCookies}
                  cookiesStored={response.settingStoreCookies}
                  headers={cookieHeaders}
                />
              </ErrorBoundary>
            </TabPanel>
          </>
        )}
        <TabPanel className="flex w-full flex-1 flex-col overflow-hidden" id="timeline">
          <ResponseTimelineViewer key={response._id} timeline={timeline} pinToBottom={true} />
        </TabPanel>
      </Tabs>
    </Pane>
  );
};
