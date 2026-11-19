import { useCallback, useEffect, useRef, useState } from 'react';

import type { TraceEvent } from '~/common/mcp-debugger/protocol/TraceEvent';
import type { McpDebuggerState } from '~/main/mcp-debugger/service';

const POLL_MS = 500;
const EMPTY_STATE: McpDebuggerState = { status: 'disconnected', capabilities: [], warnings: [], lastSequence: 0, replays: {} };

/**
 * PROTOTYPE-MOCK: polls the main-process session (state + new trace events) while mounted instead of subscribing to
 * pushed events. Fine for a debugger at human speed; a real implementation should push over IPC.
 */
export const useMcpDebugger = (requestId: string) => {
  const [state, setState] = useState<McpDebuggerState>(EMPTY_STATE);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const lastSeq = useRef(0);

  const refresh = useCallback(async () => {
    const [nextState, fresh] = await Promise.all([
      window.main.mcpDebugger.getState({ requestId }),
      window.main.mcpDebugger.getTrace({ requestId, afterSequence: lastSeq.current }),
    ]);
    setState(prev => (JSON.stringify(prev) === JSON.stringify(nextState) ? prev : nextState));
    if (fresh.length > 0) {
      lastSeq.current = fresh[fresh.length - 1].sequence;
      setTrace(prev => [...prev, ...fresh]);
    }
  }, [requestId]);

  // Reset when switching requests.
  useEffect(() => {
    lastSeq.current = 0;
    setTrace([]);
    setState(EMPTY_STATE);
  }, [requestId]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        await refresh();
      } catch (err) {
        console.warn('[mcp-debugger] poll failed', err);
      }
    };
    tick();
    const timer = setInterval(() => !cancelled && tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const clearTrace = useCallback(async () => {
    await window.main.mcpDebugger.clearTrace({ requestId });
    lastSeq.current = 0;
    setTrace([]);
  }, [requestId]);

  return { state, trace, refresh, clearTrace };
};
