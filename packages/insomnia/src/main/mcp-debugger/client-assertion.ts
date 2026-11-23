import crypto from 'node:crypto';

// Task 4348 S9a: signed client assertions (private_key_jwt, RFC 7523 section 2.2 / RFC 7521) as an alternative to a
// client secret. The client proves who it is by signing a short-lived JWT with a private key whose public half is
// registered (as a JWKS) at the server. Used at both token endpoints in the XAA flow: the IdP's (code exchange and
// ID-JAG exchange) and the MCP authorization server's (JWT bearer grant).
// The private key stays in the main process (the renderer only ever sees the public JWKS) and is held in memory per
// request, lost on restart. PROTOTYPE-MOCK: one key per request, used at both servers; RS256 and ES256 (P-256) only.

export type AssertionAudience = 'token-endpoint' | 'issuer';
export type AssertionAlg = 'RS256' | 'ES256';

export interface ClientKeyInfo {
  kid: string;
  alg: AssertionAlg;
  /** The public key as a JWKS: what to register at the IdP and the authorization server. */
  jwks: { keys: Record<string, unknown>[] };
  publicPem: string;
  /** True when Insomnia generated the key (the private half exists nowhere else). */
  generated: boolean;
}

interface StoredKey {
  privateKey: crypto.KeyObject;
  info: ClientKeyInfo;
}
const keys = new Map<string, StoredKey>();

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

const b64u = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** RFC 7638 JWK thumbprint, used as the default `kid`. */
export const jwkThumbprint = (jwk: Record<string, unknown>): string => {
  const members = jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { e: jwk.e, kty: jwk.kty, n: jwk.n };
  return crypto.createHash('sha256').update(JSON.stringify(members)).digest('base64url');
};

const describe = (privateKey: crypto.KeyObject, kid: string | undefined, generated: boolean): ClientKeyInfo => {
  const type = privateKey.asymmetricKeyType;
  const curve = privateKey.asymmetricKeyDetails?.namedCurve;
  let alg: AssertionAlg;
  if (type === 'rsa') {
    alg = 'RS256';
  } else if (type === 'ec' && curve === 'prime256v1') {
    alg = 'ES256';
  } else {
    throw new Error(`Unsupported key: ${type ?? 'unknown'}${curve ? ` (${curve})` : ''}. Use an RSA key (RS256) or an EC P-256 key (ES256).`);
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const id = kid?.trim() || jwkThumbprint(jwk);
  return {
    kid: id,
    alg,
    jwks: { keys: [{ ...jwk, kid: id, alg, use: 'sig' }] },
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    generated,
  };
};

export const generateKey = ({ requestId, alg = 'RS256' }: { requestId: string; alg?: AssertionAlg }): ClientKeyInfo => {
  const { privateKey } = alg === 'ES256' ? crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const info = describe(privateKey, undefined, true);
  keys.set(requestId, { privateKey, info });
  return info;
};

/** Use a private key the developer already has (PEM, PKCS#8 or traditional), e.g. the one registered at their IdP. */
export const importKey = ({ requestId, pem, kid }: { requestId: string; pem: string; kid?: string }): ClientKeyInfo => {
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(pem.trim());
  } catch {
    throw new Error('That is not a private key Insomnia can read. Paste a PEM block that starts with -----BEGIN PRIVATE KEY----- (or RSA / EC PRIVATE KEY). Encrypted keys are not supported.');
  }
  const info = describe(privateKey, kid, false);
  keys.set(requestId, { privateKey, info });
  return info;
};

export const getKey = ({ requestId }: { requestId: string }): ClientKeyInfo | null => keys.get(requestId)?.info ?? null;
export const clearKey = ({ requestId }: { requestId: string }) => {
  keys.delete(requestId);
};

export interface SignedAssertion {
  token: string;
  claims: Record<string, unknown>;
}

/** A fresh client assertion: iss and sub are the client id, aud the token endpoint (or issuer), valid for a minute. */
export const signAssertion = ({
  requestId,
  clientId,
  audience,
  ttlSeconds = 60,
  now = Math.floor(Date.now() / 1000),
}: {
  requestId: string;
  clientId: string;
  audience: string;
  ttlSeconds?: number;
  now?: number;
}): SignedAssertion | null => {
  const stored = keys.get(requestId);
  if (!stored) {
    return null;
  }
  const claims = { iss: clientId, sub: clientId, aud: audience, iat: now, exp: now + ttlSeconds, jti: crypto.randomUUID() };
  const signingInput = `${b64u(JSON.stringify({ alg: stored.info.alg, typ: 'JWT', kid: stored.info.kid }))}.${b64u(JSON.stringify(claims))}`;
  const signature =
    stored.info.alg === 'ES256'
      ? crypto.sign('sha256', Buffer.from(signingInput), { key: stored.privateKey, dsaEncoding: 'ieee-p1363' })
      : crypto.sign('RSA-SHA256', Buffer.from(signingInput), stored.privateKey);
  return { token: `${signingInput}.${b64u(signature)}`, claims };
};

export interface ClientAuthConfig {
  clientId: string;
  /** `secret` (the default) sends client_secret; `assertion` signs a client assertion with this request's key. */
  clientAuth?: 'secret' | 'assertion';
  clientSecret?: string;
  /** What the assertion's `aud` names. Servers differ, which is a classic source of invalid_client. */
  audience?: AssertionAudience;
}

/** The form parameters that authenticate the client at one token endpoint, plus the assertion (to show it decoded). */
export const clientAuthParams = ({
  requestId,
  auth,
  tokenEndpoint,
  issuer,
}: {
  requestId: string;
  auth: ClientAuthConfig;
  tokenEndpoint: string;
  issuer?: string;
}): { params: Record<string, string | undefined>; assertion?: string } | { error: string } => {
  if (auth.clientAuth !== 'assertion') {
    return { params: { client_id: auth.clientId, client_secret: auth.clientSecret } };
  }
  const audience = auth.audience === 'issuer' ? issuer : tokenEndpoint;
  if (!audience) {
    return { error: 'The assertion audience is the issuer, but this server published no issuer to use.' };
  }
  const signed = signAssertion({ requestId, clientId: auth.clientId, audience });
  if (!signed) {
    return { error: 'No signing key yet. Generate a key or paste a private key first.' };
  }
  return { params: { client_id: auth.clientId, client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: signed.token }, assertion: signed.token };
};
