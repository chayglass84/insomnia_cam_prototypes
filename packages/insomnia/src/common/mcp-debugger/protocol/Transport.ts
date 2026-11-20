/**
 * Low-level wire abstraction. A bidirectional message channel — knows about
 * HTTP/SSE/WebSocket/stdio framing; does NOT know about JSON-RPC, MCP, A2A,
 * or any protocol-layer correlation. The protocol layer dispatches outbound
 * messages via `send`; inbound messages are delivered to the `onMessage` sink
 * supplied when the transport is constructed. Reply correlation lives entirely
 * in the protocol layer.
 *
 * Adding a new transport (WebSocket, stdio, gRPC, …) means implementing
 * `send` / `close` and pushing inbound frames to `onMessage`. A wire that needs
 * a connect-time handshake before the first send (legacy SSE awaits its
 * `endpoint` event) does that in an async factory, so the constructed transport
 * is always ready to use. Nothing protocol-specific touches this interface.
 */

/**
 * Closed set of supported transports. Widening this union is a deliberate
 * contract change, gated by the change-control rule in the README.
 */
export type TransportKind = "http-streamable" | "http-sse" | "websocket";

export type SendOptions = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Alternate endpoint to send this message to, for transports that proxy
   * requests through a backend relay (e.g. HTTP transports routing through a
   * server-side proxy). Opaque to the transport as to why a caller chose a
   * different endpoint — falls back to the transport's default when unset.
   */
  proxyUrl?: string;
};

export type OpenOptions = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

/**
 * Transport-level metadata delivered alongside an inbound message. HTTP
 * transports attach the headers of the HTTP response the message arrived on;
 * transports with no per-message response metadata (stdio, WebSocket, legacy
 * SSE) omit it.
 */
export type MessageMeta = { responseHeaders?: Record<string, string>; /** HTTP status of the response this message arrived on. */ status?: number };

/** Called once per server→client message (a parsed JSON-RPC value). */
export type MessageSink = (message: unknown, meta?: MessageMeta) => void;

/**
 * Called at most once when the transport's standing inbound stream ends on its
 * own (the server closed the wire), NOT in response to `close()`. Lets the
 * protocol fail in-flight requests fast instead of waiting out their timeouts.
 * Supplied alongside `onMessage` at construction; transports with no standing
 * server→client stream never invoke it.
 */
export type CloseSink = () => void;

export interface Transport {
  readonly kind: TransportKind;

  /**
   * Send one outbound message to the peer. Resolves once the transport has
   * dispatched it to the wire (HTTP: 2xx response headers received). There is
   * no reply correlation here — replies surface on the `onMessage` sink given
   * at construction, never as this Promise's value. Rejects with a
   * status-bearing error on a non-OK response or a network failure.
   */
  send(message: unknown, opts?: SendOptions): Promise<void>;

  /**
   * Tear down any in-flight wire activity: abort pending sends, close SSE
   * streams, release resources. Idempotent. No further `onMessage` calls fire
   * after `close()`.
   */
  close(): Promise<void>;

  /**
   * Open the standing server→client push stream, for transports that have one
   * and need it opened after a connect-time handshake (Streamable HTTP's GET,
   * once the session/protocol headers are known). Idempotent. Absent on
   * transports whose inbound stream opens at construction (legacy SSE).
   */
  openServerStream?(): void;
}
