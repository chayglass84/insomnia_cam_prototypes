/**
 * The lifecycle status of a traced interaction, as the Trace UI renders it.
 * Protocol-agnostic: every protocol resolves a request to one of these, so the
 * trace store and views never switch on a protocol's own message vocabulary.
 */
export type TraceStatus = "pending" | "success" | "error" | "cancelled" | "no-response";

/**
 * A single observed interaction on a Protocol connection.
 *
 * The Trace UI dispatches to renderers keyed off `rendererKey`. The shape
 * is deliberately protocol-agnostic: a renderer should never need to
 * special-case the underlying transport or protocol version.
 */
export type TraceEvent = {
  /** Unique per event. */
  id: string;

  /**
   * Monotonic, assigned at append time. Disambiguates events that share
   * a millisecond timestamp; UI sorts on `sequence`, not `timestamp`.
   */
  sequence: number;

  /**
   * Ties a request to its response(s). Multiple events may share a
   * correlationId — one request can produce streamed notifications plus
   * a terminal response.
   */
  correlationId: string;

  /** Stable protocol identifier (mirrors `ProtocolId`). */
  protocol: string;

  direction: "client-to-server" | "server-to-client" | "internal";

  /**
   * Protocol-defined category. Renderers dispatch on `rendererKey`, not
   * this — switching on `messageType` directly leaks protocol assumptions.
   */
  messageType: string;

  /** ISO 8601 UTC. */
  timestamp: string;

  /** Raw protocol message. `unknown` — the matching renderer narrows it. */
  payload: unknown;

  /**
   * Dispatch key for the renderer registry. Conventionally
   * `"<protocol>:<messageType>"`; finer-grained keys are allowed when a
   * single messageType has visually distinct subtypes.
   */
  rendererKey: string;

  /**
   * The status this event settles a matching pending request to, or `undefined`
   * if it is not a terminal outcome. Set by the protocol that mints the event,
   * so the protocol-neutral trace store/engine never has to know which of a
   * protocol's message categories are terminal.
   */
  terminalStatus?: TraceStatus;

  /**
   * True for a request awaiting a reply — the event whose own row shows
   * `pending` until a later `terminalStatus` event settles it. Lets the store
   * decide pending-ness without inspecting `messageType`.
   */
  awaitsReply?: boolean;

  /**
   * True when the user may cancel this in-flight request. The protocol decides
   * (MCP: capability invocations), so the Trace UI shows a Cancel affordance off
   * this flag instead of reaching into protocol-specific method names.
   */
  cancellable?: boolean;

  /**
   * Human-readable row label (e.g. `tools/call · search`). Minted by the protocol
   * from its own message shape, so the Trace UI never reads protocol-specific
   * payload fields to label a row. Absent → the UI falls back to `messageType`.
   */
  label?: string;

  /**
   * The HTTP request headers this outbound request was dispatched with.
   * Operation rows (invoke/introspect) carry the record that was sent on the
   * wire (user-configured + auth + protocol headers like Mcp-Session-Id);
   * connect/handshake rows carry the user-configured set only, since protocol
   * headers aren't known until the handshake resolves. Credential values
   * (Authorization, X-API-Key, …) are redacted at capture — before the event
   * exists — so no secret ever enters the trace store (see
   * mcp/traceEvents.ts's CREDENTIAL_HEADER_NAMES). Live views render the
   * surviving values verbatim; share sanitization redacts every value (names
   * survive). Absent for transports that carry no request headers (stdio) and
   * for requests that carried none.
   */
  requestHeaders?: Record<string, string>;

  /**
   * The headers of the HTTP response this inbound reply arrived on. Same
   * capture-time and redact-on-share rules as `requestHeaders`. Absent for
   * transports with no per-message response metadata. Values are the headers the browser
   * received through the app's proxy/relay path, which may add or strip
   * headers relative to the origin server.
   */
  responseHeaders?: Record<string, string>;

  /**
   * Marks this event as View-initiated — "app-sourced" — rather than minted
   * directly by the connection's own protocol: an `app:*` milestone from
   * `appTraceEvents`, or a relayed protocol event (e.g. a `tools/call` the
   * rendered app triggered) tagged by `decorateAppSink`. Absent for every
   * ordinary protocol event. Kept protocol-neutral (not "mcp") since A2A apps
   * will reuse the same flag.
   */
  source?: "app";

  /**
   * Threads this event's call under another call: the one whose own
   * `correlationId` equals this value. The Calls view nests this call inside
   * that parent regardless of this event's own `correlationId`. Set by whatever
   * mints a call on another call's behalf — today MCP Apps' `decorateAppSink`,
   * tagging the protocol calls a rendered app relayed through its render
   * session. Absent on ordinary top-level calls, and on the parent's own
   * events (a parent link to itself would be circular).
   */
  parentCorrelationId?: string;

  /**
   * 4348 (S3): set on events from a cross-version replay: the protocol version that call was sent over, which differs
   * from the session's own. The call's correlationId is namespaced `xv-<version>-<id>` so it can't collide.
   */
  via?: string;

  /**
   * 4348 (S5): set on events minted by a sign-in flow rather than by the MCP connection itself (today only `"oauth"`:
   * discovery, registration, the browser redirect, token and refresh calls). The Trace UI marks them with a chip and does
   * not offer MCP-only actions (edit & replay, Copy cURL) on them.
   */
  flow?: "oauth";
};

/**
 * Receives trace events emitted by a protocol - the `connect` handshake,
 * `introspect` list calls, and `invoke` request/response. The single mechanism
 * all three lifecycle methods use to surface events.
 */
export type TraceSink = (event: TraceEvent) => void;
