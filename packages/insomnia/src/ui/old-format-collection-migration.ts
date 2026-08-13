import { services } from 'insomnia-data';

import {
  commitMigratedChangesForProject,
  findOldFormatDocumentWorkspaces,
  findOldFormatDocumentWorkspacesInProject,
  migrateDocumentToLinkedCollection,
  type OldFormatDocument,
} from '~/common/generate-linked-collection';
import { showModal } from '~/ui/components/modals';
import { AlertModal } from '~/ui/components/modals/alert-modal';
import { showToast } from '~/ui/components/toast-notification';

// INS-3528: always prompt before converting old-format documents — never silently. This is
// the single place that shows the "Fix now" prompt, runs the real migration, and shows the
// success toast, regardless of which entry point (startup, pull, clone, connect) triggered it.
function promptAndFix(oldFormatDocuments: OldFormatDocument[]) {
  const count = oldFormatDocuments.length;
  if (count === 0) {
    return;
  }

  showModal(AlertModal, {
    title: 'Documents and Collections are now separate',
    message: `We've split Collections apart from Documents so each is easier to find, with links to jump between them. Click "Fix now" and we'll convert your ${count} existing legacy collection${count === 1 ? '' : 's'}.`,
    okLabel: 'Fix now',
    onConfirm: async () => {
      const affectedProjects = new Map(oldFormatDocuments.map(({ project }) => [project._id, project]));

      for (const { workspace, project } of oldFormatDocuments) {
        await migrateDocumentToLinkedCollection(workspace, project);
      }

      for (const project of affectedProjects.values()) {
        await commitMigratedChangesForProject(project);
      }

      showToast(
        {
          title: 'Collections updated',
          description: `Converted ${count} document${count === 1 ? '' : 's'} to the new collection format and committed the changes.`,
          status: 'success',
        },
        { timeout: 5000 },
      );
    },
  });
}

export async function promptAndFixOldFormatDocuments(): Promise<void> {
  const oldFormatDocuments = await findOldFormatDocumentWorkspaces();
  promptAndFix(oldFormatDocuments);
}

export async function promptAndFixOldFormatDocumentsInProject(projectId: string): Promise<void> {
  const project = await services.project.getById(projectId);
  if (!project) {
    return;
  }

  const oldFormatWorkspaces = await findOldFormatDocumentWorkspacesInProject(project);
  promptAndFix(oldFormatWorkspaces.map(workspace => ({ workspace, project })));
}
