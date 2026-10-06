import { describe, expect, it } from 'vitest';

import { formatTokenUsage, summarizeModelRuns, sumTokenUsage } from '../runner-feedback';

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

describe('summarizeModelRuns', () => {
  const pass = { status: 'passed' } as any;
  const fail = { status: 'failed' } as any;
  const row = (alias: string, model: string, out: number, results: any[], extra: object = {}) => ({
    requestName: 'r',
    requestUrl: 'u',
    responseCode: 200,
    results,
    aiGateway: { route: '/anthropic', alias, model, inputTokens: 10, outputTokens: out },
    ...extra,
  });

  it('totals per model across requests and iterations', () => {
    const [opus] = summarizeModelRuns([
      row('opus', 'claude-opus-4-6', 100, [pass, fail]),
      row('opus', 'claude-opus-4-6', 50, [pass, pass]),
    ]);
    expect(opus).toMatchObject({ inputTokens: 20, outputTokens: 150, passedTests: 3, totalTests: 4, passRate: 0.75 });
  });

  it('ranks by pass rate, then fewest output tokens, with untested models last; ignores skipped rows', () => {
    const ranked = summarizeModelRuns([
      row('wordy', 'm1', 900, [pass, pass]),
      row('terse', 'm2', 100, [pass, pass]),
      row('flaky', 'm3', 10, [pass, fail]),
      row('untested', 'm4', 5, []),
      row('skipped', 'm5', 1, [pass], { skipped: true }),
      { requestName: 'plain', requestUrl: 'u', responseCode: 200, results: [pass] },
    ]);
    expect(ranked.map(s => s.alias)).toEqual(['terse', 'wordy', 'flaky', 'untested']);
  });
});
