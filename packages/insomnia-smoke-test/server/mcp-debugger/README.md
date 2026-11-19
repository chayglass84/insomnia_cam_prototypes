# MCP debugger mock servers (task 4348)

Ported verbatim from Ardi (`kong-insomnia/ai-debugger`, `web/frontend/e2e/fixtures/`). Standalone Node, no deps.

```bash
node packages/insomnia-smoke-test/server/mcp-debugger/mock-mcp-server.mjs            # :8787 (MOCK_MCP_PORT)
node packages/insomnia-smoke-test/server/mcp-debugger/mock-authorization-server.mjs  # :9000 (MOCK_AUTHORIZATION_SERVER_PORT), used from S5
```

Endpoints on :8787 (see `mock-mcp-server.mjs` for the full list): `/stateless` (2026-07-28), legacy
session-era paths, tasks tools (`quick-success-task`, `input-required-task`, `failed-task`,
`cancellable-task`, `expired-task`), OAuth-protected paths (bearer `good-token`).
