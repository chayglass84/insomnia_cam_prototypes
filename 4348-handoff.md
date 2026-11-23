# MCP debugger prototype (task 4348): handoff

A PM prototype that replaces Insomnia's MCP client with a protocol-aware debugger, to show developers what to build. It is
a working app, not production code: it takes shortcuts on purpose, and every one is marked `PROTOTYPE-MOCK` (in code and
in the UI). Branch `4348`, cut from `upstream/develop`. The work log, per-slice notes and decisions are in [`4348.md`](4348.md).

## Run it

```bash
fnm use "$(cat .nvmrc)" && npm ci
npm run mocks:mcp            # starts every mock below, with the right wiring (Ctrl-C stops them; add -- --restart to replace old ones)
npm run dev                  # the app: create an MCP client, point it at a mock URL, Connect
cd packages/insomnia && npx vitest run src/main/mcp-debugger src/ui/components/mcp-debugger src/common
```

After changing anything in the main process or the preload, restart the whole app (a stale main process is the usual "it's not working").

## What it does

- Connect with a protocol picker (Auto, or any of 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05); the UI adapts to the version.
- A trace of every call (Calls and Stream views, request on the left, resizable details), with edit and replay of any call, replay across versions, and request/response diffs.
- The newest spec's features: stateless requests, tasks, subscriptions, multi round-trip input; older versions' panels (roots, sampling, logging, ping).
- An OAuth debugger (discovery, registration, browser authorize, token, refresh, step-up) where every HTTP call is replayable.
- An enterprise-managed authorization (XAA) debugger: IdP sign-in, ID-JAG exchange, JWT bearer grant, a client secret or a signed client assertion, with decoded tokens and spec checks.
- Validate Server: which protocol versions a server accepts and where it falls short of (or only looks like) the newest spec.
- MCP Apps in a sandboxed pane, `_meta` / OpenTelemetry / extension display, and deprecation and age badges.
- Import `mcp.json` (Claude, Cursor, VS Code, Codex, ...) or scan this machine for existing MCP configs.

## The mocks (`packages/insomnia-smoke-test/server/mcp-debugger/`)

- **MCP server, `:8787`** (`mock-mcp-server.mjs`): the 2026-07-28 server at `/stateless` (tasks, subscriptions, multi round-trip input, apps, `_meta` trace propagation). The default thing to connect to.
- **Session-era MCP server, `:8788`** (`mock-legacy-server.mjs`): older protocol versions at `/mcp` and the deprecated HTTP+SSE transport at `/sse`, with sampling, roots, elicitation, logging and ping. For the version picker, legacy panels, cross-version replay, age badges and Validate Server's "out of date" results.
- **OAuth-protected endpoints on `:8787`**: `/oauth-protected` (plain OAuth), `/xaa-protected` (XAA-capable) and `/oauth-protected-admin` (a 403 `insufficient_scope` for step-up). Each serves just the `echo` tool once signed in. For the OAuth and XAA debuggers and the "asked for OAuth" banner.
- **Plain OAuth authorization server, `:9000`** (`mock-authorization-server.mjs`): discovery, DCR, CIMD, PKCE, RFC 9207, an Absolutely / No Way consent page, and break-it flags (`POST /admin/flags`: `omitDiscovery`, `tamperIss`, `fail`, `shortTtl`, `failRefresh`). For the OAuth debugger, refresh and step-up.
- **XAA authorization server, `:9001`** (the same file with `MOCK_AS_XAA=1`): also accepts the JWT bearer grant and validates ID-JAGs as the draft says, rejecting with a reason naming the failed check; takes a client secret or a signed assertion too. For the XAA debugger.
- **Enterprise identity provider, `:9100`** (`mock-idp.mjs`): OIDC sign-in (Alex is allowed, Bo is blocked by policy), token exchange for an ID-JAG, JWKS, client secret or signed client assertion (register a public key with `POST /admin/clients`), and break-it flags (`wrongAud`, `wrongTyp`, `expired`, `badSignature`, `wrongClient`, `denyAll`, `omitResource`, `requireAssertion`, `assertionAudIssuer`, `assertionAudToken`). For the XAA debugger's sign-in and exchange steps.

## Where the code is

- `packages/insomnia/src/main/mcp-debugger/`: sessions, trace and IPC (`service.ts`, `index.ts`), OAuth (`oauth-*.ts`), XAA (`xaa.ts`), conformance (`conformance.ts`), machine scan (`local-configs.ts`).
- `packages/insomnia/src/common/mcp-debugger/`: version profiles, conformance and deprecation rules, JWT decoding, and `protocol/` (the protocol and transport layer, ported from Ardi, the internal MCP debugger, see `4348.md`). `common/mcp-json-import.ts` is the `mcp.json` importer.
- `packages/insomnia/src/ui/components/mcp-debugger/`: the shell, URL bar, sidebar, request pane, trace pane and the wizards and modals.
- `packages/insomnia-data/`: two optional fields on `McpRequest` (`protocolVersion`, `oauthClients`); no migration.

## Real and faked

`grep -rn "PROTOTYPE-MOCK" packages/` finds every shortcut. The main ones: sessions and traces are in memory only; secrets are not stored securely; stdio servers keep the old client; XAA signs in with OIDC only (no SAML) and uses one signing key at both servers; and the conformance checks are our reading of the specs, not a certified suite.

## Not done

SAML for XAA, an XAA check in Validate Server, and advertising the enterprise-managed-authorization extension from the client. Details and the full shortcut list are in `4348.md`.
