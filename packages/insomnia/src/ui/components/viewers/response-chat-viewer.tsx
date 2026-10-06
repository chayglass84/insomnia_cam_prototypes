import React, { type FC, useEffect, useRef } from 'react';

import type { ChatCompletionSummary, ChatMessage } from '~/common/chat-completion';
import { type ChatTurnStats, totalChatTurns } from '~/common/chat-totals';
import { formatUsd } from '~/common/llm-cost';
import { priceChatTurn } from '~/konnect/transform';
import { useWorkspaceLoaderData } from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { useRequestLoaderData } from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.request.$requestId';
import { getChatTurnMeta } from '~/ui/utils/chat-turn-meta-cache';

import { Icon } from '../icon';
import { MarkdownPreview } from '../markdown-preview';
import { ChatSettingsBar, type ChatSettingsValues } from './chat-settings-bar';

interface Props {
  summary: ChatCompletionSummary;
  isStreaming?: boolean;
  isWaitingForReply?: boolean;
  requestKey: string;
  format: 'openai' | 'anthropic' | 'gemini';
  settingsValues: ChatSettingsValues;
  onApplySettings?: (next: ChatSettingsValues) => void;
  pendingSettingsNotice?: { message: string; actionLabel: string; onAction: () => void } | null;
  /** Earlier replies' usage lives in an in-memory cache here, so flag when some is missing from the totals. */
  isLiveConversation?: boolean;
}

const roleAlignment: Record<ChatMessage['role'], string> = {
  user: 'items-end',
  assistant: 'items-start',
  system: 'items-center',
};

const roleBubbleStyle: Record<ChatMessage['role'], string> = {
  user: 'bg-(--color-surprise) text-(--color-font-surprise)',
  assistant: 'bg-(--hl-sm) text-(--color-font)',
  system: 'bg-transparent text-(--hl) text-xs italic',
};

/** `model / 40 in, 120 out / $0.0012`; says so when tokens or cost are unknown rather than silently omitting them. */
const formatTurnFooter = (turn: ChatTurnStats, showCost: boolean, fallbackModel?: string) => {
  const parts: string[] = [turn.model || fallbackModel || 'model unknown'];
  if (turn.usage) {
    parts.push(`${turn.usage.inputTokens ?? '?'} tokens in, ${turn.usage.outputTokens ?? '?'} out`);
    if (showCost) {
      parts.push(
        turn.costUsd !== null
          ? formatUsd(turn.costUsd)
          : turn.costNote === 'rotating'
            ? 'cost n/a (alias rotates between models)'
            : 'cost n/a (no price)',
      );
    }
  } else {
    parts.push('tokens not reported');
  }
  return parts.join(' / ');
};

const ChatBubble: FC<{ message: ChatMessage; footer?: string }> = ({ message, footer }) => (
  <div className={`flex w-full flex-col gap-1 ${roleAlignment[message.role]}`}>
    <div
      className={`max-w-[80%] min-w-0 rounded-md px-3 py-2 text-left text-sm break-words whitespace-normal ${roleBubbleStyle[message.role]}`}
    >
      <MarkdownPreview markdown={message.content} />
    </div>
    {footer && <div className="px-1 text-[11px] text-(--hl)">{footer}</div>}
  </div>
);

const LoadingBubble: FC = () => (
  <div className={`flex w-full flex-col gap-1 ${roleAlignment.assistant}`}>
    <div
      className={`flex max-w-[80%] min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm ${roleBubbleStyle.assistant}`}
    >
      <Icon icon="spinner" className="animate-spin" />
      <span className="text-(--hl)">Waiting for a reply…</span>
    </div>
  </div>
);

export const ResponseChatViewer: FC<Props> = ({
  summary,
  isStreaming,
  isWaitingForReply,
  requestKey,
  format,
  settingsValues,
  onApplySettings,
  pendingSettingsNotice,
  isLiveConversation,
}) => {
  // The system prompt now lives in the settings bar above, not as a bubble in the list.
  const visibleMessages = summary.messages.filter(message => message.role !== 'system');

  // Per-reply stats: the live reply comes from this response's own summary; earlier ones from the in-memory cache.
  // Priced from the model that answered when known, else from the model the request's route + alias point at.
  const catalog = useWorkspaceLoaderData()?.activeWorkspace.konnectAiGatewayModels ?? [];
  const requestUrl = useRequestLoaderData()?.activeRequest?.url;
  const turnStats = visibleMessages.map((message, index): ChatTurnStats | undefined => {
    if (message.role !== 'assistant') {
      return undefined;
    }
    const meta =
      index === visibleMessages.length - 1
        ? { model: summary.model, usage: summary.usage }
        : isLiveConversation
          ? getChatTurnMeta(message.content)
          : undefined;
    return meta
      ? { ...meta, ...priceChatTurn(meta, { url: requestUrl, alias: settingsValues.model }, catalog) }
      : undefined;
  });
  // In a one-shot response, earlier assistant messages are request history (billed inside the input), not missing data.
  const totals = totalChatTurns(
    turnStats.filter((_, index) => visibleMessages[index].role === 'assistant'),
    Boolean(isLiveConversation),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Whether the viewport was already scrolled to (near) the bottom before the content grew — so a
  // user who's deliberately scrolled up to reread earlier messages isn't yanked back down.
  const isPinnedToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      isPinnedToBottomRef.current = distanceFromBottom < 24;
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) {
      return;
    }
    // A plain effect keyed on message content isn't enough: markdown compiles asynchronously
    // (see markdown-preview.tsx) via its own effect setting `dangerouslySetInnerHTML` on a later
    // render, so the DOM's final height isn't known yet when this component's own effect runs. A
    // MutationObserver on the content wrapper reacts directly to that DOM swap (and any other
    // content change) as it happens; the scroll itself is deferred one frame so it reads the
    // post-mutation layout rather than racing it.
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (!isPinnedToBottomRef.current) {
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
    observer.observe(content, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // A different request/response means a different conversation — always start pinned to the
  // bottom of it rather than carrying over whatever scroll state the previous one ended in.
  useEffect(() => {
    isPinnedToBottomRef.current = true;
  }, [requestKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ChatSettingsBar
        requestKey={requestKey}
        format={format}
        values={settingsValues}
        onApply={onApplySettings}
        totals={totals}
        stopReason={summary.stopReason}
        isStreaming={isStreaming}
        pendingNotice={pendingSettingsNotice}
      />
      <div
        ref={scrollRef}
        data-testid="chat-message-list"
        className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto p-(--padding-sm)"
      >
        <div ref={contentRef} className="flex flex-col gap-3">
          {visibleMessages.length === 0 ? (
            <div className="flex items-center gap-2 text-(--hl)">
              <Icon icon="comment" />
              No chat messages found in this exchange.
            </div>
          ) : (
            visibleMessages.map((message, index) => (
              <ChatBubble
                // eslint-disable-next-line react/no-array-index-key -- messages have no stable id
                key={index}
                message={message}
                footer={
                  message.role === 'assistant' && (turnStats[index] || index === visibleMessages.length - 1)
                    ? formatTurnFooter(turnStats[index] ?? { costUsd: null }, catalog.length > 0, settingsValues.model)
                    : undefined
                }
              />
            ))
          )}
          {isWaitingForReply && <LoadingBubble />}
        </div>
      </div>
    </div>
  );
};
