import { describe, expect, it } from 'vitest';

import { formatTokenUsage, sumTokenUsage } from '../runner-feedback';

describe('sumTokenUsage', () => {
  it('sums input and output tokens across rows that reported usage', () => {
    const rows = [
      { aiGateway: { alias: 'opus', model: 'claude-opus-4-6', inputTokens: 10, outputTokens: 200 } },
      { aiGateway: { alias: 'fable', model: 'claude-fable-5', inputTokens: 12, outputTokens: 300 } },
      { aiGateway: { alias: 'sonnet', model: 'claude-sonnet-5' } }, // skipped / no usage
      {}, // a normal, non-gateway row
    ];
    expect(sumTokenUsage(rows)).toEqual({ inputTokens: 22, outputTokens: 500 });
  });

  it('returns null when nothing reported usage', () => {
    expect(sumTokenUsage([{}, { aiGateway: { alias: 'opus', model: 'm' } }])).toBeNull();
  });
});

describe('formatTokenUsage', () => {
  it('formats with thousands separators and treats a missing side as 0', () => {
    expect(formatTokenUsage({ inputTokens: 1234, outputTokens: 5 })).toBe('1,234 in, 5 out');
    expect(formatTokenUsage({ inputTokens: 7 })).toBe('7 in, 0 out');
  });
});
