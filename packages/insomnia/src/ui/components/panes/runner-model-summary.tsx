import type { FC } from 'react';

import type { ModelRunSummary } from '../../../common/runner-feedback';

const cell = 'px-3 py-1';
const numberCell = `${cell} text-right tabular-nums`;

const passRateClassName = (rate: number | null) =>
  rate === null ? 'text-(--hl)' : rate === 1 ? 'text-lime-500' : rate === 0 ? 'text-red-500' : 'text-yellow-500';

/** Ranked per-model comparison shown above a gateway run's results. Prototype (3593AI). */
export const RunnerModelSummary: FC<{ summaries: ModelRunSummary[] }> = ({ summaries }) => (
  <div
    className="m-3 overflow-x-auto rounded-sm border border-solid border-(--hl-md)"
    data-testid="runner-model-summary"
  >
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-(--hl)">
        <tr>
          <th className={`${cell} font-normal`}>Route</th>
          <th className={`${cell} font-normal`}>Model</th>
          <th className={`${numberCell} font-normal`}>In</th>
          <th className={`${numberCell} font-normal`}>Out</th>
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
              <span className="font-semibold">{summary.alias}</span>{' '}
              <span className="font-mono text-xs text-(--hl)">{summary.model}</span>
            </td>
            <td className={numberCell}>{summary.inputTokens.toLocaleString()}</td>
            <td className={numberCell}>{summary.outputTokens.toLocaleString()}</td>
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
  </div>
);
