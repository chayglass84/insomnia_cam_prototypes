import React, { type FC, useRef } from 'react';
import { Button, ComboBox, Group, Input, ListBox, ListBoxItem, Popover } from 'react-aria-components';

import { Icon } from '~/ui/components/icon';

import { computeCostUsd, formatUsd } from '../../../common/llm-cost';
import { findCatalogModelByRequest, getAiGatewayModelSuggestions } from '../../../konnect/transform';
import { useWorkspaceLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { useRequestLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.request.$requestId';

export interface ChatSettingsValues {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

type ChatSettingsBarFormat = 'openai' | 'anthropic' | 'gemini';

// Suggestions only, not an enforced enum — new models ship constantly and a self-hosted or
// gateway-fronted model (e.g. via Kong AI Gateway) may use a name that'll never appear in any
// fixed list, so the combobox below always allows typing a custom value too.
const MODEL_SUGGESTIONS: Record<ChatSettingsBarFormat, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
};

interface Props {
  // Remounts the bar's uncontrolled fields when the underlying request/response changes —
  // same "uncontrolled + key" pattern used elsewhere in this codebase (e.g. the stream-summary
  // JSONPath field) so a round trip through patching the request doesn't clobber mid-edit typing.
  requestKey: string;
  format: ChatSettingsBarFormat;
  values: ChatSettingsValues;
  // Omit for a plain read-only summary (no editing, no pending-change warning) — used where there's
  // no obvious "apply this" action to wire up to yet (the one-shot non-streaming response pane).
  onApply?: (next: ChatSettingsValues) => void;
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
  isStreaming?: boolean;
  pendingNotice?: { message: string; actionLabel: string; onAction: () => void } | null;
}

const fieldClassName =
  'rounded-xs border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1 text-xs text-(--color-font) outline-hidden focus:border-(--hl)';

export const ChatSettingsBar: FC<Props> = ({
  requestKey,
  format,
  values,
  onApply,
  usage,
  stopReason,
  isStreaming,
  pendingNotice,
}) => {
  // Gemini nests sampling params under a differently-shaped `generationConfig` object, which
  // neither this bar nor chat-request.ts's sampling-param helpers handle — hide rather than edit
  // a field that would silently write to the wrong place.
  const supportsSamplingParams = format !== 'gemini';

  // In a synced AI Gateway workspace, suggest the `model` values the request's route actually matches on
  // (e.g. `opus`) instead of the generic provider model names, which the gateway would 404 on.
  const gatewayModels = useWorkspaceLoaderData()?.activeWorkspace.konnectAiGatewayModels;
  const requestUrl = useRequestLoaderData()?.activeRequest?.url;
  // Konnect's per-token price for the model this request targets (gateway workspaces only).
  const pricedModel =
    gatewayModels && requestUrl ? findCatalogModelByRequest(requestUrl, values.model, gatewayModels) : undefined;
  const costUsd = computeCostUsd(pricedModel, usage);
  const modelSuggestions =
    (gatewayModels && requestUrl ? getAiGatewayModelSuggestions(requestUrl, gatewayModels) : null) ??
    MODEL_SUGGESTIONS[format];

  const modelRef = useRef<HTMLInputElement>(null);
  const systemRef = useRef<HTMLTextAreaElement>(null);
  const temperatureRef = useRef<HTMLInputElement>(null);
  const maxTokensRef = useRef<HTMLInputElement>(null);

  // Takes an optional `model` override for the one path where reading `modelRef.current.value`
  // directly would race React's own (batched, asynchronous) update of the combobox's displayed
  // text: selecting a suggestion from the dropdown rather than typing and blurring.
  const commit = (overrides?: { model?: string }) => {
    if (!onApply) {
      return;
    }
    onApply({
      model: overrides && 'model' in overrides ? overrides.model : modelRef.current?.value.trim() || undefined,
      systemPrompt: systemRef.current?.value.trim() || undefined,
      temperature:
        temperatureRef.current?.value && !Number.isNaN(Number(temperatureRef.current.value))
          ? Number(temperatureRef.current.value)
          : undefined,
      maxTokens:
        maxTokensRef.current?.value && !Number.isNaN(Number(maxTokensRef.current.value))
          ? Number(maxTokensRef.current.value)
          : undefined,
    });
  };

  const commitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      (event.target as HTMLElement).blur();
    }
  };

  const totalTokens =
    usage?.inputTokens !== undefined && usage?.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined;

  if (!onApply) {
    if (!values.model && !values.systemPrompt && !usage && !stopReason && !isStreaming) {
      return null;
    }
    return (
      <div
        key={requestKey}
        className="flex shrink-0 flex-col gap-1 border-b border-solid border-(--hl-md) bg-(--hl-xs) px-3 py-1.5 text-xs text-(--hl)"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {isStreaming && (
            <span className="flex items-center gap-1 text-(--color-font)">
              <Icon icon="spinner" className="animate-spin" />
              Streaming…
            </span>
          )}
          {values.model && (
            <span className="flex items-center gap-1">
              <Icon icon="robot" />
              {values.model}
            </span>
          )}
          {usage && (
            <span className="flex items-center gap-1">
              <Icon icon="coins" />
              {usage.inputTokens ?? '?'} in / {usage.outputTokens ?? '?'} out
              {totalTokens !== undefined && <span className="text-(--hl)">({totalTokens} total)</span>}
              {costUsd !== null && <span className="font-semibold text-(--color-font)">{formatUsd(costUsd)}</span>}
            </span>
          )}
          {stopReason && (
            <span className="flex items-center gap-1">
              <Icon icon="stop" />
              {stopReason}
            </span>
          )}
        </div>
        {values.systemPrompt && (
          <div className="flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">System prompt:</span>
            <span className="truncate text-(--color-font) italic" title={values.systemPrompt}>
              {values.systemPrompt}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      key={requestKey}
      className="flex shrink-0 flex-col gap-1.5 border-b border-solid border-(--hl-md) bg-(--hl-xs) px-3 py-2 text-xs text-(--hl)"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <ComboBox
          aria-label="Model"
          allowsCustomValue
          defaultInputValue={values.model ?? ''}
          defaultItems={modelSuggestions.map(model => ({ id: model }))}
          onSelectionChange={key => commit({ model: key ? String(key) : undefined })}
          menuTrigger="focus"
        >
          <Group className="flex w-44 items-center gap-1 rounded-xs border border-solid border-(--hl-sm) bg-(--color-bg) pl-2 text-(--color-font) focus-within:border-(--hl)">
            <Icon icon="robot" />
            <Input
              ref={modelRef}
              onBlur={() => commit()}
              onKeyDown={commitOnEnter}
              placeholder="model"
              className="w-full bg-transparent py-1 outline-hidden"
            />
            <Button className="flex items-center px-1 py-1">
              <Icon icon="caret-down" />
            </Button>
          </Group>
          <Popover className="w-(--trigger-width)">
            <ListBox
              className="max-h-60 overflow-y-auto rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) py-1 text-xs shadow-lg select-none focus:outline-hidden"
              aria-label="Suggested models"
            >
              {(item: { id: string }) => (
                <ListBoxItem
                  id={item.id}
                  textValue={item.id}
                  className="flex h-(--line-height-xs) w-full items-center px-(--padding-md) whitespace-nowrap text-(--color-font) transition-colors hover:bg-(--hl-sm) focus:bg-(--hl-xs) focus:outline-hidden aria-selected:font-bold data-focused:bg-(--hl-xs)"
                >
                  {item.id}
                </ListBoxItem>
              )}
            </ListBox>
          </Popover>
        </ComboBox>
        {usage && (
          <span className="flex items-center gap-1">
            <Icon icon="coins" />
            {usage.inputTokens ?? '?'} in / {usage.outputTokens ?? '?'} out
            {totalTokens !== undefined && <span className="text-(--hl)">({totalTokens} total)</span>}
            {costUsd !== null && <span className="font-semibold text-(--color-font)">{formatUsd(costUsd)}</span>}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {isStreaming && (
          <span className="flex items-center gap-1 text-(--color-font)">
            <Icon icon="spinner" className="animate-spin" />
            Streaming…
          </span>
        )}
        {supportsSamplingParams && (
          <>
            <label className="flex items-center gap-1">
              <span>Temp</span>
              <input
                ref={temperatureRef}
                defaultValue={values.temperature ?? ''}
                onBlur={() => commit()}
                onKeyDown={commitOnEnter}
                type="number"
                step="0.1"
                min="0"
                max="2"
                placeholder="0.0–2.0"
                aria-label="Temperature"
                className={`${fieldClassName} w-16`}
              />
            </label>
            <label className="flex items-center gap-1">
              <span>Max tokens</span>
              <input
                ref={maxTokensRef}
                defaultValue={values.maxTokens ?? ''}
                onBlur={() => commit()}
                onKeyDown={commitOnEnter}
                type="number"
                step="1"
                min="1"
                placeholder="default"
                aria-label="Max tokens"
                className={`${fieldClassName} w-24`}
              />
            </label>
          </>
        )}
        {stopReason && (
          <span className="flex items-center gap-1">
            <span>Stop</span>
            <span className="text-(--color-font)">{stopReason}</span>
          </span>
        )}
      </div>
      <label className="flex flex-col gap-1">
        <span>System prompt</span>
        <textarea
          ref={systemRef}
          defaultValue={values.systemPrompt ?? ''}
          onBlur={() => commit()}
          placeholder="None set…"
          rows={1}
          className={`${fieldClassName} w-full resize-y italic`}
        />
      </label>
      {pendingNotice && (
        <div className="flex items-center justify-between gap-2 rounded-xs border border-solid border-(--color-warning) bg-(--color-bg) px-2 py-1 text-(--color-font)">
          <span className="flex items-center gap-1">
            <Icon icon="triangle-exclamation" className="text-(--color-warning)" />
            {pendingNotice.message}
          </span>
          <Button
            onPress={pendingNotice.onAction}
            className="shrink-0 rounded-xs border border-solid border-(--hl-sm) px-2 py-0.5 hover:bg-(--hl-sm)"
          >
            {pendingNotice.actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
};
