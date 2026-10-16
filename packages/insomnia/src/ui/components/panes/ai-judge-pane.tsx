import { services } from 'insomnia-data';
import { type FC, Fragment, useState } from 'react';
import {
  Button,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  NumberField,
  Popover,
  Select,
  SelectValue,
  TextArea,
  TextField,
} from 'react-aria-components';
import { useRevalidator } from 'react-router';

import { MAX_JUDGE_RUNS } from '../../../../../insomnia-scripting-environment/src/objects/judge';
import { DEFAULT_JUDGE_INSTRUCTIONS } from '../../../common/ai-judge';
import { useWorkspaceLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { Icon } from '../icon';

/**
 * Collection-wide settings for `insomnia.judge()` in scripts: which request is the judge, and extra instructions for it.
 * Prototype (3593AI). The judge request supplies the URL, headers and body template (model and params); the helper
 * replaces its messages and turns streaming off, so it can be any chat request in the collection.
 */
export const AiJudgePane: FC = () => {
  const { activeWorkspace, collection } = useWorkspaceLoaderData()!;
  const { revalidate } = useRevalidator();
  const settings = activeWorkspace.aiJudge ?? {};
  // Both values live in local state: the workspace loader only refreshes after revalidation, so reading the saved
  // values back would show stale picks (and a later save would overwrite the earlier one). Text is saved on blur so
  // typing is never interrupted by a re-render.
  const [modelId, setModelId] = useState(settings.modelId);
  // Older setting (a request as the judge). Kept working until a model is chosen, which replaces it.
  const [legacyRequestId, setLegacyRequestId] = useState(settings.requestId);
  const [system, setSystem] = useState(settings.system ?? DEFAULT_JUDGE_INSTRUCTIONS);
  const [runs, setRuns] = useState(settings.runs ?? 1);

  const catalogModels = (activeWorkspace.konnectAiGatewayModels ?? [])
    .filter(model => model.enabled && model.paths[0] && model.routeModelValues[0])
    .map(model => ({
      id: model.id,
      label: `${model.routeModelValues.join(', ')} · ${model.targetModel}`,
      path: model.paths[0],
    }));
  const selected = catalogModels.find(model => model.id === modelId);
  const legacyRequest = collection.find(item => item.doc._id === legacyRequestId)?.doc;

  const save = async (next: { modelId?: string; requestId?: string; system?: string; runs?: number }) => {
    await services.workspace.update(activeWorkspace, {
      aiJudge: { modelId, requestId: legacyRequestId, system, runs, ...next },
    });
    revalidate();
  };

  return (
    <div className="flex h-full w-full flex-col gap-5 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold">Judge</h2>
        <p className="text-sm text-(--hl)">
          Used by <code>insomnia.judge(criteria)</code> in scripts. The judge grades a response against your criteria
          using a second model; pick a different model than the ones you are comparing, or it will mark its own
          homework.
        </p>
      </div>

      <div className="flex max-w-xl flex-col gap-1 text-sm">
        <h3 className="text-sm font-bold">What the judge sees</h3>
        <ul className="list-disc pl-5 text-(--hl)">
          <li>Your criteria</li>
          <li>The answer: the model's reply</li>
          <li>The question: the last user message of the request</li>
          <li>The instructions the model was given: the request's system prompt, including any skills added to it</li>
          <li>The extra instructions below</li>
        </ul>
        <p className="text-xs text-(--hl)">
          It does not see earlier messages in the conversation, token counts, cost, timing, or other tests' results.
        </p>
      </div>

      <Select
        aria-label="Judge model"
        selectedKey={modelId ?? null}
        onSelectionChange={key => {
          setModelId(key as string);
          setLegacyRequestId(undefined);
          save({ modelId: key as string, requestId: undefined });
        }}
        className="flex max-w-xl flex-col gap-2"
      >
        <Label className="text-sm font-bold">Judge model</Label>
        <Button className="flex w-full items-center justify-between gap-2 rounded-xs border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1 text-(--color-font) ring-1 ring-transparent transition-colors hover:bg-(--hl-xs) focus:ring-1 focus:ring-(--hl-md) focus:outline-hidden focus:ring-inset aria-pressed:bg-(--hl-sm)">
          <SelectValue className="truncate">{selected ? selected.label : 'Choose a model…'}</SelectValue>
          <Icon icon="caret-down" />
        </Button>
        <Popover className="isolate flex w-(--trigger-width) min-w-max flex-col overflow-hidden rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) text-sm shadow-lg select-none">
          <ListBox items={catalogModels} className="max-h-80 min-w-max overflow-y-auto py-2 focus:outline-hidden">
            {model => (
              <ListBoxItem
                id={model.id}
                key={model.id}
                textValue={model.label}
                className="flex h-(--line-height-xs) w-full items-center gap-2 bg-transparent px-(--padding-md) whitespace-nowrap text-(--color-font) transition-colors hover:bg-(--hl-sm) focus:bg-(--hl-xs) focus:outline-hidden aria-selected:font-bold"
              >
                {({ isSelected }) => (
                  <Fragment>
                    <span>{model.label}</span>
                    <span className="pl-4 font-mono text-(--hl)">{model.path}</span>
                    {isSelected && <Icon icon="check" className="justify-self-end text-(--color-success)" />}
                  </Fragment>
                )}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
        <p className="text-xs text-(--hl)">
          {selected
            ? `Judges through the gateway at ${selected.path}, so its calls show up as ordinary gateway traffic. Its messages are replaced by the grading prompt and streaming is turned off.`
            : 'A model from this gateway\'s catalog. Its messages are replaced by the grading prompt and streaming is turned off.'}
        </p>
        {!selected && legacyRequest && (
          <p className="text-xs text-(--hl)">
            Currently using the request "{legacyRequest.name}" (an older setting). Choose a model to replace it.
          </p>
        )}
      </Select>

      <NumberField
        aria-label="Runs per judgment"
        value={runs}
        minValue={1}
        maxValue={MAX_JUDGE_RUNS}
        step={1}
        onChange={value => {
          if (Number.isFinite(value)) {
            setRuns(value);
            save({ runs: value });
          }
        }}
        className="flex max-w-xl flex-col gap-2"
      >
        <Label className="text-sm font-bold">Runs per judgment</Label>
        <Input className="w-24 rounded-xs border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1 text-(--color-font) transition-colors focus:ring-1 focus:ring-(--hl-md) focus:outline-hidden" />
        <p className="text-xs text-(--hl)">
          Each judgment asks the judge this many times, all at once, and averages every criterion's score: a 1 and a 0.5
          make 0.75, and the results show each run. More runs smooth out a noisy judge, but they multiply the judge
          calls (and cost) per request and model. The most is {MAX_JUDGE_RUNS}.
        </p>
      </NumberField>

      <TextField
        value={system}
        onChange={setSystem}
        onBlur={() => system !== (settings.system ?? DEFAULT_JUDGE_INSTRUCTIONS) && save({ system })}
        className="flex max-w-xl flex-col gap-2"
      >
        <div className="flex items-baseline justify-between">
          <Label className="text-sm font-bold">Extra instructions</Label>
          <Button
            isDisabled={system === DEFAULT_JUDGE_INSTRUCTIONS}
            onPress={() => {
              setSystem(DEFAULT_JUDGE_INSTRUCTIONS);
              save({ system: DEFAULT_JUDGE_INSTRUCTIONS });
            }}
            className="rounded-xs px-1 text-xs text-(--hl) underline hover:text-(--color-font) disabled:opacity-50"
          >
            Reset to default
          </Button>
        </div>
        <TextArea
          rows={8}
          placeholder="Optional. Leave empty to add nothing to the built-in judge prompt."
          className="w-full rounded-xs border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1 text-(--color-font) transition-colors placeholder:italic focus:ring-1 focus:ring-(--hl-md) focus:outline-hidden"
        />
        <p className="text-xs text-(--hl)">
          Added to the built-in judge prompt, which already makes the model a grader and fixes the reply format, so
          these instructions cannot break parsing. Empty means nothing extra is added.
        </p>
      </TextField>
    </div>
  );
};
