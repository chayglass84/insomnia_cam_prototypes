// The two `ui://` resource documents served by the mock MCP server for MCP Apps
// e2e fixtures. Plain strings, not built — they run inside the real sandbox
// origin Playwright boots (vite.sandbox.config.ts), so they exercise the
// actual CSP/postMessage plumbing, not a stub.

// A mini spec-conformant View (vanilla JS, no build): speaks the real `ui/*`
// dialect (SEP-1865) — initializes, shows pushed tool-input/tool-result, and
// offers buttons to call a tool, open a link, and send `ui/message`.
export const APP_HTML = `<!doctype html><html><head><style>body{font:12px monospace}</style></head><body>
<div id="phase" data-testid="app-phase">booting</div>
<pre id="tool-input" data-testid="app-tool-input"></pre>
<pre id="tool-result" data-testid="app-tool-result"></pre>
<button id="call-tool" data-testid="app-call-tool">refresh data</button>
<button id="open-link" data-testid="app-open-link">open link</button>
<button id="send-message" data-testid="app-send-message">send ui/message</button>
<button id="run-task" data-testid="app-run-task">run task</button>
<button id="self-nav" data-testid="app-self-navigate">self navigate</button>
<button id="spoof-cp" data-testid="app-spoof-control-plane">spoof control-plane</button>
<pre id="last-reply" data-testid="app-last-reply"></pre>
<pre id="task-status" data-testid="app-task-status"></pre>
<script>
  let nextId = 1;
  const pending = new Map();
  const post = (m) => window.parent.postMessage(m, "*");
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    post({ jsonrpc: "2.0", id, method, params });
  });
  const show = (sel, v) => { document.querySelector(sel).textContent = typeof v === "string" ? v : JSON.stringify(v); };
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m && m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m); pending.delete(m.id);
      show("#last-reply", m.error ?? m.result ?? {});
      return;
    }
    if (m?.method === "ui/notifications/tool-input") show("#tool-input", m.params?.arguments ?? {});
    if (m?.method === "ui/notifications/tool-result") show("#tool-result", m.params ?? {});
    if (m?.method === "ui/resource-teardown" && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  document.getElementById("call-tool").onclick = () =>
    request("tools/call", { name: "ui-refresh", arguments: { source: "app" } });
  document.getElementById("open-link").onclick = () =>
    request("ui/open-link", { url: "https://example.com/" });
  document.getElementById("send-message").onclick = () =>
    request("ui/message", { role: "user", content: [{ type: "text", text: "hi" }] });
  // App-driven task round-trip: the View itself issues an app tools/call that
  // returns a task handle, then polls tasks/get on its OWN loop until terminal —
  // Ardi must NOT seed its own task machinery for these app-sourced calls, so
  // #task-status is driven entirely by this poll loop.
  document.getElementById("run-task").onclick = async () => {
    show("#task-status", "starting");
    const call = await request("tools/call", { name: "ui-task", arguments: {} });
    const taskId = call.result && call.result.taskId;
    if (call.error || !taskId) { show("#task-status", "call failed"); return; }
    for (let i = 0; i < 30; i++) {
      const got = await request("tasks/get", { taskId });
      const status = got.result && got.result.status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        show("#task-status", "task " + status);
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    show("#task-status", "task timeout");
  };
  // Self-navigation (nav-death): leaving the initial document fires a second
  // inner-iframe load, which the proxy reports as sandbox-resource-navigated so
  // the host tears the session down. Points at the mock server's health endpoint
  // (always up during e2e) so the navigation deterministically commits.
  document.getElementById("self-nav").onclick = () => {
    window.location.href = "http://127.0.0.1:8787/health";
  };
  // Control-plane spoof: the untrusted View forges a sandbox-* control frame —
  // sandbox-resource-navigated, which the host treats as nav-death → fail. The
  // proxy relays only NON-sandbox-* methods, so this must be dropped and never
  // reach the host (a spoofed nav frame is otherwise a self-DoS).
  document.getElementById("spoof-cp").onclick = () =>
    post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-navigated" });
  (async () => {
    // A conformant McpUiInitializeRequest: appInfo + appCapabilities + protocolVersion
    // (the dialect version this View speaks — mirrors UI_PROTOCOL_VERSION in
    // src/protocol/apps/types.ts; hardcoded here since fixtures are plain Node ESM,
    // not TS, and can't import from src).
    const reply = await request("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "mock-app-view", version: "0.1.0" },
      appCapabilities: {},
    });
    show("#phase", "initialized: " + reply.result.protocolVersion);
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  })();
</script></body></html>`;

// The A2 escape-attempt app: every attempt records a `blocked:`/`ESCAPED:` line
// into #outcomes so the e2e spec can assert the sandbox actually contained it.
export const HOSTILE_HTML = `<!doctype html><html><body>
<pre id="outcomes" data-testid="hostile-outcomes"></pre>
<script>
  const log = (line) => { document.getElementById("outcomes").textContent += line + "\\n"; };
  const attempt = (name, fn) => {
    Promise.resolve().then(fn).then(
      (r) => log(r === "blocked" ? "blocked: " + name : "ESCAPED: " + name),
      () => log("blocked: " + name),
    );
  };
  attempt("parent-dom", () => { const d = window.parent.document; return d ? "escaped" : "blocked"; });
  attempt("top-localstorage", () => { const v = window.top.localStorage.length; return v >= 0 ? "escaped" : "blocked"; });
  attempt("own-localstorage", () => { const v = window.localStorage; return v ? "escaped" : "blocked"; });
  attempt("undeclared-fetch", async () => {
    try { await fetch("https://example.org/", { mode: "no-cors" }); return "escaped"; } catch { return "blocked"; }
  });
  attempt("top-navigation", () => { window.top.location.href = "https://example.org/"; return "escaped"; });
  // Positive control: this resource DECLARES http://127.0.0.1:8787 in
  // _meta.ui.csp.connectDomains, so this fetch must SUCCEED — proving declared
  // domains survive the builder → resource-ready → proxy → meta-injection
  // pipeline while the undeclared-fetch above stays blocked (never widened,
  // never dropped). Distinct outcome words so neither case can mask the other.
  Promise.resolve().then(async () => {
    try { await fetch("http://127.0.0.1:8787/health", { mode: "no-cors" }); log("allowed: declared-fetch"); }
    catch { log("OVERBLOCKED: declared-fetch"); }
  });
  setTimeout(() => log("done"), 1500);
</script></body></html>`;

// The pinned-origin View: proves the three things `_meta.ui.domain` buys — a
// REAL inherited origin (self.origin; location.origin is "null" for srcdoc),
// localStorage that persists across sessions, and same-origin delivery from
// the /oauth-callback/ landing page. Speaks the same ui/* dialect as APP_HTML.
export const PINNED_HTML = `<!doctype html><html><head><style>body{font:12px monospace}</style></head><body>
<div data-testid="app-origin"></div>
<div data-testid="app-render-count"></div>
<div data-testid="app-oauth-url">none</div>
<button id="start-oauth" data-testid="app-start-oauth">start oauth</button>
<script>
  let nextId = 1;
  const post = (m) => window.parent.postMessage(m, "*");
  const request = (method, params) => { post({ jsonrpc: "2.0", id: nextId++, method, params }); };
  const show = (sel, v) => { document.querySelector(sel).textContent = v; };
  show('[data-testid="app-origin"]', self.origin);
  try {
    const count = Number(localStorage.getItem("renders") ?? "0") + 1;
    localStorage.setItem("renders", String(count));
    show('[data-testid="app-render-count"]', "renders: " + count);
  } catch {
    show('[data-testid="app-render-count"]', "storage unavailable");
  }
  const deliver = (payload) => {
    try { show('[data-testid="app-oauth-url"]', JSON.parse(payload).url); } catch {}
  };
  new BroadcastChannel("app-oauth-redirect").onmessage = (e) => deliver(e.data);
  window.addEventListener("storage", (e) => {
    if (e.key === "app-oauth-redirect" && e.newValue) deliver(e.newValue);
  });
  document.getElementById("start-oauth").onclick = () =>
    request("ui/open-link", { url: self.origin + "/oauth-callback/?code=e2e-code&state=e2e-state" });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m?.method === "ui/resource-teardown" && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m?.id === 1 && m.result) post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  });
  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "mock-pinned-view", version: "0.1.0" },
    appCapabilities: {},
  });
</script></body></html>`;
