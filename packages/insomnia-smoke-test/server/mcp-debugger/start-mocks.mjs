#!/usr/bin/env node
/**
 * Starts every mock server the MCP debugger prototype (task 4348) uses, with the right ports and wiring, in one command:
 *
 *   npm run mocks:mcp                     # from the repo root; Ctrl-C stops them all
 *   npm run mocks:mcp -- --restart        # first stops whatever is already listening on these ports
 *
 * Or directly: node packages/insomnia-smoke-test/server/mcp-debugger/start-mocks.mjs [--restart]
 *
 * It exists because the mocks are five processes that need specific environment variables to find each other, and a
 * second copy started by hand on a busy port just dies with EADDRINUSE. Standalone Node, no dependencies.
 */

import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const origin = (port) => `http://${host}:${port}`;

const PORTS = { mcp: 8787, legacy: 8788, oauthAs: 9000, xaaAs: 9001, idp: 9100 };

const MOCKS = [
  {
    name: "mcp",
    file: "mock-mcp-server.mjs",
    port: PORTS.mcp,
    note: "MCP server: /stateless (2026-07-28), /legacy, /oauth-protected, /xaa-protected, /oauth-protected-admin",
    env: {
      MOCK_MCP_PORT: PORTS.mcp,
      MOCK_AUTHORIZATION_SERVER_ORIGIN: origin(PORTS.oauthAs),
      MOCK_XAA_AUTHORIZATION_SERVER_ORIGIN: origin(PORTS.xaaAs),
    },
  },
  {
    name: "legacy",
    file: "mock-legacy-server.mjs",
    port: PORTS.legacy,
    note: "session-era MCP server: /mcp (2025-11-25 and older) and /sse (2024-11-05 HTTP+SSE)",
    env: { MOCK_LEGACY_PORT: PORTS.legacy },
  },
  {
    name: "oauth-as",
    file: "mock-authorization-server.mjs",
    port: PORTS.oauthAs,
    note: "plain OAuth authorization server (consent page on; no XAA)",
    env: { MOCK_AUTHORIZATION_SERVER_PORT: PORTS.oauthAs, MOCK_MCP_ORIGIN: origin(PORTS.mcp), MOCK_AUTH_CONSENT: "1" },
  },
  {
    name: "xaa-as",
    file: "mock-authorization-server.mjs",
    port: PORTS.xaaAs,
    note: "XAA-capable authorization server (accepts ID-JAGs from the mock IdP)",
    env: {
      MOCK_AUTHORIZATION_SERVER_PORT: PORTS.xaaAs,
      MOCK_MCP_ORIGIN: origin(PORTS.mcp),
      MOCK_AS_XAA: "1",
      MOCK_TRUSTED_IDP: origin(PORTS.idp),
    },
  },
  {
    name: "idp",
    file: "mock-idp.mjs",
    port: PORTS.idp,
    note: "enterprise identity provider (OIDC sign-in, token exchange for ID-JAGs)",
    env: { MOCK_IDP_PORT: PORTS.idp },
  },
];

const restart = process.argv.includes("--restart");

const isListening = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const pidsOn = (port) => {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- make sure the ports are free (or free them) ----
const busy = [];
for (const mock of MOCKS) {
  if (await isListening(mock.port)) busy.push(mock);
}
if (busy.length > 0) {
  if (!restart) {
    console.error("These ports are already in use (probably mocks from an earlier run):");
    for (const mock of busy) console.error(`  :${mock.port}  ${mock.name}  (pid ${pidsOn(mock.port).join(", ") || "unknown"})`);
    console.error("\nRun again with --restart to stop them first:  npm run mocks:mcp -- --restart");
    process.exit(1);
  }
  for (const mock of busy) for (const pid of pidsOn(mock.port)) process.kill(pid);
  await sleep(800);
}

// ---- start everything ----
const children = [];
const stopAll = () => {
  for (const child of children) child.kill();
};
process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});

const width = Math.max(...MOCKS.map((m) => m.name.length));
for (const mock of MOCKS) {
  const child = spawn(process.execPath, [path.join(dir, mock.file)], {
    env: { ...process.env, ...Object.fromEntries(Object.entries(mock.env).map(([k, v]) => [k, String(v)])) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const prefix = `[${mock.name}]`.padEnd(width + 3);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) console.log(`${prefix}${line}`);
    });
  }
  child.on("exit", (code) => {
    if (code) {
      console.error(`${prefix}exited with code ${code}; stopping the rest`);
      stopAll();
      process.exit(code);
    }
  });
}

// ---- wait until each one answers ----
const healthy = async (mock) => {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${origin(mock.port)}/health`)).ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
};
const results = await Promise.all(MOCKS.map(healthy));
console.log("");
MOCKS.forEach((mock, i) => console.log(`${results[i] ? "up  " : "DOWN"}  :${mock.port}  ${mock.name.padEnd(width)}  ${mock.note}`));
if (results.includes(false)) {
  console.error("\nSome mocks did not start; see the output above.");
  stopAll();
  process.exit(1);
}
console.log("\nAll mocks are running. Ctrl-C stops them.");
