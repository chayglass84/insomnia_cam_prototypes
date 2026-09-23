import React, { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { createPortal } from 'react-dom';

import { DEFAULT_SESSION_DURATION_SECS, type KonnectControlPlaneLink, type UseKonnectDebuggerResult } from '../../hooks/use-konnect-debugger';
import { KongLogo } from '../kong-logo';

interface Props {
  link: KonnectControlPlaneLink | null;
  debuggerState: UseKonnectDebuggerResult;
}

const DOCS_URL = 'https://developer.konghq.com/observability/debugger/';

// PROTOTYPE SHORTCUT / PLACEMENT NOTE: the ask was "put this in the left
// navigation bar, even as a floating window if it can't fit." The left nav
// (project-navigation-sidebar.tsx) is a huge, org-wide component (every
// project/collection/request in the tree) with no existing access to "the
// active Konnect control plane" concept. Threading it through would mean
// plumbing that state into a shared, unrelated, already-complex component —
// a much bigger and riskier change than this task called for. Took the
// explicitly-offered fallback instead: `fixed` floating panel, anchored
// bottom-left so it visually reads as "part of the left nav" (mirrors the
// toast notification region's `fixed right-4 bottom-4` on the opposite
// corner — see toast-notification.tsx).
//
// BUG FIXED 2026-09-23: this used to render inline in request-pane.tsx's
// JSX and appeared BEHIND the sidebar's git/sync status row despite having
// `position: fixed` + `z-50` — some ancestor between here and <body> almost
// certainly has a `transform`/`filter`/`will-change` (used for a sidebar
// animation elsewhere in this codebase), which makes CSS treat THAT
// ancestor as the fixed-positioning containing block instead of the real
// viewport, trapping this panel's stacking context below content outside
// that ancestor. Portaling straight to `document.body` sidesteps the
// question entirely — this is now guaranteed to be positioned against the
// real viewport and painted in the last, top-most stacking context.
// (This was never root-caused to a specific ancestor — if it happens again
// elsewhere, that's the first thing to check for.)
export function KonnectDebuggerBanner({ link, debuggerState }: Props) {
  const { status, error, startedAt, durationSecs, traces, start, stop } = debuggerState;
  const [dismissed, setDismissed] = useState(false);
  const [durationInput, setDurationInput] = useState(String(DEFAULT_SESSION_DURATION_SECS));
  const [elapsedSecs, setElapsedSecs] = useState(0);

  useEffect(() => {
    if (status !== 'in_progress' || !startedAt) {
      return;
    }
    const tick = () => setElapsedSecs(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [status, startedAt]);

  // Re-show automatically once there's something new to see — dismissing an
  // idle prompt shouldn't also hide a session you started five minutes ago.
  useEffect(() => {
    if (status === 'in_progress' || status === 'starting') {
      setDismissed(false);
    }
  }, [status]);

  if (!link || status === 'not-linked' || dismissed) {
    return null;
  }

  const parsedDuration = Number.parseInt(durationInput, 10);
  const isDurationValid = Number.isFinite(parsedDuration) && parsedDuration >= 10 && parsedDuration <= 1800;

  return createPortal(
    <div className="fixed bottom-12 left-4 z-[9999] flex h-[220px] w-80 flex-col rounded-lg border border-solid border-(--hl-md) bg-(--color-bg) p-4 shadow-lg">
      {/* Header: identity + docs link + dismiss — always the same. */}
      <div className="mb-3 flex items-center gap-2">
        <KongLogo width={30} height={28} />
        <span className="text-base font-semibold text-(--color-font)">Konnect Debugger</span>
        <Button
          className="ml-auto shrink-0 text-xs text-(--hl) underline hover:text-(--color-font)"
          onPress={() => window.main.openInBrowser(DOCS_URL)}
        >
          Learn more
        </Button>
        <Button
          aria-label="Dismiss"
          className="shrink-0 rounded-xs px-1 text-(--hl) hover:bg-(--hl-sm) hover:text-(--color-font)"
          onPress={() => {
            // Dismissing a running session cancels it — leaving it running
            // with no visible way to see/stop it felt worse than ending it.
            // Idle/completed/error dismissals just hide the panel.
            if (status === 'in_progress') {
              stop();
            }
            setDismissed(true);
          }}
        >
          ✕
        </Button>
      </div>

      {/* Body: the one thing that matters right now, given room to breathe. */}
      <div className="flex flex-1 flex-col justify-center gap-3 text-sm">
        {status === 'idle' && (
          <>
            <p className="text-(--hl)">Capture live traffic across this control plane to see per-plugin latency.</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={10}
                max={1800}
                value={durationInput}
                onChange={e => setDurationInput(e.target.value)}
                className="w-16 shrink-0 rounded-xs border border-solid border-(--hl-md) bg-(--color-bg) px-1 py-1 text-right text-(--color-font)"
                aria-label="Session duration in seconds"
              />
              <span className="shrink-0 text-(--hl)">seconds</span>
              <Button
                isDisabled={!isDurationValid}
                // Same theme as the request pane's "Send" button (see
                // request-url-bar.tsx) — deliberately, so this reads as the
                // one prominent action in the panel rather than another
                // quiet outlined button.
                className="ml-auto shrink-0 rounded-xs bg-(--color-surprise) px-3 py-1 font-medium text-(--color-font-surprise) disabled:opacity-50"
                onPress={() => start(parsedDuration)}
              >
                Start
              </Button>
            </div>
          </>
        )}

        {status === 'starting' && <p className="text-(--hl)">Starting debug session…</p>}

        {status === 'in_progress' && (
          <>
            <p className="text-(--hl)">
              Capturing… {elapsedSecs}s / {durationSecs}s
            </p>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-(--hl)">Send any request against this CP now.</span>
              <Button
                className="shrink-0 rounded-xs border border-solid border-(--hl-md) px-3 py-1 hover:bg-(--hl-sm)"
                onPress={stop}
              >
                Cancel
              </Button>
            </div>
          </>
        )}

        {status === 'completed' && (
          <>
            <p className="text-(--hl)">
              {traces.length > 0
                ? `Captured ${traces.length} request${traces.length === 1 ? '' : 's'}.`
                : 'No matching requests captured this time.'}
            </p>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-(--hl)">See the "Konnect Debugger" tab on a response.</span>
              <Button
                className="shrink-0 rounded-xs border border-solid border-(--hl-md) px-3 py-1 hover:bg-(--hl-sm)"
                onPress={() => start()}
              >
                Restart
              </Button>
            </div>
          </>
        )}

        {status === 'error' && (
          <>
            <p className="truncate text-(--color-danger)" title={error}>
              Error: {error}
            </p>
            <Button
              className="self-start rounded-xs border border-solid border-(--hl-md) px-3 py-1 hover:bg-(--hl-sm)"
              onPress={() => start()}
            >
              Retry
            </Button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
