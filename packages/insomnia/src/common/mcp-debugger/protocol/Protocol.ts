import type { CapabilityUi } from "./apps/types";
import type { TraceEvent, TraceSink } from "./TraceEvent";

/**
 * Closed set of supported protocols. Widening this union is a deliberate
 * contract change, gated by the change-control rule in the README.
 */
export type ProtocolId = "mcp-http" | "mcp-stdio";

export const AUTH_MODES = {
  none: "No auth",
  basic: "Basic auth",
  bearer: "Bearer token",
  apiKey: "API key",
  oauth: "OAuth 2.1",
} as const;

export type AuthMode = keyof typeof AUTH_MODES;

/**
 * Transient auth credentials. HTTP-shaped - it pairs with `AuthMode`, not with
 * any one protocol and is never persisted.
 * It rides on the connect config and is dropped after the handshake.
 */
export interface Credentials {
  token?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
}

/** The blank form/reset state for every auth mode — what the credential forms start from and reset to. */
export const EMPTY_CREDENTIALS: Credentials = { token: "", username: "", password: "", apiKey: "" };

/**
 * Whether `credentials` carries what `authMode` needs to authenticate - i.e. whether
 * a connect attempt would actually send credentials. The connection form and
 * reconnect dialog gate "submit" on this so a mode is never sent empty.
 */
export function hasCredentialsFor(authMode: AuthMode, credentials: Credentials): boolean {
  switch (authMode) {
    case "none":
      return true;
    case "bearer":
      return (credentials.token ?? "").trim() !== "";
    case "basic":
      // Username only: RFC 7617 allows an empty password, so we don't require one.
      return (credentials.username ?? "").trim() !== "";
    case "apiKey":
      return (credentials.apiKey ?? "").trim() !== "";
    case "oauth":
      // OAuth does not require credentials at connect time — the flow runs
      // asynchronously; submit is always allowed when mode is oauth.
      return true;
    default:
      return false;
  }
}

/**
 * Transient inputs needed to establish a connection: the secret credential bag
 * plus any user-supplied custom headers. Never persisted - dropped after the
 * handshake, exactly like Credentials. Custom headers may or may not be secret,
 * so they live here rather than inside Credentials.
 */
export interface ConnectInputs {
  credentials?: Credentials;
  customHeaders?: Record<string, string>;
  /**
   * Transient relay handshake token (Local connections only). Consumed by the relay socket
   * opener to build the handshake URL, then dropped. Never persisted, logged, or telemetered.
   */
  relayToken?: string;
  /**
   * The relay WebSocket base (`ws://127.0.0.1:<port>`) for relay-proxied connections, whose
   * `options.url` is the remote MCP server rather than the relay. Transient like the token —
   * a reconnect re-pastes the relay's Connect line. Absent for stdio (where `options.url` IS
   * the relay) and hosted connections.
   */
  relayWsBase?: string;
}

/** How a connection reaches its server. Hosted is the default */
export type Routing = "hosted" | "relay";

export interface ConnectionOptions {
  url: string;
  authMode: AuthMode;
  /** Hosted (default) routes via the hosted proxy; relay routes via the local relay WebSocket. */
  routing?: Routing;
  /**
   * Selects the stepped (breakpoint-paused) OAuth connect flow instead of the
   * normal redirect-and-continue path. Absent/false = existing behavior.
   */
  oauthDebug?: boolean;
}

/**
 * What `connect` receives: connection options plus a live auth header getter.
 * The getter is called each time headers are needed — OAuth tokens can change
 * mid-session (refresh), so a snapshot at connect time would go stale.
 * For static auth modes (bearer, basic, apiKey) the getter returns the same
 * headers every call; for `none` it returns `{}`.
 * Optional in tests — protocols default to `() => ({})` when omitted.
 */
export interface ConnectConfig extends ConnectionOptions {
  getRequestHeaders?: () => Record<string, string>;
  /** Transient relay handshake token; present only for relay-routed connects. */
  relayToken?: string;
}

/**
 * Opaque handle returned by `connect`. Carries whatever state the
 * protocol needs to invoke and disconnect; consumers treat it as a token.
 *
 * `__brand` makes `Connection` nominally distinct from a plain record so
 * an unrelated object can't satisfy the type by accident. Implementations
 * extend this with their own fields.
 */
export type Connection = {
  readonly __brand: "Connection";
  readonly protocolId: ProtocolId;
  transportLabel?: string;
  /**
   * The protocol version negotiated for this session, or undefined before/without
   * negotiation. Protocol-agnostic like `transportLabel`: each protocol fills its own
   * (MCP from the initialize/discover handshake; A2A next). Read off the base
   * Connection by the agent-prompt source, so no consumer special-cases a protocol.
   */
  protocolVersion?: string;
  /**
   * The name the server advertised for itself at connect, or undefined before/without
   * a handshake or when the server advertised none. Protocol-agnostic like
   * `protocolVersion`: each protocol fills its own (MCP from the initialize/discover
   * handshake's serverInfo.name; A2A next). Read off the base Connection by the
   * connection store, which prefers it over the URL-derived name.
   */
  serverName?: string;
  /**
   * A ready-to-render `src` for the icon the server advertised for itself at connect, or undefined
   * when it advertised none this client can draw. Protocol-agnostic like `serverName`: each
   * protocol fills its own (MCP from the handshake's `serverInfo.icons`; A2A next). Already
   * filtered to something an `<img>` can load under this app's CSP — see `mcp/serverIcon.ts`.
   */
  serverIcon?: string;
};

/**
 * A single remote operation. Protocol-agnostic: implementations
 * interpret `method` and `params` per their wire format.
 */
export type Invocation = {
  method: string;
  params?: unknown;
  /**
   * When set, the protocol traces this call's events under this existing correlationId instead of
   * minting a fresh one, so a resubmission (e.g. an MCP elicitation answer) threads under the
   * originating call's one pending row rather than opening a new one. The wire id is still fresh;
   * only the trace correlationId is reused. Protocol-agnostic: what the resubmission carries on the
   * wire (e.g. the elicitation answers) lives in `params`.
   */
  correlationId?: string;
};

/**
 * Minimal structural JSON Schema. We read only what the request builder needs;
 * unknown keywords pass through via the index signature. No dependency.
 */
export type JSONSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  [keyword: string]: unknown;
};

export type CapabilityType = "tool" | "resource" | "prompt";

/**
 * One entry in the capability registry. `schema` is the input JSON Schema or
 * `null` when the server gave none or gave an unusable one (the builder then
 * renders a free-form JSON input).
 */
export interface Capability {
  id: string;
  type: CapabilityType;
  schema: JSONSchema | null;
  rendererKey: string;
  /**
   * The rendered-surface linkage (MCP Apps / SEP-1865 and successors): the
   * ui:// resource visualizing this capability plus its visibility. Present
   * only when the server attached `_meta.ui` to this tool during introspection
   * — absence means "no app affordances", so the UI never needs a separate
   * supported flag.
   */
  ui?: CapabilityUi;
  metadata: {
    name: string;
    description?: string;
    [key: string]: unknown;
  };
}

export type CapabilityList = Capability[];

/** A non-fatal problem found during introspection; surfaced in the UI later. */
export interface IntrospectionWarning {
  capabilityId?: string;
  method?: string;
  message: string;
}

export interface IntrospectionResult {
  capabilities: CapabilityList;
  warnings: IntrospectionWarning[];
}

/**
 * Identity of the recording a trace event belongs to. `kind: "capability"` keys
 * get their own group in the Calls view; `kind: "method"` is a fallback identity
 * for non-capability client requests (initialize, list calls) so replay/runs
 * still work for them — the view shows those in the per-server Session bucket.
 */
export interface RecordingKey {
  key: string;
  kind: "capability" | "method";
}

/**
 * Lifecycle: `connect` → (`introspect` | `invoke`)* → `disconnect`.
 * All three emit `TraceEvent`s through the same `onTrace` sink, so
 * request/response, streamed notifications, and long-running tasks share one
 * shape. `invoke` emits a request event before the call and one
 * response|error event after it resolves.
 */
export interface Protocol<Config = unknown> {
  readonly id: ProtocolId;

  connect(config: Config, signal?: AbortSignal, onTrace?: TraceSink): Promise<Connection>;

  introspect(
    connection: Connection,
    signal?: AbortSignal,
    onTrace?: TraceSink,
  ): Promise<IntrospectionResult>;

  /**
   * Send `invocation` and trace its request/response. When `invocation.correlationId` is set the
   * call is a continuation (e.g. an MCP elicitation answer): its events thread under that existing
   * id so a multi-round exchange stays one pending row, settling only on a terminal result.
   */
  invoke(
    connection: Connection,
    invocation: Invocation,
    signal?: AbortSignal,
    onTrace?: TraceSink,
  ): Promise<void>;

  /**
   * Send one raw invocation and RESOLVE its result (unlike `invoke`, which
   * reports only through the trace). Built for relaying View-initiated calls
   * (MCP Apps): the caller must return the outcome to the requesting peer.
   * Traces exactly like `invoke`. Optional: protocols without a relay use case
   * (future A2A) may omit it. Throws ProtocolException on JSON-RPC error
   * (carrying code/message/data) and on transport failure.
   */
  relayCall?(
    connection: Connection,
    invocation: Invocation,
    signal?: AbortSignal,
    onTrace?: TraceSink,
  ): Promise<unknown>;

  /**
   * Cancel an in-flight request by its trace `correlationId`. Best-effort and
   * idempotent: a no-op if the request already settled or is not cancellable.
   * The correlationId is the protocol-agnostic key the Trace UI holds; each
   * implementation maps it to its own request identity (MCP parses the numeric
   * JSON-RPC id) and notifies the peer per its wire format (MCP sends
   * `notifications/cancelled`).
   */
  cancel(connection: Connection, correlationId: string, reason: string): void;

  disconnect(connection: Connection, onTrace?: TraceSink): Promise<void>;

  /**
   * Map a selected capability plus user-supplied arguments to a wire
   * `Invocation`. Protocol-specific (MCP uses `tools/call`; A2A will differ),
   * so it lives behind this interface rather than in the UI.
   */
  buildInvocation(capability: Capability, args: Record<string, unknown>): Invocation;

  /**
   * Stable identity key for a capability — the same string
   * `recordingKeyForEvent` mints for that capability's invocations, so the
   * sidebar filter and the trace recordings agree.
   */
  capabilityKey(capability: Capability): string;

  /**
   * The recording this event's request opens, or null when the event is not a
   * client-to-server request (responses/notifications join a recording via
   * their correlationId instead).
   */
  recordingKeyForEvent(event: TraceEvent): RecordingKey | null;
}
