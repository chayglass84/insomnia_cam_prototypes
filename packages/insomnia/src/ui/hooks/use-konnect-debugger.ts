import type { Project } from 'insomnia-data';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import {
  cancelDebugSession,
  createDebugSession,
  fetchDataPlaneNodes,
  fetchDebugSession,
  fetchDebugSessionTraceDetail,
  fetchDebugSessionTraces,
  type KonnectDebugSpan,
} from '../../konnect/api';

// Real-time-ish per user request ("can it update once a second, whatever")
// — this used to only fetch traces once, after the session's `completed_at`
// showed up. Now it fetches (incrementally) on every poll tick, so the tab
// fills in live while a session is still `in_progress` instead of only
// showing anything once the whole window has elapsed.
const POLL_INTERVAL_MS = 1000;
// PROTOTYPE SHORTCUT: a session can report up to `maxSamples` traces, and
// each one needs its own detail fetch (no batch/detail endpoint found).
// Capping how many we fetch *in total, across the whole session* (not per
// poll tick — see loadedTraceIdsRef) keeps this from firing an ever-growing
// number of requests against a shared control plane over a long session.
// Revisit if real usage needs more than a handful of example requests.
const MAX_TRACE_DETAILS_TO_FETCH = 20;
export const DEFAULT_SESSION_DURATION_SECS = 30;
const MAX_SAMPLES = 200;

// SCOPE CHANGE 2026-09-23 (user request): this used to be scoped to a single
// request's route (client-side filtered), living inside request-pane.tsx.
// Now it's scoped to the whole control plane instead — one session covers
// every request against that CP, and persists across navigating between
// requests within the same workspace (see where this hook is instantiated:
// the workspace route component, not request-pane.tsx, so it survives
// switching requests — only a different workspace/project resets it).
// Consequence: `fetchDebugSessionTraces` results are no longer filtered
// down to one route — every captured trace for the CP shows up, in every
// Konnect-linked request's "Konnect Debugger" tab within that CP.
export interface KonnectControlPlaneLink {
  controlPlaneId: string;
  region: string;
}

export function resolveKonnectControlPlaneLink(
  project: Pick<Project, 'konnectControlPlaneId' | 'konnectRegion'> | null | undefined,
): KonnectControlPlaneLink | null {
  if (!project?.konnectControlPlaneId || !project?.konnectRegion) {
    return null;
  }
  return { controlPlaneId: project.konnectControlPlaneId, region: project.konnectRegion };
}

export interface DebuggerTrace {
  traceId: string;
  durationMs: number;
  spans: KonnectDebugSpan[];
}

interface KonnectDebuggerState {
  status: 'not-linked' | 'idle' | 'starting' | 'in_progress' | 'completed' | 'error';
  error?: string;
  sessionId?: string;
  startedAt?: number;
  durationSecs?: number;
  traces: DebuggerTrace[];
}

// Drives one Konnect Debugger session (create -> poll -> fetch traces) for a
// Konnect-linked control plane. See konnect/api.ts for the full "here's what
// we reverse-engineered and haven't confirmed" caveat on the underlying API.
export function useKonnectDebugger(link: KonnectControlPlaneLink | null) {
  const [state, setState] = useState<KonnectDebuggerState>({
    status: link ? 'idle' : 'not-linked',
    traces: [],
  });
  // Not state: we don't want a re-render on every poll tick, just on the
  // transitions the UI cares about (starting/in_progress/completed/error).
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  // Which trace ids we've already fetched full span detail for this
  // session — lets each poll tick fetch only the NEW traces since last
  // time, instead of re-fetching (and re-appending duplicates of) every
  // trace on every tick. Reset at the top of every start().
  const loadedTraceIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // BUG FIXED 2026-09-23: `cancelledRef` was never reset back to false
    // after a cleanup ran, so React 18 StrictMode's dev-mode double-invoke
    // (mount -> cleanup -> mount again) permanently "cancelled" every
    // session forever after — network calls would succeed (visible in
    // devtools as a real 201) but the resulting setState was silently
    // skipped because cancelledRef.current was stuck at true. Reset it on
    // every real mount, not just declare it once via useRef's initial value.
    cancelledRef.current = false;
    setState({ status: link ? 'idle' : 'not-linked', traces: [] });
    return () => {
      cancelledRef.current = true;
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.controlPlaneId, link?.region]);

  // Returns only the traces fetched for the FIRST time this call (i.e. new
  // since the last poll tick) — caller appends them to existing state
  // rather than replacing it, so traces already being displayed don't
  // flicker/reset every second.
  const refreshTraces = useCallback(async (pat: string, cpId: string, region: string, sessionId: string) => {
    const summaries = await fetchDebugSessionTraces(pat, cpId, sessionId, region);
    const remainingCapacity = MAX_TRACE_DETAILS_TO_FETCH - loadedTraceIdsRef.current.size;
    const newSummaries = summaries.filter(s => !loadedTraceIdsRef.current.has(s.trace_id)).slice(0, Math.max(remainingCapacity, 0));
    const detailed = await Promise.all(
      newSummaries.map(async summary => {
        const spans = await fetchDebugSessionTraceDetail(pat, cpId, sessionId, summary.trace_id, region);
        loadedTraceIdsRef.current.add(summary.trace_id);
        return { traceId: summary.trace_id, durationMs: summary.duration_ms, spans };
      }),
    );
    if (detailed.length > 0) {
      console.info('[konnect-debugger] refreshTraces', sessionId, '-> +', detailed.length, 'new (', loadedTraceIdsRef.current.size, 'total loaded )');
    }
    return detailed;
  }, []);

  const start = useCallback(async (durationSecs: number = DEFAULT_SESSION_DURATION_SECS) => {
    if (!link) {
      return;
    }
    console.info('[konnect-debugger] start() called, existing pollTimer:', pollTimer.current);
    // BUG FIXED 2026-09-23: if `start()` ever runs again while a previous
    // session's poll interval is still alive (e.g. "Restart"/"Retry" fired
    // in quick succession, or any other double-invocation), the old
    // interval was never explicitly cleared here — only inside its own
    // completion/error branches, which by then reference `pollTimer.current`
    // pointing at the NEW interval this call is about to create. The old
    // interval would clear the NEW one instead of itself, silently killing
    // polling for the session actually in progress — symptom: UI stuck on
    // "in_progress" forever, no error, nothing in the console. Always clear
    // whatever's currently there before starting fresh.
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    setState({ status: 'starting', traces: [] });
    try {
      const pat = await window.main.secretStorage.getSecret('konnectPat');
      if (!pat) {
        setState({ status: 'error', error: 'No Konnect personal access token found.', traces: [] });
        return;
      }
      const nodes = await fetchDataPlaneNodes(pat, link.controlPlaneId, link.region);
      // TEMP DIAGNOSTIC LOGGING 2026-09-23: added after a report of "session
      // runs, but captures nothing" that couldn't be reproduced against the
      // raw API directly (verified working with curl at the time). Keep
      // these until that's actually root-caused with real evidence from a
      // failing run's console — remove once confirmed fixed, or promote to
      // permanent if this class of bug (undocumented API, silent partial
      // failure) turns out to be recurring.
      console.info('[konnect-debugger] nodes for CP', link.controlPlaneId, nodes);
      if (nodes.length === 0) {
        setState({ status: 'error', error: 'No connected data plane nodes found for this control plane.', traces: [] });
        return;
      }
      const session = await createDebugSession(pat, link.controlPlaneId, link.region, {
        name: `insomnia-${Date.now()}`,
        targets: nodes.map(n => n.id),
        durationSecs,
        maxSamples: MAX_SAMPLES,
      });
      console.info('[konnect-debugger] session created', session);
      if (cancelledRef.current) {
        console.info('[konnect-debugger] cancelled before session could be recorded — this is the StrictMode/unmount bug if it happens outside a real unmount');
        return;
      }
      loadedTraceIdsRef.current = new Set();
      setState({
        status: 'in_progress',
        sessionId: session.id,
        startedAt: Date.now(),
        durationSecs,
        traces: [],
      });

      pollTimer.current = setInterval(async () => {
        try {
          const [current, newTraces] = await Promise.all([
            fetchDebugSession(pat, link.controlPlaneId, session.id, link.region),
            refreshTraces(pat, link.controlPlaneId, link.region, session.id),
          ]);
          console.info('[konnect-debugger] poll', session.id, 'completed_at=', current.completed_at, 'newTraces=', newTraces.length);
          if (cancelledRef.current) {
            return;
          }
          if (newTraces.length > 0) {
            setState(prev => ({ ...prev, traces: [...prev.traces, ...newTraces] }));
          }
          if (current.completed_at) {
            if (pollTimer.current) {
              clearInterval(pollTimer.current);
              pollTimer.current = null;
            }
            if (!cancelledRef.current) {
              setState(prev => ({ ...prev, status: 'completed' }));
            }
          }
        } catch (err) {
          if (pollTimer.current) {
            clearInterval(pollTimer.current);
            pollTimer.current = null;
          }
          if (!cancelledRef.current) {
            setState(prev => ({ ...prev, status: 'error', error: err instanceof Error ? err.message : 'Failed to poll debug session.' }));
          }
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setState({ status: 'error', error: err instanceof Error ? err.message : 'Failed to start debug session.', traces: [] });
    }
  }, [link, refreshTraces]);

  const stop = useCallback(async () => {
    if (!link || !state.sessionId) {
      return;
    }
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
    }
    try {
      const pat = await window.main.secretStorage.getSecret('konnectPat');
      if (pat) {
        await cancelDebugSession(pat, link.controlPlaneId, state.sessionId, link.region);
      }
    } finally {
      setState({ status: 'idle', traces: [] });
    }
  }, [link, state.sessionId]);

  return { ...state, start, stop };
}

// Shared shape, provided once at the workspace-route level (see
// organization.$organizationId.project.$projectId.workspace.$workspaceId.tsx)
// via KonnectDebuggerContext, so it survives navigating between requests —
// unlike a plain prop passed down from request-pane.tsx, which used to get
// remounted (and its session lost) both by switching requests AND by the
// response-triggered `key={uniqueKey}` remount bug fixed earlier today.
export type UseKonnectDebuggerResult = ReturnType<typeof useKonnectDebugger>;

export const KonnectDebuggerContext = createContext<{
  link: KonnectControlPlaneLink | null;
  debuggerState: UseKonnectDebuggerResult;
} | null>(null);

// Returns null when rendered outside a KonnectDebuggerContext.Provider
// (shouldn't happen in practice — the provider wraps the whole workspace
// route — but callers like RequestDebuggerTab handle null defensively
// rather than throwing, since a UI glitch here shouldn't crash the pane).
export function useKonnectDebuggerContext() {
  return useContext(KonnectDebuggerContext);
}
