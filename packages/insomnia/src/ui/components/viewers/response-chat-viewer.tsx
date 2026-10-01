import React, { type FC, useState } from 'react';
import { Button } from 'react-aria-components';

import type { ChatCompletionSummary, ChatMessage } from '~/common/chat-completion';
import { Icon } from '~/ui/components/icon';
import { Tooltip } from '~/ui/components/tooltip';

interface Props {
  summary: ChatCompletionSummary;
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

const ChatBubble: FC<{ message: ChatMessage; isLast: boolean; summary: ChatCompletionSummary }> = ({
  message,
  isLast,
  summary,
}) => {
  const [expanded, setExpanded] = useState(false);
  const showInspector = isLast && message.role === 'assistant';

  const tooltipMessage = (
    <div className="flex flex-col gap-0.5">
      <div className="capitalize">{message.role}</div>
      {showInspector && summary.model && <div>Model: {summary.model}</div>}
      {showInspector && summary.usage && (
        <div>
          {summary.usage.inputTokens ?? '?'} in / {summary.usage.outputTokens ?? '?'} out tokens
        </div>
      )}
      {showInspector && summary.stopReason && <div>Stop reason: {summary.stopReason}</div>}
      <div className="text-(--hl)">Click to {expanded ? 'collapse' : 'expand'}</div>
    </div>
  );

  if (message.role === 'system') {
    return (
      <div className={`flex w-full flex-col gap-1 ${roleAlignment[message.role]}`}>
        <div className={`max-w-[80%] rounded-md px-3 py-1 ${roleBubbleStyle[message.role]}`}>{message.content}</div>
      </div>
    );
  }

  return (
    <div className={`flex w-full flex-col gap-1 ${roleAlignment[message.role]}`}>
      <Tooltip message={tooltipMessage} position="top">
        <Button
          onPress={() => setExpanded(current => !current)}
          className={`max-w-[80%] rounded-md px-3 py-2 text-left text-sm whitespace-pre-wrap outline-hidden ${roleBubbleStyle[message.role]}`}
        >
          {message.content}
        </Button>
      </Tooltip>
      {expanded && (
        <div className="max-w-[80%] rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font)">
          <div className="flex flex-col gap-1">
            <div>
              <span className="text-(--hl)">Role:</span> {message.role}
            </div>
            {showInspector && summary.model && (
              <div>
                <span className="text-(--hl)">Model:</span> {summary.model}
              </div>
            )}
            {showInspector && summary.stopReason && (
              <div>
                <span className="text-(--hl)">Stop reason:</span> {summary.stopReason}
              </div>
            )}
            {showInspector && summary.usage && (
              <div>
                <span className="text-(--hl)">Tokens:</span>{' '}
                {summary.usage.inputTokens ?? '?'} in / {summary.usage.outputTokens ?? '?'} out
              </div>
            )}
            <details className="mt-1">
              <summary className="cursor-pointer text-(--hl)">View raw</summary>
              <pre className="mt-1 overflow-auto font-mono whitespace-pre-wrap">{message.content}</pre>
            </details>
          </div>
        </div>
      )}
    </div>
  );
};

export const ResponseChatViewer: FC<Props> = ({ summary }) => {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-(--padding-sm)">
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
  );
};
