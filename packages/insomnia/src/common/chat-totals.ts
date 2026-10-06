import type { ChatTurnMeta } from '../ui/utils/chat-turn-meta-cache';

export interface ChatTurnStats extends ChatTurnMeta {
  /** USD for this reply, or null when it can't be priced (no usage, no price, or a rotating alias with unknown model). */
  costUsd: number | null;
  /** Why `costUsd` is null even though there's usage, for the bubble footer. */
  costNote?: 'rotating' | 'no-price';
}

export interface ChatTotals {
  inputTokens: number;
  outputTokens: number;
  /** Sum over the priced replies, or null when none could be priced. */
  costUsd: number | null;
  /** Replies counted into the totals. */
  replies: number;
  /** Replies that had usage but no price, so `costUsd` undercounts. */
  unpricedReplies: number;
  /** Earlier replies whose usage was never captured (e.g. after a reload), so every total undercounts. */
  missingReplies: number;
}

/**
 * Totals across a conversation's replies. Each reply's `inputTokens` already includes the whole history sent with it
 * (the initial prompt and every earlier turn), which is what the provider bills, so summing replies gives the true
 * billed total. `undefined` entries are replies with no recorded stats. Returns null when nothing reported usage.
 */
export const totalChatTurns = (turns: (ChatTurnStats | undefined)[], countMissing: boolean): ChatTotals | null => {
  const totals: ChatTotals = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    replies: 0,
    unpricedReplies: 0,
    missingReplies: 0,
  };
  for (const turn of turns) {
    if (!turn?.usage) {
      totals.missingReplies += 1;
      continue;
    }
    totals.replies += 1;
    totals.inputTokens += turn.usage.inputTokens ?? 0;
    totals.outputTokens += turn.usage.outputTokens ?? 0;
    if (turn.costUsd === null) {
      totals.unpricedReplies += 1;
    } else {
      totals.costUsd = (totals.costUsd ?? 0) + turn.costUsd;
    }
  }
  if (!countMissing) {
    totals.missingReplies = 0;
  }
  return totals.replies > 0 ? totals : null;
};
