// Prototype (3593AI): the collection's Model Scoring script. It runs once, at the end of a Model Evaluator run, over the
// per-model totals and returns a score for each model. The default script is shown (and editable) on the Model Scoring
// tab, so the weights are not hidden constants.
import type { ModelScore } from 'insomnia-data';
import { models as dataModels } from 'insomnia-data';

import type { RequestContext } from '../../../insomnia-scripting-environment/src/objects';
import type { ModelRunSummary } from './runner-feedback';

/** What a scoring script sees for each model: totals across every request and iteration in the run. */
export interface ScoringModelInput {
  /** Return this in your result to say which model a score belongs to. */
  id: string;
  route: string;
  alias: string;
  model: string;
  rotating: boolean;
  testsPassed: number;
  testsTotal: number;
  /** 0-1, or null when the model had no tests. */
  passRate: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Total USD for the model's runs, or null when none were priced. */
  costUsd: number | null;
  /** Requests the gateway declined; they have no tests and are not in `testsTotal`. */
  declined: number;
}

export const DEFAULT_SCORING_SCRIPT = `// Runs once, at the end of a run. \`models\` has one entry per model with totals across the whole run:
//   id, route, alias, model, rotating, testsPassed, testsTotal, passRate (0-1 or null),
//   inputTokens, outputTokens, costUsd (null if unpriced), declined
// Return one { id, score } per model, with a score from 0 to 1 (higher is better).
// You can add a \`note\` to explain a score; it is shown when you hover the score.

const WEIGHTS = { tests: 0.7, cost: 0.3 };

const pricedCosts = models.map(m => m.costUsd).filter(cost => cost > 0);
const cheapest = pricedCosts.length > 0 ? Math.min(...pricedCosts) : null;

return models.map(m => {
  const tests = m.passRate ?? 0;
  // 1 for the cheapest model, falling toward 0 as a model gets pricier. A model with no price scores 0 here.
  const cost = cheapest && m.costUsd > 0 ? cheapest / m.costUsd : 0;
  return {
    id: m.id,
    score: WEIGHTS.tests * tests + WEIGHTS.cost * cost,
    note: \`tests \${Math.round(tests * 100)}% x \${WEIGHTS.tests}, cost \${Math.round(cost * 100)}% x \${WEIGHTS.cost}\`,
  };
});
`;

export const buildScoringInput = (summaries: ModelRunSummary[]): ScoringModelInput[] =>
  summaries.map(summary => ({
    id: summary.id,
    route: summary.route,
    alias: summary.alias,
    model: summary.model,
    rotating: summary.rotating,
    testsPassed: summary.passedTests,
    testsTotal: summary.totalTests,
    passRate: summary.passRate,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    costUsd: summary.costUsd,
    declined: summary.gatewayDeclined,
  }));

const INPUT_VARIABLE = '__scoringModels';
const OUTPUT_VARIABLE = '__modelScores';

/** The user's script becomes the body of an async function; its return value is handed back through the environment. */
export const buildScoringScript = (userScript: string) => `
const models = JSON.parse(insomnia.iterationData.get('${INPUT_VARIABLE}'));
const __scoring = async () => {
${userScript}
};
const __result = await __scoring();
insomnia.environment.set('${OUTPUT_VARIABLE}', JSON.stringify(__result === undefined ? null : __result));
`;

/**
 * Validates what the script returned. Throws a message meant to be shown to the user. Entries for unknown ids are
 * ignored; a model the script does not mention simply has no score.
 */
export const parseScoringOutput = (raw: unknown, knownIds: string[]): ModelScore[] => {
  if (typeof raw !== 'string') {
    throw new TypeError('The scoring script did not return anything. End it with `return models.map(...)`.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError('The scoring script returned something that is not plain data.');
  }
  if (parsed === null) {
    throw new TypeError('The scoring script did not return anything. End it with `return models.map(...)`.');
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError('The scoring script must return an array of { id, score } objects.');
  }
  const known = new Set(knownIds);
  const scores: ModelScore[] = [];
  for (const entry of parsed) {
    const { id, score, note } = (entry ?? {}) as Partial<ModelScore>;
    if (typeof id !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) {
      throw new TypeError(`Every result needs a string id and a finite number score; got ${JSON.stringify(entry)}.`);
    }
    if (known.has(id)) {
      scores.push({ id, score, ...(typeof note === 'string' && note ? { note } : {}) });
    }
  }
  return scores;
};

type ExecuteScript = (options: {
  script: string;
  context: RequestContext;
}) => Promise<RequestContext | { error: string }>;

/**
 * Runs a scoring script in the script sandbox. `execute` is the runtime's script runner (injected so this stays testable).
 * Throws with a user-readable message when the script fails or returns something unusable.
 */
export const runScoring = async ({
  summaries,
  script,
  settings,
  timelinePath,
  execute,
}: {
  summaries: ModelRunSummary[];
  script: string;
  settings: RequestContext['settings'];
  timelinePath: string;
  execute: ExecuteScript;
}): Promise<ModelScore[]> => {
  const environment = { id: 'model_scoring', name: 'Model scoring', data: {} };
  const output = await execute({
    script: buildScoringScript(script),
    context: {
      request: {
        ...dataModels.request.init(),
        _id: 'model_scoring',
        name: 'Model scoring',
        // The scripting object needs a request to build around; scoring never sends it.
        url: 'https://model-scoring.invalid',
      } as RequestContext['request'],
      timelinePath,
      environment,
      baseEnvironment: environment,
      iterationData: { name: 'scoring', data: { [INPUT_VARIABLE]: JSON.stringify(buildScoringInput(summaries)) } },
      timeout: settings.timeout,
      settings,
      clientCertificates: [],
      cookieJar: { cookies: [] } as unknown as RequestContext['cookieJar'],
      requestInfo: { eventName: 'test', iteration: 1, iterationCount: 1 },
      execution: { location: ['Model scoring'] },
      logs: [],
      transientVariables: { name: 'transientVariables', data: {} },
      parentFolders: [],
    },
  });
  if ('error' in output) {
    throw new Error(output.error);
  }
  return parseScoringOutput(
    (output.environment.data as Record<string, unknown>)[OUTPUT_VARIABLE],
    summaries.map(summary => summary.id),
  );
};

/** Highest score first; models with no score keep their order after the scored ones. */
export const rankByScore = <T extends { id: string }>(summaries: T[], scores: ModelScore[]): T[] => {
  const byId = new Map(scores.map(score => [score.id, score.score]));
  return summaries
    .map((summary, index) => ({ summary, index, score: byId.get(summary.id) }))
    .sort((a, b) =>
      a.score === b.score
        ? a.index - b.index
        : a.score === undefined
          ? 1
          : b.score === undefined
            ? -1
            : b.score - a.score,
    )
    .map(({ summary }) => summary);
};
