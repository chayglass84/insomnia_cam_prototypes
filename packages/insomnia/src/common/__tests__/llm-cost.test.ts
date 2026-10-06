import { describe, expect, it } from 'vitest';

import { computeCostUsd, formatUsd, formatUsdPerMillion } from '../llm-cost';

describe('computeCostUsd', () => {
  const opus = { inputPerToken: 0.000_005, outputPerToken: 0.000_025 }; // $5 / $25 per 1M

  it('multiplies tokens by the per-token prices', () => {
    // 30 in + 213 out = 30*0.000005 + 213*0.000025
    expect(computeCostUsd(opus, { inputTokens: 30, outputTokens: 213 })).toBeCloseTo(0.005_475, 9);
  });

  it('treats one missing side of the usage as zero', () => {
    expect(computeCostUsd(opus, { outputTokens: 100 })).toBeCloseTo(0.0025, 9);
  });

  it('returns null when there is no price or no usage', () => {
    expect(computeCostUsd(undefined, { inputTokens: 1 })).toBeNull();
    expect(computeCostUsd({}, { inputTokens: 1 })).toBeNull();
    expect(computeCostUsd(opus, null)).toBeNull();
    expect(computeCostUsd(opus, {})).toBeNull();
  });
});

describe('formatUsd', () => {
  it('uses four decimals under a dollar, two above, and flags tiny amounts', () => {
    expect(formatUsd(0.005_475)).toBe('$0.0055');
    expect(formatUsd(12.4)).toBe('$12.40');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.000_000_01)).toBe('<$0.0001');
  });
});

describe('formatUsdPerMillion', () => {
  it('shows a per-token price per 1M tokens', () => {
    expect(formatUsdPerMillion(0.000_005_5)).toBe('$5.50');
    expect(formatUsdPerMillion(0.000_000_1)).toBe('$0.10');
  });
});
