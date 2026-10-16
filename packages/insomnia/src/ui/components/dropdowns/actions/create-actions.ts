import type { IconName, IconProp } from '@fortawesome/fontawesome-svg-core';
import type { Request, WorkspaceScope } from 'insomnia-data';

import type { AiFolderKind } from '~/common/ai-skills';
import type { CreateRequestType } from '~/ui/hooks/use-request';

export interface ActionItem {
  id: string;
  name: string;
  icon: IconProp;
  action: () => void;
  scope?: WorkspaceScope;
}

export const createWorkspaceActionItems = ({
  createCollection,
  createMcpClient,
  createMockServer,
  createEnvironment,
  canCreateMockServer,
}: {
  createCollection: () => void;
  createMcpClient: () => void;
  createMockServer: () => void;
  createEnvironment: () => void;
  canCreateMockServer: boolean;
}): ActionItem[] => {
  return [
    {
      id: 'new-collection',
      name: 'API Collection',
      scope: 'collection',
      icon: 'bars',
      action: createCollection,
    },
    {
      id: 'new-mcp-client',
      name: 'MCP Client',
      scope: 'mcp',
      icon: ['fac', 'mcp'] as unknown as IconProp,
      action: createMcpClient,
    },
    ...(canCreateMockServer
      ? [
          {
            id: 'new-mock-server',
            name: 'Mock Server',
            scope: 'mock-server' as WorkspaceScope,
            icon: 'server' as IconName,
            action: createMockServer,
          },
        ]
      : []),
    {
      id: 'new-environment',
      name: 'Environment',
      scope: 'environment',
      icon: 'code',
      action: createEnvironment,
    },
  ];
};

export const createRequestOrFolderActionItems = ({
  createRequest,
  createFolder,
  folderFirst = false,
}: {
  createRequest: (requestType: CreateRequestType) => void;
  createFolder: () => void;
  folderFirst?: boolean;
}): ActionItem[] => {
  const folderItem: ActionItem = {
    id: 'New Folder',
    name: 'New Folder',
    icon: 'folder',
    action: createFolder,
  };

  const requestItems: ActionItem[] = [
    {
      id: 'HTTP',
      name: 'HTTP Request',
      icon: 'plus-circle',
      action: () => createRequest('HTTP'),
    },
    {
      id: 'Event Stream',
      name: 'Event Stream Request (SSE)',
      icon: 'plus-circle',
      action: () => createRequest('Event Stream'),
    },
    {
      id: 'GraphQL Request',
      name: 'GraphQL Request',
      icon: 'plus-circle',
      action: () => createRequest('GraphQL'),
    },
    {
      id: 'gRPC Request',
      name: 'gRPC Request',
      icon: 'plus-circle',
      action: () => createRequest('gRPC'),
    },
    {
      id: 'WebSocket Request',
      name: 'WebSocket Request',
      icon: 'plus-circle',
      action: () => createRequest('WebSocket'),
    },
    {
      id: 'Socket.IO Request',
      name: 'Socket.IO Request',
      icon: 'plus-circle',
      action: () => createRequest('SocketIO'),
    },
  ];

  return folderFirst ? [folderItem, ...requestItems] : [...requestItems, folderItem];
};

/**
 * Prototype (3593AI): the one request each synced AI folder takes (a model is an SSE route request, a prompt an SSE
 * request, a skill a request holding Markdown). Shared by every menu that can create inside those folders.
 */
export const AI_FOLDER_REQUEST_OPTIONS: Record<
  AiFolderKind,
  { id: string; name: string; type: CreateRequestType; req?: Partial<Request> }
> = {
  models: { id: 'New Model', name: 'New Model Request (SSE)', type: 'Event Stream' },
  prompts: { id: 'New Prompt', name: 'New Prompt (SSE)', type: 'Event Stream' },
  skills: { id: 'New Skill', name: 'New Skill', type: 'HTTP', req: { name: 'New Skill' } },
};

/** Subfolders plus the folder's own kind of request, and nothing else. */
export const createAiFolderActionItems = ({
  kind,
  createFolder,
  createRequest,
}: {
  kind: AiFolderKind;
  createFolder: () => void;
  createRequest: (requestType: CreateRequestType, req?: Partial<Request>) => void;
}): ActionItem[] => {
  const option = AI_FOLDER_REQUEST_OPTIONS[kind];
  return [
    { id: 'New Folder', name: 'New Folder', icon: 'folder', action: createFolder },
    { id: option.id, name: option.name, icon: 'plus-circle', action: () => createRequest(option.type, option.req) },
  ];
};
