import { models, services } from 'insomnia-data';
import { type FC, Fragment, useState } from 'react';
import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  TextArea,
  TextField,
} from 'react-aria-components';
import { useRevalidator } from 'react-router';

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
  const [requestId, setRequestId] = useState(settings.requestId);
  const [system, setSystem] = useState(settings.system ?? DEFAULT_JUDGE_INSTRUCTIONS);

  const docsById = new Map(collection.map(item => [item.doc._id, item.doc]));
  const requests = collection
    .filter(item => models.request.isRequest(item.doc))
    .map(item => {
      const folder = docsById.get(item.doc.parentId);
      const folderName = folder && models.requestGroup.isRequestGroup(folder) ? folder.name : null;
      return {
        id: item.doc._id,
        label: folderName ? `${item.doc.name} (Folder: ${folderName})` : item.doc.name,
        url: 'url' in item.doc ? item.doc.url : '',
      };
    });
  const selected = requests.find(request => request.id === requestId);

  const save = async (next: { requestId?: string; system?: string }) => {
    await services.workspace.update(activeWorkspace, { aiJudge: { requestId, system, ...next } });
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

      <Select
        aria-label="Judge request"
        selectedKey={requestId ?? null}
        onSelectionChange={key => {
          setRequestId(key as string);
          save({ requestId: key as string });
        }}
        className="flex max-w-xl flex-col gap-2"
      >
        <Label className="text-sm font-bold">Judge request</Label>
        <Button className="flex w-full items-center justify-between gap-2 rounded-xs border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1 text-(--color-font) ring-1 ring-transparent transition-colors hover:bg-(--hl-xs) focus:ring-1 focus:ring-(--hl-md) focus:outline-hidden focus:ring-inset aria-pressed:bg-(--hl-sm)">
          <SelectValue className="truncate">{selected ? selected.label : 'Choose a request…'}</SelectValue>
          <Icon icon="caret-down" />
        </Button>
        <Popover className="isolate flex w-(--trigger-width) min-w-max flex-col overflow-hidden rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) text-sm shadow-lg select-none">
          <ListBox items={requests} className="max-h-80 min-w-max overflow-y-auto py-2 focus:outline-hidden">
            {request => (
              <ListBoxItem
                id={request.id}
                key={request.id}
                textValue={request.label}
                className="flex h-(--line-height-xs) w-full items-center gap-2 bg-transparent px-(--padding-md) whitespace-nowrap text-(--color-font) transition-colors hover:bg-(--hl-sm) focus:bg-(--hl-xs) focus:outline-hidden aria-selected:font-bold"
              >
                {({ isSelected }) => (
                  <Fragment>
                    <span>{request.label}</span>
                    {isSelected && <Icon icon="check" className="justify-self-end text-(--color-success)" />}
                  </Fragment>
                )}
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
        <p className="text-xs text-(--hl)">
          {selected
            ? `Sends to ${selected.url}. Its model and settings are used; its messages are replaced and streaming is turned off. It is left out of model comparison runs.`
            : 'Its URL, headers and model are used. Its messages are replaced and streaming is turned off.'}
        </p>
      </Select>

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
