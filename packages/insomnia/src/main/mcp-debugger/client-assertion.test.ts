import crypto from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { decodeJwt } from '~/common/mcp-debugger/jwt';

import { clearKey, CLIENT_ASSERTION_TYPE, clientAuthParams, generateKey, getKey, importKey, jwkThumbprint, signAssertion } from './client-assertion';

const id = 'ca-test';
beforeEach(() => clearKey({ requestId: id }));

const verify = (token: string, jwk: Record<string, unknown>, alg: 'RS256' | 'ES256') => {
  const [h, p, s] = token.split('.');
  const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  return alg === 'ES256'
    ? crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
    : crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
};

describe('client assertion keys', () => {
  it.each(['RS256', 'ES256'] as const)('generates a %s key whose assertions verify against the published JWKS', alg => {
    const info = generateKey({ requestId: id, alg });
    expect(info).toMatchObject({ alg, generated: true });
    expect(info.kid).toBe(jwkThumbprint(info.jwks.keys[0]));
    expect(info.jwks.keys[0]).toMatchObject({ kid: info.kid, alg, use: 'sig' });
    expect(info.publicPem).toContain('BEGIN PUBLIC KEY');
    // The private key never appears in what the renderer is given.
    expect(JSON.stringify(info)).not.toMatch(/"d":|PRIVATE/);

    const signed = signAssertion({ requestId: id, clientId: 'client-1', audience: 'https://idp/token', now: 1000 })!;
    const decoded = decodeJwt(signed.token)!;
    expect(decoded.header).toMatchObject({ alg, typ: 'JWT', kid: info.kid });
    expect(decoded.payload).toMatchObject({ iss: 'client-1', sub: 'client-1', aud: 'https://idp/token', iat: 1000, exp: 1060 });
    expect(typeof decoded.payload.jti).toBe('string');
    expect(verify(signed.token, info.jwks.keys[0], alg)).toBe(true);
  });

  it('gives every assertion its own jti', () => {
    generateKey({ requestId: id });
    const a = signAssertion({ requestId: id, clientId: 'c', audience: 'a' })!;
    const b = signAssertion({ requestId: id, clientId: 'c', audience: 'a' })!;
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it('imports a private key the developer already has, with their own kid', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const info = importKey({ requestId: id, pem, kid: 'my-registered-key' });
    expect(info).toMatchObject({ alg: 'ES256', kid: 'my-registered-key', generated: false });
    const signed = signAssertion({ requestId: id, clientId: 'c', audience: 'a' })!;
    expect(decodeJwt(signed.token)!.header).toMatchObject({ kid: 'my-registered-key' });
    expect(verify(signed.token, info.jwks.keys[0], 'ES256')).toBe(true);
  });

  it('refuses things that are not usable keys, saying why', () => {
    expect(() => importKey({ requestId: id, pem: 'nope' })).toThrow(/not a private key Insomnia can read/);
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    expect(() => importKey({ requestId: id, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() })).toThrow(/P-256/);
    const encrypted = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' }).toString();
    expect(() => importKey({ requestId: id, pem: encrypted })).toThrow(/Encrypted keys are not supported/);
    expect(getKey({ requestId: id })).toBeNull();
  });
});

describe('clientAuthParams', () => {
  it('sends the secret by default', () => {
    expect(clientAuthParams({ requestId: id, auth: { clientId: 'c', clientSecret: 's' }, tokenEndpoint: 'https://t' })).toEqual({ params: { client_id: 'c', client_secret: 's' } });
  });

  it('signs an assertion for the token endpoint or the issuer, as asked', () => {
    generateKey({ requestId: id });
    const toToken = clientAuthParams({ requestId: id, auth: { clientId: 'c', clientAuth: 'assertion' }, tokenEndpoint: 'https://idp/token', issuer: 'https://idp' }) as { params: Record<string, string>; assertion: string };
    expect(toToken.params).toMatchObject({ client_id: 'c', client_assertion_type: CLIENT_ASSERTION_TYPE });
    expect(toToken.params.client_secret).toBeUndefined();
    expect(decodeJwt(toToken.assertion)!.payload.aud).toBe('https://idp/token');
    const toIssuer = clientAuthParams({ requestId: id, auth: { clientId: 'c', clientAuth: 'assertion', audience: 'issuer' }, tokenEndpoint: 'https://idp/token', issuer: 'https://idp' }) as { assertion: string };
    expect(decodeJwt(toIssuer.assertion)!.payload.aud).toBe('https://idp');
  });

  it('explains what is missing', () => {
    expect(clientAuthParams({ requestId: id, auth: { clientId: 'c', clientAuth: 'assertion' }, tokenEndpoint: 'https://t' })).toEqual({ error: expect.stringMatching(/No signing key yet/) });
    generateKey({ requestId: id });
    expect(clientAuthParams({ requestId: id, auth: { clientId: 'c', clientAuth: 'assertion', audience: 'issuer' }, tokenEndpoint: 'https://t' })).toEqual({ error: expect.stringMatching(/no issuer/) });
  });
});
