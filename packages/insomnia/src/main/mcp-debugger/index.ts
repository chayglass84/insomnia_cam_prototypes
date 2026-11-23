import { shell } from 'electron';

import { ipcMainHandle } from '../ipc/electron';
import { findLocalMcpConfigs, type LocalMcpConfig } from './local-configs';
import { discoverOAuth } from './oauth-discovery';
import { cancelAuthorization, runAuthorization, unionScopes } from './oauth-flow';
import { exchangeCode, refreshToken, storedScope } from './oauth-token';
import { probeMcpServer } from './probe';
import * as service from './service';

// Task 4348 main-process entry. Each function is plain; expose new ones through McpDebuggerBridgeAPI +
// entry.preload.ts + the channel list in ipc/electron.ts (see AGENTS.md "Electron IPC").
/** `addScope` is the step-up request: ask again for the stored token's scope plus this one. */
export type OAuthAuthorizeIpcOptions = Omit<Parameters<typeof runAuthorization>[0], 'openUrl' | 'trace' | 'scope'> & { addScope?: string };

export interface McpDebuggerBridgeAPI {
  probe: typeof probeMcpServer;
  oauthDiscover: (options: Omit<Parameters<typeof discoverOAuth>[0], 'trace'> & { requestId: string }) => ReturnType<typeof discoverOAuth>;
  oauthAuthorize: (options: OAuthAuthorizeIpcOptions) => ReturnType<typeof runAuthorization>;
  oauthCancel: typeof cancelAuthorization;
  oauthExchange: (options: { requestId: string }) => ReturnType<typeof exchangeCode>;
  oauthRefresh: (options: { requestId: string }) => ReturnType<typeof refreshToken>;
  connect: typeof service.connect;
  disconnect: typeof service.disconnect;
  getState: (options: Parameters<typeof service.getState>[0]) => Promise<ReturnType<typeof service.getState>>;
  getTrace: (options: Parameters<typeof service.getTrace>[0]) => Promise<ReturnType<typeof service.getTrace>>;
  clearTrace: (options: Parameters<typeof service.clearTrace>[0]) => Promise<void>;
  invokeCapability: (options: Parameters<typeof service.invokeCapability>[0]) => Promise<{ correlationId: string }>;
  invokeRaw: (options: Parameters<typeof service.invokeRaw>[0]) => Promise<{ correlationId: string }>;
  cancel: (options: Parameters<typeof service.cancel>[0]) => Promise<void>;
  respondPeerRequest: (options: Parameters<typeof service.respondPeerRequest>[0]) => Promise<void>;
  setRoots: (options: Parameters<typeof service.setRoots>[0]) => Promise<void>;
  replayOnVersion: typeof service.replayOnVersion;
  replayOAuthCall: typeof service.replayOAuthCall;
  /** Looks only at the known config paths of other tools on this machine; takes no arguments on purpose. */
  findLocalConfigs: () => Promise<LocalMcpConfig[]>;
  taskAction: (options: Parameters<typeof service.taskAction>[0]) => Promise<void>;
  subscribe: (options: Parameters<typeof service.subscribe>[0]) => Promise<void>;
  unsubscribe: (options: Parameters<typeof service.unsubscribe>[0]) => Promise<void>;
}

export const registerMcpDebuggerHandlers = () => {
  ipcMainHandle('mcpDebugger.probe', (_, o: Parameters<typeof probeMcpServer>[0]) => probeMcpServer(o));
  ipcMainHandle('mcpDebugger.oauthDiscover', (_, o: Omit<Parameters<typeof discoverOAuth>[0], 'trace'> & { requestId: string }) =>
    discoverOAuth({ ...o, trace: service.oauthTraceFor(o.requestId) }),
  );
  ipcMainHandle('mcpDebugger.oauthAuthorize', (_, { addScope, ...o }: OAuthAuthorizeIpcOptions) =>
    runAuthorization({
      ...o,
      scope: addScope ? unionScopes(storedScope(o) ?? o.context.scope, addScope) : undefined,
      openUrl: url => shell.openExternal(url),
      trace: service.oauthTraceFor(o.requestId),
    }),
  );
  ipcMainHandle('mcpDebugger.oauthCancel', (_, o: Parameters<typeof cancelAuthorization>[0]) => cancelAuthorization(o));
  ipcMainHandle('mcpDebugger.oauthExchange', (_, o: { requestId: string }) => exchangeCode({ ...o, trace: service.oauthTraceFor(o.requestId) }));
  ipcMainHandle('mcpDebugger.oauthRefresh', (_, o: { requestId: string }) => refreshToken({ ...o, trace: service.oauthTraceFor(o.requestId) }));
  ipcMainHandle('mcpDebugger.connect', (_, o: Parameters<typeof service.connect>[0]) => service.connect(o));
  ipcMainHandle('mcpDebugger.disconnect', (_, o: Parameters<typeof service.disconnect>[0]) => service.disconnect(o));
  ipcMainHandle('mcpDebugger.getState', (_, o: Parameters<typeof service.getState>[0]) => service.getState(o));
  ipcMainHandle('mcpDebugger.getTrace', (_, o: Parameters<typeof service.getTrace>[0]) => service.getTrace(o));
  ipcMainHandle('mcpDebugger.clearTrace', (_, o: Parameters<typeof service.clearTrace>[0]) => service.clearTrace(o));
  ipcMainHandle('mcpDebugger.invokeCapability', (_, o: Parameters<typeof service.invokeCapability>[0]) =>
    service.invokeCapability(o),
  );
  ipcMainHandle('mcpDebugger.invokeRaw', (_, o: Parameters<typeof service.invokeRaw>[0]) => service.invokeRaw(o));
  ipcMainHandle('mcpDebugger.cancel', (_, o: Parameters<typeof service.cancel>[0]) => service.cancel(o));
  ipcMainHandle('mcpDebugger.respondPeerRequest', (_, o: Parameters<typeof service.respondPeerRequest>[0]) =>
    service.respondPeerRequest(o),
  );
  ipcMainHandle('mcpDebugger.replayOnVersion', (_, o: Parameters<typeof service.replayOnVersion>[0]) =>
    service.replayOnVersion(o),
  );
  ipcMainHandle('mcpDebugger.replayOAuthCall', (_, o: Parameters<typeof service.replayOAuthCall>[0]) => service.replayOAuthCall(o));
  ipcMainHandle('mcpDebugger.findLocalConfigs', () => findLocalMcpConfigs());
  ipcMainHandle('mcpDebugger.subscribe', (_, o: Parameters<typeof service.subscribe>[0]) => service.subscribe(o));
  ipcMainHandle('mcpDebugger.unsubscribe', (_, o: Parameters<typeof service.unsubscribe>[0]) => service.unsubscribe(o));
  ipcMainHandle('mcpDebugger.taskAction', (_, o: Parameters<typeof service.taskAction>[0]) => service.taskAction(o));
  ipcMainHandle('mcpDebugger.setRoots', (_, o: Parameters<typeof service.setRoots>[0]) => service.setRoots(o));
};

export const closeAllMcpDebuggerSessions = service.closeAll;
