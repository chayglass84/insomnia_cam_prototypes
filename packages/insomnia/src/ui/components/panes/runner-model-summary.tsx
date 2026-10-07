import type { ModelScore } from 'insomnia-data';
import type { FC } from 'react';

import { formatUsd } from '../../../common/llm-cost';
import { modelAnchorId, type ModelRunSummary } from '../../../common/runner-feedback';

const cell = 'px-3 py-1';
const numberCell = `${cell} text-right tabular-nums`;

const passRateClassName = (rate: number | null) =>
  rate === null ? 'text-(--hl)' : rate === 1 ? 'text-lime-500' : rate === 0 ? 'text-red-500' : 'text-yellow-500';

/**
 * Ranked per-model comparison shown above a gateway run's results. With `scores` (from the collection's Model Scoring
 * script) it is ranked by score and shows a Score column; `scoringError` explains why a run has none. Prototype (3593AI).
 */
export const RunnerModelSummary: FC<{ summaries: ModelRunSummary[]; scores?: ModelScore[]; scoringError?: string }> = ({
  summaries,
  scores,
  scoringError,
}) => (
  <div
    className="m-3 overflow-x-auto rounded-sm border border-solid border-(--hl-md)"
    data-testid="runner-model-summary"
  >
    {scoringError && (
      <p
        className="border-b border-solid border-(--hl-md) px-3 py-1.5 text-sm text-amber-500"
        data-testid="runner-scoring-error"
      >
        The Model Scoring script failed, so this uses the default ranking: {scoringError}
      </p>
    )}
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-(--hl)">
        <tr>
          <th className={`${cell} font-normal`}>Route</th>
          <th className={`${cell} font-normal`}>Model</th>
          {scores && (
            <th
              className={`${numberCell} cursor-help font-normal`}
              title='Configure this from the "Model Scoring" tab on the Collection'
            >
              Score
            </th>
          )}
          <th className={`${numberCell} font-normal`}>In</th>
          <th className={`${numberCell} font-normal`}>Out</th>
          <th className={`${numberCell} font-normal`}>Cost</th>
          <th className={`${numberCell} font-normal`}>Tests passed</th>
        </tr>
      </thead>
      <tbody>
        {summaries.map(summary => (
          <tr
            key={`${summary.route}-${summary.alias}-${summary.model}`}
            className="border-t border-solid border-(--hl-md)"
          >
            <td className={`${cell} font-mono`}>{summary.route || '—'}</td>
            <td className={cell}>
              <button
                type="button"
                title="Jump to this model's results"
                className="cursor-pointer text-left hover:underline"
                onClick={() =>
                  document
                    .getElementById(modelAnchorId(summary, 1))
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                <span className="font-semibold">{summary.alias}</span>{' '}
                <span className="font-mono text-xs text-(--hl)">{summary.model || 'no response'}</span>
                {summary.gatewayDeclined > 0 && (
                  <span
                    className="ml-2 rounded-sm bg-amber-600/20 px-1.5 text-xs text-amber-500"
                    title="The gateway declined these requests (e.g. a format it doesn't translate). That's a gateway configuration choice, not a model failure."
                  >
                    {summary.gatewayDeclined} declined by gateway
                  </span>
                )}
                {summary.rotating && (
                  <span
                    className="ml-2 rounded-sm bg-(--hl-md) px-1.5 text-xs"
                    title="This alias rotates between several upstream models; the gateway chose this one for these runs."
                  >
                    rotating
                  </span>
                )}
              </button>
            </td>
            {scores && (
              <td className={numberCell} title={scores.find(score => score.id === summary.id)?.note}>
                {scores.some(score => score.id === summary.id) ? (
                  <strong>{scores.find(score => score.id === summary.id)!.score.toFixed(2)}</strong>
                ) : (
                  '—'
                )}
              </td>
            )}
            <td className={numberCell}>{summary.inputTokens.toLocaleString()}</td>
            <td className={numberCell}>{summary.outputTokens.toLocaleString()}</td>
            <td className={numberCell}>{summary.costUsd === null ? '—' : formatUsd(summary.costUsd)}</td>
            <td className={`${numberCell} ${passRateClassName(summary.passRate)}`}>
              {summary.passRate === null ? (
                '—'
              ) : (
                <>
                  <strong>{`${Math.round(summary.passRate * 100)}%`}</strong>
                  <span className="ml-1 text-xs text-(--hl)">{`(${summary.passedTests}/${summary.totalTests})`}</span>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    <p
      className="border-t border-solid border-(--hl-md) px-3 py-1.5 text-xs text-(--hl)"
      data-testid="runner-model-summary-note"
    >
      {scores
        ? "Ranked by score, from the collection's Model Scoring script (hover a score for its note). Models without a score rank last."
        : 'Ranked by tests passed, then cheapest, then fewest output tokens. Models without tests or prices rank after those with them.'}
    </p>
  </div>
);
