import type { FC } from 'react';

import { useRequestLoaderData } from '../../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.debug.request.$requestId';
import { useRequestPatcher } from '../../hooks/use-request';
import { MarkdownEditor } from '../markdown-editor';
import { Pane, PaneHeader } from './pane';

/** Prototype (3593AI): a skill is a Markdown document (stored in the request's description), shown instead of the request editor. */
export const SkillPane: FC = () => {
  const { activeRequest } = useRequestLoaderData()!;
  const patchRequest = useRequestPatcher();

  return (
    <Pane type="request">
      <PaneHeader>
        <div className="flex min-w-0 flex-1 items-baseline gap-2 px-3">
          <span className="truncate font-semibold">{activeRequest.name || 'Untitled skill'}</span>
          <span className="truncate text-xs text-(--hl)">
            Skill · Markdown instructions the Model Evaluator can add to a prompt
          </span>
        </div>
      </PaneHeader>
      <div className="min-h-0 w-full flex-1 overflow-hidden">
        <MarkdownEditor
          key={`skill::${activeRequest._id}`}
          historyKey={`skill::${activeRequest._id}`}
          placeholder="Write the skill's instructions in Markdown"
          defaultValue={activeRequest.description}
          onChange={(description: string) => patchRequest(activeRequest._id, { description })}
        />
      </div>
    </Pane>
  );
};
