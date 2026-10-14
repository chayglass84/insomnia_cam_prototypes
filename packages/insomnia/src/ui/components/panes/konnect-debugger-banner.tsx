import React, { useState } from 'react';
import { Button } from 'react-aria-components';
import { createPortal } from 'react-dom';

import type { KonnectControlPlaneLink, UseKonnectDebuggerResult } from '../../hooks/use-konnect-debugger';
import { KongLogo } from '../kong-logo';

interface Props {
  link: KonnectControlPlaneLink | null;
  debuggerState: UseKonnectDebuggerResult;
}

const DOCS_URL = 'https://developer.konghq.com/observability/debugger/';

// DISCOVERABILITY ONLY (2026-10-14 change): this panel used to own the whole
// configure/start/stop experience. That all lives in the Response pane's
// "Debugger" tab now (see request-debugger-tab.tsx) — this panel just tells
// you the feature exists and where to find it, then gets out of the way.
// It only shows while no session is running; once a session is going, the
// tab is the single place to watch/stop it.
//
// PLACEMENT NOTE: the original ask was "put this in the left navigation
// bar, even as a floating window if it can't fit." The left nav
// (project-navigation-sidebar.tsx) has no access to "the active Konnect
// control plane", so this stayed a `fixed` floating panel, bottom-left.
//
// It's portaled to `document.body` because, rendered inline, it appeared
// BEHIND the sidebar's git/sync row despite `position: fixed` + `z-50` —
// almost certainly an ancestor with a `transform`/`filter`/`will-change`
// becoming the fixed-positioning containing block. Never root-caused to a
// specific ancestor; if "should be on top but isn't" shows up elsewhere,
// check for that first.
//
// PROTOTYPE SHORTCUT: dismissal is plain component state, so the panel
// reappears the next time the workspace route remounts. Persist it (e.g. a
// Settings boolean) if that turns out to be annoying.
export function KonnectDebuggerBanner({ link, debuggerState }: Props) {
  const { status } = debuggerState;
  const [dismissed, setDismissed] = useState(false);

  if (!link || status !== 'idle' || dismissed) {
    return null;
  }

  return createPortal(
    <div className="fixed bottom-12 left-4 z-[9999] flex w-80 flex-col gap-3 rounded-lg border border-solid border-(--hl-md) bg-(--color-bg) p-4 shadow-lg">
      <div className="flex items-center gap-2">
        <KongLogo width={20} height={18} />
        <span className="flex-1 text-base font-semibold text-(--color-font)">Kong Debugger</span>
        <Button
          aria-label="Dismiss"
          className="shrink-0 rounded-xs px-1 text-(--hl) hover:bg-(--hl-sm) hover:text-(--color-font)"
          onPress={() => setDismissed(true)}
        >
          ✕
        </Button>
      </div>
      <p className="text-sm text-(--hl)">
        Capture live traffic across this control plane to see per-plugin latency. Open the <b>Debugger</b> tab next to
        a request's response to start a session.
      </p>
      <div className="flex items-center justify-between">
        <Button
          className="text-xs text-(--hl) underline hover:text-(--color-font)"
          onPress={() => window.main.openInBrowser(DOCS_URL)}
        >
          Learn more about Kong Debugger
        </Button>
        <Button
          className="shrink-0 rounded-xs bg-(--color-surprise) px-3 py-1 text-sm font-medium text-(--color-font-surprise)"
          onPress={() => setDismissed(true)}
        >
          Got it
        </Button>
      </div>
    </div>,
    document.body,
  );
}
