import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runScript } from '../../script-executor';
import {
  buildScoringInput,
  buildScoringScript,
  DEFAULT_SCORING_SCRIPT,
  parseScoringOutput,
  rankByScore,
  runScoring,
} from '../ai-scoring';
import { type ModelRunSummary, summarizeModelRuns } from '../runner-feedback';

const summary = (overrides: Partial<ModelRunSummary> & { id: string }): ModelRunSummary => ({
  route: '/r',
  alias: overrides.id,
  model: `${overrides.id}-model`,
  rotating: false,
  inputTokens: 100,
  outputTokens: 50,
  costUsd: null,
  gatewayDeclined: 0,
  passedTests: 0,
  totalTests: 0,
  passRate: null,
  checksPassed: 0,
  checksTotal: 0,
  checkRate: null,
  ...overrides,
});

describe('parseScoringOutput', () => {
  const ids = ['a', 'b'];

  it('returns the scores for known ids and keeps notes', () => {
    expect(
      parseScoringOutput(
        JSON.stringify([
          { id: 'a', score: 0.5, note: 'half' },
          { id: 'b', score: 1 },
        ]),
        ids,
      ),
    ).toEqual([
      { id: 'a', score: 0.5, note: 'half' },
      { id: 'b', score: 1 },
    ]);
  });

  it('ignores ids it does not know and models it is not given', () => {
    expect(parseScoringOutput(JSON.stringify([{ id: 'zzz', score: 1 }]), ids)).toEqual([]);
  });

  it('explains what is wrong when the result is not usable', () => {
    expect(() => parseScoringOutput(undefined, ids)).toThrow(/did not return anything/);
    expect(() => parseScoringOutput('not json', ids)).toThrow(/not plain data/);
    expect(() => parseScoringOutput('{"a":1}', ids)).toThrow(/array of \{ id, score \}/);
    expect(() => parseScoringOutput('[{"id":"a","score":"high"}]', ids)).toThrow(/finite number score/);
    expect(() => parseScoringOutput('[{"id":"a"}]', ids)).toThrow(/finite number score/);
    expect(() => parseScoringOutput('[null]', ids)).toThrow(/finite number score/);
  });
});

describe('rankByScore', () => {
  it('orders by score, highest first, with unscored models last in their original order', () => {
    const ranked = rankByScore(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { id: 'c', score: 0.9 },
        { id: 'a', score: 0.2 },
      ],
    );
    expect(ranked.map(row => row.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('keeps the original order for equal scores', () => {
    const ranked = rankByScore(
      [{ id: 'a' }, { id: 'b' }],
      [
        { id: 'a', score: 0.5 },
        { id: 'b', score: 0.5 },
      ],
    );
    expect(ranked.map(row => row.id)).toEqual(['a', 'b']);
  });
});

describe('buildScoringInput / summary ids', () => {
  it('gives every summary row an id and maps the fields scripts see', () => {
    const rows = summarizeModelRuns([
      {
        requestName: 'q',
        requestUrl: 'u',
        responseCode: 200,
        results: [
          {
            testCase: 't',
            status: 'passed',
            executionTime: 1,
            category: 'after-response',
            checks: { passed: 2, total: 2 },
          },
          {
            testCase: 'u',
            status: 'failed',
            executionTime: 1,
            category: 'after-response',
            checks: { passed: 1, total: 2 },
          },
        ],
        aiGateway: {
          route: '/anthropic',
          alias: 'opus',
          model: 'claude',
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.5,
        },
      },
      {
        requestName: 'q',
        requestUrl: 'u',
        responseCode: 200,
        results: [],
        aiGateway: { route: '/rot', alias: 'nano', model: 'gpt-a', rotating: true },
      },
    ]);
    expect(rows.map(row => row.id).sort()).toEqual(['/anthropic|opus', '/rot|nano|gpt-a']);
    expect(buildScoringInput(rows).find(row => row.id === '/anthropic|opus')).toMatchObject({
      testsPassed: 1,
      testsTotal: 2,
      passRate: 0.5,
      checksPassed: 3,
      checksTotal: 4,
      checkRate: 0.75,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.5,
    });
  });
});

describe('runScoring (real script engine)', () => {
  let dir: string;
  let timelinePath: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-test-'));
    timelinePath = path.join(dir, 'timeline.txt');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (script: string, summaries: ModelRunSummary[]) =>
    runScoring({
      summaries,
      script,
      settings: { timeout: 30_000 } as any,
      timelinePath,
      execute: options => runScript(options),
    });

  const field = [
    summary({ id: 'pricey', passRate: 1, passedTests: 2, totalTests: 2, costUsd: 0.02 }),
    summary({ id: 'cheap', passRate: 1, passedTests: 2, totalTests: 2, costUsd: 0.01 }),
    summary({ id: 'broken', passRate: 0.5, passedTests: 1, totalTests: 2, costUsd: null }),
  ];

  it('the default script blends 70% tests and 30% cost, with cost relative to the cheapest model', async () => {
    const scores = await run(DEFAULT_SCORING_SCRIPT, field);
    const byId = Object.fromEntries(scores.map(score => [score.id, score.score]));
    expect(byId.cheap).toBeCloseTo(1);
    expect(byId.pricey).toBeCloseTo(0.7 + 0.3 * 0.5);
    expect(byId.broken).toBeCloseTo(0.35);
    expect(scores.find(score => score.id === 'cheap')?.note).toContain('tests 100%');
  });

  it('a script can score on the judge check rate', async () => {
    const withChecks = [
      summary({ id: 'strict', checksPassed: 1, checksTotal: 4, checkRate: 0.25 }),
      summary({ id: 'good', checksPassed: 4, checksTotal: 4, checkRate: 1 }),
      summary({ id: 'no-judge' }),
    ];
    const scores = await run('return models.map(m => ({ id: m.id, score: m.checkRate ?? 0 }));', withChecks);
    expect(Object.fromEntries(scores.map(score => [score.id, score.score]))).toEqual({
      'strict': 0.25,
      'good': 1,
      'no-judge': 0,
    });
  });

  it('runs a script of the user own', async () => {
    const scores = await run('return models.map(m => ({ id: m.id, score: m.outputTokens / 100 }));', field);
    expect(scores.map(score => score.score)).toEqual([0.5, 0.5, 0.5]);
  });

  it('supports async scripts', async () => {
    const scores = await run('await Promise.resolve(); return [{ id: models[0].id, score: 1 }];', field);
    expect(scores).toEqual([{ id: 'pricey', score: 1 }]);
  });

  it('rejects with the script error when it throws', async () => {
    await expect(run('throw new Error("bad weights");', field)).rejects.toThrow(/bad weights/);
  });

  it('rejects with a hint when the script forgets to return', async () => {
    await expect(run('const x = 1;', field)).rejects.toThrow(/did not return anything/);
  });

  it('wraps the user script in an async function whose return value is the result', () => {
    expect(buildScoringScript('return 1;')).toContain('return 1;');
  });
});
