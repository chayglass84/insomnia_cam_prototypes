import type { Capability, Invocation, RecordingKey } from "../../Protocol";
import type { TraceEvent } from "../../TraceEvent";
import { buildMcpParamHeaders } from "../wireformat/encoding";

const METHOD_BY_TYPE = {
  tool: "tools/call",
  prompt: "prompts/get",
  resource: "resources/read",
} as const satisfies Record<Capability["type"], string>;

/**
 * MCP-specific capability extension: carries the param→header-name map derived
 * from `x-mcp-header` annotations on `inputSchema` properties (2026-07-28 RC).
 * Present only for stateless tool capabilities that declare at least one valid
 * x-mcp-header param. Kept out of the base `Capability` type because this
 * annotation is MCP-specific.
 */
export interface MCPCapability extends Capability {
  xcMcpHeaders?: Record<string, string>;
}

/**
 * MCP-specific invocation extension: carries pre-encoded `Mcp-Param-{Name}`
 * entries built from `x-mcp-header` annotations at `buildInvocation` time
 * (2026-07-28 RC). Only present on stateless tool invocations. Kept out of the
 * base `Invocation` type because this header scheme is MCP-specific.
 */
export interface MCPInvocation extends Invocation {
  mcpParamHeaders?: Record<string, string>;
  /**
   * 4348 (S2 edit & replay): send exactly this request. `params` go on the wire untouched (no `_meta` injection) and
   * `headers` replace the protocol-built ones. Credential values shown as redacted in the trace are restored by name
   * from the connection's live auth headers, so a replay doesn't send the literal redaction marker.
   */
  exact?: { headers: Record<string, string> };
}

/** Build the JSON-RPC invocation for a capability + user-supplied arguments. */
export function invocationForCapability(
  capability: Capability,
  args: Record<string, unknown>,
): MCPInvocation {
  switch (capability.type) {
    case "tool": {
      const inv: MCPInvocation = {
        method: METHOD_BY_TYPE.tool,
        params: { name: capability.metadata.name, arguments: args },
      };
      const mcpCap = capability as MCPCapability;
      if (mcpCap.xcMcpHeaders) {
        const paramHeaders = buildMcpParamHeaders(mcpCap.xcMcpHeaders, args);
        if (Object.keys(paramHeaders).length > 0) inv.mcpParamHeaders = paramHeaders;
      }
      return inv;
    }
    case "prompt":
      return {
        method: METHOD_BY_TYPE.prompt,
        params: { name: capability.metadata.name, arguments: args },
      };
    case "resource": {
      const uri = (capability.metadata.uri as string | undefined) ?? capability.id;
      return { method: METHOD_BY_TYPE.resource, params: { uri } };
    }
  }
}

/**
 * The wire methods a user may cancel — exactly the capability invocations
 * `invocationForCapability` produces. Excludes `initialize` (the MCP spec forbids
 * clients cancelling it) and introspection list calls (out of scope). Drives
 * whether the Trace UI shows a Cancel affordance on a pending request.
 */
const CANCELLABLE_METHODS = new Set<string>(Object.values(METHOD_BY_TYPE));

export function isCancellableMethod(method: string | undefined): boolean {
  return method !== undefined && CANCELLABLE_METHODS.has(method);
}

/**
 * A `tools/call` result reports a TOOL-level failure as a *successful* JSON-RPC
 * response whose `result` is `{ content, isError: true }` — distinct from a
 * JSON-RPC protocol `error`. True only for an object literally carrying
 * `isError === true`; a plain result (or one with `isError: false`) is a success.
 */
function isToolError(result: unknown): result is { isError: true; content?: unknown } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}

/**
 * Which methods encode a domain-level failure inside an otherwise-successful
 * result, and how to surface it. Keyed off `METHOD_BY_TYPE` so it can't drift
 * from the method table. Returns `undefined` for a plain success.
 */
export function resultLevelError(
  method: string,
  result: unknown,
): { message: string; data?: unknown } | undefined {
  if (method === METHOD_BY_TYPE.tool && isToolError(result)) {
    return { message: "tool execution returned an error", data: result.content };
  }
  return undefined;
}

/**
 * Reverse of `METHOD_BY_TYPE`, derived from it so the two cannot drift: the wire
 * method a capability invocation uses -> its capability type. Only these methods
 * are capability invocations; any other event (handshake, list call,
 * notification, response) is not.
 */
const TYPE_BY_METHOD = Object.fromEntries(
  Object.entries(METHOD_BY_TYPE).map(([type, method]) => [method, type]),
) as Record<string, Capability["type"]>;

/**
 * Stable identity key for a capability, used to filter the trace to one
 * capability's calls. MCP-specific (mirrors `invocationForCapability`): tools and
 * prompts key off `metadata.name`; resources key off `metadata.uri ?? id`, the
 * same value the invocation sends as `params.uri`.
 */
export function capabilityKey(capability: Capability): string {
  if (capability.type === "resource") {
    const uri = (capability.metadata.uri as string | undefined) ?? capability.id;
    return `resource:${uri}`;
  }
  return `${capability.type}:${capability.metadata.name}`;
}

/**
 * The recording key an MCP event opens. Capability invocations mirror
 * `capabilityKey`; any other client request awaiting a reply (initialize, list
 * calls) gets a `method:` fallback identity so replay/runs cover it. Responses,
 * notifications, and server-initiated requests return null — they join a
 * recording via correlationId. The only place the recording path reads a payload.
 */
export function recordingKeyForEvent(event: TraceEvent): RecordingKey | null {
  if (event.direction !== "client-to-server" || event.awaitsReply !== true) return null;
  const payload = event.payload as { method?: unknown; params?: unknown } | undefined;
  if (typeof payload?.method !== "string") return null;
  const type = TYPE_BY_METHOD[payload.method];
  if (type) {
    const params = payload.params as { name?: unknown; uri?: unknown } | undefined;
    const target = type === "resource" ? params?.uri : params?.name;
    if (typeof target === "string") return { key: `${type}:${target}`, kind: "capability" };
  }
  return { key: `method:${payload.method}`, kind: "method" };
}
