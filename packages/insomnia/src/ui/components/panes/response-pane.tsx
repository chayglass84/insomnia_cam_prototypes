import type { ResponseTimelineEntry } from 'insomnia-data';
import { models, services } from 'insomnia-data';
import { PREVIEW_MODE_SOURCE } from 'insomnia-data/common';
import { type FC, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs, Toolbar } from 'react-aria-components';
import { useFetcher } from 'react-router';

import { extractChatCompletion, supportsStreaming } from '~/common/chat-completion';
import { bodyBufferToUtf8 } from '~/common/utils/utf8-bytes';
import { useRootLoaderData } from '~/root';
import { AnalyticsEvent } from '~/ui/analytics';
import { showToast } from '~/ui/components/toast-notification';

import { getSetCookieHeaders } from '../../../common/misc';
import { cancelRequestById } from '../../../network/cancellation.renderer';
import {
  type RequestLoaderData,
  useRequestLoaderData,
} from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.request.$requestId';
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

  const chatCompletionSummary = useMemo(() => {
    if (!activeResponse?.bodyBuffer) {
      return null;
    }
    try {
      return extractChatCompletion(bodyBufferToUtf8(activeResponse.bodyBuffer), activeRequest.body?.text);
    } catch {
      return null;
    }
  }, [activeResponse, activeRequest.body?.text]);

  const showStreamingTeaser =
    !streamingTeaserDismissed &&
    Boolean(chatCompletionSummary) &&
    Boolean(activeResponse) &&
    supportsStreaming(activeResponse!.url) &&
    !models.request.isEventStreamRequest(activeRequest);

  const handleEnableStreaming = () => {
    const previousBody = activeRequest.body;
    const previousHeaders = activeRequest.headers;

    let bodyPatched = false;
    try {
      const parsedBody = previousBody.text ? JSON.parse(previousBody.text) : {};
      const nextBodyText = JSON.stringify({ ...parsedBody, stream: true });
      patchRequest(activeRequest._id, { body: { ...previousBody, text: nextBodyText } });
      bodyPatched = true;
    } catch {
      // Body isn't valid JSON right now (e.g. mid-edit) — leave it alone and only add the header.
    }

    const existingAcceptHeaderIndex = previousHeaders.findIndex(header => header.name.toLowerCase() === 'accept');
    const nextHeaders = existingAcceptHeaderIndex === -1
      ? [...previousHeaders, { name: 'Accept', value: 'text/event-stream' }]
      : previousHeaders.map((header, index) =>
          index === existingAcceptHeaderIndex ? { ...header, value: 'text/event-stream' } : header,
        );
    if (previousHeaders[existingAcceptHeaderIndex]?.value !== 'text/event-stream') {
      patchRequest(activeRequest._id, { headers: nextHeaders });
    }

    showToast(
      {
        icon: 'bolt',
        title: 'Enabled streaming',
        status: 'success',
        description: (
          <span>
            {bodyPatched
              ? 'Added "stream": true to the body and an Accept: text/event-stream header.'
              : 'Body was not valid JSON, so only an Accept: text/event-stream header was added.'}{' '}
            <Button
              className="underline"
              onPress={() => patchRequest(activeRequest._id, { body: previousBody, headers: previousHeaders })}
            >
              Undo
            </Button>
          </span>
        ),
      },
      { timeout: null },
    );
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
            requestBodyText={activeRequest.body?.text}
            responseId={activeResponse._id}
            updateFilter={activeResponse.error ? undefined : handleSetFilter}
            url={activeResponse.url}
          />
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
