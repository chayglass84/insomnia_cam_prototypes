import type { McpRequest } from 'insomnia-data';
import React, { type FC, useEffect, useState } from 'react';
import { Button, Dialog, Heading, Input, Modal, ModalOverlay, TextField, Tooltip, TooltipTrigger } from 'react-aria-components';

import { decodeJwt, JWT_TIME_CLAIMS } from '~/common/mcp-debugger/jwt';
import { clientsForIssuer, forgetClient, isClientSaved, saveClient } from '~/common/mcp-debugger/oauth-clients';
import type { OAuthDiscoveryResult, OAuthExchange, OAuthStep, OAuthStepStatus, OAuthTokens } from '~/main/mcp-debugger/oauth-discovery';
import { Dropdown, DropdownItem, DropdownSection, ItemContent } from '~/ui/components/base/dropdown';
import { Icon } from '~/ui/components/icon';
import { useRequestPatcher } from '~/ui/hooks/use-request';
import { tryToInterpolateRequestAndCollectSensitiveValues } from '~/ui/utils/try-interpolate';

import { JsonView } from './json-view';
import { splitUrls } from './url-text';

// Task 4348 S5: a lightweight OAuth wizard in a modal, opened from the Auth tab when no auth type is chosen.
//   Step 1 Discover (S5a): 401 -> protected resource metadata -> authorization server metadata (+ what a client can do).
//   Step 2 Register & authorize (S5b): client registration, browser authorize redirect, response checks.
//   Step 3 Get a token (S5c): code exchange, proof the MCP server accepts it, refresh.
// Each step shows its sub-steps with the raw exchange behind them.
// PROTOTYPE-MOCK: lives beside the legacy auth type picker rather than as its own auth type; results are not persisted.

const DOT: Record<OAuthStepStatus, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  skipped: 'bg-gray-500',
};
const LEVEL_TEXT = { info: '', warn: 'text-amber-500', error: 'text-red-500' } as const;

const CopyButton: FC<{ text: string; label: string; testId?: string }> = ({ text, label, testId }) => {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      aria-label={`Copy ${label}`}
      className="shrink-0 rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)"
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch (error) {
          console.error('[mcp-debugger] copy failed', error);
        }
      }}
      data-testid={testId}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
};

/** A URL in its own box with a Copy button, so it is easy to read, select and paste. */
const UrlBox: FC<{ url: string }> = ({ url }) => (
  <div className="flex min-w-0 items-start gap-2" data-testid="mcp-oauth-url">
    <code className="min-w-0 flex-1 rounded-xs bg-(--hl-xs) px-2 py-1 font-mono text-xs break-all select-all">{url}</code>
    <CopyButton text={url} label="URL" />
  </div>
);

const ExchangeView: FC<{ exchange: OAuthExchange }> = ({ exchange }) => (
  <div className="flex min-w-0 flex-col gap-1 rounded-xs border border-solid border-(--hl-md) p-2 text-xs" data-testid="mcp-oauth-exchange">
    <div className="flex min-w-0 items-start gap-2">
      <span className="shrink-0 rounded-xs border border-solid border-(--hl-md) px-1.5 py-1 font-mono">{exchange.request.method}</span>
      <div className="min-w-0 flex-1">
        <UrlBox url={exchange.request.url} />
      </div>
    </div>
    {exchange.error ? (
      <div className="text-red-500 [overflow-wrap:anywhere]">{exchange.error}</div>
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
              <pre className="[overflow-wrap:anywhere] whitespace-pre-wrap">{exchange.response.body}</pre>
            ) : (
              <JsonView value={exchange.response.body} />
            )}
          </details>
        )}
      </>
    )}
  </div>
);

const formatExpiry = (expiresAt: number) => {
  const seconds = Math.round((expiresAt - Date.now()) / 1000);
  const when = new Date(expiresAt).toLocaleTimeString();
  return seconds > 0 ? `${when} (in ${seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`})` : `${when} (expired)`;
};

const TokenRow: FC<{ label: string; value: string; testId: string }> = ({ label, value, testId }) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold">{label}</span>
      <span className="ml-auto" />
      <CopyButton text={value} label={label} testId={`${testId}-copy`} />
    </div>
    <code className="rounded-xs bg-(--hl-xs) p-2 text-xs break-all select-all" data-testid={testId}>
      {value}
    </code>
  </div>
);

/** Full, copyable tokens for a developer debugging their own server. Decoded when the access token is a JWT (never verified). */
const TokenCard: FC<{ tokens: OAuthTokens }> = ({ tokens }) => {
  const jwt = decodeJwt(tokens.accessToken);
  return (
    <div className="mx-3 mb-1 flex flex-col gap-2 rounded-xs border border-solid border-(--hl-md) p-2" data-testid="mcp-oauth-tokens">
      <TokenRow label="Access token" value={tokens.accessToken} testId="mcp-oauth-access-token" />
      {tokens.refreshToken && <TokenRow label="Refresh token" value={tokens.refreshToken} testId="mcp-oauth-refresh-token" />}
      <div className="flex flex-wrap gap-x-4 text-xs text-(--hl)">
        {tokens.expiresAt !== undefined && <span>Expires {formatExpiry(tokens.expiresAt)}</span>}
        {tokens.scope !== undefined && <span>Scope: {tokens.scope || '(none)'}</span>}
      </div>
      {jwt ? (
        <details data-testid="mcp-oauth-jwt">
          <summary className="cursor-pointer text-xs text-(--hl)">Decoded JWT (not verified)</summary>
          <div className="mt-1 flex flex-col gap-1">
            <JsonView value={{ header: jwt.header, payload: jwt.payload }} />
            <ul className="text-xs text-(--hl)">
              {JWT_TIME_CLAIMS.filter(claim => typeof jwt.payload[claim] === 'number').map(claim => (
                <li key={claim}>
                  {claim}: {new Date((jwt.payload[claim] as number) * 1000).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : (
        <p className="text-xs text-(--hl)">Opaque token (not a JWT), so there is nothing to decode.</p>
      )}
    </div>
  );
};

/** A JWT a step produced or received (ID token, ID-JAG), copyable and decoded (never verified). */
const JwtCard: FC<{ label: string; token: string }> = ({ label, token }) => {
  const jwt = decodeJwt(token);
  return (
    <div className="mx-3 mb-1 flex flex-col gap-2 rounded-xs border border-solid border-(--hl-md) p-2" data-testid="mcp-oauth-jwt-card" data-label={label}>
      <TokenRow label={label} value={token} testId={`mcp-oauth-jwt-${label.toLowerCase().replaceAll(/\W+/g, '-')}`} />
      {jwt ? (
        <details open>
          <summary className="cursor-pointer text-xs text-(--hl)">Decoded (not verified)</summary>
          <div className="mt-1 flex flex-col gap-1">
            <JsonView value={{ header: jwt.header, payload: jwt.payload }} />
            <ul className="text-xs text-(--hl)">
              {JWT_TIME_CLAIMS.filter(claim => typeof jwt.payload[claim] === 'number').map(claim => (
                <li key={claim}>
                  {claim}: {new Date((jwt.payload[claim] as number) * 1000).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : (
        <p className="text-xs text-(--hl)">Not a JWT, so there is nothing to decode.</p>
      )}
    </div>
  );
};

export const StepView: FC<{ step: OAuthStep; onStepUp?: (scope: string) => void; stepUpDisabled?: boolean }> = ({ step, onStepUp, stepUpDisabled }) => {
  const summary = splitUrls(step.summary);
  return (
  <li className="flex min-w-0 flex-col gap-1.5 border-b border-solid border-(--hl-md) px-3 py-2" data-testid="mcp-oauth-step" data-step={step.id}>
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[step.status]}`} />
      <span className="font-semibold">{step.title}</span>
      <span className="ml-auto truncate text-xs text-(--hl)" data-testid="mcp-oauth-step-summary">
        {summary.text}
      </span>
    </div>
    {summary.urls.length > 0 && (
      <div className="flex flex-col gap-1 pl-4">
        {summary.urls.map(url => (
          <UrlBox key={url} url={url} />
        ))}
      </div>
    )}
    {step.findings.length > 0 && (
      <ul className="ml-4 flex list-disc flex-col gap-1 pl-4 text-xs marker:text-(--hl)">
        {step.findings.map(finding => {
          const parts = splitUrls(finding.text);
          return (
            <li key={`${finding.level}:${finding.text}`} className={`[overflow-wrap:anywhere] ${LEVEL_TEXT[finding.level]}`}>
              {parts.text}
              {parts.urls.length > 0 && (
                <div className="mt-1 flex flex-col gap-1">
                  {parts.urls.map(url => (
                    <UrlBox key={url} url={url} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    )}
    {step.jwts?.map(jwt => (
      <JwtCard key={`${jwt.label}:${jwt.token.slice(-12)}`} label={jwt.label} token={jwt.token} />
    ))}
    {step.tokens && <TokenCard tokens={step.tokens} />}
    {step.stepUp && onStepUp && (
      <div className="pl-4">
        <Button
          className="rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-xs text-(--color-font-surprise) hover:brightness-75 disabled:opacity-50"
          onPress={() => onStepUp(step.stepUp!.scope)}
          isDisabled={stepUpDisabled}
          data-testid="mcp-oauth-step-up"
        >
          Authorize again with “{step.stepUp.scope}”
        </Button>
      </div>
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
};

export const tooltipClass =
  'max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none';
export const purpleButton =
  'shrink-0 rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-sm text-(--color-font-surprise) hover:brightness-75 disabled:opacity-50';
export const smallButton = 'rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 text-xs hover:bg-(--hl-sm)';

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

export const WizardStep: FC<{ number: number; title: string; summary: StepSummary; action?: React.ReactNode; children: React.ReactNode }> = ({
  number,
  title,
  summary,
  action,
  children,
}) => (
  <section className="flex min-w-0 flex-col rounded-md border border-solid border-(--hl-md)" data-testid={`mcp-oauth-wizard-step-${number}`}>
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

/** The button shown in the Auth tab. The wizard itself is `OAuthWizardModal`, mounted by the shell so it survives tab changes. */
export const OAuthDiscoverButton: FC<{ onOpen: () => void; onOpenXaa?: () => void; isDisabled?: boolean }> = ({ onOpen, onOpenXaa, isDisabled }) => (
  <div className="flex shrink-0 items-center gap-2 border-b border-solid border-(--hl-md) px-3 py-2" data-testid="mcp-oauth-discovery">
    <TooltipTrigger delay={200}>
      <Button className={purpleButton} onPress={onOpen} isDisabled={isDisabled} data-testid="mcp-oauth-discover">
        Discover OAuth
      </Button>
      <Tooltip offset={8} className={tooltipClass}>
        Open the OAuth debugger: probe this server without credentials, then register a client and authorize in your
        browser, with every request and response visible.
      </Tooltip>
    </TooltipTrigger>
    {onOpenXaa && (
      <TooltipTrigger delay={200}>
        <Button className={purpleButton} onPress={onOpenXaa} isDisabled={isDisabled} data-testid="mcp-xaa-discover">
          Discover XAA
        </Button>
        <Tooltip offset={8} className={tooltipClass}>
          Open the enterprise-managed authorization (XAA) debugger: sign in at your company identity provider, trade that
          sign-in for an ID-JAG, and redeem it at this server's authorization server, with every step visible. No
          per-server consent page.
        </Tooltip>
      </TooltipTrigger>
    )}
  </div>
);

export const OAuthWizardModal: FC<{
  request: McpRequest;
  environmentId: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}> = ({ request, environmentId, isOpen, onOpenChange: setOpen }) => {
  const patchRequest = useRequestPatcher();
  const [result, setResult] = useState<OAuthDiscoveryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [flowSteps, setFlowSteps] = useState<OAuthStep[]>([]);
  const [authorizing, setAuthorizing] = useState(false);
  // Which client Step 2 uses: 'auto' (register a new one), 'custom' (typed client ID or CIMD URL), or a saved client's id.
  const [clientChoice, setClientChoice] = useState('auto');
  const [customClientId, setCustomClientId] = useState('');
  const [saveName, setSaveName] = useState('');
  const [tokenSteps, setTokenSteps] = useState<OAuthStep[]>([]);
  const [gettingToken, setGettingToken] = useState(false);

  const runToken = async (call: () => Promise<OAuthStep[]>) => {
    setGettingToken(true);
    setFailure(null);
    try {
      const steps = await call();
      setTokenSteps(steps);
      // Reflect what we did in the Auth tab: a Bearer token, which is what Connect then sends.
      const tokens = steps.find(step => step.tokens && step.status !== 'error')?.tokens;
      if (tokens) {
        patchRequest(request._id, { authentication: { type: 'bearer', token: tokens.accessToken, prefix: 'Bearer', disabled: false } });
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setGettingToken(false);
    }
  };

  const issuer = result?.context?.authorizationServer.issuer;
  const savedClients = clientsForIssuer(request.oauthClients, issuer);
  const selectedSaved = savedClients.find(client => client.id === clientChoice);
  const chosenClientId = clientChoice === 'auto' ? '' : clientChoice === 'custom' ? customClientId : (selectedSaved?.clientId ?? '');

  /** Step 2. `addScope` is a step-up: ask again for what we have plus that scope, then go straight on to the token. */
  const authorize = async (addScope?: string) => {
    if (!result?.context) {
      return;
    }
    setAuthorizing(true);
    setFailure(null);
    setFlowSteps([]);
    setTokenSteps([]);
    let codeReady = false;
    try {
      const steps = await window.main.mcpDebugger.oauthAuthorize({
        requestId: request._id,
        context: result.context,
        clientId: chosenClientId,
        addScope,
      });
      setFlowSteps(steps);
      codeReady = steps.some(step => step.id === 'callback' && step.status !== 'error');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthorizing(false);
    }
    if (addScope && codeReady) {
      await runToken(() => window.main.mcpDebugger.oauthExchange({ requestId: request._id }));
    }
  };

  const discover = async () => {
    setRunning(true);
    setFailure(null);
    setFlowSteps([]);
    setTokenSteps([]);
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
          requestId: request._id,
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

  // Every time the wizard opens it starts again with discovery.
  useEffect(() => {
    if (isOpen) {
      void discover();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on open only
  }, [isOpen]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && authorizing) {
      void window.main.mcpDebugger.oauthCancel({ requestId: request._id });
    }
  };

  const canAuthorize = !!result?.context && !running;
  // The client_id the last Step 2 ended up using (a fresh registration, a typed one, or a saved one), so it can be saved.
  const registeredClientId = flowSteps.find(step => step.id === 'registration')?.clientId;
  const discoverySummary = summarizeSteps(result?.steps ?? [], 3, { active: running ? 'Running…' : undefined, idle: 'Not started' });
  const codeReady = flowSteps.some(step => step.id === 'callback' && step.status !== 'error');
  const hasToken = tokenSteps.some(step => (step.id === 'token' || step.id === 'refresh') && step.status !== 'error');
  const tokenSummary = summarizeSteps(tokenSteps, 2, {
    active: gettingToken ? 'Working…' : undefined,
    idle: codeReady ? 'Ready' : 'Waiting on Step 2',
  });
  const authorizeSummary = summarizeSteps(flowSteps, 3, {
    active: authorizing ? 'Waiting for the browser…' : undefined,
    idle: canAuthorize ? 'Ready' : 'Waiting on Step 1',
  });

  return (
    <>
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
                <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto" data-testid="mcp-oauth-wizard">
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
                          onPress={authorizing ? () => window.main.mcpDebugger.oauthCancel({ requestId: request._id }) : () => authorize()}
                          isDisabled={!authorizing && !canAuthorize}
                          data-testid="mcp-oauth-authorize"
                        >
                          {authorizing ? 'Cancel' : 'Register & authorize'}
                        </Button>
                        <Tooltip offset={8} className={tooltipClass}>
                          Register this client (or use the client ID you enter), open the authorization page in your
                          browser, and check the response that comes back (state, iss). It stops once a code arrives; Step 3
                          exchanges it.
                        </Tooltip>
                      </TooltipTrigger>
                    }
                  >
                    {canAuthorize || authorizing || flowSteps.length > 0 ? (
                      <>
                        <div className="flex flex-col gap-2 px-3 py-2">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-(--hl)">Client</span>
                            <Dropdown
                              triggerButton={
                                <Button
                                  aria-label="OAuth client"
                                  className={`flex items-center gap-1 rounded-xs border border-solid border-(--hl-md) px-2 py-0.5 ${authorizing ? 'opacity-50' : ''}`}
                                  data-testid="mcp-oauth-client-picker"
                                >
                                  <span>
                                    {clientChoice === 'auto'
                                      ? 'Register a new client'
                                      : clientChoice === 'custom'
                                        ? 'Enter a client ID…'
                                        : (selectedSaved?.name ?? 'Register a new client')}
                                  </span>
                                  <i className="fa fa-caret-down" />
                                </Button>
                              }
                              placement="bottom start"
                              isDisabled={authorizing}
                            >
                              <DropdownSection>
                                <DropdownItem key="auto">
                                  <ItemContent label="Register a new client" isSelected={clientChoice === 'auto'} onClick={() => setClientChoice('auto')} />
                                </DropdownItem>
                                <DropdownItem key="custom">
                                  <ItemContent label="Enter a client ID or CIMD URL…" isSelected={clientChoice === 'custom'} onClick={() => setClientChoice('custom')} />
                                </DropdownItem>
                              </DropdownSection>
                              <DropdownSection aria-label="Saved clients" title={savedClients.length > 0 ? 'Saved clients' : undefined}>
                                {savedClients.map(client => (
                                  <DropdownItem key={client.id}>
                                    <ItemContent
                                      label={`${client.name} · ${client.clientId}`}
                                      isSelected={clientChoice === client.id}
                                      onClick={() => setClientChoice(client.id)}
                                    />
                                  </DropdownItem>
                                ))}
                              </DropdownSection>
                            </Dropdown>
                            {selectedSaved && (
                              <Button
                                className={smallButton}
                                onPress={() => {
                                  patchRequest(request._id, { oauthClients: forgetClient(request.oauthClients, selectedSaved.id) });
                                  setClientChoice('auto');
                                }}
                                isDisabled={authorizing}
                                data-testid="mcp-oauth-forget-client"
                              >
                                Forget
                              </Button>
                            )}
                          </div>
                          {clientChoice === 'custom' && (
                            <TextField aria-label="Client ID or CIMD URL" value={customClientId} onChange={setCustomClientId} isDisabled={authorizing}>
                              <Input
                                placeholder="A pre-registered client ID, or the https URL of a client metadata document (CIMD)"
                                className="w-full rounded-xs border border-solid border-(--hl-md) bg-transparent px-2 py-1 text-xs"
                                data-testid="mcp-oauth-client-id"
                              />
                            </TextField>
                          )}
                          {registeredClientId && !isClientSaved(request.oauthClients, issuer, registeredClientId) && (
                            <div className="flex items-center gap-2 text-xs" data-testid="mcp-oauth-save-client">
                              <span className="text-(--hl)">Remember {registeredClientId}?</span>
                              <TextField aria-label="Client name" value={saveName} onChange={setSaveName} className="min-w-0 flex-1">
                                <Input
                                  placeholder="Name it (e.g. Read-only client)"
                                  className="w-full rounded-xs border border-solid border-(--hl-md) bg-transparent px-2 py-0.5 text-xs"
                                  data-testid="mcp-oauth-save-client-name"
                                />
                              </TextField>
                              <Button
                                className={smallButton}
                                onPress={() => {
                                  if (!issuer) {
                                    return;
                                  }
                                  const saved = saveClient(request.oauthClients, { name: saveName, issuer, clientId: registeredClientId }, () => crypto.randomUUID());
                                  patchRequest(request._id, { oauthClients: saved });
                                  setClientChoice(saved.find(client => client.issuer === issuer && client.clientId === registeredClientId)?.id ?? 'auto');
                                  setSaveName('');
                                }}
                                data-testid="mcp-oauth-save-client-button"
                              >
                                Save client
                              </Button>
                            </div>
                          )}
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
                  <WizardStep
                    number={3}
                    title="Get a token"
                    summary={tokenSummary}
                    action={
                      <>
                        {hasToken && (
                          <Button
                            className={smallButton}
                            onPress={() => runToken(() => window.main.mcpDebugger.oauthRefresh({ requestId: request._id }))}
                            isDisabled={gettingToken}
                            data-testid="mcp-oauth-refresh"
                          >
                            Refresh token
                          </Button>
                        )}
                        <TooltipTrigger delay={200}>
                          <Button
                            className={purpleButton}
                            onPress={() => runToken(() => window.main.mcpDebugger.oauthExchange({ requestId: request._id }))}
                            isDisabled={!codeReady || gettingToken}
                            data-testid="mcp-oauth-get-token"
                          >
                            Get token
                          </Button>
                          <Tooltip offset={8} className={tooltipClass}>
                            Exchange the authorization code from Step 2 for an access token (sending the PKCE verifier),
                            then call the MCP server with it to prove it works. A code can be used once; run Step 2
                            again for another.
                          </Tooltip>
                        </TooltipTrigger>
                      </>
                    }
                  >
                    {tokenSteps.length > 0 ? (
                      <ol className="flex flex-col">
                        {tokenSteps.map(step => (
                          <StepView
                            key={step.id}
                            step={step}
                            onStepUp={scope => authorize(scope)}
                            stepUpDisabled={authorizing || gettingToken}
                          />
                        ))}
                      </ol>
                    ) : (
                      <p className="px-3 py-2 text-xs text-(--hl)">
                        {codeReady ? 'Ready to exchange the authorization code.' : 'Finish Step 2 successfully to continue.'}
                      </p>
                    )}
                  </WizardStep>
                  {failure && <p className="text-xs text-red-500">{failure}</p>}
                </div>
                {hasToken && (
                  <div className="flex shrink-0 items-center justify-end gap-3 border-t border-solid border-(--hl-md) pt-3">
                    <span className="text-xs text-(--hl)">The Auth tab now holds this token as a Bearer token.</span>
                    <Button className={purpleButton} onPress={close} data-testid="mcp-oauth-done">
                      Done
                    </Button>
                  </div>
                )}
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
};
