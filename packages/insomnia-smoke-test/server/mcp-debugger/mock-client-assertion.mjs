/**
 * Shared by mock-idp.mjs and mock-authorization-server.mjs (4348 S9a): verifies a signed client assertion
 * (private_key_jwt, RFC 7523 section 2.2) the way a strict server would, and says in plain words what is wrong.
 * Keys are registered per client by the mocks' POST /admin/clients (the equivalent of pasting a JWKS into an IdP console).
 */

import crypto from "node:crypto";

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * @param {object} options
 * @param {string} options.assertion the JWT from client_assertion
 * @param {string | undefined} options.clientId client_id from the request, if it sent one (must match the assertion's sub)
 * @param {(clientId: string) => object[] | undefined} options.keysFor the client's registered public JWKs
 * @param {string[]} options.audiences the `aud` values this server accepts (its issuer and/or its token endpoint URL)
 * @param {Set<string>} options.usedJtis jti values already seen
 * @returns {{ clientId: string } | { error: string }}
 */
export function verifyClientAssertion({ assertion, clientId, keysFor, audiences, usedJtis, now = Math.floor(Date.now() / 1000) }) {
  const parts = String(assertion).split(".");
  if (parts.length !== 3) return { error: "the client assertion is not a JWT" };
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { error: "the client assertion is not valid base64url JSON" };
  }
  if (header.alg !== "RS256" && header.alg !== "ES256") return { error: `unsupported alg ${header.alg ?? "(none)"}; this server accepts RS256 and ES256` };
  if (!claims.iss || claims.iss !== claims.sub) return { error: `iss and sub must both be the client id (iss=${claims.iss ?? "(none)"}, sub=${claims.sub ?? "(none)"})` };
  if (clientId && clientId !== claims.sub) return { error: `client_id ${clientId} does not match the assertion's sub ${claims.sub}` };
  const keys = keysFor(claims.sub);
  if (!keys || keys.length === 0) return { error: `no public key is registered for client ${claims.sub}` };
  const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys.length === 1 ? keys[0] : undefined;
  if (!jwk) return { error: header.kid ? `no registered key has kid ${header.kid}` : "the assertion has no kid and several keys are registered" };
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  const ok =
    header.alg === "ES256"
      ? crypto.verify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
      : crypto.verify("RSA-SHA256", data, publicKey, signature);
  if (!ok) return { error: "signature verification failed against the registered key" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => audiences.includes(a))) return { error: `aud must be ${audiences.map((a) => `"${a}"`).join(" or ")}, got ${JSON.stringify(claims.aud)}` };
  if (typeof claims.exp !== "number") return { error: "exp is missing" };
  if (claims.exp + 30 <= now) return { error: `the assertion expired ${now - claims.exp} s ago` };
  if (claims.exp - now > 600) return { error: "exp is more than 10 minutes away; assertions must be short-lived" };
  if (typeof claims.iat === "number" && claims.iat > now + 60) return { error: "iat is in the future (check the clock)" };
  if (!claims.jti) return { error: "jti is missing" };
  if (usedJtis.has(claims.jti)) return { error: `jti ${claims.jti} was already used; every assertion needs a fresh jti` };
  usedJtis.add(claims.jti);
  return { clientId: claims.sub };
}

/** Which `aud` values to accept, from the mocks' flags: either by default, or only the issuer, or only the token endpoint. */
export function acceptedAudiences(flags, issuer, tokenEndpoint) {
  if (flags.assertionAudIssuer) return [issuer];
  if (flags.assertionAudToken) return [tokenEndpoint];
  return [issuer, tokenEndpoint];
}
