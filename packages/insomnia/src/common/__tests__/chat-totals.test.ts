import { describe, expect, it } from 'vitest';

import { totalChatTurns } from '../chat-totals';

describe('totalChatTurns', () => {
  it('sums input, output and cost over every reply', () => {
    const totals = totalChatTurns(
      [
        { usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.01 },
        { usage: { inputTokens: 180, outputTokens: 70 }, costUsd: 0.02 },
      ],
      true,
    );
    expect(totals).toEqual({
      inputTokens: 280,
      outputTokens: 120,
      costUsd: 0.03,
      replies: 2,
      unpricedReplies: 0,
      missingReplies: 0,
    });
  });

  it('flags unpriced and missing replies instead of hiding the undercount', () => {
    const totals = totalChatTurns(
      [undefined, { usage: { inputTokens: 10, outputTokens: 5 }, costUsd: null, costNote: 'rotating' }],
      true,
    );
    expect(totals).toMatchObject({ costUsd: null, unpricedReplies: 1, missingReplies: 1, replies: 1 });
  });

  it('ignores missing replies for one-shot responses, and returns null with no usage at all', () => {
    expect(totalChatTurns([undefined, { usage: { inputTokens: 1 }, costUsd: null }], false)?.missingReplies).toBe(0);
    expect(totalChatTurns([undefined], true)).toBeNull();
  });
});
