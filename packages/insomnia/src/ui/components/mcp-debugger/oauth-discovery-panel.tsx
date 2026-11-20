import type { McpRequest } from 'insomnia-data';
import React, { type FC, useState } from 'react';
import { Button, Dialog, Heading, Input, Modal, ModalOverlay, TextField, Tooltip, TooltipTrigger } from 'react-aria-components';

import type { OAuthDiscoveryResult, OAuthExchange, OAuthStep, OAuthStepStatus } from '~/main/mcp-debugger/oauth-discovery';
import { Icon } from '~/ui/components/icon';
import { tryToInterpolateRequestAndCollectSensitiveValues } from '~/ui/utils/try-interpolate';

import { JsonView } from './json-view';

// Task 4348 S5: a lightweight OAuth wizard in a modal, opened from the Auth tab when no auth type is chosen.
//   Step 1 Discover (S5a): 401 -> protected resource metadata -> authorization server metadata (+ what a client can do).
//   Step 2 Register & authorize (S5b): client registration, browser authorize redirect, response checks.
//   Step 3 will be the token exchange, refresh and step-up (S5c).
// Each step shows its sub-steps with the raw exchange behind them.
// PROTOTYPE-MOCK: lives beside the legacy auth type picker rather than as its own auth type; results are not persisted.

const DOT: Record<OAuthStepStatus, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  skipped: 'bg-gray-500',
};
const LEVEL_TEXT = { info: '', warn: 'text-amber-500', error: 'text-red-500' } as const;

const ExchangeView: FC<{ exchange: OAuthExchange }> = ({ exchange }) => (
  <div className="flex flex-col gap-1 rounded-xs border border-solid border-(--hl-md) p-2 text-xs" data-testid="mcp-oauth-exchange">
    <div className="font-mono">
      {exchange.request.method} {exchange.request.url}
    </div>
    {exchange.error ? (
      <div className="text-red-500">{exchange.error}</div>
    ) : (
      <>
        <div className="font-mono text-(--hl)">
          {exchange.response?.status} · {exchange.durationMs} ms
        </div>
        <details>
          <summary className="cursor-pointer text-(--hl)">Response headers</summary>
          <JsonView value={exchange.response?.headers} />
        </details>
        {exchange.response?.body !== undefined && (
          <details open={typeof exchange.response.body === 'object'}>
            <summary className="cursor-pointer text-(--hl)">Response body</summary>
            {typeof exchange.response.body === 'string' ? (
              <pre className="whitespace-pre-wrap">{exchange.response.body}</pre>
            ) : (
              <JsonView value={exchange.response.body} />
            )}
          </details>
        )}
      </>
    )}
  </div>
);

const StepView: FC<{ step: OAuthStep }> = ({ step }) => (
  <li className="flex flex-col gap-1.5 border-b border-solid border-(--hl-md) px-3 py-2" data-testid="mcp-oauth-step" data-step={step.id}>
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[step.status]}`} />
      <span className="font-semibold">{step.title}</span>
      <span className="ml-auto truncate text-xs text-(--hl)" data-testid="mcp-oauth-step-summary">
        {step.summary}
      </span>
    </div>
    {step.findings.length > 0 && (
      <ul className="ml-4 flex list-disc flex-col gap-1 pl-4 text-xs marker:text-(--hl)">
        {step.findings.map(finding => (
          <li key={`${finding.level}:${finding.text}`} className={LEVEL_TEXT[finding.level]}>
            {finding.text}
          </li>
        ))}
      </ul>
    )}
    {step.exchanges.length > 0 && (
      <details className="pl-4">
        <summary className="cursor-pointer text-xs text-(--hl)">
          {step.exchanges.length} request{step.exchanges.length === 1 ? '' : 's'}
        </summary>
        <div className="mt-1 flex flex-col gap-1">
          {step.exchanges.map(exchange => (
            <ExchangeView key={`${exchange.request.method} ${exchange.request.url}`} exchange={exchange} />
          ))}
        </div>
      </details>
    )}
  </li>
);

const tooltipClass =
  'max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none';
const purpleButton =
  'shrink-0 rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-sm text-(--color-font-surprise) hover:brightness-75 disabled:opacity-50';
const smallButton = 'rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)';

interface StepSummary {
  label: string;
  tone: OAuthStepStatus | 'idle' | 'active';
}

const TONE_CLASS: Record<StepSummary['tone'], string> = {
  ok: 'text-green-500',
  warn: 'text-amber-500',
  error: 'text-red-500',
  skipped: 'text-(--hl)',
  idle: 'text-(--hl)',
  active: 'text-(--color-font)',
};

/** One line saying where a wizard step stands, e.g. "Complete, 3 of 3 successful". A warning still counts as successful. */
export const summarizeSteps = (
  steps: OAuthStep[],
  total: number,
  { active, idle }: { active?: string; idle: string },
): StepSummary => {
  if (active) {
    return { label: active, tone: 'active' };
  }
  if (steps.length === 0) {
    return { label: idle, tone: 'idle' };
  }
  const successful = steps.filter(step => step.status === 'ok' || step.status === 'warn').length;
  const warnings = steps.filter(step => step.status === 'warn').length;
  const counts = `${successful} of ${total} successful${warnings ? ` (${warnings} with warnings)` : ''}`;
  if (steps.some(step => step.status === 'error')) {
    return { label: `Stopped, ${counts}`, tone: 'error' };
  }
  if (steps.some(step => step.status === 'skipped')) {
    return { label: `Not applicable, ${counts}`, tone: 'skipped' };
  }
  return successful === total
    ? { label: `Complete, ${counts}`, tone: warnings ? 'warn' : 'ok' }
    : { label: `In progress, ${counts}`, tone: 'active' };
};

const WizardStep: FC<{ number: number; title: string; summary: StepSummary; action?: React.ReactNode; children: React.ReactNode }> = ({
  number,
  title,
  summary,
  action,
  children,
}) => (
  <section className="flex flex-col rounded-md border border-solid border-(--hl-md)" data-testid={`mcp-oauth-wizard-step-${number}`}>
    <header className="flex items-center gap-2 border-b border-solid border-(--hl-md) bg-(--hl-xs) px-3 py-2">
      <span className="text-sm font-bold">
        Step {number} · {title}
      </span>
      <span className={`ml-auto text-xs ${TONE_CLASS[summary.tone]}`} data-testid={`mcp-oauth-wizard-step-${number}-status`}>
        {summary.label}
      </span>
      {action}
    </header>
    {children}
  </section>
);

export const OAuthDiscoveryPanel: FC<{ request: McpRequest; environmentId: string }> = ({ request, environmentId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [result, setResult] = useState<OAuthDiscoveryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [flowSteps, setFlowSteps] = useState<OAuthStep[]>([]);
  const [authorizing, setAuthorizing] = useState(false);
  const [clientId, setClientId] = useState('');

  const authorize = async () => {
    if (!result?.context) {
      return;
    }
    setAuthorizing(true);
    setFailure(null);
    setFlowSteps([]);
    try {
      setFlowSteps(await window.main.mcpDebugger.oauthAuthorize({ requestId: request._id, context: result.context, clientId }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthorizing(false);
    }
  };

  const discover = async () => {
    setRunning(true);
    setFailure(null);
    setFlowSteps([]);
    setResult(null);
    try {
      const rendered = await tryToInterpolateRequestAndCollectSensitiveValues({
        request,
        environmentId,
        payload: { url: request.url, headers: request.headers },
      });
      if (!rendered) {
        return;
      }
      setResult(
        await window.main.mcpDebugger.oauthDiscover({
          url: rendered.rendered.url,
          headers: (rendered.rendered.headers as { name: string; value: string; disabled?: boolean }[]).filter(h => !h.disabled),
        }),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const open = () => {
    setIsOpen(true);
    void discover();
  };

  const onOpenChange = (next: boolean) => {
    setIsOpen(next);
    if (!next && authorizing) {
      void window.main.mcpDebugger.oauthCancel({ requestId: request._id });
    }
  };

  const canAuthorize = !!result?.context && !running;
  const discoverySummary = summarizeSteps(result?.steps ?? [], 3, { active: running ? 'Running…' : undefined, idle: 'Not started' });
  const authorizeSummary = summarizeSteps(flowSteps, 3, {
    active: authorizing ? 'Waiting for the browser…' : undefined,
    idle: canAuthorize ? 'Ready' : 'Waiting on Step 1',
  });

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-solid border-(--hl-md) px-3 py-2" data-testid="mcp-oauth-discovery">
      <TooltipTrigger delay={200}>
        <Button className={purpleButton} onPress={open} isDisabled={!request.url} data-testid="mcp-oauth-discover">
          Discover OAuth
        </Button>
        <Tooltip offset={8} className={tooltipClass}>
          Open the OAuth debugger: probe this server without credentials, then register a client and authorize in your
          browser, with every request and response visible.
        </Tooltip>
      </TooltipTrigger>
      <ModalOverlay
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        isDismissable
        className="fixed top-0 left-0 z-10 flex h-(--visual-viewport-height) w-full items-center justify-center bg-black/30"
      >
        <Modal className="flex h-[min(46rem,calc(100%-var(--padding-xl)))] w-[min(52rem,calc(100%-var(--padding-xl)))] flex-col rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) p-(--padding-lg) text-(--color-font)">
          <Dialog className="flex h-full flex-1 flex-col gap-3 overflow-hidden outline-hidden" aria-label="OAuth debugger">
            {({ close }) => (
              <>
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <Heading slot="title" className="text-xl">
                    OAuth debugger
                  </Heading>
                  <Button
                    aria-label="Close"
                    className="flex aspect-square h-6 shrink-0 items-center justify-center rounded-xs text-sm text-(--color-font) ring-1 ring-transparent transition-all hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset"
                    onPress={close}
                  >
                    <Icon icon="x" />
                  </Button>
                </div>
                <div className="flex flex-1 flex-col gap-3 overflow-y-auto" data-testid="mcp-oauth-wizard">
                  <WizardStep
                    number={1}
                    title="Discover"
                    summary={discoverySummary}
                    action={
                      <Button className={smallButton} onPress={discover} isDisabled={running} data-testid="mcp-oauth-rediscover">
                        {running ? 'Discovering…' : 'Run again'}
                      </Button>
                    }
                  >
                    {result ? (
                      <ol className="flex flex-col" data-testid="mcp-oauth-steps">
                        {result.steps.map(step => (
                          <StepView key={step.id} step={step} />
                        ))}
                      </ol>
                    ) : (
                      <p className="px-3 py-2 text-xs text-(--hl)">{running ? 'Discovering…' : 'Nothing yet.'}</p>
                    )}
                  </WizardStep>
                  <WizardStep
                    number={2}
                    title="Register & authorize"
                    summary={authorizeSummary}
                    action={
                      <TooltipTrigger delay={200}>
                        <Button
                          className={purpleButton}
                          onPress={authorizing ? () => window.main.mcpDebugger.oauthCancel({ requestId: request._id }) : authorize}
                          isDisabled={!authorizing && !canAuthorize}
                          data-testid="mcp-oauth-authorize"
                        >
                          {authorizing ? 'Cancel' : 'Register & authorize'}
                        </Button>
                        <Tooltip offset={8} className={tooltipClass}>
                          Register this client (or use the client ID you enter), open the authorization page in your
                          browser, and check the response that comes back (state, iss). It stops once a code arrives; no
                          token is requested yet.
                        </Tooltip>
                      </TooltipTrigger>
                    }
                  >
                    {canAuthorize || authorizing || flowSteps.length > 0 ? (
                      <>
                        <div className="px-3 py-2">
                          <TextField aria-label="Client ID" value={clientId} onChange={setClientId} isDisabled={authorizing}>
                            <Input
                              placeholder="Client ID or CIMD URL (blank = register automatically)"
                              className="w-full rounded-xs border border-solid border-(--hl-md) bg-transparent px-2 py-1 text-xs"
                              data-testid="mcp-oauth-client-id"
                            />
                          </TextField>
                        </div>
                        {authorizing && (
                          <p className="px-3 pb-2 text-xs text-(--hl)" data-testid="mcp-oauth-waiting">
                            Waiting for you to finish in the browser… (Cancel to stop)
                          </p>
                        )}
                        {flowSteps.length > 0 && (
                          <ol className="flex flex-col">
                            {flowSteps.map(step => (
                              <StepView key={step.id} step={step} />
                            ))}
                          </ol>
                        )}
                      </>
                    ) : (
                      <p className="px-3 py-2 text-xs text-(--hl)">Finish Step 1 successfully to continue.</p>
                    )}
                  </WizardStep>
                  {failure && <p className="text-xs text-red-500">{failure}</p>}
                </div>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
};
