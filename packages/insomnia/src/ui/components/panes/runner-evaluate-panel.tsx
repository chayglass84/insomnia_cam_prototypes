import type { AiGatewayModel } from 'insomnia-data';
import type { FC } from 'react';
import { Button } from 'react-aria-components';

import type { RequestRow } from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.runner';

import { RunnerModelsPanel } from './runner-models-panel';

interface Props {
  requests: RequestRow[];
  selectedRequestIds: string[];
  onRequestsChange: (ids: string[]) => void;
  models: AiGatewayModel[];
  /** null means every model is selected. */
  selectedModelIds: string[] | null;
  onModelsChange: (ids: string[]) => void;
  iterations: number;
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
    <h3 className="text-xs font-bold text-(--hl) uppercase">{title}</h3>
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
  iterations,
  disabled,
}) => {
  const requestIds = requests.map(request => request.id);
  const selectedRequests = new Set(selectedRequestIds);
  const modelCount = selectedModelIds
    ? models.filter(model => selectedModelIds.includes(model.id)).length
    : models.length;
  const requestCount = requests.filter(request => selectedRequests.has(request.id)).length;
  const runs = requestCount * modelCount * iterations;

  const toggleRequest = (id: string) =>
    onRequestsChange(requestIds.filter(requestId => (requestId === id) !== selectedRequests.has(requestId)));

  return (
    <div className="flex flex-col gap-5 overflow-y-auto p-4 text-sm">
      <div className="flex flex-col gap-1">
        <p className="text-(--hl)">
          Pick the requests (prompts) to run and the models to run them against. Every selected request runs once on
          every selected model, so choose requests with different prompts. A rotating alias appears once; the gateway
          chooses which upstream model answers.
        </p>
        <p data-testid="runner-run-count">
          {requestCount === 0 ? (
            <span className="font-semibold text-(--color-warning)">Pick at least one request to run.</span>
          ) : modelCount === 0 ? (
            <span className="font-semibold text-(--color-warning)">Pick at least one model.</span>
          ) : (
            <>
              <strong>{runs}</strong> {runs === 1 ? 'run' : 'runs'}
              <span className="text-(--hl)">
                {' '}
                = {requestCount} {requestCount === 1 ? 'request' : 'requests'} × {modelCount}{' '}
                {modelCount === 1 ? 'model' : 'models'}
                {iterations > 1 ? ` × ${iterations} iterations` : ''}
              </span>
            </>
          )}
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <SectionHeader
          title="Requests"
          selected={requestCount}
          total={requests.length}
          onSelectAll={() => onRequestsChange(requestIds)}
          onDeselectAll={() => onRequestsChange([])}
          disabled={disabled}
        />
        {requests.length === 0 && <span className="text-(--hl)">This collection has no requests.</span>}
        {requests.map(request => (
          <label key={request.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={disabled}
              checked={selectedRequests.has(request.id)}
              onChange={() => toggleRequest(request.id)}
            />
            <span className={`text-xs uppercase http-method-${request.method}`}>{request.method}</span>
            <span className="font-semibold">{request.name}</span>
            {request.ancestors.length > 0 && (
              <span className="text-xs text-(--hl)">
                {request.ancestors.map(ancestor => ancestor.name).join(' / ')}
              </span>
            )}
          </label>
        ))}
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
        <RunnerModelsPanel
          models={models}
          selectedIds={selectedModelIds}
          onChange={onModelsChange}
          disabled={disabled}
        />
      </section>
    </div>
  );
};
