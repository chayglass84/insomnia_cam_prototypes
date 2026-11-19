import { ipcMainHandle } from '../ipc/electron';
import { probeMcpServer } from './probe';
import * as service from './service';

// Task 4348 main-process entry. Each function is plain; expose new ones through McpDebuggerBridgeAPI +
// entry.preload.ts + the channel list in ipc/electron.ts (see AGENTS.md "Electron IPC").
export interface McpDebuggerBridgeAPI {
  probe: typeof probeMcpServer;
  connect: typeof service.connect;
  disconnect: typeof service.disconnect;
  getState: (options: Parameters<typeof service.getState>[0]) => Promise<ReturnType<typeof service.getState>>;
  getTrace: (options: Parameters<typeof service.getTrace>[0]) => Promise<ReturnType<typeof service.getTrace>>;
  clearTrace: (options: Parameters<typeof service.clearTrace>[0]) => Promise<void>;
  invokeCapability: (options: Parameters<typeof service.invokeCapability>[0]) => Promise<void>;
  invokeRaw: (options: Parameters<typeof service.invokeRaw>[0]) => Promise<void>;
  cancel: (options: Parameters<typeof service.cancel>[0]) => Promise<void>;
}

export const registerMcpDebuggerHandlers = () => {
  ipcMainHandle('mcpDebugger.probe', (_, o: Parameters<typeof probeMcpServer>[0]) => probeMcpServer(o));
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
};

export const closeAllMcpDebuggerSessions = service.closeAll;
