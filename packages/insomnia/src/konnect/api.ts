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

/** Prototype (3593AI): AI Gateways are a separate Konnect resource from control planes. */
export interface KonnectAiGateway {
  id: string;
  name: string;
  display_name: string;
  deployment_type: string;
  region: KonnectRegion;
  proxy_urls: KonnectProxyUrl[] | null;
}

export interface KonnectAiGatewayModel {
  id: string;
  name: string;
  display_name: string;
  enabled: boolean;
  formats?: { type: string }[];
  /** Policies attached to this model. Shape unverified (always empty so far): strings or `{ id, name }` objects. */
  policies?: unknown[];
  targets: { name: string; provider: string }[];
  config: { route?: { paths?: string[]; model?: { values?: string[] } } };
}

/** One entry of Konnect's (beta) global LLM cost price list. Prices are USD per token, as strings. */
export interface KonnectLlmCostPrice {
  provider: { id: string; name?: string };
  model: { id: string; name?: string };
  pricing: { input_per_token: string; output_per_token: string };
  source?: string;
}

/** A policy on an AI Gateway: Kong's plugins, exposed by Konnect as gateway- or model-scoped "policies". */
export interface KonnectAiGatewayPolicy {
  id: string;
  name: string;
  display_name: string;
  /** The underlying plugin type, e.g. `rate-limiting`, `ai-prompt-guard`. */
  type: string;
  enabled: boolean;
  /** True when the policy applies to every model on the gateway. */
  global: boolean;
  config: Record<string, unknown>;
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

// List path confirmed with a real PAT (2026-10-06). The `/models` sub-path is inferred from the MCP tool name, still unconfirmed by curl.
const AI_GATEWAYS_PATH = '/v1/ai-gateways';

export async function* fetchAllAiGateways(
  pat: string,
  region: KonnectRegion,
  signal?: AbortSignal,
): AsyncGenerator<KonnectAiGateway[]> {
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${regionalApiBase(region)}${AI_GATEWAYS_PATH}?page[size]=${PAGE_SIZE}&page[number]=${page}`;
    const response = await fetchWithRetry(url, pat, signal);

    if (!response.ok) {
      throw new Error(`Konnect API error ${response.status} fetching AI gateways`);
    }

    const body = await response.json();
    const total: number = body?.meta?.page?.total ?? 0;
    totalPages = Math.ceil(total / PAGE_SIZE) || 1;

    yield (body.data as KonnectAiGateway[]).map(gw => ({ ...gw, region, proxy_urls: gw.proxy_urls ?? null }));
    page++;
  } while (page <= totalPages);
}

export async function fetchAiGatewayModels(
  pat: string,
  gatewayId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectAiGatewayModel[]> {
  const models: KonnectAiGatewayModel[] = [];
  let after: string | null = null;

  do {
    const base = `${regionalApiBase(region)}${AI_GATEWAYS_PATH}/${gatewayId}/models?page[size]=${PAGE_SIZE}`;
    const response = await fetchWithRetry(
      after ? `${base}&page[after]=${encodeURIComponent(after)}` : base,
      pat,
      signal,
    );

    if (!response.ok) {
      throw new Error(`Konnect API error ${response.status} fetching models for AI gateway ${gatewayId}`);
    }

    const body = await response.json();
    models.push(...(body.data as KonnectAiGatewayModel[]));
    // The list response exposes the next cursor as `meta.page.next` (null on the last page).
    const next = body?.meta?.page?.next ?? null;
    after =
      typeof next === 'string' && next ? (new URL(next, 'https://x').searchParams.get('page[after]') ?? null) : null;
  } while (after);

  return models;
}

/** All policies on an AI Gateway. The path is inferred from the MCP tool name, not yet confirmed live. */
export async function fetchAiGatewayPolicies(
  pat: string,
  gatewayId: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectAiGatewayPolicy[]> {
  const policies: KonnectAiGatewayPolicy[] = [];
  let after: string | null = null;

  do {
    const base = `${regionalApiBase(region)}${AI_GATEWAYS_PATH}/${gatewayId}/policies?page[size]=${PAGE_SIZE}`;
    const response = await fetchWithRetry(
      after ? `${base}&page[after]=${encodeURIComponent(after)}` : base,
      pat,
      signal,
    );

    if (!response.ok) {
      throw new Error(`Konnect API error ${response.status} fetching policies for AI gateway ${gatewayId}`);
    }

    const body = await response.json();
    policies.push(...((body.data ?? []) as KonnectAiGatewayPolicy[]));
    const next = body?.meta?.page?.next ?? null;
    after =
      typeof next === 'string' && next ? (new URL(next, 'https://x').searchParams.get('page[after]') ?? null) : null;
  } while (after);

  return policies;
}

// Documented as `GET /openmeter/llm-cost/prices` under the v3 API; the exact prefix is not yet confirmed live.
const LLM_COST_PRICES_PATH = '/v3/openmeter/llm-cost/prices';

/** All of Konnect's global LLM cost prices (several hundred entries, paged). */
export async function fetchLlmCostPrices(
  pat: string,
  region: string,
  signal?: AbortSignal,
): Promise<KonnectLlmCostPrice[]> {
  const prices: KonnectLlmCostPrice[] = [];
  let page = 1;
  let total = 0;

  do {
    const url = `${regionalApiBase(region)}${LLM_COST_PRICES_PATH}?page[size]=100&page[number]=${page}`;
    const response = await fetchWithRetry(url, pat, signal);

    if (!response.ok) {
      throw new Error(`Konnect API error ${response.status} fetching LLM cost prices`);
    }

    const body = await response.json();
    total = body?.meta?.page?.total ?? 0;
    prices.push(...((body.data ?? []) as KonnectLlmCostPrice[]));
    page++;
    if (!body.data?.length) {
      break;
    }
  } while (prices.length < total);

  return prices;
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

function regionalApiBase(region: string): string {
  const url = getKonnectApiUrl();
  // If KONNECT_API_URL is already a full URL (e.g. http://localhost:4010 in tests),
  // use it as-is without prepending a region subdomain or https scheme.
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url.replace(/\/$/, '');
  }
  return `https://${region}.${url.replace(/\/$/, '')}`;
}
