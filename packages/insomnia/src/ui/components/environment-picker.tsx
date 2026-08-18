import type { IconProp } from '@fortawesome/fontawesome-svg-core';
import { models } from 'insomnia-data';
import { Fragment, useState } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Heading,
  ListBox,
  ListBoxItem,
  Popover,
  Text,
} from 'react-aria-components';
import { useNavigate, useParams } from 'react-router';

import { useSetActiveEnvironmentFetcher } from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.environment.set-active';
import { useEnvironmentSetActiveGlobalActionFetcher } from '~/routes/organization.$organizationId.project.$projectId.workspace.$workspaceId.environment.set-active-global';
import { NewWorkspaceModal } from '~/ui/components/modals/new-workspace-modal';
import { Tooltip } from '~/ui/components/tooltip';
import { DEFAULT_STORAGE_RULES } from '~/ui/organization-utils';

import { useWorkspaceLoaderData } from '../../routes/organization.$organizationId.project.$projectId.workspace.$workspaceId';
import uiEventBus from '../event-bus';
import { useOrganizationPermissions } from '../hooks/use-organization-features';
import { Icon } from './icon';

const triggerButtonClassName = 'flex max-w-48 shrink-0 items-center gap-1.5 truncate rounded-xs px-2 py-1 text-sm text-(--color-font) ring-1 ring-transparent transition-all hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset aria-pressed:bg-(--hl-sm) data-open:bg-(--hl-sm)';

const inheritanceTooltipMessage = 'Values inherit down and can be overridden: collection environment values override folder values, which override project environment values.';

const InheritanceTooltip = () => (
  <Tooltip position="top" message={inheritanceTooltipMessage}>
    <Icon icon="circle-info" className="shrink-0 text-(--hl)" />
  </Tooltip>
);

export const EnvironmentPicker = ({
  isOpen,
  onOpenChange,
  onOpenEnvironmentSettingsModal,
}: {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onOpenEnvironmentSettingsModal: () => void;
}) => {
  const {
    activeProject,
    activeWorkspaceMeta,
    activeEnvironment,
    activeGlobalEnvironment,
    subEnvironments,
    baseEnvironment,
    globalBaseEnvironments,
    globalSubEnvironments,
  } = useWorkspaceLoaderData()!;

  const { organizationId, projectId, workspaceId } = useParams() as {
    organizationId: string;
    projectId: string;
    workspaceId: string;
    requestId?: string;
    requestGroupId?: string;
  };

  const { features } = useOrganizationPermissions();
  const isUsingInsomniaCloudSync = Boolean(
    models.project.isRemoteProject(activeProject) && !activeWorkspaceMeta?.gitRepositoryId,
  );
  const isUsingGitSync = Boolean(features.gitSync.enabled && activeWorkspaceMeta?.gitRepositoryId);

  const setActiveEnvironmentFetcher = useSetActiveEnvironmentFetcher();
  const setActiveGlobalEnvironmentFetcher = useEnvironmentSetActiveGlobalActionFetcher();

  const collectionEnvironmentList = [baseEnvironment, ...subEnvironments].map(({ type, ...environment }) => ({
    ...environment,
    id: environment._id,
    isBase: environment._id === baseEnvironment._id,
  }));

  const selectedGlobalBaseEnvironmentId = activeGlobalEnvironment?.parentId?.startsWith('wrk')
    ? activeGlobalEnvironment._id
    : activeGlobalEnvironment?.parentId;
  const selectedGlobalBaseEnvironment = globalBaseEnvironments.find(e => e._id === selectedGlobalBaseEnvironmentId);

  const activeGlobalBaseEnvironment = selectedGlobalBaseEnvironment;
  const activeBaseEnvironment = baseEnvironment;
  const activeSubEnvironment = subEnvironments.find(e => e._id === activeEnvironment._id);
  const activeCollectionEnvironmentName = activeSubEnvironment ? activeSubEnvironment.name : activeBaseEnvironment.name;

  const navigate = useNavigate();

  const [isNewProjectEnvironmentModalOpen, setIsNewProjectEnvironmentModalOpen] = useState(false);

  const getEnvironmentIcon = (isPrivate?: boolean): IconProp =>
    isPrivate ? 'lock' : isUsingGitSync ? ['fab', 'git-alt'] : isUsingInsomniaCloudSync ? 'globe-americas' : 'file-arrow-down';

  // Flattened list of every project environment file plus its sub-environments, so picking
  // one is a single action instead of choosing a file first and then a sub-environment.
  const projectEnvironmentItems: {
    id: string;
    name: string;
    icon: IconProp;
    color?: string | null;
    isBase: boolean;
    workspaceId?: string;
  }[] = [
    { id: '', name: 'No Project Environment', icon: 'cancel', isBase: true },
    ...globalBaseEnvironments.flatMap(baseEnv => [
      {
        id: baseEnv._id,
        name: baseEnv.workspaceName || baseEnv.name,
        icon: getEnvironmentIcon(baseEnv.isPrivate),
        color: baseEnv.color,
        isBase: true,
        workspaceId: baseEnv.parentId,
      },
      ...globalSubEnvironments
        .filter(subEnv => subEnv.parentId === baseEnv._id)
        .map(subEnv => ({
          id: subEnv._id,
          name: subEnv.name,
          icon: getEnvironmentIcon(subEnv.isPrivate),
          color: subEnv.color,
          isBase: false,
        })),
    ]),
  ];

  return (
    <div className="flex items-center gap-1">
      <DialogTrigger>
        <Button aria-label="Select a Project Environment" className={triggerButtonClassName}>
          <Icon
            icon={activeGlobalEnvironment ? (activeGlobalEnvironment.isPrivate ? 'lock' : getEnvironmentIcon(false)) : 'cancel'}
            style={{ color: activeGlobalEnvironment?.color || '' }}
            className="w-4 shrink-0"
          />
          <Tooltip position="top" message="Project environment, available to every collection in this project.">
            <span className="truncate">
              {activeGlobalEnvironment && activeGlobalBaseEnvironment ? activeGlobalEnvironment.name : 'No Project Environment'}
            </span>
          </Tooltip>
          <Icon icon="caret-down" className="w-2.5 shrink-0 text-(--hl)" />
        </Button>
        <Popover className="z-10! flex max-h-[90vh] min-w-64 flex-col" placement="bottom start" offset={8}>
          <Dialog className="flex h-full w-full flex-col overflow-hidden rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) text-sm shadow-lg select-none focus:outline-hidden">
            <Heading className="flex h-(--line-height-sm) shrink-0 items-center justify-between gap-2 px-3 py-1 text-sm font-bold text-(--hl)">
              <Tooltip position="top" message="Available to every collection in this project. Click the edit icon on a project environment to configure it.">
                <span>Project Environments</span>
              </Tooltip>
              <div className="flex shrink-0 items-center gap-2">
                <Tooltip position="top" message="Add a new project environment">
                  <Button
                    aria-label="Add Project Environment"
                    onPress={() => setIsNewProjectEnvironmentModalOpen(true)}
                    className="flex aspect-square h-6 shrink-0 items-center justify-center rounded-xs text-sm text-(--color-font) ring-1 ring-transparent transition-all hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset aria-pressed:bg-(--hl-sm)"
                  >
                    <Icon icon="plus" />
                  </Button>
                </Tooltip>
                <InheritanceTooltip />
              </div>
            </Heading>
            <ListBox
              aria-label="Select a Project Environment"
              selectionMode="single"
              disallowEmptySelection
              key={activeGlobalEnvironment?._id || 'none'}
              items={projectEnvironmentItems}
              selectedKeys={[activeGlobalEnvironment?._id || activeGlobalBaseEnvironment?._id || '']}
              onSelectionChange={keys => {
                if (keys === 'all' || !keys) {
                  return;
                }
                const [environmentId] = keys.values();

                setActiveGlobalEnvironmentFetcher.submit({
                  organizationId,
                  projectId,
                  workspaceId,
                  environmentId: environmentId.toString(),
                });
              }}
              className="flex max-h-fit min-w-max flex-1 flex-col overflow-y-auto p-2 text-sm select-none empty:p-0 focus:outline-hidden"
            >
              {item => (
                <ListBoxItem
                  textValue={item.name}
                  className={`group flex h-(--line-height-xs) w-full flex-none items-center gap-2 rounded-sm bg-transparent pr-1 whitespace-nowrap text-(--color-font) transition-colors hover:bg-(--hl-sm) focus:bg-(--hl-xs) focus:outline-hidden disabled:cursor-not-allowed ${item.isBase ? 'pl-(--padding-md)' : 'pl-8'}`}
                >
                  {({ isSelected }) => (
                    <Fragment>
                      <Icon
                        icon={item.icon}
                        className="w-5 shrink-0 text-xs"
                        style={{
                          color: item.color ?? 'var(--color-font)',
                        }}
                      />
                      <Text slot="label" className="flex-1 truncate">
                        {item.name}
                      </Text>
                      {isSelected && <Icon icon="check" className="justify-self-end px-2 text-(--color-success)" />}
                      {item.workspaceId && (
                        <Button
                          aria-label={`Edit ${item.name}`}
                          onPress={() =>
                            navigate(
                              `/organization/${organizationId}/project/${projectId}/workspace/${item.workspaceId}/environment`,
                            )
                          }
                          className="flex aspect-square h-5 shrink-0 items-center justify-center rounded-xs text-xs text-(--color-font) opacity-0 ring-1 ring-transparent transition-all group-hover:opacity-100 group-focus:opacity-100 hover:bg-(--hl-xs) focus:opacity-100 focus:ring-(--hl-md) focus:ring-inset"
                        >
                          <Icon icon="edit" />
                        </Button>
                      )}
                    </Fragment>
                  )}
                </ListBoxItem>
              )}
            </ListBox>
          </Dialog>
        </Popover>
      </DialogTrigger>
      <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
        <Button aria-label="Select a Collection Environment" className={triggerButtonClassName}>
          <Icon
            icon={activeEnvironment.isPrivate ? 'lock' : 'code'}
            style={{ color: activeEnvironment.color || '' }}
            className="w-4 shrink-0"
          />
          <Tooltip position="top" message="Collection environment, scoped to this collection only.">
            <span className="truncate">{activeCollectionEnvironmentName}</span>
          </Tooltip>
          <Icon icon="caret-down" className="w-2.5 shrink-0 text-(--hl)" />
        </Button>
        <Popover className="z-10! flex max-h-[90vh] min-w-64 flex-col" placement="bottom start" offset={8}>
          <Dialog className="flex h-full w-full flex-col overflow-hidden rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) text-sm shadow-lg select-none focus:outline-hidden">
            <Heading className="flex h-7 shrink-0 items-center justify-between gap-2 px-3 py-1 text-sm font-bold text-(--hl)">
              <Tooltip position="top" message="Scoped to this collection only. Overrides project environment values.">
                <span>Collection Environment</span>
              </Tooltip>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  onPress={onOpenEnvironmentSettingsModal}
                  aria-label="Manage collection environments"
                  className="flex aspect-square h-6 shrink-0 items-center justify-center rounded-xs text-sm text-(--color-font) ring-1 ring-transparent outline-hidden transition-all hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset aria-pressed:bg-(--hl-sm)"
                >
                  <Icon icon="edit" />
                </Button>
                <InheritanceTooltip />
              </div>
            </Heading>
            <ListBox
              aria-label="Select a Collection Environment"
              selectionMode="single"
              key={activeEnvironment._id}
              items={collectionEnvironmentList}
              selectedKeys={[activeEnvironment._id || baseEnvironment._id || '']}
              disallowEmptySelection
              onSelectionChange={keys => {
                if (keys === 'all' || !keys) {
                  return;
                }
                const [environmentId] = keys.values();
                setActiveEnvironmentFetcher.submit({
                  organizationId,
                  projectId,
                  workspaceId,
                  environmentId: environmentId.toString(),
                });
                uiEventBus.emit('CHANGE_ACTIVE_ENV', workspaceId);
              }}
              className="max-h-fit flex-1 overflow-y-auto p-2 text-sm select-none focus:outline-hidden"
            >
              {item => (
                <ListBoxItem
                  textValue={item.name}
                  className={`flex h-(--line-height-xs) w-full items-center gap-2 truncate rounded-sm bg-transparent pr-1 whitespace-nowrap text-(--color-font) transition-colors hover:bg-(--hl-sm) focus:bg-(--hl-xs) focus:outline-hidden ${item.isBase ? 'pl-(--padding-md)' : 'pl-8'}`}
                >
                  {({ isSelected }) => (
                    <Fragment>
                      <span
                        style={{
                          borderColor: item.color ?? 'var(--color-font)',
                        }}
                      >
                        <Icon
                          icon={
                            item.isPrivate
                              ? 'lock'
                              : isUsingGitSync
                                ? ['fab', 'git-alt']
                                : isUsingInsomniaCloudSync
                                  ? 'globe-americas'
                                  : 'file-arrow-down'
                          }
                          className="w-5 text-xs"
                          style={{
                            color: item.color ?? 'var(--color-font)',
                          }}
                        />
                      </span>
                      <Text slot="label" className="flex-1 truncate">
                        {item.name}
                      </Text>
                      {isSelected && <Icon icon="check" className="justify-self-end px-2 text-(--color-success)" />}
                    </Fragment>
                  )}
                </ListBoxItem>
              )}
            </ListBox>
          </Dialog>
        </Popover>
      </DialogTrigger>
      {isNewProjectEnvironmentModalOpen && (
        <NewWorkspaceModal
          isOpen
          project={activeProject}
          storageRules={DEFAULT_STORAGE_RULES}
          scope="environment"
          source="environment-picker"
          onOpenChange={setIsNewProjectEnvironmentModalOpen}
        />
      )}
    </div>
  );
};
