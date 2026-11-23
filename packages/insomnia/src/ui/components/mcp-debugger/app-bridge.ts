import { UI_METHODS, UI_NOTIFICATIONS, UI_PROTOCOL_VERSION } from '~/common/mcp-debugger/protocol/apps/types';
import type { Capability } from '~/common/mcp-debugger/protocol/Protocol';

// Task 4348 S7a: the host side of the MCP Apps dialect (SEP-1865), as pure decisions so they can be tested without an
// iframe. `decideAppRequest` says what the host should do with one request from the app; the panel acts on it.
// PROTOTYPE-MOCK: a subset of the dialect. Supported: ui/initialize, tools/call and a few read-only methods relayed to
// the server, ui/message and ui/update-model-context (logged, not sent anywhere), ui/request-display-mode (inline only).
// Declined: ui/open-link (the debugger does not open links on an app's behalf), downloads, everything else.

export interface AppRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export type AppDecision =
  | { kind: 'reply'; result: unknown; log?: string }
  | { kind: 'relay'; method: string; params: unknown }
  | { kind: 'error'; code: number; message: string };

/** Server methods an app may reach through the host. Everything else is refused. */
const RELAYED_METHODS = new Set(['tools/call', 'resources/read', 'resources/list', 'tasks/get', 'tasks/cancel']);

export const hostInitializeResult = (toolName: string, theme: 'light' | 'dark') => ({
  protocolVersion: UI_PROTOCOL_VERSION,
  hostInfo: { name: 'Insomnia MCP debugger', version: '0-prototype' },
  hostCapabilities: { serverTools: {}, message: {}, updateModelContext: {} },
  hostContext: {
    toolInfo: { tool: { name: toolName } },
    theme,
    displayMode: 'inline',
    availableDisplayModes: ['inline'],
    platform: 'desktop',
  },
});

export const decideAppRequest = (
  request: AppRequest,
  ctx: { toolName: string; theme: 'light' | 'dark'; tools: Capability[] },
): AppDecision => {
  const params = (request.params ?? {}) as Record<string, unknown>;
  switch (request.method) {
    case UI_METHODS.initialize: {
      return { kind: 'reply', result: hostInitializeResult(ctx.toolName, ctx.theme) };
    }
    case UI_METHODS.message: {
      return { kind: 'reply', result: {}, log: 'The app asked to send a message to the model. The debugger has no model, so it was only logged.' };
    }
    case UI_METHODS.updateModelContext: {
      return { kind: 'reply', result: {}, log: 'The app updated the model context. Logged only.' };
    }
    case UI_METHODS.requestDisplayMode: {
      return { kind: 'reply', result: { mode: 'inline' } };
    }
    case UI_METHODS.openLink: {
      return { kind: 'error', code: -32_000, message: 'The debugger does not open links on behalf of apps.' };
    }
    default: {
      break;
    }
  }
  if (!RELAYED_METHODS.has(request.method)) {
    return { kind: 'error', code: -32_601, message: `Method not supported by this host: ${request.method}` };
  }
  if (request.method === 'tools/call') {
    // `_meta.ui.visibility` lets a server hide a tool from apps; the host has to enforce it.
    const target = ctx.tools.find(t => t.type === 'tool' && t.metadata.name === params.name);
    if (target?.ui && !target.ui.visibility.includes('app')) {
      return { kind: 'error', code: -32_000, message: `Tool "${String(params.name)}" is not callable by apps (its _meta.ui.visibility excludes "app").` };
    }
  }
  return { kind: 'relay', method: request.method, params: request.params };
};

/** What the host sends once the app says it is initialized: the tool's arguments, then its result. */
export const initialAppNotifications = (args: unknown, result: unknown) => [
  { jsonrpc: '2.0', method: UI_NOTIFICATIONS.toolInput, params: { arguments: args } },
  { jsonrpc: '2.0', method: UI_NOTIFICATIONS.toolResult, params: result },
];

export const clampHeight = (height: unknown, min = 120, max = 900): number | null =>
  typeof height === 'number' && Number.isFinite(height) ? Math.min(max, Math.max(min, Math.ceil(height))) : null;
