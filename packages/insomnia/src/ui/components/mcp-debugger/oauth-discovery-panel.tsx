import type { McpRequest } from 'insomnia-data';
import React, { type FC, useState } from 'react';
import { Button, Tooltip, TooltipTrigger } from 'react-aria-components';

import type { OAuthDiscoveryResult, OAuthExchange, OAuthStep, OAuthStepStatus } from '~/main/mcp-debugger/oauth-discovery';
import { tryToInterpolateRequestAndCollectSensitiveValues } from '~/ui/utils/try-interpolate';

import { JsonView } from './json-view';

// Task 4348 S5a: read-only OAuth discovery stepper, shown above the Auth type picker. It probes the request URL without
// credentials and walks 401 -> protected resource metadata -> authorization server metadata -> verdict, with the raw
// exchange behind every step. No tokens are issued here (S5b/S5c).
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

const StepView: FC<{ step: OAuthStep; index: number }> = ({ step, index }) => (
  <li className="flex flex-col gap-1.5 border-b border-solid border-(--hl-md) px-3 py-2" data-testid="mcp-oauth-step" data-step={step.id}>
    <div className="flex items-center gap-2 text-sm">
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[step.status]}`} />
      <span className="font-semibold">
        {index + 1}. {step.title}
      </span>
      <span className="ml-auto truncate text-xs text-(--hl)" data-testid="mcp-oauth-step-summary">
        {step.summary}
      </span>
    </div>
    {step.findings.length > 0 && (
      <ul className="flex flex-col gap-0.5 pl-4 text-xs">
        {step.findings.map((finding, i) => (
          <li key={i} className={LEVEL_TEXT[finding.level]}>
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
          {step.exchanges.map((exchange, i) => (
            <ExchangeView key={i} exchange={exchange} />
          ))}
        </div>
      </details>
    )}
  </li>
);

export const OAuthDiscoveryPanel: FC<{ request: McpRequest; environmentId: string }> = ({ request, environmentId }) => {
  const [result, setResult] = useState<OAuthDiscoveryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setFailure(null);
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

  return (
    <div className="flex max-h-[60%] shrink-0 flex-col overflow-y-auto border-b border-solid border-(--hl-md)" data-testid="mcp-oauth-discovery">
      <div className="flex items-center gap-2 px-3 py-2">
        <TooltipTrigger delay={200}>
          <Button
            className="shrink-0 rounded-sm bg-(--color-surprise) px-(--padding-md) py-1 text-sm text-(--color-font-surprise) hover:brightness-75 disabled:opacity-50"
            onPress={run}
            isDisabled={running || !request.url}
            data-testid="mcp-oauth-discover"
          >
            {running ? 'Discovering…' : 'Discover OAuth'}
          </Button>
          <Tooltip
            offset={8}
            className="max-w-xs rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none"
          >
            Probe this server without credentials and see what a client would find: the 401 challenge, the protected
            resource metadata, the authorization server metadata, and what a client can do with them.
          </Tooltip>
        </TooltipTrigger>
      </div>
      {failure && <div className="px-3 pb-2 text-xs text-red-500">{failure}</div>}
      {result && (
        <ol className="flex flex-col" data-testid="mcp-oauth-steps">
          {result.steps.map((step, i) => (
            <StepView key={step.id} step={step} index={i} />
          ))}
        </ol>
      )}
    </div>
  );
};
