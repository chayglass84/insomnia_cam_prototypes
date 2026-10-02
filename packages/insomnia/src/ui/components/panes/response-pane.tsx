import type { ResponseTimelineEntry } from 'insomnia-data';
import { models, services } from 'insomnia-data';
import { PREVIEW_MODE_SOURCE } from 'insomnia-data/common';
import { type FC, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs, Toolbar } from 'react-aria-components';
import { useFetcher, useParams } from 'react-router';

import { extractChatCompletion, supportsStreaming } from '~/common/chat-completion';
import { parseChatRequestBody, serializeChatRequestBody } from '~/common/chat-request';
import { ensureEventStreamAcceptHeader, ensureStreamingBodyFlag, hasStreamingBodyFlag } from '~/common/chat-streaming';
import { bodyBufferToUtf8 } from '~/common/utils/utf8-bytes';
import { useRootLoaderData } from '~/root';
import { AnalyticsEvent } from '~/ui/analytics';
import { showToast } from '~/ui/components/toast-notification';
import { markPendingAutoConnect } from '~/ui/utils/pending-auto-connect';
import { recordProjectRecentRequest } from '~/ui/utils/recent-project-requests';

import { getSetCookieHeaders } from '../../../common/misc';
import { cancelRequestById } from '../../../network/cancellation.renderer';
import {
  type RequestLoaderData,
  useRequestLoaderData,
} from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.request.$requestId';
import { useDebugRequestSendActionFetcher } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.request.$requestId.send';
import { useExecutionState } from '../../hooks/use-execution-state';
import { useRequestMetaPatcher, useRequestPatcher } from '../../hooks/use-request';
import { PreviewModeDropdown } from '../dropdowns/preview-mode-dropdown';
import { ResponseHistoryDropdown } from '../dropdowns/response-history-dropdown';
import { MockResponseExtractor } from '../editors/mock-response-extractor';
import { ErrorBoundary } from '../error-boundary';
import { showError } from '../modals';
import { ResponseTimer } from '../response-timer';
import { SizeTag } from '../tags/size-tag';
import { StatusTag } from '../tags/status-tag';
import { TimeTag } from '../tags/time-tag';
import { ResponseCookiesViewer } from '../viewers/response-cookies-viewer';
import { ResponseHeadersViewer } from '../viewers/response-headers-viewer';
import { ResponseTimelineViewer } from '../viewers/response-timeline-viewer';
import { ResponseViewer } from '../viewers/response-viewer';
import { BlankPane } from './blank-pane';
import { Pane, PaneHeader } from './pane';
import { PlaceholderResponsePane } from './placeholder-response-pane';
import { RequestTestResultPane } from './request-test-result-pane';
import { downloadResponseBody } from './response-pane-utils';

interface Props {
  activeRequestId: string;
}

export const ResponsePane: FC<Props> = ({ activeRequestId }) => {
  const { activeRequest, activeRequestMeta, activeResponse, responses, requestVersions } =
    useRequestLoaderData() as RequestLoaderData;
  const filterHistory = activeRequestMeta.responseFilterHistory || [];
  const filter = activeRequestMeta.responseFilter || '';
  const patchRequestMeta = useRequestMetaPatcher();
  const patchRequest = useRequestPatcher();
  const { settings } = useRootLoaderData()!;
  const [streamingTeaserDismissed, setStreamingTeaserDismissed] = useState(false);
  useEffect(() => {
    setStreamingTeaserDismissed(false);
  }, [activeRequest._id]);

  // The request body is live-edited (e.g. composing the next turn in the Chat tab) while an
  // older response is still showing, so folding in `activeRequest.body.text` directly would make
  // the displayed conversation re-render with every keystroke before anything's actually sent.
  // Freeze a snapshot the moment a (new) response becomes active instead, and only read that.
  const [snapshotResponseId, setSnapshotResponseId] = useState(activeResponse?._id);
  const [snapshotRequestBodyText, setSnapshotRequestBodyText] = useState(activeRequest.body?.text);
  if (activeResponse?._id !== snapshotResponseId) {
    setSnapshotResponseId(activeResponse?._id);
    setSnapshotRequestBodyText(activeRequest.body?.text);
  }

  const chatCompletionSummary = useMemo(() => {
    if (!activeResponse?.bodyBuffer) {
      return null;
    }
    try {
      return extractChatCompletion(bodyBufferToUtf8(activeResponse.bodyBuffer), snapshotRequestBodyText);
    } catch {
      return null;
    }
  }, [activeResponse, snapshotRequestBodyText]);

  const showStreamingTeaser =
    !streamingTeaserDismissed &&
    Boolean(chatCompletionSummary) &&
    Boolean(activeResponse) &&
    supportsStreaming(activeResponse!.url) &&
    !models.request.isEventStreamRequest(activeRequest);

  const handleEnableStreaming = async () => {
    const previousBody = activeRequest.body;
    const previousHeaders = activeRequest.headers;

    const nextBodyText = ensureStreamingBodyFlag(previousBody.text);
    const bodyPatched = nextBodyText !== null;
    const nextBody = bodyPatched ? { ...previousBody, text: nextBodyText } : previousBody;
    const bodyAlreadyHadFlag = !bodyPatched && hasStreamingBodyFlag(previousBody.text);

    const { headers: nextHeaders, changed: headersPatched } = ensureEventStreamAcceptHeader(previousHeaders);

    // Persist directly and await it before connecting (rather than the fire-and-forget patchRequest
    // fetcher), so the connect payload built from these values below and what's actually saved
    // agree, and the pane doesn't race the switch to RealtimeResponsePane that follows.
    const patch: { body?: typeof nextBody; headers?: typeof nextHeaders } = {};
    if (bodyPatched) {
      patch.body = nextBody;
    }
    if (headersPatched) {
      patch.headers = nextHeaders;
    }
    if (Object.keys(patch).length > 0) {
      await services.request.update(activeRequest, patch);
      patchRequest(activeRequest._id, patch);
    }

    showToast(
      {
        icon: 'bolt',
        title: 'Enabled streaming',
        status: 'success',
        raised: true,
        description: (
          <span>
            <ul className="list-disc pl-4">
              <li>
                {bodyPatched
                  ? 'Added "stream": true to the body'
                  : bodyAlreadyHadFlag
                    ? 'Body already had "stream": true'
                    : 'Body was not valid JSON — could not add "stream": true'}
              </li>
              <li>
                {headersPatched ? 'Added an Accept: text/event-stream header' : 'Accept header was already set'}
              </li>
              <li>Connecting…</li>
            </ul>
            <Button
              className="underline"
              onPress={async () => {
                await services.request.update(activeRequest, { body: previousBody, headers: previousHeaders });
                patchRequest(activeRequest._id, { body: previousBody, headers: previousHeaders });
              }}
            >
              Undo
            </Button>
          </span>
        ),
      },
      { timeout: null },
    );

    // Don't connect from here: patching the headers above is what flips this request to
    // event-stream, which makes the parent route swap this whole pane out for
    // RealtimeResponsePane on its next render — unmounting this component. Firing the connect
    // fetcher from a component that's about to unmount is a race (an unkeyed useFetcher() aborts
    // its in-flight submission on unmount). Flag the intent instead; the new, long-lived pane picks
    // it up on mount using its own stable connect fetcher.
    markPendingAutoConnect(activeRequest._id);
  };

  const { organizationId, projectId, workspaceId } = useParams() as {
    organizationId: string;
    projectId: string;
    workspaceId: string;
  };
  const sendRequestFetcher = useDebugRequestSendActionFetcher({ key: `send-request-${activeRequest._id}` });
  const [followUpText, setFollowUpText] = useState('');
  // This pane only ever renders for non-event-stream requests (the parent route sends any
  // isEventStreamRequest to RealtimeResponsePane instead), so a detected chat completion here is
  // always a one-shot, already-finished exchange — continuing it is a plain re-send, not a
  // reconnect. The event-stream/live case lives in realtime-response-pane.tsx instead.
  const showFollowUpComposer = Boolean(chatCompletionSummary);
  const isSendingFollowUp = sendRequestFetcher.state !== 'idle';

  const handleSendFollowUp = async () => {
    const text = followUpText.trim();
    const parsedBody = parseChatRequestBody(activeRequest.body.text || '');
    if (!text || !parsedBody) {
      return;
    }
    const nextBodyText = serializeChatRequestBody(activeRequest.body.text || '', parsedBody.format, {
      model: parsedBody.model,
      messages: [...parsedBody.messages, { role: 'user', content: text }],
    });
    const nextBody = { ...activeRequest.body, text: nextBodyText };
    // Persist directly and await it (rather than the fire-and-forget patchRequest fetcher) so the
    // send action — which re-reads the request fresh from the database — can't race ahead of this
    // write and send the old body.
    await services.request.update(activeRequest, { body: nextBody });
    patchRequest(activeRequest._id, { body: nextBody });
    setFollowUpText('');

    sendRequestFetcher.submit({
      organizationId,
      projectId,
      workspaceId,
      requestId: activeRequest._id,
      params: {},
    });
    recordProjectRecentRequest({ projectId, requestId: activeRequest._id, workspaceId });
  };

  const previewMode = activeRequestMeta.previewMode || PREVIEW_MODE_SOURCE;
  const handleSetFilter = async (responseFilter: string) => {
    if (!activeResponse) {
      return;
    }
    const requestId = activeResponse.parentId;
    await patchRequestMeta(requestId, { responseFilter });
    const meta = await services.requestMeta.getByParentId(requestId);
    if (!meta) {
      return;
    }
    const responseFilterHistory = meta.responseFilterHistory.slice(0, 10);
    // Already in history or empty?
    if (!responseFilter || responseFilterHistory.includes(responseFilter)) {
      return;
    }
    responseFilterHistory.unshift(responseFilter);
    patchRequestMeta(requestId, { responseFilterHistory });
  };

  // Check if the request is sending by fetcher key
  const requestSendingFetcher = useFetcher({ key: `send-request-${activeRequest._id}` });
  const isRequestSending = requestSendingFetcher.state !== 'idle';

  const { isExecuting, steps } = useExecutionState({ requestId: activeRequest._id });

  const handleDownloadResponseBody = useCallback(
    async (prettify: boolean) => {
      try {
        await downloadResponseBody(
          activeRequest,
          activeResponse,
          prettify,
          activeResponse ? () => services.helpers.getResponseBodyBuffer(activeResponse) : undefined,
        );
      } catch (err) {
        showError({
          title: 'Failed to save response body',
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    },
    [activeRequest, activeResponse],
  );
  const [timeline, setTimeline] = useState<ResponseTimelineEntry[]>([]);

  useEffect(() => {
    let isCancelled = false;

    if (!activeResponse) {
      setTimeline([]);
      return;
    }

    services.helpers.getResponseTimeline(activeResponse).then(responseTimeline => {
      if (!isCancelled) {
        setTimeline(responseTimeline);
      }
    });

    return () => {
      isCancelled = true;
    };
  }, [activeResponse]);

  const { passedTestCount, totalTestCount } = useMemo(() => {
    let passedTestCount = 0;
    let totalTestCount = 0;
    activeResponse?.requestTestResults.forEach(result => {
      if (result.status === 'passed') {
        passedTestCount++;
      }
      totalTestCount++;
    });
    return { passedTestCount, totalTestCount };
  }, [activeResponse]);
  const testResultCountTagColor =
    totalTestCount > 0 ? (passedTestCount === totalTestCount ? 'bg-lime-600' : 'bg-red-600') : 'bg-(--hl-sm)';

  if (!activeRequest) {
    return <BlankPane type="response" />;
  }

  // If there is no previous response, show placeholder for loading indicator
  if (!activeResponse) {
    return (
      <PlaceholderResponsePane>
        {isExecuting && (
          <ResponseTimer
            handleCancel={() => cancelRequestById(activeRequest._id)}
            activeRequestId={activeRequestId}
            steps={steps}
          />
        )}
      </PlaceholderResponsePane>
    );
  }

  const cookieHeaders = getSetCookieHeaders(activeResponse.headers);

  return (
    <Pane type="response">
      {!activeResponse ? null : (
        <PaneHeader className="row-spaced">
          <div aria-atomic="true" aria-live="polite" className="no-wrap scrollable scrollable--no-bars pad-left">
            <StatusTag statusCode={activeResponse.statusCode} statusMessage={activeResponse.statusMessage} />
            <TimeTag milliseconds={activeResponse.elapsedTime} steps={steps} />
            <SizeTag bytesRead={activeResponse.bytesRead} bytesContent={activeResponse.bytesContent} />
          </div>
          <ResponseHistoryDropdown
            activeResponse={activeResponse}
            responses={responses}
            requestVersions={requestVersions}
          />
        </PaneHeader>
      )}
      <Tabs
        aria-label="Request group tabs"
        className="flex h-full w-full flex-1 flex-col"
        onSelectionChange={key => {
          if (key === 'mock-response') {
            window.main.trackAnalyticsEvent({
              event: AnalyticsEvent.responseToMockClicked,
              properties: {
                source: 'Response Pane Tab',
              },
            });
          }
        }}
      >
        <TabList
          className="flex h-(--line-height-sm) w-full shrink-0 items-center overflow-x-auto border-b border-solid border-b-(--hl-md) bg-(--color-bg)"
          aria-label="Request pane tabs"
        >
          <Tab
            className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
            id="preview"
          >
            Preview
          </Tab>
          <Tab
            className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
            id="headers"
          >
            Headers
            {activeResponse.headers.length > 0 && (
              <span className="flex aspect-square items-center justify-between overflow-hidden rounded-lg border border-solid border-(--hl-md) p-2 text-xs">
                {activeResponse.headers.length}
              </span>
            )}
          </Tab>
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
          <Tab
            className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
            id="test-results"
          >
            <div>
              <span>Tests</span>
              <span className={`ml-1 rounded-xs px-1 ${testResultCountTagColor}`} style={{ color: 'white' }}>
                {`${passedTestCount} / ${totalTestCount}`}
              </span>
            </div>
          </Tab>
          <Tab
            className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
            id="mock-response"
          >
            → Mock
          </Tab>
          <Tab
            className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)"
            id="timeline"
          >
            Console
          </Tab>
        </TabList>
        <TabPanel className="flex w-full flex-1 flex-col overflow-hidden" id="preview">
          <Toolbar className="flex h-(--line-height-sm) w-full shrink-0 items-center border-b border-solid border-(--hl-md) px-2">
            <PreviewModeDropdown
              download={handleDownloadResponseBody}
              copyToClipboard={async () => {
                const bodyBuffer = activeResponse ? await services.helpers.getResponseBodyBuffer(activeResponse) : null;
                if (bodyBuffer) {
                  window.clipboard.writeText(bodyBufferToUtf8(bodyBuffer));
                }
              }}
            />
          </Toolbar>
          {showStreamingTeaser && (
            <div className="flex items-center justify-between gap-2 border-b border-solid border-(--hl-md) bg-(--hl-xs) px-3 py-2 text-sm text-(--color-font)">
              <span>This endpoint supports live streaming — see the response fill in token-by-token.</span>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  onPress={handleEnableStreaming}
                  className="rounded-sm border border-solid border-(--hl-sm) px-2 py-1 text-xs hover:bg-(--hl-sm)"
                >
                  Enable streaming
                </Button>
                <Button
                  aria-label="Dismiss"
                  onPress={() => setStreamingTeaserDismissed(true)}
                  className="text-(--hl) hover:text-(--color-font)"
                >
                  ✕
                </Button>
              </div>
            </div>
          )}
          <ResponseViewer
            key={activeResponse._id}
            bytes={Math.max(activeResponse.bytesContent, activeResponse.bytesRead)}
            contentType={activeResponse.contentType || ''}
            disableHtmlPreviewJs={settings.disableHtmlPreviewJs}
            disablePreviewLinks={settings.disableResponsePreviewLinks}
            download={handleDownloadResponseBody}
            editorFontSize={settings.editorFontSize}
            error={activeResponse.error}
            filter={filter}
            filterHistory={filterHistory}
            bodyBuffer={activeResponse.bodyBuffer}
            getBody={() => services.helpers.getResponseBodyBuffer(activeResponse)}
            previewMode={activeResponse.error ? PREVIEW_MODE_SOURCE : previewMode}
            requestBodyText={snapshotRequestBodyText}
            responseId={activeResponse._id}
            updateFilter={activeResponse.error ? undefined : handleSetFilter}
            url={activeResponse.url}
          />
          {showFollowUpComposer && (
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
          )}
        </TabPanel>
        <TabPanel className="flex w-full flex-1 flex-col overflow-y-auto" id="headers">
          <ErrorBoundary key={activeResponse._id} errorClassName="font-error pad text-center">
            <ResponseHeadersViewer
              headers={activeResponse.headers}
              onCopyAll={() => {
                window.main.trackAnalyticsEvent({ event: AnalyticsEvent.responseHeadersCopyAllClicked });
              }}
            />
          </ErrorBoundary>
        </TabPanel>
        <TabPanel className="flex w-full flex-1 flex-col overflow-y-auto" id="cookies">
          <ErrorBoundary key={activeResponse._id} errorClassName="font-error pad text-center">
            <ResponseCookiesViewer
              cookiesSent={activeResponse.settingSendCookies}
              cookiesStored={activeResponse.settingStoreCookies}
              headers={cookieHeaders}
            />
          </ErrorBoundary>
        </TabPanel>
        <TabPanel className="flex w-full flex-1 flex-col overflow-y-auto" id="test-results">
          <RequestTestResultPane requestTestResults={activeResponse.requestTestResults} />
        </TabPanel>
        <TabPanel className="flex w-full flex-1 flex-col overflow-y-auto" id="mock-response">
          <MockResponseExtractor />
        </TabPanel>
        <TabPanel className="flex w-full flex-1 flex-col overflow-y-auto" id="timeline">
          <ErrorBoundary key={activeResponse._id} errorClassName="font-error pad text-center">
            <ResponseTimelineViewer key={activeResponse._id} timeline={timeline} />
          </ErrorBoundary>
        </TabPanel>
      </Tabs>
      <ErrorBoundary errorClassName="font-error pad text-center">
        {(isExecuting || isRequestSending) && (
          <ResponseTimer
            handleCancel={() => cancelRequestById(activeRequest._id)}
            activeRequestId={activeRequestId}
            steps={steps}
          />
        )}
      </ErrorBoundary>
    </Pane>
  );
};
