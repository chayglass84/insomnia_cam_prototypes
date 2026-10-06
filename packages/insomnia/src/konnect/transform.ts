import type { AiGatewayModel, AiGatewayRunInfo, KonnectDeploymentType } from 'insomnia-data';

import { extractChatCompletion } from '../common/chat-completion';
import { parseChatRequestBody } from '../common/chat-request';
import { computeCostUsd } from '../common/llm-cost';
import { bodyBufferToUtf8 } from '../common/utils/utf8-bytes';
import type {
  KonnectAiGatewayPolicy,
  KonnectControlPlane,
  KonnectLlmCostPrice,
  KonnectProxyUrl,
  KonnectRoute,
} from './api';

// ─── Template injection sanitisation ─────────────────────────────────────────

/**
 * Strips Liquid template syntax (`{{ }}`, `{% %}`) from a string
 * sourced from external API data, preventing template injection when the value
 * is later rendered by Insomnia's Liquid engine.
 */
function stripTemplateSyntax(value: string): string {
  let prev = '';
  let result = value;
  while (result !== prev) {
    prev = result;
    result = result.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\{%[\s\S]*?%\}/g, '');
  }
  return result;
}

/** Strips template syntax from each item, filters empties, and returns null if nothing remains. */
function sanitizeStringArray(arr: string[] | null): string[] | null {
  if (arr === null) {
    return null;
  }
  const result = arr.map(stripTemplateSyntax).filter(s => s.trim() !== '');
  return result.length > 0 ? result : null;
}

/**
 * Returns a copy of the route with Liquid template syntax stripped from all
 * string fields that flow into rendered request content. Array fields that
 * become entirely empty after stripping are set to null so existing fallbacks
 * (e.g. default HTTP methods) apply correctly.
 */
export function sanitizeRoute(route: KonnectRoute): KonnectRoute {
  return {
    ...route,
    name: route.name !== null ? stripTemplateSyntax(route.name) : null,
    methods: sanitizeStringArray(route.methods),
    paths: sanitizeStringArray(route.paths),
    hosts: sanitizeStringArray(route.hosts),
    headers: route.headers
      ? Object.fromEntries(
          Object.entries(route.headers)
            .map(([k, vs]): [string, string[]] => [stripTemplateSyntax(k), sanitizeStringArray(vs) ?? []])
            .filter(([k, vs]) => k.trim() !== '' && vs.length > 0),
        )
      : null,
    expression: route.expression !== null ? stripTemplateSyntax(route.expression) : null,
  };
}

// ─── Proxy environment variables ─────────────────────────────────────────────

/**
 * Names of the proxy environment variables Konnect sync manages.
 * On first sync, values are auto-filled from the control plane's `proxy_urls`
 * when available.
 *
 * - `proxy_host`: host (with port when non-standard), used in http/https/ws/wss URLs.
 * - `grpc_proxy_host`: host:port, used in grpc:// URLs.
 * - `grpcs_proxy_host`: host:port, used in grpcs:// URLs.
 */
export const KONNECT_PROXY_VAR_NAMES = ['proxy_host', 'grpc_proxy_host', 'grpcs_proxy_host'] as const;

const HTTP_LIKE_PROTOCOLS = new Set(['http', 'https', 'ws', 'wss']);
const GRPC_PROTOCOL = 'grpc';
const GRPCS_PROTOCOL = 'grpcs';

/** Default ports per protocol — used to suppress redundant port numbers in the output. */
const DEFAULT_PORTS: Record<string, number> = { http: 80, ws: 80, https: 443, wss: 443 };

/** Returns `host` for standard ports, `host:port` for non-standard ones. */
function formatHttpLikeHost(host: string, port: number, protocol: string): string {
  const defaultPort = DEFAULT_PORTS[protocol];
  return defaultPort !== undefined && port === defaultPort ? host : `${host}:${port}`;
}

/**
 * Derives default values for the proxy environment variables from a control
 * plane's `proxy_urls` array. Returns a partial map of var-name → value;
 * omitted keys mean no matching entry was found.
 *
 * - `proxy_host`       ← first http/https/ws/wss entry → host[:port] (port omitted if standard)
 * - `grpc_proxy_host`  ← first grpc entry → host:port
 * - `grpcs_proxy_host` ← first grpcs entry → host:port
 */
export function deriveProxyVarDefaults(
  proxyUrls: KonnectProxyUrl[] | null | undefined,
): Partial<Record<(typeof KONNECT_PROXY_VAR_NAMES)[number], string>> {
  const defaults: Partial<Record<(typeof KONNECT_PROXY_VAR_NAMES)[number], string>> = {};
  if (!proxyUrls?.length) {
    return defaults;
  }

  for (const entry of proxyUrls) {
    if (!entry.host) {
      continue;
    }
    const proto = entry.protocol.toLowerCase();
    if (!defaults.proxy_host && HTTP_LIKE_PROTOCOLS.has(proto)) {
      defaults.proxy_host = formatHttpLikeHost(entry.host, entry.port, proto);
    } else if (!defaults.grpc_proxy_host && proto === GRPC_PROTOCOL) {
      defaults.grpc_proxy_host = `${entry.host}:${entry.port}`;
    } else if (!defaults.grpcs_proxy_host && proto === GRPCS_PROTOCOL) {
      defaults.grpcs_proxy_host = `${entry.host}:${entry.port}`;
    }
  }

  return defaults;
}

// ─── Path handling ────────────────────────────────────────────────────────────

export interface ResolvedPath {
  /** URL path with colon-style path parameters, e.g. `/api/users/:userid`. */
  path: string;
  /** Insomnia path parameters to store on the request (values pre-filled as empty). */
  pathParameters: { name: string; value: string }[];
}

/**
 * Converts a Kong regex path string (tilde prefix already stripped) into:
 *   - a URL path using Insomnia's colon syntax (`:paramname`), and
 *   - a `pathParameters` array the user fills in via the Path Parameters tab.
 *
 * Named capture groups → `:name` (lowercased).
 * Unnamed groups and stray character classes → `:param_1`, `:param_2`, … (shared counter).
 * If the regex is too complex to parse cleanly, falls back to `/:path` (replace) or the raw
 * regex string with no path parameters (keep).
 */
export function generatePathPlaceholder(
  regexString: string,
  fallbackMode: 'keep' | 'replace' = 'replace',
): ResolvedPath {
  const paramNames: string[] = [];

  // Strip starting and ending anchors
  let path = regexString.replace(/^\^|\$$/g, '');

  // Un-escape standard path characters
  path = path.replace(/\\\//g, '/');
  path = path.replace(/\\\./g, '.');
  path = path.replace(/\/\?$/, '/'); // Optional trailing slash

  // Passes must run in this order:
  //   1. Named groups  — pattern `(?<name>...)` starts with `(?<`, so it's consumed before pass 2.
  //   2. Unnamed groups — matches remaining `(...)` after named groups are gone.
  //   3. Stray character classes — matches `[...]` that weren't inside a group.
  // Reordering would cause pass 2 to match the inner `(` of a named group before pass 1 can handle it.

  // Pass 1 — Named groups: (?<userId>\d+) → :userid
  path = path.replace(/\(\?<([a-zA-Z0-9_]+)>[^)]+\)/g, (_, groupName: string) => {
    const name = groupName.toLowerCase();
    paramNames.push(name);
    return `:${name}`;
  });

  // Passes 2 & 3 share a single param_N counter so the user sees one contiguous sequence
  // (:param_1, :param_2, …) rather than two separate ones.
  let paramCounter = 1;
  // Pass 2 — Unnamed groups: ([0-9]+) → :param_N
  path = path.replace(/\([^)]+\)/g, () => {
    const name = `param_${paramCounter++}`;
    paramNames.push(name);
    return `:${name}`;
  });
  // Pass 3 — Stray character classes: [a-z]+ → :param_N
  path = path.replace(/\[[^\]]+\][+*?]?/g, () => {
    const name = `param_${paramCounter++}`;
    paramNames.push(name);
    return `:${name}`;
  });

  // Validation: Check for leftover regex syntax
  const hasLeftoverRegex = /[()[\]*+?\\]/.test(path);
  if (hasLeftoverRegex) {
    if (fallbackMode === 'keep') {
      return { path: regexString, pathParameters: [] };
    }
    return { path: '/:path', pathParameters: [{ name: 'path', value: '' }] };
  }

  // Ensure it starts with a slash
  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  return {
    path,
    pathParameters: paramNames.map(name => ({ name, value: '' })),
  };
}

/**
 * Resolves a Kong route path for use in an Insomnia URL.
 * - null → `{ path: '', pathParameters: [] }`
 * - plain path → path unchanged, no pathParameters
 * - regex path (Kong `~` prefix) → parsed via generatePathPlaceholder
 */
export function resolvePath(rawPath: string | null): ResolvedPath {
  if (rawPath === null) {
    return { path: '', pathParameters: [] };
  }
  if (rawPath.startsWith('~')) {
    return generatePathPlaceholder(rawPath.slice(1));
  }
  return { path: rawPath, pathParameters: [] };
}

export function routeDisplayName(route: { name: string | null; id: string }): string {
  return route.name ?? `Route ${route.id}`;
}

export function buildRequestName(route: { name: string | null; paths: string[] | null; id: string }): string {
  const rawPath = route.paths?.[0];
  if (rawPath === undefined) {
    return routeDisplayName(route);
  }
  const resolved = resolvePath(rawPath).path;
  // If the regex was too complex to parse (fell back to '/:path'), use the raw
  // Kong path (including the '~' prefix) — it's more informative than '/:path'.
  if (resolved === '/:path') {
    return rawPath;
  }
  return resolved || routeDisplayName(route);
}

// ─── Header / path-parameter merging ─────────────────────────────────────────

/**
 * Merges Konnect-managed headers into an existing header array.
 * Previously Konnect-managed headers that are no longer incoming are removed
 * using the persisted `prevManagedNames` set. User-added headers outside that
 * set are always preserved.
 */
export function mergeHeaders(
  existing: { name: string; value: string }[],
  konnect: { name: string; value: string }[],
  prevManagedNames: string[],
): { name: string; value: string }[] {
  const incomingNames = new Set(konnect.map(h => h.name));
  const prevManaged = new Set(prevManagedNames);
  const userHeaders = existing.filter(h => !incomingNames.has(h.name) && !prevManaged.has(h.name));
  return [...konnect, ...userHeaders];
}

/**
 * Merges Konnect-derived path parameters into the existing set.
 * User-filled values are preserved for any param name that still appears;
 * renamed or removed params are dropped; new params get an empty value.
 */
export function mergePathParameters(
  existing: { name: string; value: string }[],
  incoming: { name: string; value: string }[],
): { name: string; value: string }[] {
  const existingByName = new Map(existing.map(p => [p.name, p.value]));
  return incoming.map(p => ({ name: p.name, value: existingByName.get(p.name) ?? '' }));
}

/**
 * Returns true if the incoming path parameters differ from existing ones
 * (by name or count). User-filled values are not considered — only structure.
 */
export function pathParametersChanged(
  existing: { name: string; value: string }[],
  incoming: { name: string; value: string }[],
): boolean {
  if (existing.length !== incoming.length) {
    return true;
  }
  return existing.some((p, i) => p.name !== incoming[i].name);
}

/**
 * Returns true if the Konnect-managed portion of the existing headers differs
 * from the incoming ones. Uses `prevManagedNames` to detect the case where all
 * Konnect headers were removed from the route.
 */
export function konnectHeadersChanged(
  existing: { name: string; value: string }[],
  incoming: { name: string; value: string }[],
  prevManagedNames: string[],
): boolean {
  const prevManaged = new Set(prevManagedNames);
  if (incoming.length === 0) {
    return existing.some(h => prevManaged.has(h.name));
  }
  const incomingByName = new Map(incoming.map(h => [h.name, h.value]));
  let matched = 0;
  for (const h of existing) {
    const expected = incomingByName.get(h.name);
    if (expected !== undefined) {
      if (h.value !== expected) {
        return true;
      }
      matched++;
    }
  }
  return matched !== incoming.length;
}

export function getKonnectDeploymentType(controlPlane: KonnectControlPlane): KonnectDeploymentType | null {
  const controlPlaneType = controlPlaneConfigToControlPlaneType({
    cluster_type: controlPlane.config.cluster_type as keyof typeof CLUSTER_TYPE_TO_CP_TYPE_MAP,
    cloud_gateway: controlPlane.config.cloud_gateway,
  });

  switch (controlPlaneType) {
    case ControlPlaneType.K8SIngressController: {
      return 'k8sIngressController';
    }
    case ControlPlaneType.Cloud: {
      return 'dedicatedCloud';
    }
    case ControlPlaneType.Serverless: {
      return 'serverless';
    }
    case ControlPlaneType.GroupWithCloudDataPlanes:
    case ControlPlaneType.GroupWithOnPremDataPlanes: {
      return 'group';
    }
    case ControlPlaneType.ServerlessV1: {
      return 'serverless';
    }
    default: {
      return 'selfManaged';
    }
  }
}

enum ControlPlaneType {
  Hybrid = 'CONTROL_PLANE_TYPE_HYBRID', // self managed
  Cloud = 'CONTROL_PLANE_TYPE_CLOUD', // Dedicated cloud
  K8SIngressController = 'CONTROL_PLANE_TYPE_K8S_INGRESS_CONTROLLER', // KIC
  /**
   * Group of hybrid-type control planes, on-prem data planes can connect to this control plane group
   */
  GroupWithOnPremDataPlanes = 'CONTROL_PLANE_TYPE_GROUP_WITH_ON_PREM_DATA_PLANES',
  /**
   * Group of hybrid-type control planes, cloud data planes can be created and managed by this control plane group
   */
  GroupWithCloudDataPlanes = 'CONTROL_PLANE_TYPE_GROUP_WITH_CLOUD_DATA_PLANES',
  Serverless = 'CONTROL_PLANE_TYPE_SERVERLESS', // Serverless.v0 deployed on fly.io
  ServerlessV1 = 'CONTROL_PLANE_TYPE_SERVERLESS_V1', // Serverless.v1 (previously HVC)
  // NativeEventProxy = 'CONTROL_PLANE_TYPE_KAFKA_NATIVE_EVENT_PROXY', // KNEP is deprecated in GM, DO NOT add it back
}

const ControlPlaneClusterTypeEnum = {
  ControlPlane: 'CLUSTER_TYPE_CONTROL_PLANE',
  K8SIngressController: 'CLUSTER_TYPE_K8S_INGRESS_CONTROLLER',
  ControlPlaneGroup: 'CLUSTER_TYPE_CONTROL_PLANE_GROUP',
  Serverless: 'CLUSTER_TYPE_SERVERLESS',
  HttpGateway: 'CLUSTER_TYPE_HTTP_GATEWAY',
  EventGateway: 'CLUSTER_TYPE_EVENT_GATEWAY',
  KafkaNativeEventProxy: 'CLUSTER_TYPE_KAFKA_NATIVE_EVENT_PROXY',
  CloudApiGateway: 'CLUSTER_TYPE_CLOUD_API_GATEWAY',
  ServerlessV1: 'CLUSTER_TYPE_SERVERLESS_V1',
};

const CLUSTER_TYPE_TO_CP_TYPE_MAP = {
  [ControlPlaneClusterTypeEnum.ControlPlane]: { false: ControlPlaneType.Hybrid, true: ControlPlaneType.Cloud },
  [ControlPlaneClusterTypeEnum.K8SIngressController]: { false: ControlPlaneType.K8SIngressController },
  [ControlPlaneClusterTypeEnum.ControlPlaneGroup]: {
    false: ControlPlaneType.GroupWithOnPremDataPlanes,
    true: ControlPlaneType.GroupWithCloudDataPlanes,
  },
  [ControlPlaneClusterTypeEnum.Serverless]: { false: ControlPlaneType.Serverless },
  [ControlPlaneClusterTypeEnum.ServerlessV1]: { true: ControlPlaneType.ServerlessV1 },
  // Placeholders for other cluster types
  [ControlPlaneClusterTypeEnum.CloudApiGateway]: { true: ControlPlaneType.ServerlessV1 }, // TODO: remove this when CLUSTER_TYPE_SERVERLESS_V1 is accepted by the API (KHCP-19640)
  [ControlPlaneClusterTypeEnum.HttpGateway]: { false: null },
  [ControlPlaneClusterTypeEnum.EventGateway]: { false: null },
  [ControlPlaneClusterTypeEnum.KafkaNativeEventProxy]: { false: null }, // KNEP is deprecated, DO NOT map it to any CP type
} as const;

type ControlPlaneConfigToControlPlaneType<
  T extends keyof typeof CLUSTER_TYPE_TO_CP_TYPE_MAP,
  C extends boolean,
> = `${C}` extends keyof (typeof CLUSTER_TYPE_TO_CP_TYPE_MAP)[T]
  ? (typeof CLUSTER_TYPE_TO_CP_TYPE_MAP)[T][`${C}`]
  : never;

type NeverToNull<T> = T extends never ? null : T;

function controlPlaneConfigToControlPlaneType<
  T extends keyof typeof CLUSTER_TYPE_TO_CP_TYPE_MAP,
  C extends boolean,
>(config: { cluster_type: T; cloud_gateway: C }): NeverToNull<ControlPlaneConfigToControlPlaneType<T, C>> {
  type ReturnType = NeverToNull<ControlPlaneConfigToControlPlaneType<T, C>>;
  const { cluster_type: clusterType, cloud_gateway: isCloudGateway } = config;
  const subMap = CLUSTER_TYPE_TO_CP_TYPE_MAP[clusterType];
  if (subMap && Object.hasOwnProperty.call(subMap, `${isCloudGateway}`)) {
    return subMap[`${isCloudGateway}` as keyof typeof subMap] as ReturnType;
  }
  // this should never happen, but just in case
  console.error(
    `ControlPlaneConfigToControlPlaneType: invalid clusterType ${clusterType} or cloud_gateway ${isCloudGateway}`,
  );

  return null as ReturnType;
}

// ─── AI Gateway (prototype, 3593AI) ───────────────────────────────────────────

/**
 * Konnect reports a model's request `format` but not the endpoint path, so this map is hardcoded
 * (prototype shortcut). The endpoint is whatever the gateway exposes for that format, which is not always the provider's own
 * path: Anthropic keeps `/v1/messages` but OpenAI is `/chat/completions` with no `/v1`.
 * Formats not listed here (gemini, bedrock, cohere, huggingface) get a request at the bare route path.
 */
const AI_FORMAT_ENDPOINTS: Record<string, string> = {
  anthropic: '/v1/messages',
  // No `/v1`, unlike Anthropic: confirmed against the gateway's own example cURL (a `/v1` path 404s "no Route matched").
  openai: '/chat/completions',
};

/** Groups models by route path. A model listening on several paths appears under each. */
export function groupModelsByPath(models: AiGatewayModel[]): [string, AiGatewayModel[]][] {
  const groups = new Map<string, AiGatewayModel[]>();
  for (const model of models) {
    for (const path of model.paths.length > 0 ? model.paths : ['(no path)']) {
      groups.set(path, [...(groups.get(path) ?? []), model]);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Starter after-response tests put on a gateway's root folder: a valid, non-empty reply and a total-token cap.
 * Reads usage straight from the response JSON, handling both Anthropic and OpenAI field names.
 */
export const AI_GATEWAY_STARTER_AFTER_RESPONSE_SCRIPT = `insomnia.test('Got a valid response', () => {
  insomnia.expect(insomnia.response.code).to.equal(200);

  // Anthropic-format models return content blocks; OpenAI-format models return choices.
  const body = insomnia.response.json();
  const text = body.content
    ? body.content.filter(b => b.type === 'text').map(b => b.text).join('')
    : body.choices?.[0]?.message?.content;

  insomnia.expect(text).to.be.a('string').and.not.be.empty;
});

insomnia.test('Uses under 500 tokens', () => {
  const usage = insomnia.response.json().usage;
  const tokensIn = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const tokensOut = usage.output_tokens ?? usage.completion_tokens ?? 0;

  insomnia.expect(tokensIn + tokensOut, \`used \${tokensIn} in + \${tokensOut} out\`).to.be.below(500);
});
`;

const AI_DEFAULT_MAX_TOKENS = 4096;
const AI_DEFAULT_SYSTEM_PROMPT = 'Be a helpful assistant.';
const AI_DEFAULT_FIRST_PROMPT = 'Tell me how Kong AI Gateway can help me, in five concise bullet points.';

export interface AiGatewayRequestSpec {
  name: string;
  /** Path appended to `{{ _.proxy_host }}`, route path + format endpoint. */
  path: string;
  body?: string;
  description: string;
}

/** Builds the starter streaming chat request for one route. Uses the first model's format and model value. */
export function buildAiGatewayRequestSpec(routePath: string, models: AiGatewayModel[]): AiGatewayRequestSpec {
  const model = models.find(m => m.routeModelValues.length > 0) ?? models[0];
  const endpoint = AI_FORMAT_ENDPOINTS[model.format];
  const name = `Chat — ${routePath}`;
  if (!endpoint) {
    return {
      name,
      path: routePath,
      description: `No known chat endpoint for the "${model.format}" format. Set the URL path and body by hand.`,
    };
  }
  const modelValue = model.routeModelValues[0];
  // Anthropic takes `system` at the top level; OpenAI takes it as the first message.
  const body =
    model.format === 'anthropic'
      ? {
          model: modelValue,
          // Literal on purpose: the chat editor JSON.parses the body, so it can't hold a `{{ _.var }}` template.
          max_tokens: AI_DEFAULT_MAX_TOKENS,
          stream: true,
          system: AI_DEFAULT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: AI_DEFAULT_FIRST_PROMPT }],
        }
      : {
          model: modelValue,
          stream: true,
          messages: [
            { role: 'system', content: AI_DEFAULT_SYSTEM_PROMPT },
            { role: 'user', content: AI_DEFAULT_FIRST_PROMPT },
          ],
        };
  return {
    name,
    path: `${routePath}${endpoint}`,
    body: JSON.stringify(body, null, 2),
    description: `Models on this route: ${models.map(m => `${m.displayName} (${m.routeModelValues.join(', ')})`).join('; ')}`,
  };
}

/**
 * Model-field suggestions for a request in an AI Gateway workspace: the `model` values the request's route
 * matches on (e.g. `opus`, `fable` for `/anthropic`). Returns null when the URL matches no catalog route.
 */
export function getAiGatewayModelSuggestions(requestUrl: string, models: AiGatewayModel[]): string[] | null {
  // Strip scheme + host. A templated host like `{{ _.proxy_host }}` contains no `/`, so this still works.
  const pathname = requestUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split('?')[0];
  const matches = models.filter(m => m.paths.some(path => pathname === path || pathname.startsWith(`${path}/`)));
  if (matches.length === 0) {
    return null;
  }
  return [...new Set(matches.flatMap(m => m.routeModelValues))];
}

export type AiGatewayModelOverride =
  | { url: string; bodyText: string; headers: { name: string; value: string }[] }
  | { skipReason: string };

/**
 * Rewrites a gateway chat request so it runs against `target` (used by the collection runner to compare
 * models): swaps the route path, sets the body `model` to the route's model value, and turns streaming off so
 * the response is plain JSON with `usage`. Returns a skip reason when the request can't be retargeted —
 * unknown route, non-chat body, or a different request format (the body shapes differ per format).
 */
export function applyAiGatewayModelOverride(
  request: { url: string; headers?: { name: string; value: string; disabled?: boolean }[]; body?: { text?: string } },
  target: AiGatewayModel,
  catalog: AiGatewayModel[],
): AiGatewayModelOverride {
  // Strip scheme + host; a templated host like `{{ _.proxy_host }}` contains no `/`.
  const rest = request.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const hostPart = request.url.slice(0, request.url.length - rest.length);
  const pathname = rest.split('?')[0];
  const currentRoute = catalog
    .flatMap(m => m.paths)
    .filter(path => pathname === path || pathname.startsWith(`${path}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!currentRoute) {
    return {
      skipReason: "This request's URL doesn't match any route on the gateway, so it can't be pointed at another model.",
    };
  }

  const parsed = request.body?.text ? parseChatRequestBody(request.body.text) : null;
  if (!parsed) {
    return { skipReason: "This request's body isn't a chat request, so it can't be pointed at another model." };
  }
  if (parsed.format !== target.format) {
    return {
      skipReason: `This request uses the ${parsed.format} format, but ${target.routeModelValues[0] ?? target.displayName} (${target.targetModel}) uses the ${target.format} format, and the two request bodies aren't compatible.`,
    };
  }
  const targetPath = target.paths[0];
  const modelValue = target.routeModelValues[0];
  if (!targetPath || !modelValue) {
    return {
      skipReason: `${target.targetModel || target.displayName} has no route path or model value on the gateway, so it can't be targeted.`,
    };
  }

  const body = { ...JSON.parse(request.body!.text!), model: modelValue, stream: false };
  return {
    url: `${hostPart}${targetPath}${rest.slice(currentRoute.length)}`,
    bodyText: JSON.stringify(body, null, 2),
    // Streaming is off, so don't ask for an event stream back.
    headers: (request.headers ?? []).map(h =>
      h.name.toLowerCase() === 'accept' ? { ...h, value: 'application/json' } : h,
    ),
  };
}

/**
 * Fills token usage and the provider-reported model into a runner row from the (non-streaming) response body.
 * The body can be a string, a Buffer, or a Uint8Array — over Electron IPC a Buffer arrives as a Uint8Array.
 */
export function withUsageFromResponseBody(
  info: AiGatewayRunInfo,
  body: string | Uint8Array,
  price?: { inputPerToken?: number; outputPerToken?: number },
): AiGatewayRunInfo {
  const summary = extractChatCompletion(typeof body === 'string' ? body : bodyBufferToUtf8(body));
  const costUsd = computeCostUsd(price, summary?.usage);
  return {
    ...info,
    model: summary?.model || info.model,
    inputTokens: summary?.usage?.inputTokens,
    outputTokens: summary?.usage?.outputTokens,
    ...(costUsd === null ? {} : { costUsd }),
  };
}

/**
 * Picks the price for a catalog model's upstream target (e.g. `claude-opus-4-6`) from Konnect's price list. Matches the
 * model id exactly; regional/cloud variants (`anthropic.claude-opus-4-6-v1`) have different ids and so don't match.
 * If several providers list the same id, prefers the provider named like the gateway's provider entity (`openai`),
 * then the first. Returns null when there is no exact match. Prototype: provider *type* is not consulted.
 */
export function pickLlmPrice(
  prices: KonnectLlmCostPrice[],
  targetModel: string,
  providerName: string,
): { inputPerToken: number; outputPerToken: number } | null {
  const candidates = prices.filter(price => price.model.id === targetModel);
  const chosen =
    candidates.find(price => price.provider.id.toLowerCase() === providerName.toLowerCase()) ?? candidates[0];
  if (!chosen) {
    return null;
  }
  const inputPerToken = Number.parseFloat(chosen.pricing.input_per_token);
  const outputPerToken = Number.parseFloat(chosen.pricing.output_per_token);
  return Number.isFinite(inputPerToken) && Number.isFinite(outputPerToken) ? { inputPerToken, outputPerToken } : null;
}

/** The catalog model whose upstream target the provider's reported model id starts with (`gpt-4.1-nano-2025-04-14`). */
export function findCatalogModelByResponseModel(
  responseModel: string | undefined,
  catalog: AiGatewayModel[],
): AiGatewayModel | undefined {
  if (!responseModel) {
    return undefined;
  }
  return catalog
    .filter(m => m.targetModel && (responseModel === m.targetModel || responseModel.startsWith(`${m.targetModel}-`)))
    .sort((a, b) => b.targetModel.length - a.targetModel.length)[0];
}

/** The catalog model a request would hit: the longest matching route path whose model values include the body alias. */
export function findCatalogModelByRequest(
  requestUrl: string,
  alias: string | undefined,
  catalog: AiGatewayModel[],
): AiGatewayModel | undefined {
  if (!alias) {
    return undefined;
  }
  const pathname = requestUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split('?')[0];
  const longestPath = (m: AiGatewayModel) => Math.max(0, ...m.paths.map(path => path.length));
  return catalog
    .filter(
      m =>
        m.routeModelValues.includes(alias) &&
        m.paths.some(path => pathname === path || pathname.startsWith(`${path}/`)),
    )
    .sort((a, b) => longestPath(b) - longestPath(a))[0];
}

export interface AppliedAiGatewayPolicy {
  policy: KonnectAiGatewayPolicy;
  scope: 'Model' | 'Global';
}

/**
 * The policies that affect a model's traffic: those attached to the model (by id or name), then the gateway's global
 * ones. A policy that is both global and attached is listed once, as global. No execution-order claim is made.
 */
export function selectAppliedAiGatewayPolicies(
  policies: KonnectAiGatewayPolicy[],
  modelPolicyRefs?: string[],
): AppliedAiGatewayPolicy[] {
  const refs = new Set(modelPolicyRefs);
  const attached = policies.filter(p => !p.global && (refs.has(p.id) || refs.has(p.name)));
  return [
    ...attached.map(policy => ({ policy, scope: 'Model' as const })),
    ...policies.filter(p => p.global).map(policy => ({ policy, scope: 'Global' as const })),
  ];
}
