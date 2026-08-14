import type { Project } from 'insomnia-data';
import { models } from 'insomnia-data';

// INS-3528: stages and commits whatever files the collection-format split (migration or fresh
// "Generate Collection") wrote to disk, so `linkedCollectionId`/`linkedDocumentId` round-trip
// through git instead of being silently dropped the next time the repo is reimported. Lives in
// `ui/` (not `common/generate-linked-collection.ts`) because it needs `window.main.git`, and
// `common/` is shared with the main process and inso CLI, where `window` isn't available.
export async function commitMigratedChangesForProject(project: Project) {
  if (!models.project.isGitProject(project)) {
    return;
  }

  const { changes } = await window.main.git.gitChangesLoader({ projectId: project._id });
  const paths = changes.unstaged.map(change => change.path);
  if (paths.length === 0) {
    return;
  }

  await window.main.git.stageChanges({ projectId: project._id, paths });
  await window.main.git.commitToGitRepo({
    projectId: project._id,
    message: 'Split collection out of document (INS-3528)',
  });
}
