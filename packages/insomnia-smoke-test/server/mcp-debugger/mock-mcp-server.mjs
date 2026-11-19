import http from "node:http";

import { APP_HTML, HOSTILE_HTML, PINNED_HTML } from "./app-views.mjs";
import { cancelTask, createTask, getTask, isTaskTool, updateTask } from "./tasks-behaviors.mjs";

const port = Number(process.env.MOCK_MCP_PORT ?? "8787");
const host = "127.0.0.1";
const sessionId = "session-playwright";
const legacyVersion = "2025-11-25";
const statelessVersion = "2026-07-28";
const validBearerToken = "good-token";

// Mock authorization server origin, used in WWW-Authenticate for OAuth-protected endpoints.
const mockAuthorizationServerOrigin =
  process.env.MOCK_AUTHORIZATION_SERVER_ORIGIN ?? "http://127.0.0.1:9000";

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (body.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const echoTool = {
  name: "echo",
  description: "Echo a message back to the caller.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to echo" },
    },
    required: ["message"],
  },
};

// 4348: added for the Insomnia prototype (not in Ardi's fixture). Stays pending for `delayMs` (default 5000) so the
// trace's pending state and Cancel can be tested by hand. Aborts if the client goes away.
const slowEchoTool = {
  name: "slow-echo",
  description: "Echo a message after a delay (default 5000 ms). Stays pending, for testing in-flight calls and Cancel.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to echo" },
      delayMs: { type: "integer", description: "Delay before replying, in ms", default: 5000 },
    },
    required: ["message"],
  },
};

// 4348: plain MRTR (SEP-2322) on tools/call, not in Ardi's fixture (which only has the task-level input_required).
// First call answers `resultType: "input_required"` with an elicitation request; the retry carries `inputResponses`
// and the echoed `requestState`, and completes.
const askInputTool = {
  name: "ask-input",
  description: "Asks the client for input (multi round-trip request), then greets by name.",
  inputSchema: { type: "object", properties: {} },
};

function respondAskInput(res, id, params) {
  const answer = params?.inputResponses?.who;
  if (!answer) {
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "input_required",
        inputRequests: {
          who: {
            method: "elicitation/create",
            params: {
              message: "What is your name?",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string", title: "Name" } },
                required: ["name"],
              },
            },
          },
        },
        requestState: "mrtr-state-1",
      },
    });
    return;
  }
  const text =
    answer.action === "accept" ? `Hello, ${answer.content?.name ?? "stranger"}!` : `The user chose to ${answer.action}.`;
  writeJson(res, 200, {
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", content: [{ type: "text", text }], isError: false },
  });
}

// 4348: subscriptions/listen (2026-07-28), not in Ardi's fixture. The response is a long-lived SSE stream: the first
// message acknowledges the subset of the requested filter this mock honors, then change notifications follow.
// This mock honors tools/resources list changes and resource subscriptions, but NOT promptsListChanged, so the
// acknowledgement shows a type being omitted. The `trigger-change` tool pushes notifications to open listeners.
const listeners = new Set();
const HONORED = ["toolsListChanged", "resourcesListChanged", "resourceSubscriptions"];

const triggerChangeTool = {
  name: "trigger-change",
  description: "Push a change notification to open subscriptions/listen streams (kind: tools | resources | prompts | resource).",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["tools", "resources", "prompts", "resource"],
        description: "What changed. Leave empty to send a resource update when `uri` is set, otherwise a tools list change.",
      },
      uri: { type: "string", description: "For a resource update: the resource URI that changed" },
    },
  },
};

function sseSend(res, message) {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

function openListenStream(req, res, payload) {
  const requested = payload.params?.notifications ?? {};
  const acknowledged = {};
  for (const key of HONORED) {
    if (key === "resourceSubscriptions") {
      if (Array.isArray(requested[key]) && requested[key].length > 0) acknowledged[key] = requested[key];
    } else if (requested[key] === true) {
      acknowledged[key] = true;
    }
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const listener = { res, id: payload.id, filter: acknowledged };
  listeners.add(listener);
  req.on("close", () => listeners.delete(listener));
  sseSend(res, {
    jsonrpc: "2.0",
    method: "notifications/subscriptions/acknowledged",
    params: { _meta: { "io.modelcontextprotocol/subscriptionId": payload.id }, notifications: acknowledged },
  });
}

function triggerChange(kind, uri) {
  let delivered = 0;
  for (const { res, id, filter } of listeners) {
    const meta = { "io.modelcontextprotocol/subscriptionId": id };
    if (kind === "tools" && filter.toolsListChanged) {
      sseSend(res, { jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: meta } });
      delivered += 1;
    } else if (kind === "resources" && filter.resourcesListChanged) {
      sseSend(res, { jsonrpc: "2.0", method: "notifications/resources/list_changed", params: { _meta: meta } });
      delivered += 1;
    } else if (kind === "prompts" && filter.promptsListChanged) {
      sseSend(res, { jsonrpc: "2.0", method: "notifications/prompts/list_changed", params: { _meta: meta } });
      delivered += 1;
    } else if (kind === "resource" && uri && filter.resourceSubscriptions?.some((u) => uri === u || uri.startsWith(u))) {
      sseSend(res, { jsonrpc: "2.0", method: "notifications/resources/updated", params: { _meta: meta, uri } });
      delivered += 1;
    }
  }
  return delivered;
}

function respondSlowly(res, id, args) {
  const delayMs = Number(args?.delayMs ?? 5000);
  const timer = setTimeout(() => echoResult(res, id, args?.message ?? ""), delayMs);
  res.on("close", () => clearTimeout(timer));
}

// Tools that return a task handle instead of a terminal result (2026-07-28 RC "tasks"
// extension) — one tool per behavior, so the e2e spec picks a lifecycle by tool name.
const taskTools = [
  { name: "quick-success-task", description: "Returns a task that completes after 2 polls." },
  {
    name: "input-required-task",
    description: "Returns a task that asks for input before completing.",
  },
  { name: "failed-task", description: "Returns a task that fails after 2 polls." },
  { name: "cancellable-task", description: "Returns a task that stays working until cancelled." },
  { name: "expired-task", description: "Returns a task whose tasks/get expires after 2 polls." },
].map((t) => ({ ...t, inputSchema: { type: "object", properties: {} } }));

// MCP Apps (SEP-1865): tools that carry `_meta.ui` so the client renders them as
// an app view instead of (or in addition to) a plain result. `ui-refresh` is
// `visibility: ["app"]` — app-only, never a model-invocable top-level tool.
// `ui-task` additionally returns a task handle (see its `tools/call` branch
// below), for the app-driven task round-trip case.
const UI_MIME = "text/html;profile=mcp-app";
const uiTools = [
  {
    name: "ui-chart",
    description: "Echo with an app view.",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
    _meta: { ui: { resourceUri: "ui://mock/app" } },
  },
  {
    name: "ui-refresh",
    description: "App-only data refresh.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://mock/app", visibility: ["app"] } },
  },
  {
    name: "ui-hostile",
    description: "Echo with a hostile app view (escape-attempt fixture).",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://mock/hostile" } },
  },
  {
    name: "ui-task",
    description: "Task-returning tool with an app view.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://mock/app" } },
  },
  {
    name: "ui-pinned",
    description: "Echo with a domain-pinned app view.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://mock/pinned" } },
  },
  {
    name: "ui-pinned-bad",
    description: "Echo with an app view claiming the host sandbox suffix.",
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: "ui://mock/pinned-bad" } },
  },
];
// Each resource is `{ text, _meta? }` — `_meta.ui` rides the resources/read
// contents entry when present, exactly as a real server attaches csp/permissions.
const uiResources = {
  "ui://mock/app": { text: APP_HTML },
  // The hostile view declares the mock server itself in connectDomains: the
  // escape e2e asserts a DECLARED fetch succeeds while undeclared egress stays
  // blocked — the positive control that declared domains survive the whole
  // builder → resource-ready → proxy → meta-injection pipeline, alongside the
  // never-widened negative cases.
  "ui://mock/hostile": {
    text: HOSTILE_HTML,
    _meta: { ui: { csp: { connectDomains: ["http://127.0.0.1:8787"] } } },
  },
  // Pinned View: `domain` is any stable identifier the server chooses; the host
  // derives sha256(serverUrl + "\n" + domain)[:32] under .localhost.
  "ui://mock/pinned": {
    text: PINNED_HTML,
    _meta: { ui: { domain: "www.example.com" } },
  },
  // Our-suffix claim: the e2e sandbox suffix is `localhost`, so this must fail
  // loud with the derived-origin guidance rather than render.
  "ui://mock/pinned-bad": {
    text: PINNED_HTML,
    _meta: { ui: { domain: "evil.localhost" } },
  },
};
const UI_EXTENSION = { "io.modelcontextprotocol/ui": { mimeTypes: [UI_MIME] } };

function uiResourceContent(uri, resource) {
  const content = { uri, mimeType: UI_MIME, text: resource.text };
  if (resource._meta) content._meta = resource._meta;
  return content;
}

function writeToolList(res, id) {
  writeJson(res, 200, {
    jsonrpc: "2.0",
    id,
    result: { tools: [echoTool, slowEchoTool, askInputTool, triggerChangeTool, ...taskTools, ...uiTools] },
  });
}

function echoResult(res, id, message) {
  writeJson(res, 200, {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: `echo: ${message}` }],
      isError: false,
    },
  });
}

function unauthorized(res) {
  writeJson(res, 401, { error: "unauthorized" });
}

/**
 * OAuth-protected MCP endpoint.
 * First request (no bearer): 401 with RFC 6750 + RFC 9728 WWW-Authenticate.
 * The resource_metadata points at the mock authorization server's PRM endpoint
 * (served from the authorization server itself for convenience — the authorization
 * server knows the MCP server's resource URI).
 * Subsequent requests with a valid bearer token are forwarded to handleLegacy.
 *
 * The token is validated against the mock authorization server's /introspect endpoint
 * so that Playwright tests can observe a real bearer flow without hard-coding the token.
 * For speed, we accept any non-empty Authorization: Bearer header that the authorization
 * server would accept — we rely on the mock authorization server introspect to confirm.
 */
function writeOauthUnauthorized(res) {
  writeJson(
    res,
    401,
    { error: "unauthorized" },
    {
      "WWW-Authenticate": `Bearer realm="mock-mcp-server", resource_metadata="${mockAuthorizationServerOrigin}/.well-known/oauth-protected-resource"`,
    },
  );
}

async function introspectToken(token) {
  return new Promise((resolve) => {
    const url = `${mockAuthorizationServerOrigin}/introspect?token=${encodeURIComponent(token)}`;
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(body.active === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Legacy era (2025-11-25): initialize handshake + Mcp-Session-Id.
// `server/discover` is answered with -32601 (200 OK) so the client cleanly
// falls back to the legacy initialize path — this exercises the era fallback.
// ---------------------------------------------------------------------------

function writeInitialize(res, id) {
  writeJson(
    res,
    200,
    {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: legacyVersion,
        // No `resources: {}` here — ui:// resources resolve purely by URI via
        // resources/read; declaring the capability would make introspect issue a
        // resources/list this fixture doesn't implement, injecting a spurious
        // -32601 warning into every trace.
        capabilities: { tools: {}, extensions: UI_EXTENSION },
        serverInfo: { name: "playwright-mock", version: "0.1.0" },
      },
    },
    { "Mcp-Session-Id": sessionId },
  );
}

function checkLegacySessionHeaders(req) {
  return (
    req.headers["mcp-session-id"] === sessionId &&
    req.headers["mcp-protocol-version"] === legacyVersion
  );
}

async function handleLegacy(req, res) {
  if (req.method === "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("server push not supported");
    return;
  }
  if (req.method === "DELETE") {
    res.writeHead(204);
    res.end();
    return;
  }

  const payload = await readJson(req);
  if (!payload || typeof payload !== "object") {
    writeJson(res, 400, { error: "invalid payload" });
    return;
  }

  // A legacy server does not implement the stateless discover probe.
  if (payload.method === "server/discover") {
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id: payload.id ?? null,
      error: { code: -32601, message: 'Method "server/discover" not found' },
    });
    return;
  }

  if (payload.method === "initialize") {
    writeInitialize(res, payload.id);
    return;
  }

  if (payload.method === "notifications/initialized") {
    res.writeHead(202);
    res.end();
    return;
  }

  if (!checkLegacySessionHeaders(req)) {
    writeJson(res, 400, {
      jsonrpc: "2.0",
      id: payload.id ?? null,
      error: { code: -32000, message: "missing session headers" },
    });
    return;
  }

  if (payload.method === "tools/list") {
    writeToolList(res, payload.id);
    return;
  }

  if (payload.method === "tools/call") {
    if (payload.params?.name === "ui-refresh") {
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id: payload.id,
        result: { content: [{ type: "text", text: "refreshed at mock-time" }], isError: false },
      });
      return;
    }
    if (payload.params?.name === "slow-echo") {
      respondSlowly(res, payload.id, payload.params?.arguments);
      return;
    }
    // ui-chart / ui-hostile / ui-task / ui-pinned / ui-pinned-bad fall through to
    // the plain echo, same as every other tool this era doesn't special-case.
    echoResult(res, payload.id, payload.params?.arguments?.message ?? "");
    return;
  }

  if (payload.method === "resources/read") {
    const uri = payload.params?.uri;
    const resource = uiResources[uri];
    if (!resource) {
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id: payload.id,
        error: { code: -32602, message: `unknown resource "${uri}"` },
      });
      return;
    }
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id: payload.id,
      result: { contents: [uiResourceContent(uri, resource)] },
    });
    return;
  }

  writeJson(res, 200, {
    jsonrpc: "2.0",
    id: payload.id ?? null,
    error: { code: -32601, message: `Method "${payload.method}" not found` },
  });
}

// ---------------------------------------------------------------------------
// Stateless era (2026-07-28 RC): no initialize, no session id. Every request
// carries per-request metadata in `_meta` + mirrored routing headers. This
// handler is STRICT — it enforces the wire contract so the e2e proves the
// client emits a spec-correct stateless frame, not merely that a tool renders.
// ---------------------------------------------------------------------------

function statelessError(res, id, code, message) {
  // Stateless errors are JSON-RPC errors returned with a 4xx so the client's
  // `isStatelessJsonRpcError` path treats them as a stateless server reply.
  writeJson(res, 400, {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

/**
 * Validate the routing headers + `_meta` every stateless request must carry.
 * Returns an error string when the contract is violated, else null.
 */
function checkStatelessContract(req, payload, expectedMethod) {
  if (req.headers["mcp-protocol-version"] !== statelessVersion) {
    return "missing or wrong MCP-Protocol-Version header";
  }
  if (req.headers["mcp-method"] !== expectedMethod) {
    return `Mcp-Method header must mirror "${expectedMethod}"`;
  }
  const meta = payload?.params?._meta;
  if (!meta || meta["io.modelcontextprotocol/protocolVersion"] !== statelessVersion) {
    return "missing _meta protocol version";
  }
  return null;
}

async function handleStateless(req, res) {
  if (req.method === "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("server push not supported");
    return;
  }

  const payload = await readJson(req);
  if (!payload || typeof payload !== "object") {
    writeJson(res, 400, { error: "invalid payload" });
    return;
  }

  if (payload.method === "subscriptions/listen") {
    const err = checkStatelessContract(req, payload, "subscriptions/listen");
    if (err) {
      statelessError(res, payload.id, -32600, err);
      return;
    }
    openListenStream(req, res, payload);
    return;
  }

  if (payload.method === "server/discover") {
    const err = checkStatelessContract(req, payload, "server/discover");
    // -32004 UnsupportedProtocolVersion carries supported[] so a mismatched
    // probe surfaces correctly; here the contract is about routing metadata.
    if (err) {
      statelessError(res, payload.id, -32600, err);
      return;
    }
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        supportedVersions: [statelessVersion],
        // No `resources: {}` here — see the matching note on the legacy
        // writeInitialize capabilities above.
        capabilities: {
          tools: {},
          extensions: { "io.modelcontextprotocol/tasks": {}, ...UI_EXTENSION },
        },
        serverInfo: { name: "playwright-mock", version: "0.1.0" },
      },
    });
    return;
  }

  if (payload.method === "tools/list") {
    const err = checkStatelessContract(req, payload, "tools/list");
    if (err) {
      statelessError(res, payload.id, -32600, err);
      return;
    }
    writeToolList(res, payload.id);
    return;
  }

  if (payload.method === "tools/call") {
    const err = checkStatelessContract(req, payload, "tools/call");
    if (err) {
      statelessError(res, payload.id, -32600, err);
      return;
    }
    const name = payload.params?.name;
    // Mcp-Name MUST mirror params.name exactly (spec: Server Validation).
    if (req.headers["mcp-name"] !== name) {
      statelessError(res, payload.id, -32600, "Mcp-Name header must mirror params.name");
      return;
    }
    if (name === "ui-refresh") {
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id: payload.id,
        result: { content: [{ type: "text", text: "refreshed at mock-time" }], isError: false },
      });
      return;
    }
    if (name === "ui-task") {
      // Reuses "quick-success-task"'s completing lifecycle (2 polls) rather than
      // inventing a new fixture behavior — the app-driven round-trip test (Task
      // 16) just needs a task that actually reaches "completed".
      writeJson(res, 200, {
        jsonrpc: "2.0",
        id: payload.id,
        result: createTask("quick-success-task"),
      });
      return;
    }
    if (isTaskTool(name)) {
      writeJson(res, 200, { jsonrpc: "2.0", id: payload.id, result: createTask(name) });
      return;
    }
    if (name === "slow-echo") {
      respondSlowly(res, payload.id, payload.params?.arguments);
      return;
    }
    if (name === "ask-input") {
      respondAskInput(res, payload.id, payload.params);
      return;
    }
    if (name === "trigger-change") {
      const args = payload.params?.arguments ?? {};
      // No default kind in the schema: a `uri` on its own means "this resource changed".
      const kind = args.kind || (args.uri ? "resource" : "tools");
      const delivered = triggerChange(kind, args.uri);
      echoResult(res, payload.id, `kind=${kind}${args.uri ? ` uri=${args.uri}` : ""}: notified ${delivered} listener(s)`);
      return;
    }
    // ui-chart / ui-hostile / ui-pinned / ui-pinned-bad fall through to the plain echo.
    echoResult(res, payload.id, payload.params?.arguments?.message ?? "");
    return;
  }

  if (payload.method === "resources/read") {
    const err = checkStatelessContract(req, payload, "resources/read");
    if (err) {
      statelessError(res, payload.id, -32600, err);
      return;
    }
    const uri = payload.params?.uri;
    // Mcp-Name MUST mirror the resource uri exactly, same rule as tools/call's
    // params.name — pinning it here exercises the requirement in e2e, not just
    // unit tests.
    if (req.headers["mcp-name"] !== uri) {
      statelessError(res, payload.id, -32600, "Mcp-Name header must mirror params.uri");
      return;
    }
    const resource = uiResources[uri];
    if (!resource) {
      statelessError(res, payload.id, -32602, `unknown resource "${uri}"`);
      return;
    }
    writeJson(res, 200, {
      jsonrpc: "2.0",
      id: payload.id,
      result: { contents: [uiResourceContent(uri, resource)] },
    });
    return;
  }

  if (
    payload.method === "tasks/get" ||
    payload.method === "tasks/cancel" ||
    payload.method === "tasks/update"
  ) {
    const err = checkStatelessContract(req, payload, payload.method);
    if (err) {
      statelessError(res, payload.id, -32600, err);
      return;
    }
    const taskId = payload.params?.taskId;
    const outcome =
      payload.method === "tasks/get"
        ? getTask(taskId)
        : payload.method === "tasks/cancel"
          ? cancelTask(taskId)
          : updateTask(taskId, payload.params);
    if (!outcome) {
      statelessError(res, payload.id, -32602, `unknown taskId "${taskId}"`);
      return;
    }
    if (outcome.dispatchError) {
      writeJson(res, 200, { jsonrpc: "2.0", id: payload.id, error: outcome.dispatchError });
      return;
    }
    writeJson(res, 200, { jsonrpc: "2.0", id: payload.id, result: outcome });
    return;
  }

  statelessError(res, payload.id, -32601, `Method "${payload.method}" not found`);
}

async function handler(req, res) {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.url === "/bad-json") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>not json</html>");
      return;
    }

    if (req.url === "/protected") {
      if (req.headers.authorization !== `Bearer ${validBearerToken}`) {
        unauthorized(res);
        return;
      }
      await handleLegacy(req, res);
      return;
    }

    // RFC 9728 Protected Resource Metadata. A real MCP server publishes this so
    // the client can discover its authorization server proactively (before any
    // 401). discoverProtectedResource() probes the path-aware form first, then the
    // bare well-known path — serve both so either candidate resolves.
    if (
      req.url === "/.well-known/oauth-protected-resource/oauth-protected" ||
      req.url === "/.well-known/oauth-protected-resource"
    ) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify({
          resource: `http://${host}:${port}/oauth-protected`,
          authorization_servers: [mockAuthorizationServerOrigin],
        }),
      );
      return;
    }

    // OAuth-protected endpoint: validates bearer via mock authorization server /introspect.
    if (req.url === "/oauth-protected") {
      const authHeader = req.headers.authorization ?? "";
      const match = authHeader.match(/^Bearer (.+)$/i);
      if (!match) {
        writeOauthUnauthorized(res);
        return;
      }
      const valid = await introspectToken(match[1]);
      if (!valid) {
        writeOauthUnauthorized(res);
        return;
      }
      await handleLegacy(req, res);
      return;
    }

    if (req.url === "/legacy") {
      await handleLegacy(req, res);
      return;
    }

    if (req.url === "/stateless") {
      await handleStateless(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
}

const server = http.createServer((req, res) => {
  void handler(req, res);
});

server.listen(port, host, () => {
  console.log(`mock MCP server listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
