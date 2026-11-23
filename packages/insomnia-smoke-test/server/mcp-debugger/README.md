# MCP debugger mock servers (task 4348)

Standalone Node, no dependencies. Start all of them, wired together, from the repo root:

```bash
npm run mocks:mcp                 # Ctrl-C stops them all
npm run mocks:mcp -- --restart    # first stops whatever is already on these ports
```

| Port | Mock | File | Notes |
|---|---|---|---|
| 8787 | MCP server | `mock-mcp-server.mjs` | `/stateless` (2026-07-28), `/legacy`, `/oauth-protected`, `/xaa-protected`, `/oauth-protected-admin`, `/protected` |
| 8788 | Session-era MCP server | `mock-legacy-server.mjs` | `/mcp` (2025-11-25 and older), `/sse` (2024-11-05 HTTP+SSE) |
| 9000 | Plain OAuth authorization server | `mock-authorization-server.mjs` | `MOCK_AUTH_CONSENT=1` shows the Absolutely / No Way consent page |
| 9001 | XAA authorization server | `mock-authorization-server.mjs` | the same file with `MOCK_AS_XAA=1` (trusts the IdP at `MOCK_TRUSTED_IDP`) |
| 9100 | Enterprise identity provider | `mock-idp.mjs` | OIDC sign-in, token exchange for ID-JAGs, JWKS |

Ports can be changed with `MOCK_MCP_PORT`, `MOCK_LEGACY_PORT`, `MOCK_AUTHORIZATION_SERVER_PORT` and `MOCK_IDP_PORT`;
`start-mocks.mjs` is the place that wires them together (it sets `MOCK_AUTHORIZATION_SERVER_ORIGIN`,
`MOCK_XAA_AUTHORIZATION_SERVER_ORIGIN`, `MOCK_MCP_ORIGIN` and `MOCK_TRUSTED_IDP`).

Break-it flags: the authorization servers and the IdP take `POST /admin/flags` with a JSON body (`GET` reads them,
`POST /admin/reset` clears them). The flag names are listed at the top of `mock-authorization-server.mjs` and `mock-idp.mjs`.

`app-views.mjs` and `tasks-behaviors.mjs` are fixtures for `mock-mcp-server.mjs`. `sample-mcp.json` is a file to try
the `mcp.json` import with. The MCP and legacy mocks were ported from Ardi's e2e fixtures and extended; the
authorization server, the IdP and the launcher are new for this prototype.
