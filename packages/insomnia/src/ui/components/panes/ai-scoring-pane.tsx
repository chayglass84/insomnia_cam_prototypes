import { services } from 'insomnia-data';
import { type FC, useState } from 'react';
import { Button, Label, TextArea, TextField } from 'react-aria-components';
import { useRevalidator } from 'react-router';

import { DEFAULT_SCORING_SCRIPT } from '../../../common/ai-scoring';
import { useWorkspaceLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';

/**
 * The collection's Model Scoring script: runs once at the end of every Model Evaluator run over the per-model totals and
 * returns a score for each model. Prototype (3593AI): a plain text area, not the code editor (which is uncontrolled and
 * needs remounting to refresh), saved on blur.
 */
export const AiScoringPane: FC = () => {
  const { activeWorkspace } = useWorkspaceLoaderData()!;
  const { revalidate } = useRevalidator();
  const saved = activeWorkspace.aiScoring?.script;
  // Local state so typing is never interrupted by a re-render; the loader only refreshes after revalidation.
  const [script, setScript] = useState(saved ?? DEFAULT_SCORING_SCRIPT);

  const save = async (next?: string) => {
    await services.workspace.update(activeWorkspace, { aiScoring: next === undefined ? {} : { script: next } });
    revalidate();
  };

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold">Model scoring</h2>
        <p className="text-sm text-(--hl)">
          This script runs once at the end of every Model Evaluator run and gives each model a score from 0 to 1. The
          results table is ranked by it. Scores are saved with the run, so changing the script only affects future runs.
          If it fails, the run still finishes and the table falls back to the default ranking, with the error shown.
        </p>
      </div>

      <TextField
        value={script}
        onChange={setScript}
        onBlur={() => script !== (saved ?? DEFAULT_SCORING_SCRIPT) && save(script)}
        className="flex max-w-4xl flex-col gap-2"
      >
        <div className="flex items-baseline justify-between">
          <Label className="text-sm font-bold">Script</Label>
          <Button
            isDisabled={script === DEFAULT_SCORING_SCRIPT}
            onPress={() => {
              setScript(DEFAULT_SCORING_SCRIPT);
              save();
            }}
            className="rounded-xs px-1 text-xs text-(--hl) underline hover:text-(--color-font) disabled:opacity-50"
          >
            Reset to default
          </Button>
        </div>
        <TextArea
          rows={26}
          spellCheck={false}
          className="w-full rounded-xs border border-solid border-(--hl-sm) bg-(--color-bg) px-2 py-1 font-mono text-xs text-(--color-font) transition-colors focus:ring-1 focus:ring-(--hl-md) focus:outline-hidden"
        />
        <p className="text-xs text-(--hl)">
          Plain JavaScript with the usual script sandbox. <code>models</code> is the input and the script must{' '}
          <code>return</code> an array of <code>{'{ id, score, note? }'}</code>. A model you leave out has no score and
          ranks last.
        </p>
      </TextField>
    </div>
  );
};
