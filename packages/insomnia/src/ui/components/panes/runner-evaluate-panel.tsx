import type { AiGatewayModel } from 'insomnia-data';
import React, { type FC } from 'react';
import { Button } from 'react-aria-components';

import type { RequestRow } from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.runner';

import { Tooltip } from '../tooltip';
import { RunnerModelsPanel } from './runner-models-panel';

interface Props {
  requests: RequestRow[];
  selectedRequestIds: string[];
  onRequestsChange: (ids: string[]) => void;
  models: AiGatewayModel[];
  /** null means every model is selected. */
  selectedModelIds: string[] | null;
  onModelsChange: (ids: string[]) => void;
  disabled?: boolean;
}

const linkButton = 'rounded-xs px-1 text-xs text-(--hl) underline hover:text-(--color-font) disabled:opacity-50';

const SectionHeader: FC<{
  title: string;
  selected: number;
  total: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  disabled?: boolean;
}> = ({ title, selected, total, onSelectAll, onDeselectAll, disabled }) => (
  <div className="flex items-baseline gap-3">
    <h3 className="text-sm font-bold text-(--hl) uppercase">{title}</h3>
    <span className="text-xs text-(--hl)">
      {selected} of {total} selected
    </span>
    <span className="ml-auto flex gap-2">
      <Button className={linkButton} isDisabled={disabled || selected === total} onPress={onSelectAll}>
        Select all
      </Button>
      <Button className={linkButton} isDisabled={disabled || selected === 0} onPress={onDeselectAll}>
        Deselect all
      </Button>
    </span>
  </div>
);

/**
 * Runner tab for synced AI Gateway collections: pick the requests (prompts) and the models, and the runner runs every
 * selected request against every selected model. Prototype (3593AI).
 */
export const RunnerEvaluatePanel: FC<Props> = ({
  requests,
  selectedRequestIds,
  onRequestsChange,
  models,
  selectedModelIds,
  onModelsChange,
  disabled,
}) => {
  const requestIds = requests.map(request => request.id);
  // Grouped by where they live (collection, then folders), keeping the collection's own order within a folder.
  const folderPath = (request: RequestRow) => request.ancestors.map(ancestor => ancestor.name).join('\u0000');
  const sortedRequests = requests
    .map((request, index) => ({ request, index }))
    .sort((a, b) => folderPath(a.request).localeCompare(folderPath(b.request)) || a.index - b.index)
    .map(({ request }) => request);
  const selectedRequests = new Set(selectedRequestIds);
  const modelCount = selectedModelIds
    ? models.filter(model => selectedModelIds.includes(model.id)).length
    : models.length;
  const requestCount = requests.filter(request => selectedRequests.has(request.id)).length;

  const toggleRequest = (id: string) =>
    onRequestsChange(requestIds.filter(requestId => (requestId === id) !== selectedRequests.has(requestId)));

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-4 text-sm">
      <p className="text-(--hl)">
        Pick the requests (prompts) to run and the models to run them against. Every selected request runs once on every
        selected model, so choose requests with different prompts. A rotating alias appears once; the gateway chooses
        which upstream model answers.
      </p>

      <section className="flex flex-col gap-2">
        <SectionHeader
          title="Requests"
          selected={requestCount}
          total={requests.length}
          onSelectAll={() => onRequestsChange(requestIds)}
          onDeselectAll={() => onRequestsChange([])}
          disabled={disabled}
        />
        <div className="flex flex-col gap-2 pl-4">
          {requests.length === 0 && <span className="text-(--hl)">This collection has no requests.</span>}
          {sortedRequests.map(request => {
            const [collection, ...folders] = request.ancestors;
            const row = (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selectedRequests.has(request.id)}
                  onChange={() => toggleRequest(request.id)}
                />
                <span className={`text-xs uppercase http-method-${request.method}`}>{request.method}</span>
                <span className="font-semibold">{request.name}</span>
              </label>
            );
            // Where the request lives is a hover detail, one labelled line per level, so names containing slashes
            // (routes) don't clutter the row.
            return collection ? (
              <Tooltip
                key={request.id}
                followCursor
                message={
                  <div className="flex flex-col gap-0.5 text-left">
                    <span>
                      <strong>Collection:</strong> {collection.name}
                    </span>
                    {folders.map(folder => (
                      <span key={folder.id}>
                        <strong>Folder:</strong> {folder.name}
                      </span>
                    ))}
                  </div>
                }
              >
                {row}
              </Tooltip>
            ) : (
              <React.Fragment key={request.id}>{row}</React.Fragment>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeader
          title="Models"
          selected={modelCount}
          total={models.length}
          onSelectAll={() => onModelsChange(models.map(model => model.id))}
          onDeselectAll={() => onModelsChange([])}
          disabled={disabled}
        />
        <div className="pl-4">
          <RunnerModelsPanel
            models={models}
            selectedIds={selectedModelIds}
            onChange={onModelsChange}
            disabled={disabled}
          />
        </div>
      </section>
    </div>
  );
};
