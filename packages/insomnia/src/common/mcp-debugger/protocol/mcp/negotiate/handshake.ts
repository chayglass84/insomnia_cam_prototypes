import { base64Utf8 } from "../../lib/encoding";

import { UI_EXTENSION_ID, UI_MIME_TYPE } from "../../apps/types";
import { HTTPStatusError, isProtocolException, isServerReply, protocolError } from "../../errors";
import type { ConnectionOptions, Credentials, Routing } from "../../Protocol";
import type { Transport } from "../../Transport";
import { HTTPTransport } from "../../transports/HTTPTransport";
import { proxyFetch } from "../../transports/proxyFetch";
import { createSSETransport } from "../../transports/SSETransport";
import { CLIENT_INFO } from "../client";
import type { DeclaredCapabilities } from "../introspect/introspect";
import { classifyFetchError, isStatelessJsonRpcError } from "../wire/classify";
import {
  currentOrigin,
  DISCONNECT_DELETE_TIMEOUT_MS,
  type MCPConnection,
  sendRequest,
  withTimeout,
} from "../wire/connection";
import { probeHeadersFor, requestHeadersFor } from "../wireformat/headers";
import { withStatelessMeta } from "../wireformat/params";
import {
  isLegacyFallbackStatus,
  LATEST_LEGACY_VERSION,
  LEGACY_VERSIONS,
  STATELESS_VERSION,
  SUPPORTED_VERSIONS,
} from "./versions";

export {
  isLegacyFallbackStatus,
  LATEST_LEGACY_VERSION,
  LEGACY_VERSIONS,
  STATELESS_VERSION,
  SUPPORTED_VERSIONS,
} from "./versions";

export const INITIALIZE_REQUEST = {
  method: "initialize",
  params: {
    protocolVersion: LATEST_LEGACY_VERSION,
    // MCP Apps (SEP-1865): advertise the ui extension so servers may attach
    // _meta.ui to tools. This advertisement is client→server only — a
    // conforming server does NOT echo it back in its initialize capabilities;
    // discovery keys off _meta.ui on each tool during introspection instead
    // (see detectUi / prefetchUiResources in introspect.ts).
    capabilities: {
      extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } },
    },
    clientInfo: CLIENT_INFO,
  },
} as const;

export const CONNECT_TIMEOUT_MS = 10_000;

type InitializeResult = {
  protocolVersion?: string;
  capabilities?: DeclaredCapabilities;
  // `icons` is left `unknown[]` rather than typed here: it is server-controlled and only ever
  // consumed by `pickServerIcon`, which validates each entry itself.
  serverInfo?: { name?: string; version?: string; icons?: unknown };
};

/**
 * Build the static auth headers for a synchronous auth mode (bearer/basic/apiKey).
 * OAuth is handled separately by `buildGetRequestHeaders` (lib/auth), which needs
 * the live token store; this helper only covers the modes whose headers are fixed
 * for the life of the connection.
 */
export function authHeadersFor(
  authMode: ConnectionOptions["authMode"],
  credentials: Credentials,
): Record<string, string> {
  if (authMode === "bearer" && credentials.token)
    return { Authorization: `Bearer ${credentials.token}` };
  if (authMode === "basic" && credentials.username) {
    return {
      Authorization: `Basic ${base64Utf8(`${credentials.username}:${credentials.password ?? ""}`)}`,
    };
  }
  if (authMode === "apiKey" && credentials.apiKey) return { "X-API-Key": credentials.apiKey };
  return {};
}

/**
 * The fields we read from a `server/discover` response (2026-07-28 RC).
 * Other fields in the spec result (instructions, ttlMs, cacheScope, etc.)
 * are not used by the debugger and are intentionally ignored.
 */
export type DiscoverResult = {
  supportedVersions: string[];
  capabilities: DeclaredCapabilities;
  // `icons` is left `unknown[]` rather than typed here: it is server-controlled and only ever
  // consumed by `pickServerIcon`, which validates each entry itself.
  serverInfo?: { name?: string; version?: string; icons?: unknown };
};

/**
 * Probe `server/discover` to determine whether the server is a stateless RC
 * server. Returns the DiscoverResult on success.
 *
 * Throws a ProtocolException when the server replies with a recognized
 * stateless error code (-32004/-32003/-32001) so the caller can retry (e.g.
 * pick from -32004's supported[]). Throws HTTPStatusError for non-stateless
 * 4xx/5xx responses so the caller can detect a legacy server.
 */
export async function discoverStateless(
  url: string,
  getRequestHeaders: () => Record<string, string>,
  signal: AbortSignal,
  routing?: Routing,
): Promise<DiscoverResult> {
  const version = STATELESS_VERSION;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: withStatelessMeta(version),
  };

  let response: Response;
  try {
    response = await proxyFetch({
      target: url,
      method: "POST",
      // Custom/auth headers first, then protocol framing, then the stateless
      // routing headers last, so each layer wins over the one before it by
      // construction (a custom Content-Type/Accept can't break the probe).
      headers: {
        ...getRequestHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json",
        ...probeHeadersFor(version, "server/discover"),
      },
      body,
      signal,
      routing,
    });
  } catch (e) {
    throw classifyFetchError(e, { url, origin: currentOrigin() });
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    if (isStatelessJsonRpcError(responseBody)) {
      // Server is stateless but rejected our specific request — surface the
      // JSON-RPC error so the caller can retry (e.g. pick from -32004's supported[]).
      const err = (responseBody as Record<string, unknown>)["error"] as Record<string, unknown>;
      throw protocolError({
        kind: "protocol-remote",
        message: typeof err["message"] === "string" ? err["message"] : "server/discover failed",
        code: err["code"] as number,
        data: err["data"],
      });
    }
    // Non-stateless 4xx/5xx → legacy server
    throw new HTTPStatusError(
      response.status,
      url,
      response.headers.get("WWW-Authenticate") ?? undefined,
    );
  }

  const result = (responseBody as Record<string, unknown> | null)?.["result"];
  if (!result || typeof result !== "object") {
    throw protocolError({
      kind: "schema-parse",
      message: "server/discover returned no result",
      url,
    });
  }
  const r = result as Record<string, unknown>;
  return {
    supportedVersions: Array.isArray(r["supportedVersions"])
      ? (r["supportedVersions"] as string[]).filter((v) => typeof v === "string")
      : [],
    capabilities: (r["capabilities"] as DeclaredCapabilities | undefined) ?? {},
    serverInfo:
      r["serverInfo"] && typeof r["serverInfo"] === "object" ? r["serverInfo"] : undefined,
  };
}

function shouldSurfaceFallbackFailure(e: unknown): boolean {
  if (e instanceof HTTPStatusError) return true;
  if (!isProtocolException(e)) return false;
  return isServerReply(e.error) || e.error.kind === "target-blocked";
}

/** `initialize` params, proposing `proposedVersion` (4348: a pinned legacy version) instead of the newest one. */
export function initializeParams(proposedVersion?: string) {
  const protocolVersion = proposedVersion ?? INITIALIZE_REQUEST.params.protocolVersion;
  return {
    ...INITIALIZE_REQUEST.params,
    protocolVersion,
    capabilities: { ...INITIALIZE_REQUEST.params.capabilities, ...legacyClientCapabilities(protocolVersion) },
  };
}

/**
 * 4348 (S3): the client capabilities the debugger can actually serve to a session-era server. Roots and sampling exist
 * in every legacy version; elicitation arrived in 2025-06-18. Advertising them is what makes a server send the requests.
 */
export function legacyClientCapabilities(version: string): Record<string, unknown> {
  return {
    roots: { listChanged: true },
    sampling: {},
    ...(version >= "2025-06-18" ? { elicitation: {} } : {}),
  };
}

export async function negotiateAndInitialize(
  conn: MCPConnection,
  sink: { onMessage: (m: unknown) => void; onClose: () => void },
  url: string,
  getRequestHeaders: () => Record<string, string>,
  parentSignal: AbortSignal,
  onResponseHeaders: (h: Headers) => void,
  getHeaders: () => Record<string, string>,
  // 4348: the version to propose in `initialize` (a user-pinned legacy version); default is the newest legacy one.
  proposedVersion?: string,
): Promise<InitializeResult> {
  // Try Streamable HTTP first. No onClose: for Streamable HTTP the server→client
  // push stream is auxiliary, not the connection, so its closing must not tear the
  // connection down (POST replies are independent). onClose is wired only for the
  // legacy SSE fallback below, whose single GET stream IS the connection.
  conn.transport = new HTTPTransport(url, {
    onMessage: sink.onMessage,
    onResponseHeaders,
    getHeaders,
    routing: conn.routing,
  });
  try {
    return await runInitialize(conn, url, parentSignal, proposedVersion);
  } catch (streamableErr) {
    // Always release the HTTP transport before failing or falling back — its
    // initialize POST may already have opened a background GET stream.
    await conn.transport.close().catch(() => {});
    if (!isLegacyFallbackStatus(streamableErr)) {
      throw classifyFetchError(streamableErr, { url, origin: currentOrigin() });
    }
    try {
      // The legacy factory opens the GET stream and resolves on the endpoint
      // event; its frames (incl. the initialize reply) surface on the sink.
      conn.transport = await withTimeout(parentSignal, CONNECT_TIMEOUT_MS, url, (sig) =>
        createSSETransport(
          url,
          { onMessage: sink.onMessage, onClose: sink.onClose, routing: conn.routing },
          sig,
          getRequestHeaders,
        ),
      );
      return await runInitialize(conn, url, parentSignal, proposedVersion);
    } catch (legacyErr) {
      // Close on any failure after construction — including a runInitialize
      // throw after the GET stream was already established.
      await conn.transport.close().catch(() => {});
      // Both attempts failed. Surface the fallback only when it produced a
      // concrete reply or a direct proxy refusal of its own. If the fallback
      // only hit an opaque/no-bytes failure (for example a browser TypeError
      // later classified as CORS/network), prefer the original Streamable HTTP
      // status so the user sees the actionable server reply rather than a probe
      // artifact.
      if (shouldSurfaceFallbackFailure(legacyErr)) {
        throw classifyFetchError(legacyErr, { url, origin: currentOrigin() });
      }
      throw classifyFetchError(streamableErr, { url, origin: currentOrigin() });
    }
  }
}

/**
 * Send `initialize` over `conn.transport` and await the matched-id reply
 * through the connection's pending map — the same correlation path every
 * later request uses, wired by the transport's `onMessage` sink. No separate
 * handshake iterator: a notification the server pushes in this window is
 * dispatched by the sink like any other, never buffered for replay.
 */
async function runInitialize(
  conn: MCPConnection,
  url: string,
  parent: AbortSignal,
  proposedVersion?: string,
): Promise<InitializeResult> {
  const id = 1;
  try {
    const { envelope } = await withTimeout(parent, CONNECT_TIMEOUT_MS, url, (sig) =>
      sendRequest(
        conn,
        id,
        {
          jsonrpc: "2.0",
          id,
          method: INITIALIZE_REQUEST.method,
          params: initializeParams(proposedVersion),
        },
        { signal: sig, headers: requestHeadersFor(conn) },
      ),
    );
    if (envelope.error) {
      throw protocolError({
        kind: "protocol-remote",
        message: envelope.error.message ?? "initialize failed",
      });
    }
    if (!envelope.result || typeof envelope.result !== "object") {
      throw protocolError({
        kind: "schema-parse",
        message: "initialize response had no result",
        url,
      });
    }
    return envelope.result;
  } catch (e) {
    if (e instanceof HTTPStatusError) throw e;
    if (isProtocolException(e)) throw e;
    throw classifyFetchError(e, { url, origin: currentOrigin() });
  }
}

/**
 * Validate the version negotiated via the legacy `initialize` handshake.
 * Accepts any supported version that is NOT the stateless version — a legacy
 * server echoing STATELESS_VERSION would corrupt every subsequent call since
 * `isStatelessConnection` would fire on a session-based connection.
 */
export async function validateVersion(
  version: string | undefined,
  transport: Transport,
  sessionId: string | undefined,
  getRequestHeaders: () => Record<string, string>,
  url: string,
  routing?: Routing,
): Promise<void> {
  if (version && LEGACY_VERSIONS.has(version)) {
    return;
  }
  // Server already issued a session id we'll never use — terminate it
  // explicitly so the server doesn't keep an orphaned session alive.
  if (sessionId) {
    try {
      await proxyFetch({
        target: url,
        method: "DELETE",
        // getRequestHeaders first so protocol headers win, matching requestHeadersFor.
        headers: { ...getRequestHeaders(), "Mcp-Session-Id": sessionId },
        keepalive: true,
        signal: AbortSignal.timeout(DISCONNECT_DELETE_TIMEOUT_MS),
        routing,
      });
    } catch (e) {
      // Best-effort: we throw the version-mismatch error below regardless. Log
      // so an orphaned session left on the server is visible.
      console.warn("[handshake] DELETE of version-mismatched session failed (non-fatal)", e);
    }
  }
  await transport.close();
  const isStatelessEcho = version === STATELESS_VERSION;
  throw protocolError({
    kind: "protocol-version-mismatch",
    message: isStatelessEcho
      ? `Server echoed stateless version "${version}" in a legacy initialize reply`
      : `Server negotiated unsupported MCP version ${version ?? "(none)"}`,
    serverVersion: version,
    supported: [...SUPPORTED_VERSIONS].filter((v) => v !== STATELESS_VERSION),
  });
}
