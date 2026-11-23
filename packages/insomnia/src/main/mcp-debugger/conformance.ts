import {
  checkHandshakeShape,
  checkListResult,
  type CheckStatus,
  checkUnknownMethod,
  type ConformanceCheck,
  type ConformanceProbe,
  type ConformanceReport,
  jsonRpcError,
  jsonRpcResult,
  listMethodsFor,
  makeCheck,
  summarizeConformance,
  type VersionResult,
} from '~/common/mcp-debugger/conformance';
import { type McpProtocolVersion, STATELESS_VERSION, SUPPORTED_VERSIONS } from '~/common/mcp-debugger/versions';

import { discoverOAuth } from './oauth-discovery';

// Task 4348 S6b: probe a server and say how current and how compliant it is. Every probe is read-only (handshakes, list
// calls, a ping, a deliberately unknown method, a GET for the legacy SSE endpoint); it never calls a tool. Plain fetch
// on purpose, so each answer is exactly what the server sent, not something a client library smoothed over.
// PROTOTYPE-MOCK: no proxy, TLS options or retry; 10 s per request, 4 s to see the first legacy SSE event.

const CLIENT_INFO = { name: 'Insomnia', version: '0-prototype' };
const ACCEPT = 'application/json, text/event-stream';
const LEGACY_VERSIONS = SUPPORTED_VERSIONS.filter(v => v !== STATELESS_VERSION);

type Headers = Record<string, string>;

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** JSON or a one-shot SSE stream: the first JSON-RPC message either way. */
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

/** `ours` wins over `user`, ignoring header-name case. */
const merge = (user: Headers, ours: Headers): Headers => {
  const taken = new Set(Object.keys(ours).map(k => k.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(user).filter(([k]) => !taken.has(k.toLowerCase()))), ...ours };
};

const send = async (method: string, url: string, headers: Headers, body?: unknown): Promise<ConformanceProbe> => {
  const probe: ConformanceProbe = { request: { method, url, headers, ...(body === undefined ? {} : { body }) } };
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    probe.response = {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: parseBody(res.headers.get('content-type') ?? '', text),
    };
  } catch (err) {
    probe.error = err instanceof Error ? err.message : String(err);
  }
  return probe;
};

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

const statelessMeta = (version: string) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
});

/** A stateless (2026-07-28) call: version and method are mirrored in headers, `_meta` carries the per-request context. */
const statelessCall = (url: string, user: Headers, method: string, opts: { version?: string; methodHeader?: string; params?: Record<string, unknown> } = {}) => {
  const version = opts.version ?? STATELESS_VERSION;
  return send(
    'POST',
    url,
    merge(user, { 'content-type': 'application/json', accept: ACCEPT, 'mcp-protocol-version': version, 'mcp-method': opts.methodHeader ?? method }),
    rpc(2, method, { ...opts.params, _meta: statelessMeta(version) }),
  );
};

/** Newest legacy-era session we manage to open; the session checks run against it. */
interface LegacySession {
  version: McpProtocolVersion;
  sessionId?: string;
  capabilities: unknown;
  initProbe: ConformanceProbe;
}

const sessionHeaders = (user: Headers, session: LegacySession): Headers =>
  merge(user, {
    'content-type': 'application/json',
    accept: ACCEPT,
    'mcp-protocol-version': session.version,
    ...(session.sessionId ? { 'mcp-session-id': session.sessionId } : {}),
  });

const hasHttpAnswer = (probe: ConformanceProbe) => probe.response !== undefined;
const isAuthStatus = (status?: number) => status === 401 || status === 403;

const authChecks = async (url: string, probe?: ConformanceProbe): Promise<ConformanceCheck[]> => {
  const checks: ConformanceCheck[] = [];
  const challenge = probe?.response?.headers['www-authenticate'];
  if (probe && isAuthStatus(probe.response?.status)) {
    checks.push(
      makeCheck(
        'auth-required',
        'auth',
        'Requires authentication',
        'info',
        `Answered ${probe.response?.status}${challenge ? ` with WWW-Authenticate: ${challenge}` : ''}.`,
        { probe },
      ),
    );
    if (!/\bbearer\b/i.test(challenge ?? '')) {
      return checks;
    }
  } else if (probe) {
    checks.push(
      makeCheck(
        'auth-open',
        'auth',
        'Accepts unauthenticated requests',
        'info',
        'A request with no credentials was answered normally. Fine for a local or development server; unexpected for a hosted one.',
        { probe },
      ),
    );
    return checks;
  }
  // An OAuth-protected server: reuse the discovery chain (RFC 9728, RFC 8414, PKCE, issuer match) as checks.
  const statusMap: Record<string, CheckStatus> = { ok: 'pass', warn: 'warn', error: 'fail', skipped: 'skipped' };
  try {
    const discovery = await discoverOAuth({ url });
    for (const step of discovery.steps) {
      const findings = step.findings.filter(f => f.level !== 'info').map(f => f.text);
      checks.push(
        makeCheck(`auth-${step.id}`, 'auth', step.title, statusMap[step.status] ?? 'info', [step.summary, ...findings].filter(Boolean).join(' ')),
      );
    }
  } catch (err) {
    checks.push(makeCheck('auth-discovery', 'auth', 'OAuth discovery', 'warn', err instanceof Error ? err.message : String(err)));
  }
  return checks;
};

export const runConformance = async ({ url, headers }: { url: string; headers: { name: string; value: string; disabled?: boolean }[] }): Promise<ConformanceReport> => {
  const user: Headers = Object.fromEntries(headers.filter(h => !h.disabled && h.name.trim()).map(h => [h.name, h.value]));
  const checks: ConformanceCheck[] = [];
  const versions: VersionResult[] = [];
  let reachable = false;
  let authBlocked = false;
  const note = (probe: ConformanceProbe) => {
    reachable = reachable || hasHttpAnswer(probe);
    if (isAuthStatus(probe.response?.status)) {
      authBlocked = true;
    }
  };

  // ---- 2026-07-28: server/discover ----
  const discover = await statelessCall(url, user, 'server/discover');
  note(discover);
  const discoverResult = jsonRpcResult(discover.response?.body);
  const discoverError = jsonRpcError(discover.response?.body);
  const advertised = Array.isArray(discoverResult?.supportedVersions) ? (discoverResult.supportedVersions as string[]) : [];
  const modern = Boolean(discoverResult) && advertised.includes(STATELESS_VERSION);
  if (discover.error) {
    versions.push({ version: STATELESS_VERSION, outcome: 'unknown', note: `Request failed: ${discover.error}` });
  } else if (authBlocked) {
    versions.push({ version: STATELESS_VERSION, outcome: 'unknown', note: `Answered ${discover.response?.status}; credentials needed.` });
  } else if (modern) {
    versions.push({ version: STATELESS_VERSION, outcome: 'accepted', note: `server/discover answered and lists ${STATELESS_VERSION}.` });
  } else if (discoverResult) {
    versions.push({ version: STATELESS_VERSION, outcome: 'rejected', note: `server/discover answered but supportedVersions is ${advertised.length ? advertised.join(', ') : 'missing'}.` });
  } else if (discoverError?.code === -32_004) {
    versions.push({ version: STATELESS_VERSION, outcome: 'rejected', note: 'Rejected the version with -32004 (unsupported protocol version).' });
  } else {
    versions.push({
      version: STATELESS_VERSION,
      outcome: 'rejected',
      note: discoverError ? `Answered error ${discoverError.code}: ${discoverError.message}` : `HTTP ${discover.response?.status ?? '?'}: not a stateless endpoint.`,
    });
  }

  // ---- 2025-11-25 and older: initialize, once per version ----
  let session: LegacySession | undefined;
  const openSessions: LegacySession[] = [];
  if (!authBlocked) {
    for (const version of LEGACY_VERSIONS) {
      const probe = await send(
        'POST',
        url,
        merge(user, { 'content-type': 'application/json', accept: ACCEPT }),
        rpc(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO }),
      );
      note(probe);
      const result = jsonRpcResult(probe.response?.body);
      const error = jsonRpcError(probe.response?.body);
      if (probe.error) {
        versions.push({ version, outcome: 'unknown', note: `Request failed: ${probe.error}` });
      } else if (result && typeof result.protocolVersion === 'string') {
        const accepted = result.protocolVersion === version;
        versions.push({
          version,
          outcome: accepted ? 'accepted' : 'counter-offered',
          note: accepted ? 'initialize accepted.' : `Asked for ${version}, the server answered with ${result.protocolVersion}.`,
        });
        const opened: LegacySession = {
          version: (accepted ? version : result.protocolVersion) as McpProtocolVersion,
          sessionId: probe.response?.headers['mcp-session-id'],
          capabilities: result.capabilities,
          initProbe: probe,
        };
        openSessions.push(opened);
        if (accepted && !session) {
          session = opened;
          checks.push(...checkHandshakeShape('session', 's', result, { version, probe }));
        }
      } else {
        versions.push({
          version,
          outcome: 'rejected',
          note: error ? `Rejected with ${error.code}: ${error.message}` : `HTTP ${probe.response?.status ?? '?'} without an initialize result.`,
        });
      }
    }
  }

  // ---- modern checks ----
  if (modern && discoverResult) {
    checks.push(...checkHandshakeShape('modern', 'm', discoverResult, { version: STATELESS_VERSION, probe: discover }, { requireSupportedVersions: true }));
    if (discover.response?.headers['mcp-session-id']) {
      checks.push(makeCheck('m-no-session', 'modern', 'Does not use sessions', 'warn', 'The response sets an Mcp-Session-Id. The stateless protocol has no sessions; this looks like older-protocol behavior carried over.', { version: STATELESS_VERSION, probe: discover }));
    } else {
      checks.push(makeCheck('m-no-session', 'modern', 'Does not use sessions', 'pass', 'No Mcp-Session-Id, as expected for the stateless protocol.', { version: STATELESS_VERSION }));
    }
    for (const method of listMethodsFor(discoverResult.capabilities)) {
      const probe = await statelessCall(url, user, method);
      checks.push(checkListResult(method, 'modern', jsonRpcResult(probe.response?.body), jsonRpcError(probe.response?.body), { version: STATELESS_VERSION, probe }, 'm'));
    }
    const mismatch = await statelessCall(url, user, 'server/discover', { methodHeader: 'tools/call' });
    const mismatchRejected = (mismatch.response?.status ?? 200) >= 400 || jsonRpcError(mismatch.response?.body) !== undefined;
    checks.push(
      makeCheck(
        'm-header-mismatch',
        'modern',
        'Rejects a request whose Mcp-Method header disagrees with the body',
        mismatchRejected ? 'pass' : 'warn',
        mismatchRejected
          ? 'Rejected, as the spec asks (the routing header must match the body).'
          : 'Accepted a request whose Mcp-Method header said tools/call while the body said server/discover. Servers should reject that; it usually means the header is ignored.',
        { version: STATELESS_VERSION, probe: mismatch },
      ),
    );
    const future = await statelessCall(url, user, 'server/discover', { version: '2099-01-01' });
    const futureError = jsonRpcError(future.response?.body);
    checks.push(
      makeCheck(
        'm-unsupported-version',
        'modern',
        'Rejects an unsupported protocol version with -32004',
        futureError?.code === -32_004 ? 'pass' : 'warn',
        futureError?.code === -32_004
          ? 'Answered -32004 and told the client which versions it supports.'
          : futureError
            ? `Answered ${futureError.code} (${futureError.message}) instead of -32004.`
            : 'Answered a request for protocol 2099-01-01 normally; the requested version is being ignored.',
        { version: STATELESS_VERSION, probe: future },
      ),
    );
    const unknown = await statelessCall(url, user, 'insomnia/unknown-method');
    checks.push(checkUnknownMethod('modern', 'm', unknown.response?.status, unknown.response?.body, { version: STATELESS_VERSION, probe: unknown }));
  } else if (!authBlocked) {
    checks.push(makeCheck('m-not-modern', 'modern', 'Newest protocol (2026-07-28) is not available', 'info', 'server/discover did not return a usable result, so none of the stateless-protocol checks ran. The version list above shows what the server does accept.', { version: STATELESS_VERSION, probe: discover }));
  }

  // ---- session-era checks against the newest version that accepted a handshake ----
  if (session) {
    const base = sessionHeaders(user, session);
    await send('POST', url, base, { jsonrpc: '2.0', method: 'notifications/initialized' });
    if (session.sessionId && !/^[!-~]+$/.test(session.sessionId)) {
      checks.push(makeCheck('s-session-id', 'session', 'Session id is visible ASCII', 'warn', 'Mcp-Session-Id contains characters outside 0x21 to 0x7E.', { version: session.version, probe: session.initProbe }));
    } else {
      checks.push(makeCheck('s-session-id', 'session', 'Session id', 'info', session.sessionId ? 'The server issued an Mcp-Session-Id.' : 'The server issued no Mcp-Session-Id (stateless operation; optional in this version).', { version: session.version }));
    }
    const ping = await send('POST', url, base, rpc(3, 'ping'));
    const pingResult = jsonRpcResult(ping.response?.body);
    checks.push(makeCheck('s-ping', 'session', 'ping returns an empty result', pingResult && Object.keys(pingResult).length === 0 ? 'pass' : 'warn', pingResult ? 'Answered ping.' : 'ping was not answered with a result.', { version: session.version, probe: ping }));
    for (const method of listMethodsFor(session.capabilities)) {
      const probe = await send('POST', url, base, rpc(4, method));
      checks.push(checkListResult(method, 'session', jsonRpcResult(probe.response?.body), jsonRpcError(probe.response?.body), { version: session.version, probe }, 's'));
    }
    const unknown = await send('POST', url, base, rpc(5, 'insomnia/unknown-method'));
    checks.push(checkUnknownMethod('session', 's', unknown.response?.status, unknown.response?.body, { version: session.version, probe: unknown }));
  } else if (!authBlocked && !modern) {
    checks.push(makeCheck('s-no-session', 'session', 'Accepts an initialize handshake', 'fail', 'No supported version completed an initialize handshake over POST.', {}));
  }
  // Tidy up: end every session we opened (a 405 just means the server does not let clients end sessions).
  for (const opened of openSessions) {
    if (opened.sessionId) {
      const del = await send('DELETE', url, merge(user, { 'mcp-session-id': opened.sessionId, 'mcp-protocol-version': opened.version }));
      if (opened === session) {
        const status = del.response?.status;
        checks.push(
          makeCheck(
            's-delete',
            'session',
            'Sessions can be ended with DELETE',
            status !== undefined && status < 300 ? 'pass' : status === 405 ? 'info' : 'warn',
            status === undefined ? 'No answer to DELETE.' : status === 405 ? 'DELETE returned 405; the spec allows a server to refuse client-ended sessions.' : `DELETE answered ${status}.`,
            { version: opened.version, probe: del },
          ),
        );
      }
    }
  }

  // ---- the deprecated HTTP+SSE transport (2024-11-05) ----
  if (!authBlocked) {
    const sse = await readFirstSseEvent(url, merge(user, { accept: 'text/event-stream' }));
    note(sse.probe);
    if (sse.event === 'endpoint') {
      checks.push(makeCheck('t-legacy-sse', 'transport', 'Legacy HTTP+SSE transport', 'warn', 'This URL opens an SSE stream whose first event is "endpoint": the deprecated 2024-11-05 HTTP+SSE transport. Current clients use Streamable HTTP.', { version: '2024-11-05', probe: sse.probe }));
      const existing = versions.find(v => v.version === '2024-11-05');
      if (existing && existing.outcome !== 'accepted') {
        existing.outcome = 'via-sse';
        existing.note = 'Served over the legacy HTTP+SSE transport at this URL.';
      }
    } else if (sse.event !== undefined) {
      checks.push(makeCheck('t-sse-stream', 'transport', 'Server-to-client SSE stream', 'info', `GET opens an SSE stream (first event: ${sse.event || 'message'}). Normal for Streamable HTTP in 2025 and later.`, { probe: sse.probe }));
    } else {
      const status = sse.probe.response?.status;
      checks.push(makeCheck('t-sse-stream', 'transport', 'Server-to-client SSE stream', 'info', status === 405 ? 'GET returned 405: no standalone stream, which is allowed.' : `GET did not open an SSE stream${status ? ` (HTTP ${status})` : ''}.`, { probe: sse.probe }));
    }
  }

  // ---- auth ----
  if (authBlocked) {
    checks.push(...(await authChecks(url, discover)));
  } else if (Object.keys(user).length > 0) {
    const open = await send('POST', url, { 'content-type': 'application/json', accept: ACCEPT }, rpc(9, 'initialize', { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO }));
    checks.push(...(await authChecks(url, open)));
  } else {
    checks.push(...(await authChecks(url, discover)));
  }

  const order: Record<string, number> = { modern: 0, session: 1, transport: 2, auth: 3 };
  checks.sort((a, b) => order[a.group] - order[b.group]);
  return {
    url,
    ranAt: new Date().toISOString(),
    versions,
    checks,
    verdict: summarizeConformance({ versions, checks, reachable, authBlocked }),
  };
};

/** GET the URL asking for an event stream and report the name of the first SSE event, giving up after 4 s. */
const readFirstSseEvent = async (url: string, headers: Headers): Promise<{ probe: ConformanceProbe; event?: string }> => {
  const probe: ConformanceProbe = { request: { method: 'GET', url, headers } };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 4000);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: abort.signal });
    probe.response = { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: undefined };
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
      return { probe };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const eventLine = buffer.split('\n').find(line => line.startsWith('event:'));
      if (eventLine || buffer.includes('\n\n')) {
        const event = eventLine ? eventLine.slice(6).trim() : '';
        probe.response.body = buffer.trim();
        void reader.cancel();
        return { probe, event };
      }
    }
    return { probe, event: '' };
  } catch (err) {
    if (!probe.response) {
      probe.error = err instanceof Error ? err.message : String(err);
    }
    return { probe };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
};
