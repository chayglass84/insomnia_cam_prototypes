import type { AiGatewayModel, Request } from 'insomnia-data';
import { models as dataModels } from 'insomnia-data';
import type { FC } from 'react';
import { Button } from 'react-aria-components';
import { useParams } from 'react-router';

import { formatUsdPerMillion } from '../../../common/llm-cost';
import { findCatalogModelsByPath, groupModelsByPath, isRotatingModel, modelTargets } from '../../../konnect/transform';
import { useWorkspaceLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { useTabNavigate } from '../../hooks/use-insomnia-tab';
import { Icon } from '../icon';

/** `$5.00 / $25.00` per 1M tokens, or an em dash when Konnect has no price for the model. */
const formatPricePerMillion = (price: Pick<AiGatewayModel, 'inputPerToken' | 'outputPerToken'>) =>
  price.inputPerToken === undefined || price.outputPerToken === undefined
    ? '—'
    : `${formatUsdPerMillion(price.inputPerToken)} / ${formatUsdPerMillion(price.outputPerToken)}`;

/** Read-only catalog of the models an AI Gateway exposes, grouped by route (path). Prototype (3593AI). */
export const AiGatewayModelsPane: FC<{ models: AiGatewayModel[] }> = ({ models }) => {
  const groups = groupModelsByPath(models);
  const { organizationId } = useParams() as { organizationId: string };
  const { activeProject, activeWorkspace, collection } = useWorkspaceLoaderData()!;
  const tabNavigate = useTabNavigate();
  const openRunner = () =>
    tabNavigate(
      { organization: organizationId, project: activeProject, workspace: activeWorkspace, item: activeWorkspace },
      { shouldNavigate: true, asRunner: true },
    );

  // A request belongs to a route when its URL path resolves to that route's models (same rule the Policies tab uses).
  const requestsByRoute = new Map<string, Request[]>();
  for (const { doc } of collection) {
    if (!dataModels.request.isRequest(doc)) {
      continue;
    }
    for (const path of new Set(findCatalogModelsByPath(doc.url, models).flatMap(model => model.paths))) {
      if (groups.some(([groupPath]) => groupPath === path) && doc.url.includes(path)) {
        requestsByRoute.set(path, [...(requestsByRoute.get(path) ?? []), doc]);
      }
    }
  }
  const openRequest = (request: Request) =>
    tabNavigate(
      { organization: organizationId, project: activeProject, workspace: activeWorkspace, item: request },
      { shouldNavigate: true },
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
            {(requestsByRoute.get(path) ?? []).map(request => (
              <span key={request._id} title={request.name || 'Untitled request'}>
                <Button
                  onPress={() => openRequest(request)}
                  aria-label={`Try ${request.name || 'Untitled request'}`}
                  className="rounded-sm border border-solid border-(--hl-md) bg-(--hl-xs) px-2 py-0.5 text-xs font-medium text-(--color-font) hover:bg-(--hl-sm) focus:bg-(--hl-sm)"
                >
                  Try now →
                </Button>
              </span>
            ))}
            <span className="ml-auto text-xs text-(--hl)">
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
              {pathModels.flatMap(model =>
                // A rotating alias gets one row per upstream model; the alias only labels the first.
                modelTargets(model).map((target, index) => (
                  <tr key={`${model.id}-${target.name}`} className={model.enabled ? '' : 'opacity-50'}>
                    <td className="px-3 py-1 font-semibold break-words">
                      {index === 0 && (
                        <>
                          {model.routeModelValues.join(', ') || '—'}
                          {isRotatingModel(model) && (
                            <span
                              className="ml-2 rounded-sm bg-(--hl-md) px-1.5 text-xs font-normal"
                              title="The gateway picks one of these upstream models per request."
                            >
                              rotating
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-1 font-mono break-all">{target.name}</td>
                    <td className="px-3 py-1">{target.provider}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{formatPricePerMillion(target)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
};
