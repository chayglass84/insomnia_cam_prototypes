import type { AiGatewayModel, Request } from 'insomnia-data';
import type { FC } from 'react';
import { Button } from 'react-aria-components';

import { applyAiGatewayModelOverride, findSelectedAiGatewayModel, groupModelsByPath } from '../../../konnect/transform';
import { useRequestPatcher } from '../../hooks/use-request';
import { Dropdown, DropdownItem, DropdownSection, ItemContent } from '../base/dropdown';
import { Icon } from '../icon';

/**
 * Prototype (3593AI): picks the gateway model a prompt request talks to, from the catalog, instead of typing a URL.
 * Choosing one rewrites the request's route path and body `model` (the prompt text is untouched) and saves it.
 */
export const AiGatewayPromptModelPicker: FC<{ request: Request; catalog: AiGatewayModel[] }> = ({
  request,
  catalog,
}) => {
  const patchRequest = useRequestPatcher();
  const selected = findSelectedAiGatewayModel(request, catalog);
  const enabledModels = catalog.filter(model => model.enabled && model.paths[0] && model.routeModelValues[0]);
  const groups = groupModelsByPath(enabledModels);

  const choose = (modelId: string) => {
    const target = catalog.find(model => model.id === modelId);
    if (!target || target.id === selected?.id) {
      return;
    }
    const override = applyAiGatewayModelOverride(request, target, catalog, { keepStreaming: true });
    if ('skipReason' in override) {
      return;
    }
    patchRequest(request._id, { url: override.url, body: { ...request.body, text: override.bodyText } });
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-[12px]/[100%]">
      <Dropdown
        aria-label="Gateway model"
        placement="bottom start"
        triggerButton={
          <Button
            aria-label="Gateway model"
            className="flex min-w-56 items-center justify-between gap-2 rounded-sm border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1 text-[12px]/[100%] text-(--color-font) hover:bg-(--hl-xs)"
          >
            <Icon icon="robot" />
            <span className="flex min-w-0 flex-1 items-baseline gap-2 truncate text-left">
              {selected ? (
                <>
                  <span className="font-semibold">{selected.routeModelValues.join(', ')}</span>
                  <span className="truncate text-(--hl)">{selected.targetModel}</span>
                </>
              ) : (
                'Choose a model'
              )}
            </span>
            <i className="fa fa-caret-down" />
          </Button>
        }
      >
        <DropdownSection>
          {groups.flatMap(([path, models]) =>
            models.map(model => (
              <DropdownItem key={model.id} textValue={`${model.routeModelValues[0]} ${model.targetModel}`}>
                <ItemContent isSelected={model.id === selected?.id} onClick={() => choose(model.id)}>
                  <span className="font-semibold">{model.routeModelValues.join(', ')}</span>
                  <span className="pl-2 text-(--hl)">{model.targetModel}</span>
                  <span className="ml-auto pl-6 font-mono text-(--hl)">{path}</span>
                </ItemContent>
              </DropdownItem>
            )),
          )}
        </DropdownSection>
      </Dropdown>
      {!selected && <span className="text-(--hl)">This request doesn't point at a catalog model yet.</span>}
    </div>
  );
};

export type AiGatewayPromptTarget = 'model' | 'url';

const TARGET_OPTIONS = [
  { id: 'model', label: 'Pick model' },
  { id: 'url', label: 'Enter URL' },
] as const;

/** "Pick model" / "Enter URL" dropdown for a prompt request's target, built like the HTTP verb dropdown beside it. */
export const AiGatewayPromptTargetToggle: FC<{
  value: AiGatewayPromptTarget;
  onChange: (value: AiGatewayPromptTarget) => void;
}> = ({ value, onChange }) => (
  <div className="flex shrink-0 items-stretch p-1">
    <Dropdown
      aria-label="Request target"
      placement="bottom start"
      className="self-stretch"
      triggerButton={
        <Button
          aria-label="Request target"
          className="flex items-center gap-1 self-stretch rounded-sm border border-solid border-(--hl-sm) px-2 py-1 text-center text-[12px]/[100%] whitespace-nowrap text-(--color-font) hover:bg-(--hl-xs)"
        >
          <span>{TARGET_OPTIONS.find(option => option.id === value)?.label}</span>
          <i className="fa fa-caret-down" />
        </Button>
      }
    >
      <DropdownSection>
        {TARGET_OPTIONS.map(option => (
          <DropdownItem key={option.id} textValue={option.label}>
            <ItemContent label={option.label} isSelected={option.id === value} onClick={() => onChange(option.id)} />
          </DropdownItem>
        ))}
      </DropdownSection>
    </Dropdown>
  </div>
);
