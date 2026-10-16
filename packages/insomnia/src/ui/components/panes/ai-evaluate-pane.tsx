import type { FC } from 'react';
import { Button } from 'react-aria-components';
import { useParams } from 'react-router';

import { useWorkspaceLoaderData } from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import { useTabNavigate } from '~/ui/hooks/use-insomnia-tab';

import { Icon } from '../icon';

/**
 * Landing tab of the prompts/testing project: a sentence and a button into the Model Evaluator (the runner, where
 * prompts, skills and models are picked). Prototype (3593AI).
 */
export const AiEvaluatePane: FC = () => {
  const { organizationId } = useParams() as { organizationId: string };
  const { activeProject, activeWorkspace } = useWorkspaceLoaderData()!;
  const tabNavigate = useTabNavigate();
  const openRunner = () =>
    tabNavigate(
      { organization: organizationId, project: activeProject, workspace: activeWorkspace, item: activeWorkspace },
      { shouldNavigate: true, asRunner: true },
    );

  return (
    <div className="flex h-full w-full flex-col items-start gap-3 overflow-y-auto p-4">
      <div>
        <h2 className="text-lg font-semibold">Evaluate multiple models</h2>
        <p className="text-sm text-(--hl)">
          Run your prompts, with or without skills, against several models and compare the results, tokens, cost and
          score.
        </p>
      </div>
      <Button
        onPress={openRunner}
        className="flex items-center gap-2 rounded-sm bg-(--color-surprise) px-3 py-1.5 text-sm text-(--color-font-surprise) ring-1 ring-transparent transition-all hover:opacity-90 focus:ring-(--hl-md) focus:ring-inset"
      >
        <Icon icon="play" /> Open Model Evaluator
      </Button>
    </div>
  );
};
