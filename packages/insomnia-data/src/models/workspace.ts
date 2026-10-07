import { strings } from 'insomnia-data/common';

import type { BaseModel } from './base-types';

export const name = 'Workspace';
export const type = 'Workspace';
export const prefix = 'wrk';
export const canDuplicate = true;
export const canSync = true;

export const SCRATCHPAD_WORKSPACE_ID = 'wrk_scratchpad';

/** One model exposed by a Konnect AI Gateway. Several models can share a path, told apart by `routeModelValues`. */
/** One upstream a model balances across. A model with several targets is "rotating": the gateway picks one per request. */
export interface AiGatewayTarget {
  /** Upstream model, e.g. `gpt-4.1-nano`. */
  name: string;
  provider: string;
  inputPerToken?: number;
  outputPerToken?: number;
}

export interface AiGatewayModel {
  id: string;
  displayName: string;
  /** First upstream model the gateway targets, e.g. `claude-opus-4-6`. See `targets` for all of them. */
  targetModel: string;
  provider: string;
  /** Konnect request/response format: anthropic, openai, gemini, bedrock, cohere, huggingface. */
  format: string;
  paths: string[];
  /** Values of the request body `model` field that the route matches on, e.g. `["opus"]`. */
  routeModelValues: string[];
  enabled: boolean;
  /** USD per token from Konnect's LLM cost price list, when a price was found for `targetModel`. */
  inputPerToken?: number;
  outputPerToken?: number;
  /** Ids (or names) of the gateway policies attached to this model. Global policies are not listed here. */
  policyRefs?: string[];
  /** Every upstream the model balances across (first one mirrors `targetModel`/`provider`/prices). Absent on older syncs. */
  targets?: AiGatewayTarget[];
}

export interface BaseWorkspace {
  name: string;
  description: string;
  certificates?: any; // deprecated
  scope: 'design' | 'collection' | 'mock-server' | 'environment' | 'mcp';
  konnectServiceId?: string | null;
  /** Prototype (3593AI): model catalog synced from a Konnect AI Gateway. */
  konnectAiGatewayModels?: AiGatewayModel[] | null;
  /** Prototype (3593AI): collection-wide settings for `insomnia.judge()`, edited on the collection's Judge tab. */
  aiJudge?: AiJudgeSettings | null;
  /** Prototype (3593AI): the Model Scoring tab's script; absent means the default script. */
  aiScoring?: AiScoringSettings | null;
}

export interface AiScoringSettings {
  script?: string;
}

export interface AiJudgeSettings {
  /** The request (in this collection) whose URL, headers and body template the judge uses. */
  requestId?: string;
  /** Extra instructions appended to the built-in judge prompt. */
  system?: string;
  /** How many times the judge is asked per judgment (1-10, default 1); each criterion's score is the average. */
  runs?: number;
}

export type WorkspaceScope = BaseWorkspace['scope'];

export const WorkspaceScopeKeys = {
  design: 'design',
  collection: 'collection',
  mockServer: 'mock-server',
  environment: 'environment',
  mcp: 'mcp',
} as const;

export type Workspace = BaseModel & BaseWorkspace;

export const isWorkspace = (model: Pick<BaseModel, 'type'>): model is Workspace => model.type === type;

export const optionalKeys = ['konnectServiceId', 'konnectAiGatewayModels', 'aiJudge', 'aiScoring'];
export const isWorkspaceId = (id?: string | null) => id?.startsWith(prefix + '_');

export const isDesign = (workspace: Pick<Workspace, 'scope'>) => workspace.scope === WorkspaceScopeKeys.design;

export const isCollection = (workspace: Pick<Workspace, 'scope'>) => workspace.scope === WorkspaceScopeKeys.collection;

export const isMockServer = (workspace: Pick<Workspace, 'scope'>) => workspace.scope === WorkspaceScopeKeys.mockServer;

export const isEnvironment = (workspace: Pick<Workspace, 'scope'>) =>
  workspace.scope === WorkspaceScopeKeys.environment;

export const isMcp = (workspace: Pick<Workspace, 'scope'>) => workspace.scope === WorkspaceScopeKeys.mcp;

export const init = (): BaseWorkspace => ({
  name: `New ${strings.collection.singular}`,
  description: '',
  scope: WorkspaceScopeKeys.collection,
});

export function isScratchpad(workspace?: Workspace) {
  return workspace?._id === SCRATCHPAD_WORKSPACE_ID;
}

export const scopeToActivity = (scope: WorkspaceScope) => {
  switch (scope) {
    case WorkspaceScopeKeys.collection: {
      return 'debug';
    }
    case WorkspaceScopeKeys.design: {
      // Legacy spec workspace route has been merged into the debug route, so we return debug here as well.
      return 'debug';
    }
    case WorkspaceScopeKeys.mockServer: {
      return 'mock-server';
    }
    case WorkspaceScopeKeys.environment: {
      return 'environment';
    }
    case WorkspaceScopeKeys.mcp: {
      return 'mcp';
    }
    default: {
      return 'debug';
    }
  }
};
