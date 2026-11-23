import type { McpRequest } from 'insomnia-data';
import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay, Tooltip, TooltipTrigger } from 'react-aria-components';

import type {
  CheckGroup,
  CheckStatus,
  ConformanceCheck,
  ConformanceReport,
  VerdictLevel,
  VersionOutcome,
} from '~/common/mcp-debugger/conformance';
import { versionBadge } from '~/common/mcp-debugger/deprecations';
import { isSupportedVersion } from '~/common/mcp-debugger/versions';
import { Icon } from '~/ui/components/icon';

import { buildMcpConnectParams } from './build-connect-params';
import { JsonView } from './json-view';

// Task 4348 S6b: the conformance report. Opens from the URL bar, works before or after Connect (a server that is a year
// out of date is often the one that will not connect), and answers one question first: is this server current, and if
// not, how far behind and where. Every verdict has its raw request/response one click away.

const smallButton = 'rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm) disabled:opacity-50';
const tooltipClass =
  'max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none';

/**
 * The URL bar button that opens the report. When the connected server speaks an older protocol version the whole button
 * turns amber with a warning icon (S7c), since the report is exactly what explains what that server is missing.
 */
export const ConformanceButton: FC<{ onOpen: () => void; isDisabled?: boolean; connectedVersion?: string }> = ({ onOpen, isDisabled, connectedVersion }) => {
  const badge = isSupportedVersion(connectedVersion) ? versionBadge(connectedVersion) : null;
  const old = badge !== null && badge.tone !== 'newest';
  return (
    <TooltipTrigger delay={200}>
      <Button
        className={`flex shrink-0 items-center gap-1.5 rounded-xs border border-solid px-(--padding-sm) py-0.5 text-xs disabled:opacity-50 ${
          old
            ? 'border-amber-500/70 bg-amber-500/15 text-amber-500 hover:bg-amber-500/25'
            : 'border-(--hl-md) hover:bg-(--hl-sm)'
        }`}
        onPress={onOpen}
        isDisabled={isDisabled}
        data-testid="mcp-conformance-open"
        data-old={old}
      >
        {old && <i className="fa fa-triangle-exclamation" />}
        Validate Server
      </Button>
      <Tooltip offset={8} className={tooltipClass}>
        {old
          ? `${badge.tooltip} Click to run the report.`
          : 'Check how current and spec-compliant this server is: which MCP versions it accepts, where it falls short of the newest spec, and where it only looks current. Read-only: no tools are called.'}
      </Tooltip>
    </TooltipTrigger>
  );
};

const VERDICT_STYLE: Record<VerdictLevel, { box: string; icon: string }> = {
  current: { box: 'border-green-500/50 bg-green-500/10', icon: 'text-green-500' },
  behind: { box: 'border-amber-500/50 bg-amber-500/10', icon: 'text-amber-500' },
  'legacy-transport': { box: 'border-red-500/50 bg-red-500/10', icon: 'text-red-500' },
  'auth-blocked': { box: 'border-(--hl-md) bg-(--hl-xs)', icon: 'text-(--hl)' },
  unreachable: { box: 'border-red-500/50 bg-red-500/10', icon: 'text-red-500' },
  unknown: { box: 'border-amber-500/50 bg-amber-500/10', icon: 'text-amber-500' },
};
const VERDICT_ICON: Record<VerdictLevel, string> = {
  current: 'fa-circle-check',
  behind: 'fa-clock-rotate-left',
  'legacy-transport': 'fa-triangle-exclamation',
  'auth-blocked': 'fa-lock',
  unreachable: 'fa-circle-xmark',
  unknown: 'fa-circle-question',
};

const STATUS_ICON: Record<CheckStatus, { icon: string; className: string; label: string }> = {
  pass: { icon: 'fa-circle-check', className: 'text-green-500', label: 'Pass' },
  warn: { icon: 'fa-triangle-exclamation', className: 'text-amber-500', label: 'Warning' },
  fail: { icon: 'fa-circle-xmark', className: 'text-red-500', label: 'Fail' },
  info: { icon: 'fa-circle-info', className: 'text-(--hl)', label: 'Info' },
  skipped: { icon: 'fa-circle-minus', className: 'text-(--hl)', label: 'Skipped' },
};

const OUTCOME: Record<VersionOutcome, { label: string; className: string }> = {
  accepted: { label: 'Accepted', className: 'text-green-500' },
  'via-sse': { label: 'Accepted via HTTP+SSE', className: 'text-amber-500' },
  'counter-offered': { label: 'Counter-offered', className: 'text-amber-500' },
  rejected: { label: 'Not supported', className: 'text-(--hl)' },
  unknown: { label: 'Unknown', className: 'text-amber-500' },
};

const GROUP_TITLES: Record<CheckGroup, string> = {
  modern: '2026-07-28 (stateless protocol)',
  session: 'Session protocols (2025-11-25 and earlier)',
  transport: 'Transport',
  auth: 'Authentication',
};
const GROUP_ORDER: CheckGroup[] = ['modern', 'session', 'transport', 'auth'];

const CheckRow: FC<{ check: ConformanceCheck }> = ({ check }) => {
  const style = STATUS_ICON[check.status];
  return (
    <div className="flex gap-2 py-1.5" data-testid={`mcp-conformance-check-${check.id}`} data-status={check.status}>
      <i className={`fa ${style.icon} mt-0.5 w-4 shrink-0 text-center ${style.className}`} title={style.label} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span>{check.title}</span>
          {check.version && (
            <span className="shrink-0 rounded-xs border border-solid border-(--hl-md) px-1 font-mono text-[10px] text-(--hl)">{check.version}</span>
          )}
        </div>
        <p className="text-xs text-(--hl)">{check.detail}</p>
        {check.probe && (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-(--hl)">Request and response</summary>
            <div className="mt-1 flex flex-col gap-1">
              <JsonView value={check.probe.request} />
              <JsonView value={check.probe.error ? { error: check.probe.error } : check.probe.response} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
};

export const ConformanceModal: FC<{
  request: McpRequest;
  environmentId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ request, environmentId, isOpen, onOpenChange }) => {
  const [report, setReport] = useState<ConformanceReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  const run = useCallback(async () => {
    const id = ++runId.current;
    setRunning(true);
    setError(null);
    try {
      const params = await buildMcpConnectParams({ request, environmentId });
      if (!params) {
        setError('Could not render the URL and headers (check the request for template errors).');
        return;
      }
      const next = await window.main.mcpDebugger.runConformance({ url: params.url, headers: params.headers });
      if (id === runId.current) {
        setReport(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === runId.current) {
        setRunning(false);
      }
    }
  }, [environmentId, request]);

  // Run on open; a different request starts from a clean slate.
  useEffect(() => {
    if (isOpen) {
      setReport(null);
      void run();
    }
    // Only when the dialog opens (or the request changes), not on every re-render of `run`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, request._id]);

  const checksByGroup = GROUP_ORDER.map(group => ({ group, checks: report?.checks.filter(c => c.group === group) ?? [] })).filter(g => g.checks.length > 0);
  const verdict = report?.verdict;

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed top-0 left-0 z-10 flex h-(--visual-viewport-height) w-full items-center justify-center bg-black/30"
    >
      <Modal className="flex h-[min(46rem,calc(100%-var(--padding-xl)))] w-[min(52rem,calc(100%-var(--padding-xl)))] flex-col rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) p-(--padding-lg) text-(--color-font)">
        <Dialog className="flex h-full flex-1 flex-col gap-3 overflow-hidden outline-hidden" aria-label="Conformance report">
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2">
                <Heading slot="title" className="text-xl">
                  Conformance report
                </Heading>
                <div className="flex items-center gap-2">
                  <Button className={smallButton} onPress={run} isDisabled={running} data-testid="mcp-conformance-rerun">
                    {running ? 'Checking…' : 'Run again'}
                  </Button>
                  <Button
                    aria-label="Close"
                    className="flex aspect-square h-6 shrink-0 items-center justify-center rounded-xs text-sm text-(--color-font) ring-1 ring-transparent transition-all hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset"
                    onPress={close}
                  >
                    <Icon icon="x" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-4 overflow-y-auto" data-testid="mcp-conformance-report">
                <p className="truncate font-mono text-xs text-(--hl)">{report?.url ?? request.url}</p>
                {error && <p className="text-sm text-red-500">{error}</p>}
                {running && !report && <p className="text-sm text-(--hl)">Probing the server…</p>}
                {verdict && (
                  <div className={`flex gap-3 rounded-sm border border-solid p-3 ${VERDICT_STYLE[verdict.level].box}`} data-testid="mcp-conformance-verdict" data-level={verdict.level}>
                    <i className={`fa ${VERDICT_ICON[verdict.level]} mt-0.5 text-lg ${VERDICT_STYLE[verdict.level].icon}`} />
                    <div>
                      <div className="font-bold">{verdict.headline}</div>
                      <p className="text-sm">{verdict.detail}</p>
                    </div>
                  </div>
                )}
                {report && (
                  <section>
                    <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">Protocol versions</h4>
                    <div className="flex flex-col divide-y divide-(--hl-sm) rounded-xs border border-solid border-(--hl-md)" data-testid="mcp-conformance-versions">
                      {report.versions.map(v => (
                        <div key={v.version} className="flex items-baseline gap-3 px-2 py-1.5 text-sm" data-testid={`mcp-conformance-version-${v.version}`} data-outcome={v.outcome}>
                          <span className="w-24 shrink-0 font-mono">{v.version}</span>
                          <span className={`w-44 shrink-0 ${OUTCOME[v.outcome].className}`}>{OUTCOME[v.outcome].label}</span>
                          <span className="min-w-0 text-xs text-(--hl)">{v.note}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                {checksByGroup.map(({ group, checks }) => (
                  <section key={group}>
                    <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">{GROUP_TITLES[group]}</h4>
                    <div className="divide-y divide-(--hl-sm)">
                      {checks.map(check => (
                        <CheckRow key={check.id} check={check} />
                      ))}
                    </div>
                  </section>
                ))}
                {report && <p className="text-xs text-(--hl)">Read-only: handshakes, list calls, a ping and a deliberately unknown method. No tool is ever called. These checks are our reading of the specs, not a certification.</p>}
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
