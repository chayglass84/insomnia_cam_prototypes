import type { AiGatewayModel } from 'insomnia-data';
import type { FC } from 'react';

import { groupModelsByPath } from '../../../konnect/transform';

/** Read-only catalog of the models an AI Gateway exposes, grouped by route (path). Prototype (3593AI). */
export const AiGatewayModelsPane: FC<{ models: AiGatewayModel[] }> = ({ models }) => {
  const groups = groupModelsByPath(models);

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold">AI Gateway models</h2>
        <p className="text-sm text-(--hl)">
          {models.length} {models.length === 1 ? 'model' : 'models'} on {groups.length}{' '}
          {groups.length === 1 ? 'route' : 'routes'}. Synced from Konnect; re-sync to refresh.
        </p>
      </div>
      {groups.map(([path, pathModels]) => (
        <section key={path} className="rounded-md border border-solid border-(--hl-md)">
          <header className="flex items-center gap-2 border-b border-solid border-(--hl-md) px-3 py-2">
            <span className="font-mono text-sm font-semibold">{path}</span>
            <span className="text-xs text-(--hl)">
              {pathModels.length} {pathModels.length === 1 ? 'model' : 'models'}
            </span>
          </header>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-(--hl)">
              <tr>
                <th className="px-3 py-1 font-normal">Model</th>
                <th className="px-3 py-1 font-normal">Request body `model`</th>
                <th className="px-3 py-1 font-normal">Target</th>
                <th className="px-3 py-1 font-normal">Provider</th>
              </tr>
            </thead>
            <tbody>
              {pathModels.map(model => (
                <tr key={model.id} className={model.enabled ? '' : 'opacity-50'}>
                  <td className="px-3 py-1">{model.displayName}</td>
                  <td className="px-3 py-1 font-mono">{model.routeModelValues.join(', ') || '—'}</td>
                  <td className="px-3 py-1 font-mono">{model.targetModel}</td>
                  <td className="px-3 py-1">{model.provider}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
};
