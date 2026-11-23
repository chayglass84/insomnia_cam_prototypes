import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decodeJwt } from '~/common/mcp-debugger/jwt';

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

const run = async (requestId: string, user = 'alex') => {
  await fetch(`${IDP}/admin/reset`, { method: 'POST' });
  const discovery = await discoverOAuth({ url: `${MCP}/xaa-protected`, trace: service.oauthTraceFor(requestId) });
  const context = discovery.context!;
  const signIn = await xaaSignIn({ requestId, idp: idpClient, openUrl: signInAs(user), timeoutMs: 5000, trace: service.oauthTraceFor(requestId) });
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
