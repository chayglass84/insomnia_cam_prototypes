/**
 * Mock enterprise identity provider (the "Okta / Entra" side) for the Insomnia MCP debugger prototype (task 4348, S8).
 * Standalone Node, no deps.
 *
 *   node mock-idp.mjs                      # :9100 (MOCK_IDP_PORT)
 *
 * It plays the two roles a real IdP plays in Enterprise-Managed Authorization (XAA):
 *   1. OIDC single sign-on for the MCP *client*: /authorize shows a sign-in page (Alex is allowed, Bo is blocked by
 *      policy), /token exchanges the code (PKCE S256 + client secret) for an ID token.
 *   2. RFC 8693 token exchange: /token with grant_type=urn:ietf:params:oauth:grant-type:token-exchange trades the ID token
 *      for an ID-JAG (typ oauth-id-jag+jwt) addressed to one MCP authorization server, after applying the admin's policy.
 * Keys: an RSA key pair is generated at start; the public half is at /.well-known/jwks.json (RS256).
 *
 * Registered client: client_id `insomnia-xaa`, client_secret `insomnia-xaa-secret` (client_secret_post or Basic).
 *
 * Break-it flags (POST /admin/flags with JSON, GET /admin/flags to read, POST /admin/reset to clear):
 *   denyAll        refuse every token exchange with access_denied (a policy that forbids the app)
 *   wrongTyp       ID-JAG header typ is "JWT" instead of "oauth-id-jag+jwt"
 *   wrongAud       ID-JAG aud is not the audience that was asked for
 *   expired        ID-JAG exp is in the past
 *   wrongClient    ID-JAG client_id claim names a different client
 *   badSignature   ID-JAG is signed with a key that is not in the JWKS
 *   omitResource   ID-JAG has no resource claim
 *
 * PROTOTYPE-MOCK: not a real IdP. No sessions, no MFA, one hard-coded client, two hard-coded users.
 */

import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env.MOCK_IDP_PORT ?? "9100");
const host = "127.0.0.1";
const issuer = `http://${host}:${port}`;

const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_JAG_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";

const CLIENTS = { "insomnia-xaa": { secret: "insomnia-xaa-secret" } };
const USERS = {
  alex: { sub: "00u-alex", email: "alex@acme.test", name: "Alex Allowed", allowed: true },
  bo: { sub: "00u-bo", email: "bo@acme.test", name: "Bo Blocked", allowed: false },
};

const flags = {
  denyAll: false,
  wrongTyp: false,
  wrongAud: false,
  expired: false,
  wrongClient: false,
  badSignature: false,
  omitResource: false,
};

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: strangerKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "mock-idp-key-1";

/** code -> { clientId, redirectUri, challenge, user, nonce } */
const codes = new Map();

const b64url = (input) => Buffer.from(input).toString("base64url");
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function signJwt(header, payload, key = privateKey) {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: KID, ...header }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(signature)}`;
}

/** Verify one of our own RS256 JWTs; returns the payload or throws with a plain reason. */
function verifyJwt(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("subject_token is not a JWT");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("subject_token signature is not valid for this issuer");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const writeJson = (res, status, body, extra = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", ...extra });
  res.end(JSON.stringify(body));
};
const writeError = (res, status, error, description) => writeJson(res, status, { error, error_description: description });

/** client_secret_post or client_secret_basic. Returns the client id, or null after answering 401. */
function authenticateClient(req, body, res) {
  let id = body.client_id;
  let secret = body.client_secret;
  const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
  if (basic) {
    const [user, pass] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    id = decodeURIComponent(user);
    secret = decodeURIComponent(pass ?? "");
  }
  if (!id || !CLIENTS[id] || CLIENTS[id].secret !== secret) {
    writeError(res, 401, "invalid_client", "Client authentication failed (unknown client_id or wrong client_secret).");
    return null;
  }
  return id;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function signInPage(qs, clientId) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Mock IdP sign in</title>
<style>body{font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem}a.b{display:block;margin:.6rem 0;padding:.9rem 1rem;border:1px solid #888;border-radius:6px;text-decoration:none;color:inherit}
a.b:hover{background:#8881}small{color:#777}.tag{display:inline-block;background:#fa05;border-radius:4px;padding:0 .4rem;font-size:.75rem}</style></head>
<body><span class="tag">MOCK IDENTITY PROVIDER</span><h1>Sign in to ${escapeHtml(clientId)}</h1>
<p>Pretend this is your company's Okta or Entra sign-in page. Pick who you are.</p>
<a class="b" href="/authorize/decide?user=alex&${qs}"><b>Alex Allowed</b><br><small>alex@acme.test. The admin's policy lets Alex use MCP servers.</small></a>
<a class="b" href="/authorize/decide?user=bo&${qs}"><b>Bo Blocked</b><br><small>bo@acme.test. Can sign in, but the policy refuses access to MCP servers at the token exchange.</small></a>
<a class="b" href="/authorize/decide?user=cancel&${qs}"><b>Cancel</b><br><small>Return to the app with access_denied.</small></a>
</body></html>`;
}

function handleAuthorize(url, res) {
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  if (!CLIENTS[clientId]) return writeError(res, 400, "invalid_client", "Unknown client_id");
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(redirectUri)) return writeError(res, 400, "invalid_request", "redirect_uri must be a loopback http://127.0.0.1 URL");
  if (url.searchParams.get("response_type") !== "code") return writeError(res, 400, "unsupported_response_type", "Only response_type=code");
  if (!url.searchParams.get("code_challenge") || url.searchParams.get("code_challenge_method") !== "S256") {
    return writeError(res, 400, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(signInPage(url.searchParams.toString(), clientId));
}

function handleDecide(url, res) {
  const redirect = new URL(url.searchParams.get("redirect_uri"));
  const state = url.searchParams.get("state");
  if (state) redirect.searchParams.set("state", state);
  redirect.searchParams.set("iss", issuer);
  const who = url.searchParams.get("user");
  const user = USERS[who];
  if (!user) {
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set("error_description", "The user cancelled the sign in.");
  } else {
    const code = randomToken();
    codes.set(code, {
      clientId: url.searchParams.get("client_id"),
      redirectUri: url.searchParams.get("redirect_uri"),
      challenge: url.searchParams.get("code_challenge"),
      user,
      nonce: url.searchParams.get("nonce") ?? undefined,
    });
    redirect.searchParams.set("code", code);
  }
  res.writeHead(302, { Location: redirect.toString() });
  res.end();
}

async function handleToken(req, res) {
  const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
  const clientId = authenticateClient(req, body, res);
  if (!clientId) return;

  if (body.grant_type === "authorization_code") {
    const stored = codes.get(body.code);
    codes.delete(body.code);
    if (!stored || stored.clientId !== clientId) return writeError(res, 400, "invalid_grant", "Unknown or already used authorization code");
    if (stored.redirectUri !== body.redirect_uri) return writeError(res, 400, "invalid_grant", "redirect_uri mismatch");
    const digest = crypto.createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
    if (digest !== stored.challenge) return writeError(res, 400, "invalid_grant", "PKCE verification failed");
    const iat = now();
    const idToken = signJwt(
      { typ: "JWT" },
      { iss: issuer, sub: stored.user.sub, aud: clientId, iat, exp: iat + 3600, email: stored.user.email, name: stored.user.name, ...(stored.nonce ? { nonce: stored.nonce } : {}) },
    );
    return writeJson(res, 200, { access_token: randomToken(), token_type: "Bearer", expires_in: 3600, id_token: idToken, scope: "openid" });
  }

  if (body.grant_type === TOKEN_EXCHANGE) {
    if (body.requested_token_type !== ID_JAG_TYPE) return writeError(res, 400, "invalid_request", `requested_token_type must be ${ID_JAG_TYPE}`);
    if (body.subject_token_type !== ID_TOKEN_TYPE) return writeError(res, 400, "invalid_request", `subject_token_type must be ${ID_TOKEN_TYPE} (SAML is not supported by this mock)`);
    if (!body.subject_token) return writeError(res, 400, "invalid_request", "subject_token is required");
    if (!body.audience) return writeError(res, 400, "invalid_request", "audience is required (the issuer of the MCP server's authorization server)");

    let claims;
    try {
      claims = verifyJwt(body.subject_token);
    } catch (err) {
      return writeError(res, 400, "invalid_grant", err.message);
    }
    if (claims.iss !== issuer) return writeError(res, 400, "invalid_grant", "subject_token was not issued by this IdP");
    if (claims.aud !== clientId) return writeError(res, 400, "invalid_grant", `subject_token audience (${claims.aud}) does not match the authenticated client (${clientId})`);
    if (claims.exp <= now()) return writeError(res, 400, "invalid_grant", "subject_token has expired");

    const user = Object.values(USERS).find((u) => u.sub === claims.sub);
    if (flags.denyAll || !user?.allowed) {
      return writeError(res, 400, "access_denied", `Policy: ${claims.email ?? claims.sub} is not allowed to use ${clientId} with ${body.audience}.`);
    }
    const iat = now();
    const jag = signJwt(
      { typ: flags.wrongTyp ? "JWT" : "oauth-id-jag+jwt" },
      {
        iss: issuer,
        sub: claims.sub,
        aud: flags.wrongAud ? "http://127.0.0.1:9999" : body.audience,
        client_id: flags.wrongClient ? "some-other-client" : clientId,
        jti: crypto.randomUUID(),
        iat,
        exp: flags.expired ? iat - 60 : iat + 300,
        ...(body.resource && !flags.omitResource ? { resource: body.resource } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        email: claims.email,
      },
      flags.badSignature ? strangerKey : privateKey,
    );
    return writeJson(res, 200, { issued_token_type: ID_JAG_TYPE, access_token: jag, token_type: "N_A", ...(body.scope ? { scope: body.scope } : {}), expires_in: 300 });
  }

  return writeError(res, 400, "unsupported_grant_type", `Unsupported grant_type ${body.grant_type}`);
}

async function handleAdmin(req, res, url) {
  if (url.pathname === "/admin/reset") {
    for (const key of Object.keys(flags)) flags[key] = false;
    codes.clear();
    return writeJson(res, 200, { ok: true, flags });
  }
  if (url.pathname === "/admin/flags" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    for (const key of Object.keys(flags)) if (key in body) flags[key] = Boolean(body[key]);
    return writeJson(res, 200, { ok: true, flags });
  }
  return writeJson(res, 200, { flags });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", issuer);
  const run = async () => {
    if (url.pathname === "/health") return writeJson(res, 200, { ok: true });
    if (url.pathname === "/.well-known/openid-configuration") {
      return writeJson(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", TOKEN_EXCHANGE],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        scopes_supported: ["openid", "email", "profile"],
      });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      return writeJson(res, 200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/authorize" && req.method === "GET") return handleAuthorize(url, res);
    if (url.pathname === "/authorize/decide" && req.method === "GET") return handleDecide(url, res);
    if (url.pathname === "/token" && req.method === "POST") return handleToken(req, res);
    if (url.pathname.startsWith("/admin/")) return handleAdmin(req, res, url);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  };
  run().catch((err) => {
    console.error("mock-idp error:", err);
    if (!res.headersSent) writeError(res, 500, "server_error", String(err));
  });
});

server.listen(port, host, () => console.log(`mock IdP listening on ${issuer}`));
