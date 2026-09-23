import { getKonnectApiRegions, getKonnectApiUrl } from '../common/constants';

export type KonnectRegion = string;

const PAGE_SIZE = 100;
// Maximum number of retry attempts after the first 429 response (5 retries = 6 total attempts).
const MAX_RETRY_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface KonnectProxyUrl {
  host: string;
  port: number;
  protocol: string;
}

export interface KonnectControlPlane {
  id: string;
  name: string;
  description: string;
  region: KonnectRegion;
  config: {
    cluster_type: string;
    control_plane_endpoint: string;
    cloud_gateway: boolean;
  };
  proxy_urls: KonnectProxyUrl[] | null;
}

export interface KonnectService {
  id: string;
  name: string | null;
  protocol: string;
  host: string;
  port: number;
  path: string | null;
  enabled: boolean;
  tags: string[] | null;
}

export interface KonnectRoute {
  id: string;
  name: string | null;
  methods: string[] | null;
  paths: string[] | null;
  protocols: string[];
  hosts: string[] | null;
  headers: Record<string, string[]> | null;
  snis: string[] | null;
  expression: string | null;
  service: { id: string } | null;
}

export const getActiveRegions = getKonnectApiRegions;

// Boundary normalizers — coerce any missing nullable field to `null` so the
// declared `T | null` types are honest. Defending against `undefined` once
// here lets every downstream consumer use strict `=== null` checks and skip
// the `?? null` / `arr == null` defensive plumbing that otherwise leaks
// through sanitizeRoute, sync.ts, expression-parser, etc.
function normalizeControlPlane(cp: KonnectControlPlane, region: KonnectRegion): KonnectControlPlane {
  return { ...cp, region, proxy_urls: cp.proxy_urls ?? null };
}

function normalizeService(s: KonnectService): KonnectService {
  return { ...s, name: s.name ?? null, path: s.path ?? null, tags: s.tags ?? null };
}

function normalizeRoute(r: KonnectRoute): KonnectRoute {
  return {
    ...r,
    name: r.name ?? null,
    methods: r.methods ?? null,
    paths: r.paths ?? null,
    hosts: r.hosts ?? null,
    headers: r.headers ?? null,
    snis: r.snis ?? null,
    expression: r.expression ?? null,
    service: r.service ?? null,
  };
}

async function fetchWithRetry(url: string, pat: string, signal?: AbortSignal): Promise<Response> {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${pat}` },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status !== 429 || attempt >= MAX_RETRY_ATTEMPTS) {
      return response;
    }

    const parsed = response.headers.get('Retry-After')
      ? Number.parseInt(response.headers.get('Retry-After')!, 10)
      : Number.NaN;
    const delay =
      Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);

    console.log(`[konnect] Rate limited. Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    attempt++;
  }
}

export interface PatValidationResult {
  valid: boolean;
  error?: string;
}

export async function validatePat(pat: string): Promise<PatValidationResult> {
  try {
    const response = await fetch(`${regionalApiBase('us')}/v2/control-planes?page[size]=1`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (response.ok) {
      return { valid: true };
    }
    if (response.status === 401) {
      return { valid: false, error: 'Invalid token (401 Unauthorized).' };
    }
    if (response.status === 403) {
      return { valid: false, error: 'Token lacks permission to list control planes (403 Forbidden).' };
    }
    return { valid: false, error: `Konnect returned ${response.status}.` };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'Could not reach Konnect.' };
  }
}

export async function fetchKonnectOrganizationId(pat: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchWithRetry(`${regionalApiBase('us')}/v3/organizations/me`, pat, signal);
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as { id?: string };
    return data.id;
  } catch {
    return undefined;
  }
}

export async function* fetchAllControlPlanes(
  pat: string,
  region: KonnectRegion,
  signal?: AbortSignal,
): AsyncGenerator<KonnectControlPlane[]> {
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${regionalApiBase(region)}/v2/control-planes?page[size]=${PAGE_SIZE}&page[number]=${page}`;
    const response = await fetchWithRetry(url, pat, signal);

    if (!response.ok) {
      throw new Error(`Konnect API error ${response.status} fetching control planes`);
    }

    const body = await response.json();
    const total: number = body?.meta?.page?.total ?? 0;
    totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    yield (body.data as KonnectControlPlane[]).map(cp => normalizeControlPlane(cp, region));
    page++;
  } while (page <= totalPages);
}

async function fetchAllOffsetPaginated<T>(
  baseUrl: string,
  pat: string,
  errorContext: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const results: T[] = [];
  let offset: string | null = null;

  do {
    const url = offset ? `${baseUrl}?size=${PAGE_SIZE}&offset=${offset}` : `${baseUrl}?size=${PAGE_SIZE}`;
    const response = await fetchWithRetry(url, pat, signal);

    if (!response.ok) {
      throw new Error(`Konnect API error ${response.status} ${errorContext}`);
    }

    const body = await response.json();
    results.push(...(body.data as T[]));
    offset = body.offset ?? null;
  } while (offset !== null);

  return results;
}

export async function fetchAllServices(
  pat: string,
  cpId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectService[]> {
  const services = await fetchAllOffsetPaginated<KonnectService>(
    `${regionalApiBase(region)}/v2/control-planes/${cpId}/core-entities/services`,
    pat,
    `fetching services for CP ${cpId}`,
    signal,
  );
  return services.map(normalizeService);
}

export async function fetchRoutesForService(
  pat: string,
  cpId: string,
  serviceId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectRoute[]> {
  const routes = await fetchAllOffsetPaginated<KonnectRoute>(
    `${regionalApiBase(region)}/v2/control-planes/${cpId}/core-entities/services/${serviceId}/routes`,
    pat,
    `fetching routes for service ${serviceId}`,
    signal,
  );
  return routes.map(normalizeRoute);
}

export interface KonnectPlugin {
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  protocols: string[] | null;
  tags: string[] | null;
  route: { id: string } | null;
  service: { id: string } | null;
  consumer: { id: string } | null;
  ordering?: {
    before?: Record<string, string[]>;
    after?: Record<string, string[]>;
  } | null;
}

export async function fetchPluginsForRoute(
  pat: string,
  cpId: string,
  routeId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectPlugin[]> {
  const plugins = await fetchAllOffsetPaginated<KonnectPlugin>(
    `${regionalApiBase(region)}/v2/control-planes/${cpId}/core-entities/routes/${routeId}/plugins`,
    pat,
    `fetching plugins for route ${routeId}`,
    signal,
  );
  return plugins.map(normalizePlugin);
}

export async function fetchAllPlugins(
  pat: string,
  cpId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectPlugin[]> {
  const plugins = await fetchAllOffsetPaginated<KonnectPlugin>(
    `${regionalApiBase(region)}/v2/control-planes/${cpId}/core-entities/plugins`,
    pat,
    `fetching plugins for CP ${cpId}`,
    signal,
  );
  return plugins.map(normalizePlugin);
}

function normalizePlugin(p: KonnectPlugin): KonnectPlugin {
  return {
    ...p,
    protocols: p.protocols ?? null,
    tags: p.tags ?? null,
    route: p.route ?? null,
    service: p.service ?? null,
    consumer: p.consumer ?? null,
    ordering: p.ordering ?? null,
  };
}

// ── Debugger (o11y/debug-sessions) ──────────────────────────────────────────
//
// PROTOTYPE SHORTCUT / READ THIS BEFORE RELYING ON THIS SECTION:
// Everything below is REVERSE-ENGINEERED, not from a published API spec.
// Kong's public API catalog (developer.konghq.com/api/) has no documented
// endpoint for this feature as of 2026-09-23. We found it by driving the
// real Konnect UI's "Start debugging" action in a browser and reading the
// network tab, then verified the full request/response shapes against a
// real control plane with a real PAT (see 3593.md, "Part 2: Debugger tab").
// It could rename/reshape without notice since it's not a supported contract.
// Before shipping this beyond a prototype, get Konnect's API/platform team
// to confirm (a) this is the intended long-term contract, (b) `sampling_rule`
// syntax for scoping a session to a single route/service (we never confirmed
// this — see fetchDebugSessionTraces below, we filter client-side instead),
// and (c) whether there's a supported SDK/client we should use instead of a
// hand-rolled fetch.
//
// There is a SECOND, unrelated, and genuinely documented debugging mechanism
// in Kong Gateway — header-based single-request debug via `X-Kong-Request-Debug`
// / `X-Kong-Request-Debug-Output` (developer.konghq.com/gateway/debug-requests/).
// We are NOT using it here because it requires control over the data plane's
// config (`KONG_REQUEST_DEBUG_TOKEN`), which isn't available on Serverless
// Cloud Gateways — the CP type we tested against. Don't conflate the two if
// you're extending this later.

export interface KonnectDataPlaneNode {
  id: string;
  hostname: string;
}

export async function fetchDataPlaneNodes(
  pat: string,
  cpId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectDataPlaneNode[]> {
  const response = await fetchWithRetry(`${regionalApiBase(region)}/v2/control-planes/${cpId}/nodes`, pat, signal);
  if (!response.ok) {
    throw new Error(`Konnect API error ${response.status} fetching data plane nodes for CP ${cpId}`);
  }
  const body = await response.json();
  return (body.items as { id: string; hostname: string }[]).map(n => ({ id: n.id, hostname: n.hostname }));
}

export interface KonnectDebugSession {
  id: string;
  name: string;
  duration_secs: number;
  max_samples: number;
  targets: string[];
  created_at: string;
  started_at: string;
  // Absent while the session is still running. This is inferred from the
  // real API's observed shape — there was no separate status enum field
  // (the MCP tool description we initially found implied one exists, e.g.
  // "in_progress | completed | timed_out | cancelled | pending"; the real
  // REST response doesn't have it). Re-verify if this ever looks wrong.
  completed_at?: string;
  timed_out?: boolean;
}

// duration_secs: seen 10-1800 accepted in the real Konnect UI's form; not
// independently confirmed as the hard min/max here.
export async function createDebugSession(
  pat: string,
  cpId: string,
  region: string,
  params: { name: string; targets: string[]; durationSecs: number; maxSamples: number },
  signal?: AbortSignal,
): Promise<KonnectDebugSession> {
  const response = await fetch(`${regionalApiBase(region)}/v1/control-planes/${cpId}/o11y/debug-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: params.name,
      targets: params.targets,
      duration_secs: params.durationSecs,
      max_samples: params.maxSamples,
      capture_traces: true,
      sampling_rate: 1,
      // Empty string = capture all traffic on the targeted node(s), not just
      // this route. PROTOTYPE SHORTCUT: we never confirmed the real filter
      // expression syntax for scoping server-side to one route/service, so
      // we over-capture here and filter client-side in fetchDebugSessionTraces
      // callers instead (see use-konnect-debugger.ts). Fine for a single
      // developer testing their own request; would be noisy on a busy
      // shared control plane with real traffic.
      sampling_rule: '',
    }),
    // BUG FIXED 2026-09-23: this used to pass `signal` straight through with
    // no fallback. Every other request in this file goes through
    // fetchWithRetry, which always applies REQUEST_TIMEOUT_MS even when the
    // caller doesn't supply a signal — this one didn't, so a stalled request
    // could hang forever with the UI stuck on "Starting debug session…" and
    // no error ever surfacing. Match the same always-timeout pattern here.
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Surface the real response body — this is an undocumented, unstable
    // endpoint (see the caveat above), so a bare status code isn't enough
    // to debug a 400/422 here. Don't strip this down to a generic message
    // again; it's the only way to see Konnect's actual validation error.
    const detail = await response.text().catch(() => '');
    throw new Error(`Konnect API error ${response.status} creating debug session: ${detail}`);
  }
  return response.json();
}

export async function fetchDebugSession(
  pat: string,
  cpId: string,
  sessionId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectDebugSession> {
  const response = await fetchWithRetry(
    `${regionalApiBase(region)}/v1/control-planes/${cpId}/o11y/debug-sessions/${sessionId}`,
    pat,
    signal,
  );
  if (!response.ok) {
    throw new Error(`Konnect API error ${response.status} fetching debug session ${sessionId}`);
  }
  return response.json();
}

// Cancels/deletes a session early. Confirmed by direct testing (204, session
// is gone on subsequent GET — a 404, not a "cancelled" status) but not
// documented anywhere; re-verify if Konnect changes this API.
export async function cancelDebugSession(
  pat: string,
  cpId: string,
  sessionId: string,
  region: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${regionalApiBase(region)}/v1/control-planes/${cpId}/o11y/debug-sessions/${sessionId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${pat}` },
    signal,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Konnect API error ${response.status} cancelling debug session ${sessionId}`);
  }
}

export interface KonnectDebugTraceSummary {
  trace_id: string;
  duration_ms: number;
}

export async function fetchDebugSessionTraces(
  pat: string,
  cpId: string,
  sessionId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectDebugTraceSummary[]> {
  const response = await fetchWithRetry(
    `${regionalApiBase(region)}/v1/control-planes/${cpId}/o11y/debug-sessions/${sessionId}/traces?limit=2000`,
    pat,
    signal,
  );
  if (!response.ok) {
    throw new Error(`Konnect API error ${response.status} fetching traces for debug session ${sessionId}`);
  }
  const body = await response.json();
  const traces = (body.traces ?? []) as { trace_id: string; duration_ms: number }[];
  return traces.map(t => ({ trace_id: t.trace_id, duration_ms: t.duration_ms }));
}

// Real OTel-shaped span, as returned by the traces/{traceId} endpoint. Only
// the fields we actually read are declared — the real payload has more
// (status, links, scope info) that we ignore for now.
export interface KonnectDebugSpan {
  span_id: string;
  parent_span_id: string;
  name: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  attributes: Record<string, unknown>;
}

export async function fetchDebugSessionTraceDetail(
  pat: string,
  cpId: string,
  sessionId: string,
  traceId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectDebugSpan[]> {
  const response = await fetchWithRetry(
    `${regionalApiBase(region)}/v1/control-planes/${cpId}/o11y/debug-sessions/${sessionId}/traces/${traceId}`,
    pat,
    signal,
  );
  if (!response.ok) {
    throw new Error(`Konnect API error ${response.status} fetching trace ${traceId}`);
  }
  const body = await response.json();
  // Real shape is OTel's resource_spans[].scope_spans[].spans[] — flatten it
  // since we only have one resource/scope per trace in practice here.
  const resourceSpans = body.resource_spans ?? [];
  return resourceSpans.flatMap((rs: { scope_spans?: { spans?: KonnectDebugSpan[] }[] }) =>
    (rs.scope_spans ?? []).flatMap(ss => ss.spans ?? []),
  );
}

function regionalApiBase(region: string): string {
  const url = getKonnectApiUrl();
  // If KONNECT_API_URL is already a full URL (e.g. http://localhost:4010 in tests),
  // use it as-is without prepending a region subdomain or https scheme.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url.replace(/\/$/, '');
  }
  return `https://${region}.${url.replace(/\/$/, '')}`;
}
