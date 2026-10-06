import type { AiGatewayModel } from 'insomnia-data';
import type { FC } from 'react';
import { Button } from 'react-aria-components';
import { useParams } from 'react-router';

import { formatUsdPerMillion } from '../../../common/llm-cost';
import { groupModelsByPath } from '../../../konnect/transform';
import { useWorkspaceLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { useTabNavigate } from '../../hooks/use-insomnia-tab';
import { Icon } from '../icon';

/** `$5.00 / $25.00` per 1M tokens, or an em dash when Konnect has no price for the model. */
const formatPricePerMillion = (model: AiGatewayModel) =>
  model.inputPerToken === undefined || model.outputPerToken === undefined
    ? '—'
    : `${formatUsdPerMillion(model.inputPerToken)} / ${formatUsdPerMillion(model.outputPerToken)}`;

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
          <table className="w-full table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[20%]" />
              <col className="w-[32%]" />
              <col className="w-[16%]" />
              <col className="w-[32%]" />
            </colgroup>
            <thead className="text-xs text-(--hl)">
              <tr>
                <th className="px-3 py-1 font-normal">Model alias</th>
                <th className="px-3 py-1 font-normal">Actual model</th>
                <th className="px-3 py-1 font-normal">Provider</th>
                <th className="px-3 py-1 text-right font-normal">Price per 1M tokens (in / out)</th>
              </tr>
            </thead>
            <tbody>
              {pathModels.map(model => (
                <tr key={model.id} className={model.enabled ? '' : 'opacity-50'}>
                  <td className="px-3 py-1 font-semibold break-words">{model.routeModelValues.join(', ') || '—'}</td>
                  <td className="px-3 py-1 font-mono break-all">{model.targetModel}</td>
                  <td className="px-3 py-1">{model.provider}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{formatPricePerMillion(model)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
};
