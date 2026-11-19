// Task 4348 (S3): a session-era MCP mock for the Insomnia prototype. Not part of Ardi's fixtures (those only cover one
// legacy version with no server push). Standalone Node, no deps.
//
//   node mock-legacy-server.mjs            # :8788 (MOCK_LEGACY_PORT)
//
// /mcp   Streamable HTTP, session-based. Accepts 2025-11-25, 2025-06-18, 2025-03-26 (answers with its newest if asked for
//        anything else, like a real server). A GET opens the server->client SSE stream. Tools:
//          echo           echoes `message`
//          ask-sampling   server asks the client sampling/createMessage and returns the client's answer
//          ask-roots      server asks the client roots/list
//          ask-elicit     server asks the client elicitation/create (form mode)
//        Also: ping, logging/setLevel (+ a notifications/message on the stream), notifications/initialized.
// /sse   The old HTTP+SSE transport (2024-11-05): GET /sse -> `endpoint` event, POST /messages?sessionId=...,
//        replies come back on the SSE stream. Supports initialize, ping, tools/list, tools/call (echo).
import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.env.MOCK_LEGACY_PORT ?? "8788");
const host = "127.0.0.1";
const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SSE_VERSION = "2024-11-05";
const SERVER_INFO = { name: "mock-legacy", version: "0.1.0" };

const tools = [
  {
    name: "echo",
    description: "Echo a message back.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
  { name: "ask-sampling", description: "Ask the client for a sampling/createMessage.", inputSchema: { type: "object", properties: {} } },
  { name: "ask-roots", description: "Ask the client for roots/list.", inputSchema: { type: "object", properties: {} } },
  { name: "ask-elicit", description: "Ask the client for an elicitation/create.", inputSchema: { type: "object", properties: {} } },
];

const sessions = new Map(); // streamable-http: id -> { version, stream, pending, serverSeq, logLevel }
const sseSessions = new Map(); // http+sse: id -> { res }

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (text, isError = false) => ({ content: [{ type: "text", text }], isError });
const sseWrite = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

// ---------- Streamable HTTP (/mcp) ----------

function askClient(session, method, params) {
  return new Promise((resolve, reject) => {
    if (!session.stream) {
      reject(new Error("no server stream open (the client has not opened its GET stream)"));
      return;
    }
    const id = `srv-${++session.serverSeq}`;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`client did not answer ${method} within 30s`));
    }, 30_000);
    session.pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    sseWrite(session.stream, "message", { jsonrpc: "2.0", id, method, params });
  });
}

async function callTool(session, name, args) {
  if (name === "echo") return textResult(String(args?.message ?? ""));
  const asks = {
    "ask-sampling": [
      "sampling/createMessage",
      { messages: [{ role: "user", content: { type: "text", text: "Say hello." } }], maxTokens: 50 },
    ],
    "ask-roots": ["roots/list", undefined],
    "ask-elicit": [
      "elicitation/create",
      {
        message: "What is your name?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    ],
  };
  const ask = asks[name];
  if (!ask) return textResult(`unknown tool ${name}`, true);
  try {
    const answer = await askClient(session, ask[0], ask[1]);
    return textResult(JSON.stringify(answer.error ? { error: answer.error } : answer.result));
  } catch (error) {
    return textResult(error.message, true);
  }
}

async function handleMcp(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

  if (req.method === "GET") {
    if (!session) return json(res, 400, { error: "missing or unknown session" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": stream open\n\n");
    session.stream = res;
    req.on("close", () => {
      if (session.stream === res) session.stream = null;
    });
    return;
  }
  if (req.method === "DELETE") {
    if (session) sessions.delete(sessionId);
    res.writeHead(session ? 204 : 404);
    res.end();
    return;
  }

  const payload = await readJson(req);
  if (!payload || typeof payload !== "object") return json(res, 400, rpcError(null, -32700, "invalid JSON"));

  if (payload.method === "server/discover") {
    return json(res, 200, rpcError(payload.id ?? null, -32601, 'Method "server/discover" not found'));
  }
  if (payload.method === "initialize") {
    const requested = payload.params?.protocolVersion;
    const version = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
    const id = crypto.randomUUID();
    sessions.set(id, { version, stream: null, pending: new Map(), serverSeq: 0, logLevel: "info" });
    return json(
      res,
      200,
      rpcResult(payload.id, {
        protocolVersion: version,
        capabilities: { tools: {}, logging: {} },
        serverInfo: SERVER_INFO,
      }),
      { "Mcp-Session-Id": id },
    );
  }
  if (!session) return json(res, 400, rpcError(payload.id ?? null, -32000, "missing or unknown Mcp-Session-Id"));

  // A client reply to one of our server-initiated requests (it has an id and a result/error but no method).
  if (payload.method === undefined && payload.id !== undefined) {
    session.pending.get(payload.id)?.(payload);
    session.pending.delete(payload.id);
    res.writeHead(202);
    res.end();
    return;
  }
  if (payload.method?.startsWith("notifications/")) {
    res.writeHead(202);
    res.end();
    return;
  }

  switch (payload.method) {
    case "ping":
      return json(res, 200, rpcResult(payload.id, {}));
    case "logging/setLevel":
      session.logLevel = payload.params?.level ?? "info";
      if (session.stream) {
        sseWrite(session.stream, "message", {
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: session.logLevel, logger: "mock-legacy", data: `log level set to ${session.logLevel}` },
        });
      }
      return json(res, 200, rpcResult(payload.id, {}));
    case "tools/list":
      return json(res, 200, rpcResult(payload.id, { tools }));
    case "tools/call":
      return json(res, 200, rpcResult(payload.id, await callTool(session, payload.params?.name, payload.params?.arguments)));
    default:
      return json(res, 200, rpcError(payload.id ?? null, -32601, `Method "${payload.method}" not found`));
  }
}

// ---------- HTTP+SSE (/sse + /messages), protocol 2024-11-05 ----------

function handleSseOpen(req, res) {
  const id = crypto.randomUUID();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
  sseSessions.set(id, { res });
  req.on("close", () => sseSessions.delete(id));
}

async function handleSseMessage(req, res, url) {
  const session = sseSessions.get(url.searchParams.get("sessionId") ?? "");
  if (!session) return json(res, 404, { error: "unknown sessionId" });
  const payload = await readJson(req);
  res.writeHead(202, { "Content-Type": "text/plain" });
  res.end("Accepted");
  if (!payload?.method || payload.method.startsWith("notifications/")) return;
  const reply = (body) => sseWrite(session.res, "message", body);
  switch (payload.method) {
    case "initialize":
      return reply(
        rpcResult(payload.id, { protocolVersion: SSE_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO }),
      );
    case "ping":
      return reply(rpcResult(payload.id, {}));
    case "tools/list":
      return reply(rpcResult(payload.id, { tools: tools.slice(0, 1) }));
    case "tools/call":
      return reply(
        rpcResult(
          payload.id,
          payload.params?.name === "echo"
            ? textResult(String(payload.params?.arguments?.message ?? ""))
            : textResult("not available over HTTP+SSE in this mock", true),
        ),
      );
    default:
      return reply(rpcError(payload.id ?? null, -32601, `Method "${payload.method}" not found`));
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const run = async () => {
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (url.pathname === "/mcp") return handleMcp(req, res);
    if (url.pathname === "/sse" && req.method === "GET") return handleSseOpen(req, res);
    if (url.pathname === "/messages" && req.method === "POST") return handleSseMessage(req, res, url);
    res.writeHead(404);
    res.end();
  };
  run().catch((error) => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: String(error) });
  });
});

server.listen(port, host, () => {
  console.log(`mock legacy MCP server listening on http://${host}:${port} (/mcp, /sse)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
