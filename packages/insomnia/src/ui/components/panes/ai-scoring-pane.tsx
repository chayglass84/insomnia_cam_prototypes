import { services } from 'insomnia-data';
import { type FC, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { useRevalidator } from 'react-router';

import { DEFAULT_SCORING_SCRIPT } from '../../../common/ai-scoring';
import { useWorkspaceLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { CodeEditor, type CodeEditorHandle } from '../.client/codemirror/code-editor';
import { ErrorBoundary } from '../error-boundary';

// `models` is the script's input. The script runs as the body of an async function, so a top-level `return` is fine
// (JSHint agrees) and so is a top-level `await` (JSHint does not, and will flag it).
const lintOptions = {
  globals: { models: true, insomnia: true, console: true, _: true, require: true },
  asi: true,
  undef: true,
  node: true,
  esversion: 11,
};

/**
 * The collection's Model Scoring script: runs once at the end of every Model Evaluator run over the per-model totals and
 * returns a score for each model. Prototype (3593AI). The code editor is uncontrolled (it only reads `defaultValue` when
 * it mounts), so the current text lives in the editor and is saved from its debounced `onChange`.
 */
export const AiScoringPane: FC = () => {
  const { activeWorkspace } = useWorkspaceLoaderData()!;
  const { revalidate } = useRevalidator();
  const editorRef = useRef<CodeEditorHandle>(null);
  const initial = activeWorkspace.aiScoring?.script ?? DEFAULT_SCORING_SCRIPT;
  const [isDefault, setIsDefault] = useState(initial === DEFAULT_SCORING_SCRIPT);

  // Saving the default text clears the setting instead, so a later improvement to the default still reaches this
  // collection. Re-read the workspace first: the loader's copy may be older than a save made a moment ago.
  const save = async (script: string) => {
    const fresh = (await services.workspace.getById(activeWorkspace._id)) ?? activeWorkspace;
    await services.workspace.update(fresh, { aiScoring: script === DEFAULT_SCORING_SCRIPT ? {} : { script } });
    revalidate();
  };

  return (
    <div className="flex h-full w-full flex-col gap-4 p-4">
      <div>
        <h2 className="text-lg font-semibold">Model scoring</h2>
        <p className="text-sm text-(--hl)">
          This script runs once at the end of every Model Evaluator run and gives each model a score from 0 to 1. The
          results table is ranked by it. Scores are saved with the run, so changing the script only affects future runs.
          If it fails, the run still finishes and the table falls back to the default ranking, with the error shown.
        </p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-bold">Script</span>
          <Button
            isDisabled={isDefault}
            onPress={() => {
              editorRef.current?.setValue(DEFAULT_SCORING_SCRIPT);
              setIsDefault(true);
              save(DEFAULT_SCORING_SCRIPT);
            }}
            className="rounded-xs px-1 text-xs text-(--hl) underline hover:text-(--color-font) disabled:opacity-50"
          >
            Reset to default
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-xs border border-solid border-(--hl-sm)">
          <ErrorBoundary key={activeWorkspace._id} errorClassName="font-error pad text-center">
            <CodeEditor
              id={`model-scoring-script-${activeWorkspace._id}`}
              key={activeWorkspace._id}
              historyKey={`${activeWorkspace._id}:model-scoring-script`}
              ref={editorRef}
              mode="text/javascript"
              defaultValue={initial}
              lintOptions={lintOptions}
              onChange={script => {
                setIsDefault(script === DEFAULT_SCORING_SCRIPT);
                save(script);
              }}
            />
          </ErrorBoundary>
        </div>
        <p className="text-xs text-(--hl)">
          Plain JavaScript in the usual script sandbox. <code>models</code> is the input and the script must{' '}
          <code>return</code> an array of <code>{'{ id, score, note? }'}</code>. A model you leave out has no score and
          ranks last. The editor may flag a top-level <code>await</code>; it works.
        </p>
      </div>
    </div>
  );
};
