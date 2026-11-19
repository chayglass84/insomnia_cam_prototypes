import {
  eraOfVersion,
  isSupportedVersion,
  type McpEra,
  type McpProtocolVersion,
  STATELESS_VERSION,
  SUPPORTED_VERSIONS,
} from '~/common/mcp-debugger/versions';

// S0 skeleton: a real (not mocked) Auto-detect probe, so the main-process plumbing is proven end to end.
// S1 replaces this with the full ported MCPHTTPProtocol (connect/introspect/invoke/cancel). Ardi reference:
// web/frontend/src/protocol/mcp/negotiate/{handshake,versions}.ts.
// PROTOTYPE-MOCK: probe uses plain fetch with no auth, no custom headers, no TLS options, no SSE-transport fallback.

export interface McpProbeExchange {
  step: string;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response?: { status: number; headers: Record<string, string>; body: unknown };
  error?: string;
  durationMs: number;
}

export interface McpProbeResult {
  ok: boolean;
  /** Era we concluded; undefined if the server answered neither probe. */
  era?: McpEra;
  /** Newest version we both support, per the server's answer. */
  version?: McpProtocolVersion;
  serverInfo?: { name?: string; version?: string };
  advertisedVersions: string[];
  exchanges: McpProbeExchange[];
}

const CLIENT_INFO = { name: 'Insomnia', version: '0-prototype' };
const ACCEPT = 'application/json, text/event-stream';

/** Servers may answer JSON or a one-shot SSE stream; return the first JSON-RPC message either way. */
const parseBody = (contentType: string, text: string): unknown => {
  if (!text) {
    return undefined;
  }
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find(line => line.startsWith('data:'));
    return dataLine ? safeJson(dataLine.slice(5).trim()) : text;
  }
  return safeJson(text);
};
const safeJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const post = async (step: string, url: string, headers: Record<string, string>, body: unknown): Promise<McpProbeExchange> => {
  const started = Date.now();
  const exchange: McpProbeExchange = {
    step,
    request: { method: 'POST', url, headers, body },
    durationMs: 0,
  };
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    exchange.response = {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parseBody(res.headers.get('content-type') ?? '', text),
    };
  } catch (err) {
    exchange.error = err instanceof Error ? err.message : String(err);
  }
  exchange.durationMs = Date.now() - started;
  return exchange;
};

const result = (exchange?: McpProbeExchange) => (exchange?.response?.body as { result?: any; error?: any } | undefined) ?? {};

const newestSupported = (advertised: unknown): McpProtocolVersion | undefined => {
  const list = Array.isArray(advertised) ? advertised : [];
  return SUPPORTED_VERSIONS.find(v => list.includes(v));
};

export const probeMcpServer = async ({ url }: { url: string }): Promise<McpProbeResult> => {
  const exchanges: McpProbeExchange[] = [];

  // 1. Stateless probe: server/discover (2026-07-28).
  const discover = await post('server/discover', url, {
    'content-type': 'application/json',
    accept: ACCEPT,
    'mcp-protocol-version': STATELESS_VERSION,
    'mcp-method': 'server/discover',
  }, {
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': STATELESS_VERSION,
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
      },
    },
  });
  exchanges.push(discover);
  const discovered = result(discover).result;
  if (discovered && Array.isArray(discovered.supportedVersions)) {
    const version = newestSupported(discovered.supportedVersions);
    return {
      ok: Boolean(version),
      era: version ? eraOfVersion(version) : undefined,
      version,
      serverInfo: discovered.serverInfo,
      advertisedVersions: discovered.supportedVersions,
      exchanges,
    };
  }

  // 2. Fall back to the session-era `initialize` handshake, newest legacy version first.
  const initialize = await post('initialize', url, {
    'content-type': 'application/json',
    accept: ACCEPT,
  }, {
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO },
  });
  exchanges.push(initialize);
  const initialized = result(initialize).result;
  const negotiated = initialized?.protocolVersion;
  if (isSupportedVersion(negotiated)) {
    return {
      ok: true,
      era: eraOfVersion(negotiated),
      version: negotiated,
      serverInfo: initialized.serverInfo,
      advertisedVersions: [negotiated],
      exchanges,
    };
  }
  return { ok: false, advertisedVersions: [], exchanges };
};
