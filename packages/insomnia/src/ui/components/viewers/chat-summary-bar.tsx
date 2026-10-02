import React, { type FC } from 'react';

import { Icon } from '~/ui/components/icon';

interface Props {
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
  isStreaming?: boolean;
}

export const ChatSummaryBar: FC<Props> = ({ model, usage, stopReason, isStreaming }) => {
  if (!model && !usage && !stopReason && !isStreaming) {
    return null;
  }

  const totalTokens =
    usage?.inputTokens !== undefined && usage?.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-solid border-(--hl-md) bg-(--hl-xs) px-3 py-1.5 text-xs text-(--hl)">
      {isStreaming && (
        <span className="flex items-center gap-1 text-(--color-font)">
          <Icon icon="spinner" className="animate-spin" />
          Streaming…
        </span>
      )}
      {model && (
        <span className="flex items-center gap-1">
          <Icon icon="robot" />
          {model}
        </span>
      )}
      {usage && (
        <span className="flex items-center gap-1">
          <Icon icon="coins" />
          {usage.inputTokens ?? '?'} in / {usage.outputTokens ?? '?'} out
          {totalTokens !== undefined && <span className="text-(--hl)">({totalTokens} total)</span>}
        </span>
      )}
      {stopReason && (
        <span className="flex items-center gap-1">
          <Icon icon="stop" />
          {stopReason}
        </span>
      )}
    </div>
  );
};
