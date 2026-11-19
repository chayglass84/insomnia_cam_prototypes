import { HTTPStatusError } from "../errors";
import type { Routing } from "../Protocol";
import type { MessageMeta, MessageSink, SendOptions, Transport, TransportKind } from "../Transport";
import { proxyFetch } from "./proxyFetch";
import { SSEFrameParser } from "./sseParser";

export type HTTPTransportOptions = {
  /** Sink for every server→client message (parsed JSON-RPC value). */
  onMessage: MessageSink;
  /** The owning connection's routing, forwarded to every proxyFetch this transport makes. */
  routing?: Routing;
  /**
   * Called once with the response headers for every POST/GET response, before
   * the body is drained. MCP-specific concession kept off the `Transport`
   * interface: `MCPHTTPProtocol` captures `Mcp-Session-Id` here so it can
   * echo the header on subsequent sends.
   */
  onResponseHeaders?: (h: Headers) => void;
  /**
   * Supplies the headers the transport must attach to requests it initiates on
   * its own — currently the GET that opens the server-push stream. The
   * protocol returns the live `Mcp-Session-Id` / `MCP-Protocol-Version` (and any
   * auth headers) here so a stateful server binds the push stream to the
   * session. Same MCP-specific concession as `onResponseHeaders`; absent for
   * plain transports.
   */
  getHeaders?: () => Record<string, string>;
};

/**
 * The id a request payload expects its reply under. A Streamable HTTP POST
 * carries one request and its reply arrives in that POST's response, so the
 * transport may attribute a missing/malformed response body to this id — the
 * one bit of JSON-RPC shape it reads, to fail the waiter promptly instead of
 * leaving it to the protocol's request timeout. Returns undefined for
 * notifications and responses (no reply expected; a 202 is correct).
 */
function replyIdOf(payload: unknown): string | number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const env = payload as { id?: string | number; method?: unknown };
  return env.id !== undefined && typeof env.method === "string" ? env.id : undefined;
}

/** Whether `msg` is the result/error reply for `replyId` (vs a notification or a peer request). */
function isReplyFor(msg: unknown, replyId: string | number): boolean {
  if (msg === null || typeof msg !== "object") return false;
  const env = msg as { id?: string | number; result?: unknown; error?: unknown };
  // Compare ids as strings: the pending layer keys by String(id), so a server that
  // echoes the request id with a different JS type (5 vs "5") still matches here.
  return (
    env.id !== undefined &&
    String(env.id) === String(replyId) &&
    ("result" in env || "error" in env)
  );
}

function containsReplyFor(msg: unknown, replyId: string | number): boolean {
  if (Array.isArray(msg)) return msg.some((entry) => containsReplyFor(entry, replyId));
  return isReplyFor(msg, replyId);
}

/** Snapshot a fetch `Headers` into the plain record `MessageMeta` carries. */
export function headersToRecord(h: Headers): Record<string, string> {
  return Object.fromEntries(h.entries());
}

/**
 * MCP "Streamable HTTP" transport under the push Transport interface. POSTs to
 * the endpoint are dispatched via `send`; each response body (single JSON frame
 * or `text/event-stream`) drains to `onMessage` in arrival order. A standing
 * server→client GET SSE stream is opened lazily after the first POST and its
 * frames surface on the same `onMessage`.
 *
 * The transport stays JSON-RPC-naïve apart from `replyIdOf`. The protocol
 * correlates, dispatches, and routes.
 *
 * A request's reply rides its own POST response body, so the standing GET
 * push-stream carries only server-initiated traffic. The protocol opens it via
 * `openServerStream` once the handshake has negotiated the session/protocol
 * headers — opening it on the first send would send them empty. The push stream
 * ending is benign: it is not the connection (POST replies are independent, and
 * the spec lets the server close this stream at any time), so it never tears the
 * connection down — unlike legacy SSE, where the GET stream IS the connection.
 */
export class HTTPTransport implements Transport {
  readonly kind: TransportKind = "http-streamable";
  private readonly url: string;
  private readonly onMessage: MessageSink;
  private readonly onResponseHeaders?: (h: Headers) => void;
  private readonly getHeaders?: () => Record<string, string>;
  private readonly routing?: Routing;
  private readonly abort = new AbortController();
  private getStreamStarted = false;

  constructor(url: string, options: HTTPTransportOptions) {
    this.url = url;
    this.onMessage = options.onMessage;
    this.onResponseHeaders = options.onResponseHeaders;
    this.getHeaders = options.getHeaders;
    this.routing = options.routing;
  }

  async send(payload: unknown, opts: SendOptions = {}): Promise<void> {
    const combined = opts.signal
      ? AbortSignal.any([this.abort.signal, opts.signal])
      : this.abort.signal;
    // Custom headers first so protocol framing (Content-Type/Accept) wins by
    // construction; a user-supplied Accept must not strip text/event-stream.
    const headers: Record<string, string> = {
      ...opts.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const res = await proxyFetch({
      target: this.url,
      method: "POST",
      headers,
      body: payload,
      signal: combined,
      routing: this.routing,
      url: opts.proxyUrl,
    });

    this.onResponseHeaders?.(res.headers);

    if (!res.ok) {
      // 4348: keep a bounded copy of the error body + headers so the trace can show what the server said.
      const errorBody = await res.text().then(
        (t) => t.slice(0, 4096),
        () => undefined,
      );
      throw new HTTPStatusError(
        res.status,
        this.url,
        res.headers.get("WWW-Authenticate") ?? undefined,
        errorBody,
        headersToRecord(res.headers),
      );
    }

    // Drain the response body to onMessage in the background; the send Promise
    // itself resolves now (headers received, status OK). Body errors mid-drain
    // are silently dropped; the protocol's per-request timeout catches if a
    // matched reply never lands.
    void this.drainResponseBody(res, replyIdOf(payload), {
      responseHeaders: headersToRecord(res.headers),
    });
  }

  /**
   * Open the standing server→client GET push stream. Idempotent. Called by the
   * protocol after the handshake so `getHeaders()` carries the negotiated
   * session id + protocol version (opening it on the first send would send them
   * empty, which a stateful server can reject).
   */
  openServerStream(): void {
    if (this.getStreamStarted) return;
    this.getStreamStarted = true;
    void this.startGetStream();
  }

  close(): Promise<void> {
    this.abort.abort();
    return Promise.resolve();
  }

  // --- internals ---

  /**
   * Deliver one inbound message, unless the transport is closed. The abort gate
   * is the push-model equivalent of ending the old inbound queue: a frame a
   * background drain parses after `close()` (its body reader may resolve once
   * more before the abort cancels it) is dropped, never handed to the protocol.
   */
  private deliver(message: unknown, meta?: MessageMeta): void {
    if (this.abort.signal.aborted) return;
    this.onMessage(message, meta);
  }

  private async drainResponseBody(
    res: Response,
    replyId: string | number | undefined,
    meta: MessageMeta,
  ): Promise<void> {
    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream") && res.body) {
      // Pass replyId so a POST whose event-stream reply body closes without the
      // matched frame fails the waiter fast, symmetric with the JSON path below.
      await this.drainSSEStream(res.body, replyId, meta);
      return;
    }

    if (!res.body) {
      this.emitReplyError(replyId, "Server returned no response body", meta);
      return;
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      return; // body read aborted on close(); silent
    }
    if (text.length === 0) {
      // A 202/empty body is correct for a notification or response; for a
      // request it means the server answered nothing — surface immediately
      // rather than leave the waiter to time out.
      this.emitReplyError(replyId, "Server returned an empty response body", meta);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emitReplyError(replyId, "Server response was not valid JSON", meta);
      return;
    }
    if (replyId !== undefined && (parsed === null || typeof parsed !== "object")) {
      this.emitReplyError(replyId, "Server response was not a JSON-RPC message", meta);
      return;
    }
    // A JSON-RPC error the server couldn't tie to an id (`id: null`) is, for a
    // single-request POST, the reply to this request — attribute it so the
    // waiter resolves with the error instead of waiting out the timeout.
    if (
      replyId !== undefined &&
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { id?: unknown }).id == null &&
      "error" in parsed
    ) {
      this.deliver({ ...(parsed as object), id: replyId }, meta);
      return;
    }
    this.deliver(parsed, meta);
  }

  /**
   * Resolve a request's waiter with a synthetic JSON-RPC error when its
   * Streamable HTTP response body is missing or malformed. No-op for payloads
   * that expect no reply (replyId undefined) — their 202 is correct.
   */
  private emitReplyError(
    replyId: string | number | undefined,
    message: string,
    meta?: MessageMeta,
  ): void {
    if (replyId === undefined) return;
    this.deliver({ jsonrpc: "2.0", id: replyId, error: { code: -32700, message } }, meta);
  }

  private async drainSSEStream(
    body: ReadableStream<Uint8Array>,
    replyId?: string | number,
    meta?: MessageMeta,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SSEFrameParser();
    let sawReply = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          // For a POST response stream (replyId set), the stream closing without
          // ever carrying the matched reply means the server answered nothing —
          // fail the waiter fast instead of leaving it to the request timeout.
          // The standing GET stream (no replyId) ending is normal: stay silent.
          if (replyId !== undefined && !sawReply) {
            this.emitReplyError(replyId, "Server closed the response stream without a reply", meta);
          }
          return;
        }
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          let msg: unknown;
          try {
            msg = JSON.parse(frame.data);
          } catch {
            console.warn("[HTTPTransport] dropping unparseable frame");
            continue;
          }
          if (replyId !== undefined && containsReplyFor(msg, replyId)) sawReply = true;
          this.deliver(msg, meta);
        }
      }
    } catch (e) {
      // close() aborts the reader — that path is expected and stays silent. Any
      // other throw is a genuine stream failure (e.g. connection reset
      // mid-stream); surface it, since this transport has no onClose and the
      // dropped server-push channel would otherwise vanish without a trace.
      if (!this.abort.signal.aborted) {
        console.warn("[HTTPTransport] server-push stream errored", e);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  private async startGetStream(): Promise<void> {
    let res: Response;
    try {
      res = await proxyFetch({
        target: this.url,
        method: "GET",
        // The auth + session/protocol headers (via getHeaders) are required for
        // a stateful server to bind the push stream to this session — without
        // them it rejects the GET and server-initiated traffic is lost.
        headers: { ...this.getHeaders?.(), Accept: "text/event-stream" },
        signal: this.abort.signal,
        routing: this.routing,
      });
    } catch {
      // GET failed to start; not fatal — POST replies continue.
      return;
    }

    this.onResponseHeaders?.(res.headers);

    if (res.status === 405) {
      // Server-push not offered; abandon GET silently. POSTs still work.
      await res.body?.cancel();
      return;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Spec violation on the GET path. Drop the body silently.
      await res.body?.cancel();
      return;
    }
    // The server→client push stream ended on its own. For Streamable HTTP this is
    // benign and deliberately NOT treated as the connection closing: the push
    // stream is auxiliary (a request's reply rides its own POST response body),
    // and the spec lets the server close it at any time. Tearing the connection
    // down here would fail unrelated in-flight POSTs; the per-request POST timeout
    // (and a failing POST fetch if the server is truly gone) are the backstops.
    //
    // No meta: the standing stream carries only server→client notifications and
    // requests, never id-matched replies, so no trace row would consume response
    // headers stamped here (a reply always rides its own POST response body).
    await this.drainSSEStream(res.body);
  }
}
