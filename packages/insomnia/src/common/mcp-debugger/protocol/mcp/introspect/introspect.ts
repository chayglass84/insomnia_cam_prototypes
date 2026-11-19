import { detectUi } from "../../apps/detectUi";
import { isProtocolException } from "../../errors";
import type {
  Capability,
  IntrospectionResult,
  IntrospectionWarning,
  JSONSchema,
} from "../../Protocol";
import type { MCPCapability } from "../capabilities/methods";
import { extractXMcpHeaders } from "../wireformat/encoding";

const JSONRPC_METHOD_NOT_FOUND = -32601;
/** Safety cap on pages walked per list method, so a server that always returns a
 *  cursor can't spin forever. Hitting it surfaces a warning rather than failing silently. */
const MAX_PAGES = 50;

/**
 * Issue one JSON-RPC request and resolve its `result`. Throws on a JSON-RPC
 * error — a `protocol-remote` ProtocolException carrying the wire `code`, so
 * introspect can distinguish a method-not-found degrade from a real failure.
 * Injected by the protocol layer, which owns the send/pending/trace/timeout
 * machinery — introspect never touches a transport or the wire.
 *
 * `opts.name` threads the wire-required `Mcp-Name` header for a stateless
 * connection's name-bearing methods (e.g. `resources/read`'s `uri`, used by
 * `prefetchUiResources`); the list methods above omit it. A legacy connection
 * ignores it — no such header exists on that era.
 */
export type RpcCall = (
  method: string,
  params?: unknown,
  opts?: { name?: string },
) => Promise<unknown>;

type ListSpec = {
  method: "tools/list" | "resources/list" | "prompts/list";
  key: "tools" | "resources" | "prompts";
  normalize: (items: unknown[]) => IntrospectionResult;
};

const LISTS: ListSpec[] = [
  { method: "tools/list", key: "tools", normalize: normalizeTools },
  { method: "resources/list", key: "resources", normalize: normalizeResources },
  { method: "prompts/list", key: "prompts", normalize: normalizePrompts },
];

/** The slice of a server's declared `initialize` capabilities that gates introspection:
 *  a list method is only worth calling when its key is present here. */
export type DeclaredCapabilities = {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean };
  prompts?: { listChanged?: boolean };
};

/** A JSON-RPC error code surfaced by the injected `call`, or undefined for a non-remote failure. */
function remoteErrorCode(e: unknown): number | undefined {
  return isProtocolException(e) && e.error.kind === "protocol-remote" ? e.error.code : undefined;
}

/**
 * List the capabilities the server declared at `initialize`. Per MCP capability
 * negotiation a server only advertises a feature it implements, so we call a list
 * method only when its key is `declared` — rather than probing all three and reading
 * `-32601`s back. Those failed probes would be pure noise in the trace, which is the
 * product here. The `-32601` handling below stays as a backstop for a server that
 * declares a capability but doesn't actually implement its list method.
 *
 * `call` is injected (see `RpcCall`): replies are correlated, traced, and timed by
 * the caller, so introspect is pure pagination + normalization with no transport
 * dependency. A non-method-not-found JSON-RPC error becomes a per-method warning;
 * a transport/timeout failure propagates and fails introspection.
 */
export async function introspect(
  call: RpcCall,
  declared: DeclaredCapabilities,
  signal?: AbortSignal,
): Promise<IntrospectionResult> {
  signal?.throwIfAborted();
  const capabilities: Capability[] = [];
  const warnings: IntrospectionWarning[] = [];

  const specs = LISTS.filter((spec) => declared[spec.key] != null);
  if (specs.length === 0) {
    warnings.push({
      message: "Server declared no tools, resources, or prompts; nothing to introspect.",
    });
  }

  for (const spec of specs) {
    let cursor: string | undefined;
    let pagesFetched = 0;
    const rawItems: unknown[] = [];
    do {
      const params = cursor ? { cursor } : {};

      let result: Record<string, unknown> | undefined;
      try {
        result = (await call(spec.method, params)) as Record<string, unknown> | undefined;
      } catch (e) {
        const code = remoteErrorCode(e);
        if (code === undefined) throw e; // transport/timeout failure → fail introspection
        if (code !== JSONRPC_METHOD_NOT_FOUND) {
          warnings.push({
            method: spec.method,
            message: e instanceof Error ? e.message : `${spec.method} failed`,
          });
        }
        cursor = undefined;
        break;
      }

      const items = result?.[spec.key];
      if (!Array.isArray(items)) {
        warnings.push({
          method: spec.method,
          message: `${spec.method} returned no "${spec.key}" array`,
        });
        cursor = undefined;
        break;
      }

      rawItems.push(...(items as unknown[]));
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor && ++pagesFetched < MAX_PAGES);
    if (cursor) {
      warnings.push({
        method: spec.method,
        message: `Stopped ${spec.method} pagination at the ${MAX_PAGES}-page safety cap; some ${spec.key} may be missing.`,
      });
    }
    const normalized = spec.normalize(rawItems);
    capabilities.push(...normalized.capabilities);
    warnings.push(...normalized.warnings);
  }

  // MCP Apps: a tool's ui:// resource is NOT fetched here — fetching every
  // declared ui:// resource on tools/list would run before the user has
  // chosen to render anything. Resources are fetched lazily, on first render
  // attempt, by `ensureUiResourceFetched` (appSessionController.ts).
  return { capabilities, warnings };
}

function asSchema(raw: unknown): JSONSchema | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as JSONSchema;
}

/**
 * The skeleton shared by all three list methods: skip entries that are malformed,
 * missing their identifying field, or duplicates of an earlier entry — each with a
 * warning — then hand every surviving entry to `build`, which produces the one
 * Capability shape unique to this list. `warn` lets `build` attach its own
 * per-entry warnings (e.g. an unusable schema) carrying the entry's id.
 */
function normalizeList(
  items: unknown[],
  method: ListSpec["method"],
  noun: string,
  idField: string,
  build: (
    raw: Record<string, unknown>,
    id: string,
    warn: (message: string) => void,
  ) => Capability | null,
): IntrospectionResult {
  const capabilities: Capability[] = [];
  const warnings: IntrospectionWarning[] = [];
  const seen = new Set<string>();
  const capitalizedNoun = noun[0]!.toUpperCase() + noun.slice(1);
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") {
      warnings.push({ method, message: `Skipped a malformed ${noun} entry` });
      continue;
    }
    const record = raw as Record<string, unknown>;
    const id = record[idField];
    if (typeof id !== "string" || id.length === 0) {
      warnings.push({ method, message: `Skipped a ${noun} with no ${idField}` });
      continue;
    }
    if (seen.has(id)) {
      warnings.push({
        capabilityId: id,
        method,
        message: `${capitalizedNoun} "${id}" is listed more than once; keeping the first`,
      });
      continue;
    }
    seen.add(id);
    const cap = build(record, id, (message) =>
      warnings.push({ capabilityId: id, method, message }),
    );
    if (cap !== null) capabilities.push(cap);
  }
  return { capabilities, warnings };
}

export function normalizeTools(tools: unknown[]): IntrospectionResult {
  return normalizeList(tools, "tools/list", "tool", "name", (raw, id, warn) => {
    const schema = asSchema(raw.inputSchema);
    if (raw.inputSchema != null && schema === null) {
      warn(`Tool "${id}" has an unusable input schema; rendering free-form JSON`);
    }

    // Per spec: clients MUST exclude tools with INVALID x-mcp-header annotations.
    // A schema-too-deep diagnostic is not a violation, so it does not exclude.
    const { headers: xcMcpHeaders, violations } = extractXMcpHeaders(schema, id, warn);
    if (violations > 0) {
      warn(`Tool "${id}" excluded: invalid x-mcp-header annotation(s) above`);
      return null;
    }

    const cap: MCPCapability = {
      id,
      type: "tool",
      rendererKey: "tool",
      schema,
      metadata: {
        name: id,
        description: typeof raw.description === "string" ? raw.description : undefined,
      },
    };
    if (Object.keys(xcMcpHeaders).length > 0) cap.xcMcpHeaders = xcMcpHeaders;

    const ui = detectUi(raw._meta);
    if (ui) cap.ui = ui;

    return cap;
  });
}

export function normalizeResources(resources: unknown[]): IntrospectionResult {
  return normalizeList(resources, "resources/list", "resource", "uri", (raw, id) => ({
    id,
    type: "resource",
    rendererKey: "resource",
    schema: null,
    metadata: {
      name: typeof raw.name === "string" ? raw.name : id,
      description: typeof raw.description === "string" ? raw.description : undefined,
      uri: id,
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
    },
  }));
}

export function normalizePrompts(prompts: unknown[]): IntrospectionResult {
  return normalizeList(prompts, "prompts/list", "prompt", "name", (raw, id) => {
    let schema: JSONSchema | null = null;
    if (Array.isArray(raw.arguments)) {
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const arg of raw.arguments as Array<{
        name?: unknown;
        description?: unknown;
        required?: unknown;
      }>) {
        if (typeof arg?.name !== "string") continue;
        properties[arg.name] = {
          type: "string",
          description: typeof arg.description === "string" ? arg.description : undefined,
        };
        if (arg.required === true) required.push(arg.name);
      }
      schema = { type: "object", properties, required };
    }
    return {
      id,
      type: "prompt",
      rendererKey: "prompt",
      schema,
      metadata: {
        name: id,
        description: typeof raw.description === "string" ? raw.description : undefined,
        arguments: raw.arguments,
      },
    };
  });
}
