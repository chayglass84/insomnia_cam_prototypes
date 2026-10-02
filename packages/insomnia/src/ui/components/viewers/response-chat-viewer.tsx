import React, { type FC } from 'react';

import type { ChatCompletionSummary, ChatMessage } from '~/common/chat-completion';
import { getChatTurnMeta } from '~/ui/utils/chat-turn-meta-cache';

import { Icon } from '../icon';
import { MarkdownPreview } from '../markdown-preview';
import { ChatSummaryBar } from './chat-summary-bar';

interface Props {
  summary: ChatCompletionSummary;
  isStreaming?: boolean;
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

const formatTurnFooter = (turnMeta: { model?: string; usage?: { inputTokens?: number; outputTokens?: number } }) => {
  const parts: string[] = [];
  if (turnMeta.model) {
    parts.push(turnMeta.model);
  }
  if (turnMeta.usage) {
    parts.push(`${turnMeta.usage.inputTokens ?? '?'} tokens in, ${turnMeta.usage.outputTokens ?? '?'} out`);
  }
  return parts.join(' / ');
};

const ChatBubble: FC<{ message: ChatMessage; isLast: boolean; summary: ChatCompletionSummary }> = ({
  message,
  isLast,
  summary,
}) => {
  if (message.role === 'system') {
    return (
      <div className={`flex w-full flex-col items-center gap-1`}>
        <div className="text-[10px] font-semibold tracking-wide text-(--hl) uppercase">System prompt</div>
        <div className="max-w-[80%] rounded-md bg-transparent px-3 py-1 text-center text-xs break-words whitespace-pre-wrap text-(--hl) italic">
          {message.content}
        </div>
      </div>
    );
  }

  const isAssistant = message.role === 'assistant';
  // The live/current turn's model+usage comes from the response's own summary; any earlier
  // turn's only exists in the in-memory turn-meta cache (see chat-turn-meta-cache.ts) — past
  // turns' content is never persisted with structure, only as plain text.
  const turnMeta = isAssistant
    ? isLast
      ? { model: summary.model, usage: summary.usage }
      : getChatTurnMeta(message.content)
    : undefined;
  const footer = turnMeta ? formatTurnFooter(turnMeta) : '';

  return (
    <div className={`flex w-full flex-col gap-1 ${roleAlignment[message.role]}`}>
      <div
        className={`max-w-[80%] min-w-0 rounded-md px-3 py-2 text-left text-sm break-words whitespace-normal ${roleBubbleStyle[message.role]}`}
      >
        <MarkdownPreview markdown={message.content} />
      </div>
      {footer && <div className="px-1 text-[11px] text-(--hl)">{footer}</div>}
    </div>
  );
};

export const ResponseChatViewer: FC<Props> = ({ summary, isStreaming }) => {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ChatSummaryBar
        model={summary.model}
        usage={summary.usage}
        stopReason={summary.stopReason}
        isStreaming={isStreaming}
      />
      <div className="flex flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-(--padding-sm)">
        {summary.messages.length === 0 ? (
          <div className="flex items-center gap-2 text-(--hl)">
            <Icon icon="comment" />
            No chat messages found in this exchange.
          </div>
        ) : (
          summary.messages.map((message, index) => (
            <ChatBubble
              // eslint-disable-next-line react/no-array-index-key -- messages have no stable id
              key={index}
              message={message}
              isLast={index === summary.messages.length - 1}
              summary={summary}
            />
          ))
        )}
      </div>
    </div>
  );
};
