import React, { type FC, type PropsWithChildren } from 'react';

/**
 * Task 4348 convention: any faked/not-yet-built surface is wrapped in this so it is obvious IN THE UI where the
 * prototype stops. Every use must also have a `// PROTOTYPE-MOCK: ...` comment in code and an entry in 4348.md.
 */
export const PrototypeMock: FC<PropsWithChildren<{ reason: string; inline?: boolean }>> = ({ reason, inline, children }) => (
  <div
    className={inline ? 'inline-flex items-center gap-2' : 'flex flex-col gap-2 rounded-md border border-dashed border-amber-500/70 bg-amber-500/5 p-3'}
    data-testid="prototype-mock"
  >
    <span className="w-fit rounded-xs bg-amber-500/20 px-1.5 py-0.5 text-xs font-semibold tracking-wide text-amber-500 uppercase">
      Prototype mock
    </span>
    <span className="text-xs text-(--hl)">{reason}</span>
    {children}
  </div>
);
