/**
 * Mock Authorization Server for OAuth e2e tests.
 *
 * Implements:
 *   RFC 8414  – Authorization server metadata (/.well-known/oauth-authorization-server)
 *   RFC 9728  – Protected-resource metadata (/.well-known/oauth-protected-resource)
 *   RFC 7591  – Dynamic Client Registration (/register)
 *   RFC 9207  – iss parameter on authorization response
 *   RFC 8707  – resource parameter
 *   CIMD      – accepts URL client_id, fetches + validates client metadata doc
 *   PKCE S256 – /authorize + /token (code exchange and refresh)
 *
 * Failure-mode controls via query-string:
 *   ?omit_discovery=1  – 404 on /.well-known/oauth-authorization-server
 *   ?tamper_iss=1      – send wrong iss on /authorize redirect
 *   ?fail=1            – redirect back with error=access_denied instead of a code
 *   ?short_ttl=1       – issue access_token with 2s expiry (triggers refresh)
 *   ?fail_refresh=1    – return invalid_grant on /token with grant_type=refresh_token
 *
 * Enterprise-Managed Authorization / XAA (4348 S8), only when started with MOCK_AS_XAA=1 (otherwise this is a plain OAuth
 * authorization server: no id-jag profile in its metadata, and the jwt-bearer grant is refused): also accepts the RFC 7523 JWT bearer grant carrying an ID-JAG
 * (typ oauth-id-jag+jwt) issued by the mock IdP (mock-idp.mjs, MOCK_TRUSTED_IDP, default http://127.0.0.1:9100), and
 * advertises authorization_grant_profiles_supported. The ID-JAG is validated the way the draft says an authorization
 * server must (typ, signature, issuer, aud, exp, client_id binding, jti replay) and rejected with invalid_grant plus a
 * description naming the failed check. The client authenticates with client_id `insomnia-xaa` and client_secret
 * `insomnia-xaa-as-secret` (deliberately different from the IdP secret: the two registrations are independent).
 *
 * Consent page (4348): with MOCK_AUTH_CONSENT=1 (or the `consent` flag via /admin/flags), /authorize shows a silly
 * Absolutely / No Way page instead of auto-granting, so the browser leg of the flow is visible. Off by default so the
 * e2e specs, which rely on the auto-grant redirect, are unaffected.
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const port = Number(process.env.MOCK_AUTHORIZATION_SERVER_PORT ?? "9000");
const host = "127.0.0.1";

// Access-token lifetime issued when the shortTtl flag is set (see /admin/flags).
// oauth.e2e.spec.ts mirrors this value (as SHORT_TTL_SECONDS) to wait it out.
const SHORT_TTL_SECONDS = 2;

// ---------------------------------------------------------------------------
// Failure-mode flags (set by query string on the very first /.well-known request).
// We store them in a mutable object so individual tests can toggle them via the
// /admin/flags endpoint without restarting the server.
// ---------------------------------------------------------------------------
const flags = {
  omitDiscovery: false,
  tamperIss: false,
  fail: false,
  shortTtl: false,
  failRefresh: false,
  consent: process.env.MOCK_AUTH_CONSENT === "1",
};

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
/** Issued auth codes: code → { clientId, codeChallenge, redirectUri, resource, connectionId } */
const authCodes = new Map();
/** Issued access tokens: token → { clientId, resource, expiresAt } */
const accessTokens = new Map();
/** Issued refresh tokens: token → { clientId, resource } */
const refreshTokens = new Map();
/** DCR-registered clients: clientId → { redirectUris, secret? } */
const registeredClients = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseBodyAsForm(raw) {
  const params = new URLSearchParams(raw);
  const obj = {};
  for (const [k, v] of params) obj[k] = v;
  return obj;
}

function writeJson(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    ...extraHeaders,
  });
  res.end(json);
}

function writeError(res, status, error, description) {
  writeJson(res, status, { error, error_description: description });
}

/** Verify PKCE S256: BASE64URL(SHA256(verifier)) === challenge */
function verifyPkce(verifier, challenge) {
  const digest = crypto.createHash("sha256").update(verifier).digest("base64url");
  return digest === challenge;
}

const issuer = `http://${host}:${port}`;

/** XAA support is opt-in, so one mock can be a plain OAuth server (:9000) and another an XAA-capable one (:9001). */
const xaaEnabled = process.env.MOCK_AS_XAA === "1";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ID_JAG_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";
const trustedIdp = process.env.MOCK_TRUSTED_IDP ?? "http://127.0.0.1:9100";
/** The one client registered for the XAA grant at this authorization server. */
const XAA_CLIENT = { id: "insomnia-xaa", secret: "insomnia-xaa-as-secret" };
/** jti values already redeemed (an ID-JAG is single use). */
const usedJtis = new Set();

/** Validate an ID-JAG; returns { claims } or { error } where error is the invalid_grant description. */
async function validateIdJag(assertion) {
  const parts = String(assertion).split(".");
  if (parts.length !== 3) return { error: "assertion is not a JWT" };
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { error: "assertion is not valid base64url JSON" };
  }
  if (header.typ !== "oauth-id-jag+jwt") return { error: `JWT header typ must be oauth-id-jag+jwt, got ${header.typ ?? "(none)"}` };
  if (claims.iss !== trustedIdp) return { error: `untrusted issuer ${claims.iss}; this server trusts ${trustedIdp}` };
  let jwks;
  try {
    jwks = await (await fetch(`${trustedIdp}/.well-known/jwks.json`)).json();
  } catch (err) {
    return { error: `could not fetch the IdP's JWKS: ${err.message}` };
  }
  const jwk = jwks.keys?.find((k) => k.kid === header.kid);
  if (!jwk) return { error: `no key with kid ${header.kid} in the IdP's JWKS` };
  const signatureOk = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!signatureOk) return { error: "signature verification failed" };
  if (claims.aud !== issuer) return { error: `aud must be this authorization server (${issuer}), got ${claims.aud}` };
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) return { error: "the ID-JAG has expired" };
  for (const claim of ["sub", "client_id", "jti", "iat"]) {
    if (claims[claim] === undefined) return { error: `required claim ${claim} is missing` };
  }
  if (usedJtis.has(claims.jti)) return { error: `jti ${claims.jti} was already used (an ID-JAG can be redeemed once)` };
  return { claims };
}

function auhorizationServerMetadata() {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: xaaEnabled ? ["authorization_code", "refresh_token", JWT_BEARER] : ["authorization_code", "refresh_token"],
    // Enterprise-Managed Authorization (XAA): this server accepts ID-JAGs (draft-ietf-oauth-identity-assertion-authz-grant).
    ...(xaaEnabled ? { authorization_grant_profiles_supported: [ID_JAG_PROFILE] } : {}),
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

// Fetch a CIMD metadata doc and validate that its client_id matches the URL.
async function fetchCimdDoc(clientIdUrl) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(clientIdUrl);
    } catch {
      return reject(new Error("invalid client_id URL"));
    }

    const lib = parsedUrl.protocol === "https:" ? https : http;
    const req = lib.get(clientIdUrl, { timeout: 5000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`CIMD fetch failed: HTTP ${res.statusCode}`));
        }
        try {
          const doc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(doc);
        } catch {
          reject(new Error("CIMD doc is not valid JSON"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("CIMD fetch timed out"));
    });
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  });
  res.end();
}

function handleHealth(res) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}

function handleWellKnownAs(res) {
  if (flags.omitDiscovery) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  writeJson(res, 200, auhorizationServerMetadata());
}

// Protected-resource metadata for the mock MCP server.
// The MCP server URL must be passed as MOCK_MCP_ORIGIN env var.
function handleWellKnownPrm(res) {
  const mcpOrigin = process.env.MOCK_MCP_ORIGIN ?? "http://127.0.0.1:8787";
  writeJson(res, 200, {
    resource: mcpOrigin,
    authorization_servers: [issuer],
  });
}

async function handleRegister(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return writeError(res, 400, "invalid_request", "body must be JSON");
  }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return writeError(res, 400, "invalid_redirect_uri", "redirect_uris required");
  }

  const clientId = `dcr-${randomToken(12)}`;
  // If the client requests client_secret_post auth, issue a secret.
  const wantsSecret = body.token_endpoint_auth_method === "client_secret_post";
  const clientSecret = wantsSecret ? randomToken(24) : undefined;
  registeredClients.set(clientId, { redirectUris: body.redirect_uris, clientSecret });

  const response = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris,
    token_endpoint_auth_method: wantsSecret ? "client_secret_post" : "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
  if (clientSecret) response.client_secret = clientSecret;
  writeJson(res, 201, response);
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The silly consent page. Both buttons re-request /authorize with consent_decision, keeping every other parameter. */
function consentPage(url, clientId, resource) {
  const link = (decision) => {
    const next = new URL(url);
    next.searchParams.set("consent_decision", decision);
    return escapeHtml(next.pathname + next.search);
  };
  const scope = url.searchParams.get("scope");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock authorization server</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f1fa; color: #1c1b22; display: flex; justify-content: center; padding-top: 12vh; }
  main { background: #fff; border-radius: 12px; padding: 2rem 2.5rem; max-width: 34rem; box-shadow: 0 4px 24px rgba(0,0,0,.12); }
  h1 { font-size: 1.15rem; margin-top: 0; }
  dl { font-size: .85rem; color: #555; display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
  dd { margin: 0; font-family: ui-monospace, monospace; word-break: break-all; }
  .buttons { display: flex; gap: 1rem; margin-top: 1.5rem; }
  a.button { flex: 1; text-align: center; padding: .7rem 1rem; border-radius: 8px; text-decoration: none; font-weight: 600; }
  a.yes { background: #5b3df5; color: #fff; }
  a.no { background: #fff; color: #5b3df5; border: 2px solid #5b3df5; }
</style></head>
<body><main data-testid="mock-consent">
  <h1>Since this is the internet, do you have blind faith in letting this client access your account on this server?</h1>
  <dl>
    <dt>Client</dt><dd>${escapeHtml(clientId)}</dd>
    <dt>Resource</dt><dd>${escapeHtml(resource ?? "(none)")}</dd>
    <dt>Scope</dt><dd>${escapeHtml(scope ?? "(none)")}</dd>
  </dl>
  <div class="buttons">
    <a class="button yes" href="${link("allow")}" data-testid="mock-consent-allow">Absolutely</a>
    <a class="button no" href="${link("deny")}" data-testid="mock-consent-deny">No Way</a>
  </div>
</main></body></html>`;
}

/**
 * /authorize: validate params, auto-grant, redirect back with code (+ iss).
 * In tests Playwright intercepts this page and checks the redirect instead of
 * driving a login UI. We respond with a minimal HTML that immediately redirects.
 */
async function handleAuthorize(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const resource = url.searchParams.get("resource");
  const scopeParam = url.searchParams.get("scope");

  if (!clientId || !redirectUri || !state || !codeChallenge || codeChallengeMethod !== "S256") {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing required OAuth parameters");
    return;
  }

  // Validate client_id: either a DCR-registered id or a CIMD URL.
  let isKnownClient = registeredClients.has(clientId);

  if (!isKnownClient) {
    // CIMD path: client_id is a URL -> fetch the metadata doc and validate it.
    let looksLikeUrl = false;
    try {
      const u = new URL(clientId);
      looksLikeUrl = u.protocol === "http:" || u.protocol === "https:";
    } catch {
      // not a URL
    }

    if (looksLikeUrl) {
      try {
        const doc = await fetchCimdDoc(clientId);
        if (doc.client_id !== clientId) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`CIMD validation failed: doc client_id "${doc.client_id}" !== "${clientId}"`);
          return;
        }
        if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.includes(redirectUri)) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`CIMD validation failed: redirect_uri not in doc.redirect_uris`);
          return;
        }
        // Register implicitly so /token can validate.
        registeredClients.set(clientId, { redirectUris: doc.redirect_uris, cimd: true });
        isKnownClient = true;
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`CIMD fetch/validation failed: ${e.message}`);
        return;
      }
    }
  }

  if (!isKnownClient) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Unknown client_id: ${clientId}`);
    return;
  }

  // RFC 9207: iss goes on error responses too. Tamper it if the flag is set.
  const iss = flags.tamperIss ? "https://attacker.example.com" : issuer;
  const denyRedirect = () => {
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("error", "access_denied");
    callbackUrl.searchParams.set("error_description", "The resource owner denied the request.");
    callbackUrl.searchParams.set("state", state);
    callbackUrl.searchParams.set("iss", iss);
    res.writeHead(302, { Location: callbackUrl.toString() });
    res.end();
  };

  if (flags.fail) {
    denyRedirect();
    return;
  }

  // 4348 consent page: ask the human before granting (see header comment).
  const decision = url.searchParams.get("consent_decision");
  if (flags.consent && !decision) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(consentPage(url, clientId, resource));
    return;
  }
  if (decision === "deny") {
    denyRedirect();
    return;
  }

  const code = randomToken(24);
  authCodes.set(code, {
    clientId,
    codeChallenge,
    redirectUri,
    resource: resource ?? null,
    scope: scopeParam ?? null,
  });

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set("state", state);

  // RFC 9207: include iss on the authorization response.
  callbackUrl.searchParams.set("iss", iss);

  // Auto-grant: immediate redirect with no human interaction.
  res.writeHead(302, { Location: callbackUrl.toString() });
  res.end();
}

async function handleToken(req, res) {
  const raw = await readBody(req);
  const body = parseBodyAsForm(raw);
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    const code = body.code;
    const verifier = body.code_verifier;
    const clientId = body.client_id;
    const redirectUri = body.redirect_uri;

    if (!code || !verifier || !clientId) {
      return writeError(res, 400, "invalid_request", "Missing required parameters");
    }

    const stored = authCodes.get(code);
    if (!stored) {
      return writeError(res, 400, "invalid_grant", "Unknown or expired authorization code");
    }
    authCodes.delete(code);

    if (stored.clientId !== clientId) {
      return writeError(res, 400, "invalid_grant", "client_id mismatch");
    }
    if (stored.redirectUri !== redirectUri) {
      return writeError(res, 400, "invalid_grant", "redirect_uri mismatch");
    }
    if (!verifyPkce(verifier, stored.codeChallenge)) {
      return writeError(res, 400, "invalid_grant", "PKCE verification failed");
    }
    // Validate client_secret when the client is confidential.
    const clientReg = registeredClients.get(clientId);
    if (clientReg?.clientSecret) {
      if (body.client_secret !== clientReg.clientSecret) {
        return writeError(res, 401, "invalid_client", "invalid client_secret");
      }
    }

    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const expiresIn = flags.shortTtl ? SHORT_TTL_SECONDS : 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    accessTokens.set(accessToken, { clientId, resource: stored.resource, expiresAt, scope: stored.scope });
    refreshTokens.set(refreshToken, { clientId, resource: stored.resource, scope: stored.scope });

    writeJson(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      ...(stored.scope ? { scope: stored.scope } : {}),
    });
    return;
  }

  if (grantType === "refresh_token") {
    if (flags.failRefresh) {
      return writeError(res, 400, "invalid_grant", "Refresh token is invalid or expired");
    }

    const refreshToken = body.refresh_token;
    const clientId = body.client_id;
    if (!refreshToken || !clientId) {
      return writeError(res, 400, "invalid_request", "Missing refresh_token or client_id");
    }

    const stored = refreshTokens.get(refreshToken);
    if (!stored || stored.clientId !== clientId) {
      return writeError(res, 400, "invalid_grant", "Unknown or expired refresh token");
    }

    // Rotate: invalidate old tokens, issue new ones.
    refreshTokens.delete(refreshToken);
    // Clear any access token associated with this client (best-effort).
    for (const [token, data] of accessTokens) {
      if (data.clientId === clientId) accessTokens.delete(token);
    }

    const newAccessToken = randomToken(32);
    const newRefreshToken = randomToken(32);
    const expiresIn = flags.shortTtl ? SHORT_TTL_SECONDS : 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    accessTokens.set(newAccessToken, { clientId, resource: stored.resource, expiresAt, scope: stored.scope });
    refreshTokens.set(newRefreshToken, { clientId, resource: stored.resource, scope: stored.scope });

    writeJson(res, 200, {
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: newRefreshToken,
      ...(stored.scope ? { scope: stored.scope } : {}),
    });
    return;
  }

  if (grantType === JWT_BEARER && xaaEnabled) {
    // Client authentication (client_secret_post or Basic).
    let clientId = body.client_id;
    let secret = body.client_secret;
    const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
    if (basic) {
      const [user, pass] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      clientId = decodeURIComponent(user);
      secret = decodeURIComponent(pass ?? "");
    }
    if (clientId !== XAA_CLIENT.id || secret !== XAA_CLIENT.secret) {
      return writeError(res, 401, "invalid_client", "Client authentication failed (unknown client_id or wrong client_secret for this authorization server).");
    }
    if (!body.assertion) {
      return writeError(res, 400, "invalid_request", "assertion is required");
    }
    const checked = await validateIdJag(body.assertion);
    if (checked.error) {
      return writeError(res, 400, "invalid_grant", checked.error);
    }
    const { claims } = checked;
    if (claims.client_id !== clientId) {
      return writeError(res, 400, "invalid_grant", `the ID-JAG client_id (${claims.client_id}) does not match the authenticated client (${clientId})`);
    }
    usedJtis.add(claims.jti);
    const accessToken = randomToken(32);
    const expiresIn = flags.shortTtl ? SHORT_TTL_SECONDS : 3600;
    // Audience-restricted to the MCP server named by the ID-JAG's resource claim, and no refresh token (the draft says SHOULD NOT).
    accessTokens.set(accessToken, { clientId, resource: claims.resource, expiresAt: Date.now() + expiresIn * 1000, scope: claims.scope });
    return writeJson(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, ...(claims.scope ? { scope: claims.scope } : {}) });
  }

  writeError(res, 400, "unsupported_grant_type", `Unknown grant_type: ${grantType}`);
}

/** Read-only token introspection for tests. */
function handleIntrospect(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);
  const token = url.searchParams.get("token");
  if (!token) {
    return writeJson(res, 200, { active: false });
  }
  const data = accessTokens.get(token);
  if (!data) {
    return writeJson(res, 200, { active: false });
  }
  const active = data.expiresAt > Date.now();
  writeJson(res, 200, { active, client_id: data.clientId, resource: data.resource, scope: data.scope ?? undefined });
}

/**
 * Admin endpoint for Playwright tests to configure failure-mode flags without
 * restarting the server. POST /admin/flags with a JSON body of flag overrides.
 * GET /admin/flags returns current flags.
 * POST /admin/reset clears all in-memory state and resets flags.
 */
async function handleAdmin(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);

  if (url.pathname === "/admin/reset") {
    authCodes.clear();
    accessTokens.clear();
    refreshTokens.clear();
    registeredClients.clear();
    usedJtis.clear();
    flags.omitDiscovery = false;
    flags.tamperIss = false;
    flags.fail = false;
    flags.shortTtl = false;
    flags.failRefresh = false;
    flags.consent = process.env.MOCK_AUTH_CONSENT === "1";
    return writeJson(res, 200, { ok: true });
  }

  if (url.pathname === "/admin/flags") {
    if (req.method === "GET") {
      return writeJson(res, 200, { ...flags });
    }
    if (req.method === "POST") {
      const raw = await readBody(req);
      let updates;
      try {
        updates = JSON.parse(raw);
      } catch {
        return writeError(res, 400, "invalid_request", "body must be JSON");
      }
      Object.assign(flags, updates);
      return writeJson(res, 200, { ...flags });
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
async function handler(req, res) {
  const url = new URL(req.url, `http://${host}:${port}`);

  if (req.method === "OPTIONS") {
    handleOptions(res);
    return;
  }

  if (url.pathname === "/health") {
    handleHealth(res);
    return;
  }

  if (url.pathname === "/.well-known/oauth-authorization-server") {
    handleWellKnownAs(res);
    return;
  }

  // RFC 9728 protected-resource metadata served from the AS for convenience in
  // tests where the mock MCP server doesn't serve its own PRM.
  if (url.pathname === "/.well-known/oauth-protected-resource") {
    handleWellKnownPrm(res);
    return;
  }

  if (url.pathname === "/register" && req.method === "POST") {
    await handleRegister(req, res);
    return;
  }

  if (url.pathname === "/authorize" && req.method === "GET") {
    await handleAuthorize(req, res);
    return;
  }

  if (url.pathname === "/token" && req.method === "POST") {
    await handleToken(req, res);
    return;
  }

  if (url.pathname === "/introspect" && req.method === "GET") {
    handleIntrospect(req, res);
    return;
  }

  if (url.pathname.startsWith("/admin/")) {
    await handleAdmin(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error("mock-as error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(err));
    }
  });
});

server.listen(port, host, () => {
  console.log(`Mock Authorization Server listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
