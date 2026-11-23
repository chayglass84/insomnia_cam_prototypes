import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decodeJwt } from '~/common/mcp-debugger/jwt';

import { clearKey, generateKey, signAssertion } from './client-assertion';
import { discoverOAuth, supportsIdJag } from './oauth-discovery';
import { canRefresh, currentAccessToken } from './oauth-token';
import * as service from './service';
import { checkIdJag, ID_JAG_JWT_TYPE, xaaExchange, xaaRedeem, xaaSignIn } from './xaa';

// Integration tests (S8) against the real mocks: the identity provider, the authorization server and the OAuth-protected
// MCP mock, plus pure tests for the ID-JAG checks.
const IDP_PORT = 19_110;
const AS_PORT = 19_010;
const PLAIN_AS_PORT = 19_020;
const MCP_PORT = 18_827;
const IDP = `http://127.0.0.1:${IDP_PORT}`;
const AS = `http://127.0.0.1:${AS_PORT}`;
const PLAIN_AS = `http://127.0.0.1:${PLAIN_AS_PORT}`;
const MCP = `http://127.0.0.1:${MCP_PORT}`;
const children: ChildProcess[] = [];
const idpClient = { issuer: IDP, clientId: 'insomnia-xaa', clientSecret: 'insomnia-xaa-secret' };
const asClient = { clientId: 'insomnia-xaa', clientSecret: 'insomnia-xaa-as-secret' };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const setIdpFlags = (flags: object) => fetch(`${IDP}/admin/flags`, { method: 'POST', body: JSON.stringify(flags) });

beforeAll(async () => {
  const dir = path.resolve(__dirname, '../../../../insomnia-smoke-test/server/mcp-debugger');
  children.push(
    spawn(process.execPath, [path.join(dir, 'mock-idp.mjs')], { env: { ...process.env, MOCK_IDP_PORT: String(IDP_PORT) }, stdio: 'ignore' }),
    // The XAA-capable authorization server (behind /xaa-protected) and a plain OAuth one (behind /oauth-protected).
    spawn(process.execPath, [path.join(dir, 'mock-authorization-server.mjs')], {
      env: { ...process.env, MOCK_AUTHORIZATION_SERVER_PORT: String(AS_PORT), MOCK_MCP_ORIGIN: MCP, MOCK_AUTH_CONSENT: '0', MOCK_TRUSTED_IDP: IDP, MOCK_AS_XAA: '1' },
      stdio: 'ignore',
    }),
    spawn(process.execPath, [path.join(dir, 'mock-authorization-server.mjs')], {
      env: { ...process.env, MOCK_AUTHORIZATION_SERVER_PORT: String(PLAIN_AS_PORT), MOCK_MCP_ORIGIN: MCP, MOCK_AUTH_CONSENT: '0' },
      stdio: 'ignore',
    }),
    spawn(process.execPath, [path.join(dir, 'mock-mcp-server.mjs')], {
      env: { ...process.env, MOCK_MCP_PORT: String(MCP_PORT), MOCK_AUTHORIZATION_SERVER_ORIGIN: PLAIN_AS, MOCK_XAA_AUTHORIZATION_SERVER_ORIGIN: AS },
      stdio: 'ignore',
    }),
  );
  for (const url of [`${IDP}/health`, `${AS}/health`, `${PLAIN_AS}/health`, `${MCP}/health`]) {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(url)).ok) {
          break;
        }
      } catch {}
      await sleep(50);
    }
  }
});
afterAll(() => children.forEach(child => child.kill()));

/** Stands in for the browser: picks `user` on the mock IdP's sign-in page and follows the redirect to the loopback listener. */
const signInAs = (user: string) => async (url: string) => {
  const parsed = new URL(url);
  const decide = await fetch(`${parsed.origin}/authorize/decide?user=${user}&${parsed.searchParams.toString()}`, { redirect: 'manual' });
  void fetch(decide.headers.get('location')!);
};

const run = async (requestId: string, user = 'alex', idp: Parameters<typeof xaaSignIn>[0]['idp'] = idpClient, resetIdp = true) => {
  if (resetIdp) {
    await fetch(`${IDP}/admin/reset`, { method: 'POST' });
  }
  const discovery = await discoverOAuth({ url: `${MCP}/xaa-protected`, trace: service.oauthTraceFor(requestId) });
  const context = discovery.context!;
  const signIn = await xaaSignIn({ requestId, idp, openUrl: signInAs(user), timeoutMs: 5000, trace: service.oauthTraceFor(requestId) });
  return { context, signIn };
};

describe('XAA flow against the mocks', () => {
  it('signs in, gets an ID-JAG, redeems it and calls the MCP server', async () => {
    const requestId = 'xaa-happy';
    await fetch(`${IDP}/admin/reset`, { method: 'POST' });
    const { context, signIn } = await run(requestId);
    expect(signIn.map(s => [s.id, s.status])).toEqual([['idp-metadata', 'ok'], ['idp-signin', 'ok'], ['idp-token', 'ok']]);
    const idToken = signIn[2].jwts![0].token;
    expect(decodeJwt(idToken)?.payload.email).toBe('alex@acme.test');

    const exchangeSteps = await xaaExchange({ requestId, context, trace: service.oauthTraceFor(requestId) });
    expect(exchangeSteps[0].status).toBe('ok');
    const jag = decodeJwt(exchangeSteps[0].jwts![0].token)!;
    expect((jag.header as { typ: string }).typ).toBe(ID_JAG_JWT_TYPE);
    expect(jag.payload).toMatchObject({ aud: AS, client_id: 'insomnia-xaa', resource: MCP });

    const redeem = await xaaRedeem({ requestId, context, asClient, trace: service.oauthTraceFor(requestId) });
    expect(redeem.map(s => [s.id, s.status])).toEqual([['jwt-bearer', 'ok'], ['verify', 'ok']]);
    expect(currentAccessToken(requestId)).toBeTruthy();
    expect(canRefresh(requestId)).toBe(false);
    expect(redeem[0].findings.some(f => f.text.startsWith('No refresh token, as the draft expects'))).toBe(true);

    // Every hop is its own OAuth call in the trace.
    const labels = service
      .getTrace({ requestId })
      .filter(e => e.flow === 'oauth' && e.direction === 'client-to-server')
      .map(e => e.label?.split(' · ')[0]);
    expect(labels).toEqual(expect.arrayContaining(['Identity provider metadata', 'Sign in at the identity provider', 'Identity provider token', 'Token exchange for an ID-JAG', 'JWT bearer grant at the MCP authorization server']));

    // With that token, the XAA endpoint connects and serves just the echo tool.
    const connected = await service.connect({
      requestId,
      url: `${MCP}/xaa-protected`,
      headers: [{ name: 'Authorization', value: `Bearer ${currentAccessToken(requestId)}` }],
      protocolVersion: 'auto',
    });
    expect(connected.status).toBe('connected');
    expect(connected.capabilities.map(c => c.metadata.name)).toEqual(['echo']);
    await service.disconnect({ requestId });

    // An ID-JAG can be redeemed once.
    expect((await xaaRedeem({ requestId, context, asClient }))[0]).toMatchObject({ status: 'error', summary: 'No ID-JAG' });
  });

  it("shows the IdP policy's refusal for a blocked user", async () => {
    const requestId = 'xaa-blocked';
    const { context, signIn } = await run(requestId, 'bo');
    expect(signIn[2].status).toBe('ok'); // Bo can sign in
    const [step] = await xaaExchange({ requestId, context });
    expect(step).toMatchObject({ status: 'error', summary: 'Refused by IdP policy' });
    expect(step.findings.some(f => f.text.includes("admin's policy"))).toBe(true);
  });

  it('flags a flawed ID-JAG, and still lets it be sent so the authorization server reaction is visible', async () => {
    const requestId = 'xaa-wrong-aud';
    const { context } = await run(requestId);
    await setIdpFlags({ wrongAud: true });
    const [exchanged] = await xaaExchange({ requestId, context });
    expect(exchanged.status).toBe('error');
    expect(exchanged.findings.some(f => f.level === 'error' && f.text.includes('aud is'))).toBe(true);
    const [redeemed] = await xaaRedeem({ requestId, context, asClient });
    expect(redeemed).toMatchObject({ status: 'error', summary: 'Refused' });
    expect(redeemed.findings[0].text).toContain('aud must be this authorization server');
    await fetch(`${IDP}/admin/reset`, { method: 'POST' });
  });

  it.each([
    ['wrongTyp', 'typ must be oauth-id-jag+jwt'],
    ['expired', 'expired'],
    ['badSignature', 'signature verification failed'],
    ['wrongClient', 'does not match the authenticated client'],
  ])('the authorization server rejects an ID-JAG with %s and says why', async (flag, message) => {
    const requestId = `xaa-${flag}`;
    const { context } = await run(requestId);
    await setIdpFlags({ [flag]: true });
    await xaaExchange({ requestId, context });
    const [redeemed] = await xaaRedeem({ requestId, context, asClient });
    expect(redeemed.status).toBe('error');
    expect(redeemed.findings[0].text).toContain(message);
    await fetch(`${IDP}/admin/reset`, { method: 'POST' });
  });

  it('reports a wrong client secret at the authorization server', async () => {
    const requestId = 'xaa-bad-secret';
    const { context } = await run(requestId);
    await xaaExchange({ requestId, context });
    const [redeemed] = await xaaRedeem({ requestId, context, asClient: { ...asClient, clientSecret: 'nope' } });
    expect(redeemed.findings[0].text).toContain('invalid_client');
  });

  it('offers XAA after a failed Connect only when the server\'s authorization server accepts it', async () => {
    const detect = async (requestId: string, pathname: string) => {
      const state = await service.connect({ requestId, url: `${MCP}${pathname}`, headers: [], protocolVersion: 'auto' });
      expect(state.status).toBe('error');
      expect(state.oauthRequired).toBe(true);
      for (let i = 0; i < 80 && service.getState({ requestId }).xaaSupported === undefined; i++) {
        await sleep(25);
      }
      return service.getState({ requestId }).xaaSupported;
    };
    expect(await detect('xaa-detect', '/xaa-protected')).toBe(true);
    // The plain OAuth endpoint's authorization server does not advertise the id-jag profile.
    expect(await detect('xaa-detect-plain', '/oauth-protected')).toBe(false);
    // A new connect attempt clears the answer until it is known again.
    void service.connect({ requestId: 'xaa-detect', url: `${MCP}/xaa-protected`, headers: [], protocolVersion: 'auto' });
    expect(service.getState({ requestId: 'xaa-detect' }).xaaSupported).toBeUndefined();
  });

  it('keeps the plain OAuth server a plain OAuth server: no id-jag profile, and the jwt-bearer grant is refused', async () => {
    const metadata = await (await fetch(`${PLAIN_AS}/.well-known/oauth-authorization-server`)).json();
    expect(metadata.authorization_grant_profiles_supported).toBeUndefined();
    expect(metadata.grant_types_supported).not.toContain('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const refused = await fetch(`${PLAIN_AS}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'x' }),
    });
    expect((await refused.json()).error).toBe('unsupported_grant_type');
  });

  it('stops with a clear message when the IdP cannot be found', async () => {
    const steps = await xaaSignIn({ requestId: 'xaa-no-idp', idp: { ...idpClient, issuer: 'http://127.0.0.1:1' }, openUrl: () => {}, timeoutMs: 500 });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'idp-metadata', status: 'error' });
  });
});

describe('checkIdJag', () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const make = (header: object, payload: object) => `${b64({ alg: 'RS256', ...header })}.${b64(payload)}.sig`;
  const expected = { idpIssuer: 'https://idp', audience: 'https://as', resource: 'https://mcp', clientId: 'c1', now: 1000 };
  const good = { iss: 'https://idp', sub: 'u', aud: 'https://as', client_id: 'c1', jti: 'j', iat: 990, exp: 1300, resource: 'https://mcp', email: 'a@b' };

  it('passes a conforming ID-JAG', () => {
    const findings = checkIdJag(make({ typ: ID_JAG_JWT_TYPE }, good), expected);
    expect(findings.filter(f => f.level !== 'info')).toEqual([]);
  });

  it('names each thing an authorization server would reject', () => {
    const errors = (header: object, payload: object) => checkIdJag(make(header, payload), expected).filter(f => f.level === 'error').map(f => f.text);
    expect(errors({ typ: 'JWT' }, good)[0]).toMatch(/typ must be oauth-id-jag\+jwt/);
    expect(errors({ typ: ID_JAG_JWT_TYPE }, { ...good, aud: 'https://other' })[0]).toMatch(/aud is "https:\/\/other"/);
    expect(errors({ typ: ID_JAG_JWT_TYPE }, { ...good, exp: 900 })[0]).toMatch(/Already expired/);
    expect(errors({ typ: ID_JAG_JWT_TYPE }, { ...good, resource: 'https://wrong' })[0]).toMatch(/resource is/);
    expect(errors({ typ: ID_JAG_JWT_TYPE }, { ...good, jti: undefined })[0]).toMatch(/Required claim jti/);
    expect(errors({ typ: ID_JAG_JWT_TYPE, alg: 'none' }, good).some(t => t.includes('alg is none'))).toBe(true);
    expect(checkIdJag('not-a-jwt', expected)[0].level).toBe('error');
  });

  it('warns about a missing resource and a different client_id', () => {
    const warns = checkIdJag(make({ typ: ID_JAG_JWT_TYPE }, { ...good, resource: undefined, client_id: 'c2' }), expected).filter(f => f.level === 'warn');
    expect(warns).toHaveLength(2);
  });
});

describe('supportsIdJag', () => {
  it('reads the id-jag grant profile from the authorization server metadata', () => {
    expect(supportsIdJag({ authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'] })).toBe(true);
    expect(supportsIdJag({ authorization_grant_profiles_supported: ['other'] })).toBe(false);
    expect(supportsIdJag({})).toBe(false);
    expect(supportsIdJag()).toBe(false);
  });
});

describe('signed client assertions (private_key_jwt)', () => {
  const assertionIdp: Parameters<typeof xaaSignIn>[0]['idp'] = { issuer: IDP, clientId: 'insomnia-xaa', clientAuth: 'assertion' };
  const assertionAs: Parameters<typeof xaaRedeem>[0]['asClient'] = { clientId: 'insomnia-xaa', clientAuth: 'assertion' };
  const post = (url: string, body: object) => fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const reset = () => Promise.all([`${IDP}/admin/reset`, `${AS}/admin/reset`].map(url => fetch(url, { method: 'POST' })));
  /** Generates this request's key and registers its public half at both mock servers, like pasting a JWKS into a console. */
  const registerKey = async (requestId: string, alg: 'RS256' | 'ES256' = 'RS256') => {
    clearKey({ requestId });
    const info = generateKey({ requestId, alg });
    await post(`${IDP}/admin/clients`, { clientId: 'insomnia-xaa', jwks: info.jwks });
    await post(`${AS}/admin/clients`, { clientId: 'insomnia-xaa', jwks: info.jwks });
    return info;
  };
  const allSteps = async (requestId: string, idp = assertionIdp, as = assertionAs) => {
    // Not resetting the IdP here: the tests register keys and set flags first.
    const { context, signIn } = await run(requestId, 'alex', idp, false);
    const exchanged = signIn.every(step => step.status !== 'error') ? await xaaExchange({ requestId, context, trace: service.oauthTraceFor(requestId) }) : [];
    const redeemed = exchanged.length > 0 ? await xaaRedeem({ requestId, context, asClient: as, trace: service.oauthTraceFor(requestId) }) : [];
    return { signIn, exchanged, redeemed };
  };

  it.each(['RS256', 'ES256'] as const)('works end to end with a %s key at both servers, and never sends a client_secret', async alg => {
    const requestId = `ca-${alg}`;
    await reset();
    await registerKey(requestId, alg);
    const { signIn, exchanged, redeemed } = await allSteps(requestId);
    expect(signIn.map(s => s.status)).toEqual(['ok', 'ok', 'ok']);
    expect(exchanged[0].status).toBe('ok');
    expect(redeemed.map(s => [s.id, s.status])).toEqual([['jwt-bearer', 'ok'], ['verify', 'ok']]);
    // The assertion is shown decoded at each hop: claims name the client and the right endpoint.
    const assertion = (steps: { jwts?: { label: string; token: string }[] }[]) => decodeJwt(steps.flatMap(s => s.jwts ?? []).find(j => j.label === 'Client assertion')!.token)!;
    expect(assertion(signIn).payload).toMatchObject({ iss: 'insomnia-xaa', sub: 'insomnia-xaa', aud: `${IDP}/token` });
    expect(assertion(exchanged).header).toMatchObject({ alg, typ: 'JWT' });
    expect(assertion(redeemed).payload.aud).toBe(`${AS}/token`);
    const sent = service
      .getTrace({ requestId })
      .filter(e => e.flow === 'oauth' && e.direction === 'client-to-server')
      .map(e => String((e.payload as { body?: unknown }).body ?? ''));
    expect(sent.some(body => body.includes('client_assertion='))).toBe(true);
    expect(sent.some(body => body.includes('client_secret='))).toBe(false);
  });

  it('is refused when no key was registered at the server, saying so', async () => {
    const requestId = 'ca-unregistered';
    await reset();
    generateKey({ requestId });
    const { signIn } = await allSteps(requestId);
    expect(signIn[2].status).toBe('error');
    expect(signIn[2].findings[0].text).toContain('no public key is registered for client insomnia-xaa');
  });

  it('is refused when the key signing does not match the registered one', async () => {
    const requestId = 'ca-wrong-key';
    await reset();
    const registered = generateKey({ requestId: 'ca-someone-else' });
    await post(`${IDP}/admin/clients`, { clientId: 'insomnia-xaa', jwks: registered.jwks });
    generateKey({ requestId });
    const { signIn } = await allSteps(requestId);
    expect(signIn[2].findings[0].text).toMatch(/no registered key has kid|signature verification failed/);
    clearKey({ requestId: 'ca-someone-else' });
  });

  it('shows the audience mismatch that strict servers cause, and the fix', async () => {
    const requestId = 'ca-aud';
    await reset();
    await registerKey(requestId);
    await post(`${IDP}/admin/flags`, { assertionAudIssuer: true });
    const wrong = await allSteps(requestId);
    expect(wrong.signIn[2].findings[0].text).toContain(`aud must be "${IDP}"`);
    // The same server is happy once the assertion names the issuer instead of the token endpoint.
    const fixed = await allSteps(requestId, { ...assertionIdp, audience: 'issuer' });
    expect(fixed.signIn.map(s => s.status)).toEqual(['ok', 'ok', 'ok']);
    await reset();
  });

  it('turns client_secret away when the server only takes assertions, and the same at the authorization server', async () => {
    const requestId = 'ca-required';
    await reset();
    await registerKey(requestId);
    await post(`${IDP}/admin/flags`, { requireAssertion: true });
    const secretAtIdp = await allSteps(requestId, { ...idpClient, clientAuth: 'secret' } as never);
    expect(secretAtIdp.signIn[2].findings[0].text).toContain('requires a signed client assertion');
    await reset();
    await registerKey(requestId);
    await post(`${AS}/admin/flags`, { requireAssertion: true });
    const secretAtAs = await allSteps(requestId, assertionIdp, { ...asClient, clientAuth: 'secret' } as never);
    expect(secretAtAs.redeemed[0].findings[0].text).toContain('requires a signed client assertion');
    // ... and signing at the authorization server works.
    const ok = await allSteps(requestId);
    expect(ok.redeemed.map(s => s.status)).toEqual(['ok', 'ok']);
    await reset();
  });

  it('says what is missing when there is no key yet, without calling the server', async () => {
    const requestId = 'ca-no-key';
    await reset();
    clearKey({ requestId });
    const { signIn } = await allSteps(requestId);
    expect(signIn.at(-1)).toMatchObject({ status: 'error', summary: 'Cannot authenticate' });
    expect(signIn.at(-1)!.findings[0].text).toContain('No signing key yet');
  });

  it('rejects an assertion that is used twice', async () => {
    await reset();
    const info = generateKey({ requestId: 'ca-replay' });
    await post(`${IDP}/admin/clients`, { clientId: 'insomnia-xaa', jwks: info.jwks });
    const signed = signAssertion({ requestId: 'ca-replay', clientId: 'insomnia-xaa', audience: `${IDP}/token` })!;
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: signed.token });
    const first = await fetch(`${IDP}/token`, { method: 'POST', body });
    expect((await first.json()).error_description).not.toMatch(/jti/); // fails later for other reasons: no code
    const second = await (await fetch(`${IDP}/token`, { method: 'POST', body })).json();
    expect(second.error_description).toMatch(/jti .* was already used/);
    await reset();
  });
});
