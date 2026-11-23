import type { McpRequest } from 'insomnia-data';
import React, { type FC, useEffect, useState } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay, Tooltip, TooltipTrigger } from 'react-aria-components';
import { useLocalStorage } from 'react-use';

import type { AuthServerMetadata, OAuthDiscoveryResult, OAuthStep } from '~/main/mcp-debugger/oauth-discovery';
import { supportsIdJag } from '~/main/mcp-debugger/oauth-discovery';
import { Icon } from '~/ui/components/icon';
import { useRequestPatcher } from '~/ui/hooks/use-request';
import { tryToInterpolateRequestAndCollectSensitiveValues } from '~/ui/utils/try-interpolate';

import { purpleButton, smallButton, StepView, summarizeSteps, tooltipClass, WizardStep } from './oauth-discovery-panel';
import { PrototypeMock } from './prototype-mock';

// Task 4348 S8: the enterprise-managed authorization (XAA) debugger, in a modal opened by "Discover XAA" next to
// "Discover OAuth". Four steps, each showing its sub-steps with the raw exchange behind them:
//   1 Discover: the same probe as the OAuth wizard, plus whether the server's authorization server accepts ID-JAGs.
//   2 Sign in at the identity provider: OIDC single sign-on for this client (browser), giving an ID token.
//   3 Get an ID-JAG: trade the ID token at the IdP for an ID-JAG addressed to the MCP authorization server.
//   4 Get an access token: present the ID-JAG at the MCP authorization server (JWT bearer grant), then call the server.
// PROTOTYPE-MOCK: client secret only (no signed client assertion), OIDC only (no SAML); the issuer and client ids are
// remembered per request in this browser's storage, the secrets are not remembered at all.

interface Remembered {
  idpIssuer: string;
  idpClientId: string;
  asClientId: string;
}
const EMPTY: Remembered = { idpIssuer: '', idpClientId: '', asClientId: '' };

const MOCK_IDP = { issuer: 'http://127.0.0.1:9100', clientId: 'insomnia-xaa', clientSecret: 'insomnia-xaa-secret', asClientId: 'insomnia-xaa', asClientSecret: 'insomnia-xaa-as-secret' };

const inputClass = 'w-full rounded-xs border border-solid border-(--hl-md) bg-transparent px-2 py-1 text-sm';

const Field: FC<{ label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; testId: string }> = ({ label, value, onChange, type = 'text', placeholder, testId }) => (
  <label className="flex flex-col gap-0.5 text-xs">
    <span className="text-(--hl)">{label}</span>
    <input
      className={inputClass}
      type={type}
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      onChange={event => onChange(event.target.value)}
      data-testid={testId}
    />
  </label>
);

export const XaaWizardModal: FC<{
  request: McpRequest;
  environmentId: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}> = ({ request, environmentId, isOpen, onOpenChange: setOpen }) => {
  const patchRequest = useRequestPatcher();
  const [remembered = EMPTY, setRemembered] = useLocalStorage<Remembered>(`mcp-xaa:${request._id}`, EMPTY);
  const [idpSecret, setIdpSecret] = useState('');
  const [asSecret, setAsSecret] = useState('');
  const [result, setResult] = useState<OAuthDiscoveryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [signInSteps, setSignInSteps] = useState<OAuthStep[]>([]);
  const [signingIn, setSigningIn] = useState(false);
  const [jagSteps, setJagSteps] = useState<OAuthStep[]>([]);
  const [exchanging, setExchanging] = useState(false);
  const [tokenSteps, setTokenSteps] = useState<OAuthStep[]>([]);
  const [redeeming, setRedeeming] = useState(false);

  const context = result?.context;
  const idpFilled = remembered.idpIssuer.trim() !== '' && remembered.idpClientId.trim() !== '' && idpSecret !== '';
  const asFilled = remembered.asClientId.trim() !== '' && asSecret !== '';
  const signedIn = signInSteps.some(step => step.id === 'idp-token' && step.status !== 'error');
  const jagReady = jagSteps.some(step => step.id === 'id-jag' && (step.jwts?.length ?? 0) > 0);
  const hasToken = tokenSteps.some(step => step.id === 'jwt-bearer' && step.status !== 'error');
  const xaaSupported = supportsIdJag(context?.authorizationServer as AuthServerMetadata | undefined);

  const guard = async (setBusy: (busy: boolean) => void, work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const discover = () =>
    guard(setRunning, async () => {
      setResult(null);
      setSignInSteps([]);
      setJagSteps([]);
      setTokenSteps([]);
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
    });

  const signIn = () =>
    guard(setSigningIn, async () => {
      setSignInSteps([]);
      setJagSteps([]);
      setTokenSteps([]);
      setSignInSteps(
        await window.main.mcpDebugger.xaaSignIn({
          requestId: request._id,
          idp: { issuer: remembered.idpIssuer.trim(), clientId: remembered.idpClientId.trim(), clientSecret: idpSecret },
        }),
      );
    });

  const exchangeJag = () =>
    guard(setExchanging, async () => {
      if (!context) {
        return;
      }
      setJagSteps([]);
      setTokenSteps([]);
      setJagSteps(await window.main.mcpDebugger.xaaExchange({ requestId: request._id, context }));
    });

  const redeem = () =>
    guard(setRedeeming, async () => {
      if (!context) {
        return;
      }
      setTokenSteps([]);
      const steps = await window.main.mcpDebugger.xaaRedeem({
        requestId: request._id,
        context,
        asClient: { clientId: remembered.asClientId.trim(), clientSecret: asSecret },
      });
      setTokenSteps(steps);
      // Reflect it in the Auth tab, as the OAuth wizard does: a Bearer token is what Connect then sends.
      const tokens = steps.find(step => step.tokens && step.status !== 'error')?.tokens;
      if (tokens) {
        patchRequest(request._id, { authentication: { type: 'bearer', token: tokens.accessToken, prefix: 'Bearer', disabled: false } });
      }
    });

  // Every time the wizard opens it starts again with discovery.
  useEffect(() => {
    if (isOpen) {
      void discover();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on open only
  }, [isOpen]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && signingIn) {
      void window.main.mcpDebugger.oauthCancel({ requestId: request._id });
    }
  };

  const useMockIdp = () => {
    setRemembered({ idpIssuer: MOCK_IDP.issuer, idpClientId: MOCK_IDP.clientId, asClientId: MOCK_IDP.asClientId });
    setIdpSecret(MOCK_IDP.clientSecret);
    setAsSecret(MOCK_IDP.asClientSecret);
  };

  const discoverySummary = summarizeSteps(result?.steps ?? [], 3, { active: running ? 'Running…' : undefined, idle: 'Not started' });
  const signInSummary = summarizeSteps(signInSteps, 3, { active: signingIn ? 'Waiting for the browser…' : undefined, idle: context ? 'Ready' : 'Waiting on Step 1' });
  const jagSummary = summarizeSteps(jagSteps, 1, { active: exchanging ? 'Working…' : undefined, idle: signedIn ? 'Ready' : 'Waiting on Step 2' });
  const tokenSummary = summarizeSteps(tokenSteps, 2, { active: redeeming ? 'Working…' : undefined, idle: jagReady ? 'Ready' : 'Waiting on Step 3' });

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed top-0 left-0 z-10 flex h-(--visual-viewport-height) w-full items-center justify-center bg-black/30"
    >
      <Modal className="flex h-[min(52rem,calc(100%-var(--padding-xl)))] w-[min(52rem,calc(100%-var(--padding-xl)))] flex-col rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) p-(--padding-lg) text-(--color-font)">
        <Dialog className="flex h-full flex-1 flex-col gap-3 overflow-hidden outline-hidden" aria-label="Enterprise-managed authorization debugger">
          {({ close }) => (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2">
                <Heading slot="title" className="text-xl">
                  Enterprise-managed authorization (XAA)
                </Heading>
                <Button
                  aria-label="Close"
                  className="flex aspect-square h-6 shrink-0 items-center justify-center rounded-xs text-sm text-(--color-font) ring-1 ring-transparent transition-all hover:bg-(--hl-xs) focus:ring-(--hl-md) focus:ring-inset"
                  onPress={close}
                >
                  <Icon icon="x" />
                </Button>
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto" data-testid="mcp-xaa-wizard">
                <p className="text-xs text-(--hl)">
                  Your company identity provider decides whether this app may use this MCP server. You sign in there once;
                  Insomnia trades that sign-in for an ID-JAG (a signed permission slip), and the server&apos;s authorization
                  server turns the slip into an access token. There is no consent page at the MCP server.
                </p>
                {failure && (
                  <p className="text-sm text-red-500" data-testid="mcp-xaa-failure">
                    {failure}
                  </p>
                )}
                <WizardStep
                  number={1}
                  title="Discover"
                  summary={discoverySummary}
                  action={
                    <Button className={smallButton} onPress={discover} isDisabled={running} data-testid="mcp-xaa-rediscover">
                      {running ? 'Discovering…' : 'Run again'}
                    </Button>
                  }
                >
                  {result ? (
                    <>
                      <ol className="flex flex-col" data-testid="mcp-xaa-steps">
                        {result.steps.map(step => (
                          <StepView key={step.id} step={step} />
                        ))}
                      </ol>
                      {context && (
                        <p
                          className={`px-3 py-2 text-xs ${xaaSupported ? 'text-green-500' : 'text-amber-500'}`}
                          data-testid="mcp-xaa-support"
                          data-supported={xaaSupported}
                        >
                          {xaaSupported
                            ? 'This server’s authorization server accepts ID-JAGs (it advertises the id-jag grant profile).'
                            : 'This server’s authorization server does not advertise the id-jag grant profile, so it may not accept enterprise-managed authorization. You can still try the steps below.'}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="px-3 py-2 text-xs text-(--hl)">{running ? 'Discovering…' : 'Nothing yet.'}</p>
                  )}
                </WizardStep>
                <WizardStep
                  number={2}
                  title="Sign in at the identity provider"
                  summary={signInSummary}
                  action={
                    <TooltipTrigger delay={200}>
                      <Button
                        className={purpleButton}
                        onPress={signingIn ? () => window.main.mcpDebugger.oauthCancel({ requestId: request._id }) : signIn}
                        isDisabled={!signingIn && (!context || !idpFilled)}
                        data-testid="mcp-xaa-sign-in"
                      >
                        {signingIn ? 'Cancel' : 'Sign in'}
                      </Button>
                      <Tooltip offset={8} className={tooltipClass}>
                        Look up the identity provider, open its sign-in page in your browser (OIDC with PKCE), and receive
                        an ID token for this client app.
                      </Tooltip>
                    </TooltipTrigger>
                  }
                >
                  <div className="flex flex-col gap-2 px-3 py-2">
                    <div className="flex flex-col gap-2 rounded-xs border border-dashed border-amber-500/60 p-2">
                      <PrototypeMock inline reason="Client secret only (no signed client assertion yet) and OIDC only (no SAML). Secrets are kept in memory and shown as sent in the trace." />
                      <div>
                        <Button className={smallButton} onPress={useMockIdp} data-testid="mcp-xaa-use-mock">
                          Fill in the mock IdP
                        </Button>
                      </div>
                    </div>
                    <Field label="Identity provider issuer URL" value={remembered.idpIssuer} onChange={idpIssuer => setRemembered({ ...remembered, idpIssuer })} placeholder="https://your-company.okta.com" testId="mcp-xaa-idp-issuer" />
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Client ID at the identity provider" value={remembered.idpClientId} onChange={idpClientId => setRemembered({ ...remembered, idpClientId })} testId="mcp-xaa-idp-client-id" />
                      <Field label="Client secret (not remembered)" value={idpSecret} onChange={setIdpSecret} type="password" testId="mcp-xaa-idp-secret" />
                    </div>
                  </div>
                  {signInSteps.length > 0 && (
                    <ol className="flex flex-col" data-testid="mcp-xaa-signin-steps">
                      {signInSteps.map(step => (
                        <StepView key={step.id} step={step} />
                      ))}
                    </ol>
                  )}
                </WizardStep>
                <WizardStep
                  number={3}
                  title="Get an ID-JAG"
                  summary={jagSummary}
                  action={
                    <TooltipTrigger delay={200}>
                      <Button className={purpleButton} onPress={exchangeJag} isDisabled={exchanging || !signedIn || !context} data-testid="mcp-xaa-exchange">
                        {exchanging ? 'Exchanging…' : jagReady ? 'Exchange again' : 'Exchange'}
                      </Button>
                      <Tooltip offset={8} className={tooltipClass}>
                        Send your ID token to the identity provider and ask for an ID-JAG addressed to this server&apos;s
                        authorization server (RFC 8693 token exchange). The IdP applies the admin&apos;s policy here and
                        may refuse. An ID-JAG can be redeemed once and expires in minutes.
                      </Tooltip>
                    </TooltipTrigger>
                  }
                >
                  {jagSteps.length > 0 ? (
                    <ol className="flex flex-col" data-testid="mcp-xaa-jag-steps">
                      {jagSteps.map(step => (
                        <StepView key={step.id} step={step} />
                      ))}
                    </ol>
                  ) : (
                    <p className="px-3 py-2 text-xs text-(--hl)">The ID-JAG appears here decoded, with checks for what an authorization server will reject it for.</p>
                  )}
                </WizardStep>
                <WizardStep
                  number={4}
                  title="Get an access token"
                  summary={tokenSummary}
                  action={
                    <TooltipTrigger delay={200}>
                      <Button className={purpleButton} onPress={redeem} isDisabled={redeeming || !jagReady || !asFilled} data-testid="mcp-xaa-redeem">
                        {redeeming ? 'Redeeming…' : 'Redeem'}
                      </Button>
                      <Tooltip offset={8} className={tooltipClass}>
                        Present the ID-JAG to the MCP server&apos;s authorization server (RFC 7523 JWT bearer grant) with this
                        client&apos;s credentials there, then call the MCP server with the token it issues. The token also
                        lands in the Auth tab.
                      </Tooltip>
                    </TooltipTrigger>
                  }
                >
                  <div className="grid grid-cols-2 gap-2 px-3 py-2">
                    <Field label="Client ID at the MCP authorization server" value={remembered.asClientId} onChange={asClientId => setRemembered({ ...remembered, asClientId })} testId="mcp-xaa-as-client-id" />
                    <Field label="Client secret there (not remembered)" value={asSecret} onChange={setAsSecret} type="password" testId="mcp-xaa-as-secret" />
                  </div>
                  {tokenSteps.length > 0 && (
                    <ol className="flex flex-col" data-testid="mcp-xaa-token-steps">
                      {tokenSteps.map(step => (
                        <StepView key={step.id} step={step} />
                      ))}
                    </ol>
                  )}
                </WizardStep>
              </div>
              {hasToken && (
                <div className="flex shrink-0 items-center justify-end gap-3 border-t border-solid border-(--hl-md) pt-3" data-testid="mcp-xaa-done-bar">
                  <span className="text-xs text-(--hl)">The Auth tab now holds this token as a Bearer token. Close this and Connect.</span>
                  <Button className={purpleButton} onPress={close} data-testid="mcp-xaa-done">
                    Done
                  </Button>
                </div>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
};
