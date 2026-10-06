import type { AiGatewayModel } from 'insomnia-data';
import type { FC } from 'react';

import { groupModelsByPath } from '../../../konnect/transform';

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
            <label key={model.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={disabled}
                checked={selected.has(model.id)}
                onChange={() => toggle(model.id)}
              />
              <span className="font-semibold">{model.routeModelValues.join(', ') || '—'}</span>
              <span className="font-mono text-xs text-(--hl)">{model.targetModel}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
};
