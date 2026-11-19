import { protocolError } from "../errors";
import type { Routing } from "../Protocol";
import type {
  CloseSink,
  MessageSink,
  OpenOptions,
  SendOptions,
  Transport,
  TransportKind,
} from "../Transport";
import { proxyFetch } from "./proxyFetch";
import { SSEFrameParser } from "./sseParser";

export type SSETransportOptions = {
  /** Sink for every server→client message (parsed JSON-RPC value). */
  onMessage: MessageSink;
  /** Invoked once if the GET stream — the sole inbound channel — ends on its own. */
  onClose?: CloseSink;
  /** The owning connection's routing, forwarded to every proxyFetch this transport makes. */
  routing?: Routing;
};

/**
 * Legacy MCP "HTTP+SSE" transport (2024-11-05) under the push Transport
 * interface. One long-lived GET stream carries every server→client message and
 * surfaces it on `onMessage`; a separate POST endpoint (announced via the first
 * `endpoint` event) carries client→server messages.
 *
 *  - `send(payload)` POSTs to the announced endpoint. No reply correlation here
 *    — replies arrive on `onMessage`.
 *  - The GET stream is opened by `createSSETransport`, which resolves once the
 *    `endpoint` event arrives, so a constructed `SSETransport` is ready to send.
 *
 * Legacy SSE has no inherent session concept — closing the GET stream is the
 * teardown signal — so `close()` aborts the stream and any in-flight POSTs.
 */
export class SSETransport implements Transport {
  readonly kind: TransportKind = "http-sse";
  private readonly url: string;
  private readonly onMessage: MessageSink;
  private readonly onClose?: CloseSink;
  private readonly routing?: Routing;
  private readonly abort = new AbortController();

  private messageEndpoint: string | undefined;
  private endpointReady!: Promise<void>;
  private endpointResolve!: () => void;
  private endpointReject!: (e: unknown) => void;
  private openStarted = false;

  constructor(url: string, options: SSETransportOptions) {
    this.url = url;
    this.onMessage = options.onMessage;
    this.onClose = options.onClose;
    this.routing = options.routing;
    this.endpointReady = new Promise<void>((resolve, reject) => {
      this.endpointResolve = resolve;
      this.endpointReject = reject;
    });
    // endpointReady is awaited by open() and every send(); if it ends up
    // rejected with no awaiter yet, swallow here so it isn't an unhandled
    // rejection. Real awaiters still observe the rejection.
    this.endpointReady.catch(() => {});
  }

  /**
   * Open the GET stream and wait until the `endpoint` event arrives. Idempotent.
   * `createSSETransport` calls this before returning the transport — legacy SSE
   * has no per-call request stream, so the GET must be open before any `send()`.
   */
  async open(opts: OpenOptions = {}): Promise<void> {
    if (this.openStarted) return this.endpointReady;
    this.openStarted = true;

    const combined = opts.signal
      ? AbortSignal.any([this.abort.signal, opts.signal])
      : this.abort.signal;
    const onAbort = () =>
      this.endpointReject(
        protocolError({
          kind: "transport",
          message: "SSE stream closed before announcing a message endpoint",
          url: this.url,
        }),
      );

    let res: Response;
    try {
      res = await proxyFetch({
        target: this.url,
        method: "GET",
        headers: { ...opts.headers, Accept: "text/event-stream" },
        signal: combined,
        routing: this.routing,
      });
    } catch (e) {
      if (combined.aborted) {
        onAbort();
      } else {
        this.endpointReject(e);
      }
      return this.endpointReady;
    }

    if (!res.ok || !res.body) {
      const message =
        res.status === 410
          ? "The SSE endpoint returned 410 Gone - the server removed its legacy SSE transport. Connect to its Streamable HTTP endpoint instead."
          : `SSE stream failed (${res.status})`;
      this.endpointReject(protocolError({ kind: "transport", message, url: this.url }));
      return this.endpointReady;
    }

    // Listen on `combined` (not just the caller signal) so close() — which
    // aborts this.abort — settles endpointReady, instead of leaving open()/
    // send() awaiting it forever.
    if (combined.aborted) {
      onAbort();
    } else {
      combined.addEventListener("abort", onAbort, { once: true });
    }

    void this.pump(res.body);
    try {
      await this.endpointReady;
    } finally {
      combined.removeEventListener("abort", onAbort);
    }
  }

  async send(payload: unknown, opts: SendOptions = {}): Promise<void> {
    await this.endpointReady;
    if (!this.messageEndpoint) {
      throw protocolError({
        kind: "transport",
        message: "SSE server never announced a message endpoint",
        url: this.url,
      });
    }
    const combined = opts.signal
      ? AbortSignal.any([this.abort.signal, opts.signal])
      : this.abort.signal;
    const endpoint = new URL(this.messageEndpoint, this.url).toString();
    const res = await proxyFetch({
      target: endpoint,
      method: "POST",
      headers: { ...opts.headers, "Content-Type": "application/json" },
      body: payload,
      signal: combined,
      routing: this.routing,
    });

    if (!res.ok) {
      throw protocolError({
        kind: "transport",
        message: `POST to message endpoint failed (${res.status})`,
        url: endpoint,
      });
    }
  }

  close(): Promise<void> {
    this.abort.abort();
    return Promise.resolve();
  }

  // --- internals ---

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEFrameParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event === "endpoint") {
            let endpoint: URL;
            try {
              endpoint = new URL(frame.data, this.url);
            } catch {
              // Reject with the specific reason before aborting: close()'s
              // abort listener (on `combined`) would otherwise settle
              // endpointReady first with the generic "closed" message.
              this.endpointReject(
                protocolError({
                  kind: "transport",
                  message: "SSE server announced an invalid message endpoint",
                  url: this.url,
                }),
              );
              this.abort.abort();
              return;
            }
            if (endpoint.origin !== new URL(this.url).origin) {
              this.endpointReject(
                protocolError({
                  kind: "transport",
                  message: `SSE server announced a cross-origin message endpoint (${endpoint.origin})`,
                  url: this.url,
                }),
              );
              this.abort.abort();
              return;
            }
            this.messageEndpoint = endpoint.toString();
            this.endpointResolve();
          } else {
            let message: unknown;
            try {
              message = JSON.parse(frame.data);
            } catch {
              console.warn("[SSETransport] dropping unparseable frame");
              continue;
            }
            // Drop a frame the reader resolves after close() aborts us (the
            // push-model equivalent of the old inbound queue ending on close).
            if (!this.abort.signal.aborted) this.onMessage(message);
          }
        }
      }
    } catch (e) {
      // close() aborts the stream — that path is expected and stays silent. Any
      // other throw is a genuine failure; onClose below still notifies the
      // protocol, but the specific error would otherwise be lost, so log it.
      if (!this.abort.signal.aborted) {
        console.warn("[SSETransport] inbound stream errored", e);
      }
    } finally {
      reader.releaseLock();
      // The GET is the sole inbound channel: when it ends on its own (server
      // close), signal the protocol so it can fail in-flight requests instead
      // of parking forever. A teardown via close() aborts this.abort first, so
      // that path stays silent.
      if (!this.abort.signal.aborted) this.onClose?.();
    }
  }
}

/**
 * Open the legacy GET SSE stream and resolve once the first `endpoint` event
 * arrives (carrying the POST URL). `signal` bounds the open (the connect
 * deadline). The returned transport is ready to `send`; server→client frames
 * surface on `options.onMessage`.
 */
export async function createSSETransport(
  url: string,
  options: SSETransportOptions,
  signal?: AbortSignal,
  getRequestHeaders?: () => Record<string, string>,
): Promise<SSETransport> {
  const transport = new SSETransport(url, options);
  try {
    await transport.open({ signal, headers: getRequestHeaders ? getRequestHeaders() : undefined });
  } catch (e) {
    // open() rejects via endpointReject WITHOUT aborting the transport's own
    // controller (e.g. the connect deadline fired after the GET stream was
    // already reading). Close it so pump() stops and the GET body is released —
    // otherwise the half-built transport leaks, since the caller's assignment
    // (`mcpConnection.transport = await createSSETransport(...)`) never ran.
    await transport.close().catch(() => {});
    throw e;
  }
  return transport;
}
