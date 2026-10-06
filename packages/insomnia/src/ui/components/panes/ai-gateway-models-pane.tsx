import type { AiGatewayModel } from 'insomnia-data';
import type { FC } from 'react';
import { Button } from 'react-aria-components';
import { useParams } from 'react-router';

import { groupModelsByPath } from '../../../konnect/transform';
import { useWorkspaceLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { useTabNavigate } from '../../hooks/use-insomnia-tab';
import { Icon } from '../icon';

/** Read-only catalog of the models an AI Gateway exposes, grouped by route (path). Prototype (3593AI). */
export const AiGatewayModelsPane: FC<{ models: AiGatewayModel[] }> = ({ models }) => {
  const groups = groupModelsByPath(models);
  const { organizationId } = useParams() as { organizationId: string };
  const { activeProject, activeWorkspace } = useWorkspaceLoaderData()!;
  const tabNavigate = useTabNavigate();
  const openRunner = () =>
    tabNavigate(
      { organization: organizationId, project: activeProject, workspace: activeWorkspace, item: activeWorkspace },
      { shouldNavigate: true, asRunner: true },
    );

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">AI Gateway models</h2>
          <p className="text-sm text-(--hl)">
            {models.length} {models.length === 1 ? 'model' : 'models'} on {groups.length}{' '}
            {groups.length === 1 ? 'route' : 'routes'}. Synced from Konnect; re-sync to refresh.
          </p>
        </div>
        <Button
          onPress={openRunner}
          className="flex shrink-0 items-center gap-2 rounded-sm bg-(--color-surprise) px-3 py-1.5 text-sm text-(--color-font-surprise) hover:bg-(--color-surprise)/90 focus:bg-(--color-surprise)/90"
        >
          <Icon icon="play" /> Evaluate Multiple Models
        </Button>
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
                <th className="px-3 py-1 font-normal">Model alias (request body `model`)</th>
                <th className="px-3 py-1 font-normal">Actual model</th>
                <th className="px-3 py-1 font-normal">Provider</th>
              </tr>
            </thead>
            <tbody>
              {pathModels.map(model => (
                <tr key={model.id} className={model.enabled ? '' : 'opacity-50'}>
                  <td className="px-3 py-1 font-semibold">{model.routeModelValues.join(', ') || '—'}</td>
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
