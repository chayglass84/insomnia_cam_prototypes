import type { AiGatewayModel } from 'insomnia-data';
import type { FC } from 'react';

import { formatUsdPerMillion } from '../../../common/llm-cost';
import { groupModelsByPath, isRotatingModel, modelTargets } from '../../../konnect/transform';

interface Props {
  models: AiGatewayModel[];
  /** null means every model is selected. */
  selectedIds: string[] | null;
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

/** Runner tab for synced AI Gateway collections: pick which models each selected request runs against. Prototype (3593AI). */
export const RunnerModelsPanel: FC<Props> = ({ models, selectedIds, onChange, disabled }) => {
  const selected = new Set(selectedIds ?? models.map(m => m.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange([...next]);
  };

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4 text-sm">
      {groupModelsByPath(models).map(([path, pathModels]) => (
        <div key={path} className="flex flex-col gap-1">
          <span className="font-mono text-xs font-semibold text-(--hl)">{path}</span>
          {pathModels.map(model => (
            <div key={model.id} className="flex flex-col">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected.has(model.id)}
                  onChange={() => toggle(model.id)}
                />
                <span className="font-semibold">{model.routeModelValues.join(', ') || '—'}</span>
                {isRotatingModel(model) ? (
                  <span
                    className="rounded-sm bg-(--hl-md) px-1.5 text-xs"
                    title="The gateway picks one of these per request, so which model answers isn't known up front. Raise the iteration count to sample more of them."
                  >
                    rotates between {modelTargets(model).length} models
                  </span>
                ) : (
                  <span className="font-mono text-xs text-(--hl)">{model.targetModel}</span>
                )}
              </label>
              {isRotatingModel(model) && (
                <ul className="ml-6 text-xs text-(--hl)">
                  {modelTargets(model).map(target => (
                    <li key={target.name} className="flex gap-2">
                      <span className="font-mono">{target.name}</span>
                      {target.inputPerToken !== undefined && target.outputPerToken !== undefined && (
                        <span className="tabular-nums">
                          {formatUsdPerMillion(target.inputPerToken)} / {formatUsdPerMillion(target.outputPerToken)} per
                          1M
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};
