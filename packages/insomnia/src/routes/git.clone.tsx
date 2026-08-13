import { href, redirect } from 'react-router';

import { invariant } from '~/common/utils/invariant';
import { promptAndFixOldFormatDocumentsInProject } from '~/ui/old-format-collection-migration';
import { createFetcherSubmitHook } from '~/ui/utils/router';

import type { Route } from './+types/git.clone';

interface CloneGitRepoData {
  organizationId: string;
  projectId?: string;
  uri: string;
  author: {
    name: string;
    email: string;
  };
  credentialsId: string | null;
  ref: string;
  selectedAuthorEmail?: string | null;
}

export async function clientAction({ request }: Route.ClientActionArgs) {
  const data = (await request.json()) as CloneGitRepoData;

  const { errors, projectId } = await window.main.git.cloneGitRepo(data);

  if (errors) {
    return { errors };
  }

  invariant(projectId, 'Project ID is required');

  // INS-3528: check for/prompt to fix old-format documents in the freshly-cloned project.
  // Not awaited — the prompt is a modal that waits on the user, and shouldn't block this redirect.
  promptAndFixOldFormatDocumentsInProject(projectId);

  return redirect(
    href(`/organization/:organizationId/project/:projectId`, {
      organizationId: data.organizationId,
      projectId,
    }),
  );
}

export const useGitCloneActionFetcher = createFetcherSubmitHook(
  submit => (data: CloneGitRepoData) => {
    return submit(JSON.stringify(data), {
      method: 'POST',
      action: href('/git/clone'),
      encType: 'application/json',
    });
  },
  clientAction,
);
