import type { Project, Workspace } from 'insomnia-data';
import { models, services } from 'insomnia-data';

import { database } from '~/common/database';
import { safeToUseInsomniaFileNameWithExt } from '~/sync/git/insomnia-filename';

// INS-3528: creates a real, standalone `scope: 'collection'` workspace for a Document
// (instead of the old behavior of importing requests onto the Document's own workspace),
// and links the two together via `linkedCollectionId` / `linkedDocumentId`.
export async function createLinkedCollectionWorkspace(documentWorkspace: Workspace, project: Project) {
  const flushId = await database.bufferChanges();

  const collectionWorkspace = await services.workspace.create({
    name: documentWorkspace.name,
    scope: 'collection',
    parentId: documentWorkspace.parentId,
  });

  await services.environment.getOrCreateForParentId(collectionWorkspace._id);
  await services.cookieJar.getOrCreateForParentId(collectionWorkspace._id);
  const collectionMeta = await services.workspaceMeta.getOrCreateByParentId(collectionWorkspace._id);

  if (models.project.isGitProject(project)) {
    const gitFilePath = await getUniqueCollectionGitFilePath(documentWorkspace, project);
    await services.workspaceMeta.update(collectionMeta, { gitFilePath });
  }

  const linkedCollectionWorkspace = await services.workspace.update(collectionWorkspace, {
    linkedDocumentId: documentWorkspace._id,
  });
  await services.workspace.update(documentWorkspace, { linkedCollectionId: collectionWorkspace._id });

  await database.flushChanges(flushId);

  return linkedCollectionWorkspace;
}

// INS-3528: the generated collection's file must not collide with the Document's own file
// (which uses the same base name), or with any other file already in the project.
async function getUniqueCollectionGitFilePath(documentWorkspace: Workspace, project: Project): Promise<string> {
  const projectWorkspaces = await services.workspace.listByParentId(project._id);
  const workspaceMetas = await services.workspaceMeta.list({
    parentId: { $in: projectWorkspaces.map(workspace => workspace._id) },
  });
  const existingFilePaths = new Set(workspaceMetas.map(meta => meta.gitFilePath).filter(Boolean));

  const baseName = `${documentWorkspace.name}_collection`;
  let candidate = safeToUseInsomniaFileNameWithExt(baseName);
  let attempt = 2;
  while (existingFilePaths.has(candidate)) {
    candidate = safeToUseInsomniaFileNameWithExt(`${baseName}_${attempt}`);
    attempt++;
  }

  return candidate;
}

export interface OldFormatDocument {
  workspace: Workspace;
  project: Project;
}

// INS-3528: a Document is "old format" if requests/folders were imported directly onto its
// own workspace (the old "Generate Collection" behavior) and it hasn't already been split
// into a linked standalone collection. Scoped to git-backed projects only, since the
// migration's "commit our changes" step only makes sense where there are files to commit.
export async function findOldFormatDocumentWorkspacesInProject(project: Project): Promise<Workspace[]> {
  if (!models.project.isGitProject(project)) {
    return [];
  }

  const workspaces = await services.workspace.listByParentId(project._id);
  const oldFormatWorkspaces: Workspace[] = [];

  for (const workspace of workspaces) {
    if (!models.workspace.isDesign(workspace) || workspace.linkedCollectionId) {
      continue;
    }

    const [requests, requestGroups] = await Promise.all([
      services.request.findByParentId(workspace._id),
      services.requestGroup.findByParentId(workspace._id),
    ]);

    if (requests.length > 0 || requestGroups.length > 0) {
      oldFormatWorkspaces.push(workspace);
    }
  }

  return oldFormatWorkspaces;
}

export async function findOldFormatDocumentWorkspaces(): Promise<OldFormatDocument[]> {
  const projects = await services.project.list();
  const gitProjects = projects.filter(models.project.isGitProject);

  const results: OldFormatDocument[] = [];

  for (const project of gitProjects) {
    const oldFormatWorkspaces = await findOldFormatDocumentWorkspacesInProject(project);
    results.push(...oldFormatWorkspaces.map(workspace => ({ workspace, project })));
  }

  return results;
}

// INS-3528: splits an old-format Document's embedded request tree out into a new linked
// standalone collection. Requests/folders are reparented (not regenerated from the spec),
// so any manual edits the user made to the old embedded collection are preserved.
export async function migrateDocumentToLinkedCollection(documentWorkspace: Workspace, project: Project) {
  const collectionWorkspace = await createLinkedCollectionWorkspace(documentWorkspace, project);

  const flushId = await database.bufferChangesIndefinitely();

  const [requests, requestGroups] = await Promise.all([
    services.request.findByParentId(documentWorkspace._id),
    services.requestGroup.findByParentId(documentWorkspace._id),
  ]);

  await Promise.all([
    ...requestGroups.map(requestGroup =>
      services.requestGroup.update(requestGroup, { parentId: collectionWorkspace._id }),
    ),
    ...requests.map(request => services.request.update(request, { parentId: collectionWorkspace._id })),
  ]);

  await database.flushChanges(flushId);

  return collectionWorkspace;
}
