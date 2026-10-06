import type { AiGatewayRunInfo } from 'insomnia-data';
import type { ReactNode } from 'react';

import { formatTokenUsage, groupRowsByModel, modelAnchorId, sumTokenUsage } from '../../../common/runner-feedback';

interface Props<T extends { aiGateway?: AiGatewayRunInfo }> {
  rows: T[];
  iteration: number;
  /** Rendered for each row; `index` is the row's position in `rows`, handy for stable test ids. */
  renderRow: (row: T, index: number) => ReactNode;
  /** Rows failing this are left out, and a model with no visible rows gets no heading. Defaults to all visible. */
  isVisible?: (row: T) => boolean;
}

/**
 * One heading per gateway model with that model's requests listed beneath it. Rows that didn't run against a gateway
 * model (a normal collection run) are rendered as a plain list with no heading. Prototype (3593AI).
 */
export function RunnerModelGroups<T extends { aiGateway?: AiGatewayRunInfo }>({
  rows,
  iteration,
  renderRow,
  isVisible = () => true,
}: Props<T>) {
  return (
    <>
      {groupRowsByModel(rows).map(group => {
        const entries = group.entries.filter(({ row }) => isVisible(row));
        if (entries.length === 0) {
          return null;
        }
        const body = entries.map(({ row, index }) => renderRow(row, index));
        if (!group.info) {
          return <div key="ungrouped">{body}</div>;
        }
        const tokens = sumTokenUsage(entries.map(entry => entry.row));
        return (
          <section key={group.key} id={modelAnchorId(group.info, iteration)} className="scroll-mt-2">
            <h3 className="mx-3 mt-4 flex flex-wrap items-baseline gap-x-2 border-b border-solid border-(--hl-md) pb-1 text-base">
              <span className="font-semibold">{group.info.alias}</span>
              <span className="font-mono text-sm text-neutral-400">{group.info.model}</span>
              {group.info.route && <span className="font-mono text-xs text-neutral-400">{group.info.route}</span>}
              {tokens && <span className="ml-auto text-sm tabular-nums">{`Tokens: ${formatTokenUsage(tokens)}`}</span>}
            </h3>
            {body}
          </section>
        );
      })}
    </>
  );
}
