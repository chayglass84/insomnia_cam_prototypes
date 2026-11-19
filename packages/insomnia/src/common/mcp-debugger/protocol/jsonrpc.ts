/**
 * Protocol-generic JSON-RPC 2.0 primitives. Knows the envelope shape and
 * request/reply correlation; knows nothing about MCP (or A2A) method names,
 * capabilities, or transports — hence `protocol/`, not `protocol/mcp/`. Reused
 * by any JSON-RPC-over-transport protocol layered on the push `Transport`.
 */

import type { MessageMeta } from "./Transport";

/**
 * A permissive JSON-RPC 2.0 envelope: requests, notifications, and replies all
 * fit this one shape, so a single guard/dispatch handles every inbound frame.
 * Every field is optional because which ones are present is what distinguishes
 * the message kinds (id+method = request, method only = notification,
 * id+result/error = reply).
 */
export type JsonRpcEnvelope = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/** Coarse structural guard: any non-null object can be read as an envelope. */
export function isJsonRpcLike(v: unknown): v is JsonRpcEnvelope {
  return v !== null && typeof v === "object";
}

/** Strict JSON-RPC 2.0 shape check (the `jsonrpc: "2.0"` marker plus valid request/notification/reply fields), rejecting anything `isJsonRpcLike` would loosely accept. */
export function isWellFormedJsonRpcMessage(v: unknown): v is JsonRpcEnvelope {
  if (v === null || typeof v !== "object") return false;
  const env = v as {
    jsonrpc?: unknown;
    method?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (env.jsonrpc !== "2.0") return false;
  const idIsValid =
    env.id === undefined ||
    env.id === null ||
    typeof env.id === "string" ||
    typeof env.id === "number";
  if (!idIsValid) return false;
  if (typeof env.method === "string") return true;
  const hasId = typeof env.id === "string" || typeof env.id === "number";
  if (!hasId) return false;
  return "result" in env || (typeof env.error === "object" && env.error !== null);
}

/**
 * Monotonic request-id source. `start` is the first id handed out; callers that
 * reserve a fixed id for a handshake pass the next free value (MCP's legacy
 * `initialize` takes id 1, so it starts operations at 2).
 */
export function createIdGenerator(start = 1): () => number {
  let next = start;
  return () => next++;
}

/** One outstanding request awaiting its id-matched reply. */
export type Pending = {
  resolve: (v: JsonRpcEnvelope, meta?: MessageMeta) => void;
  reject: (e: unknown) => void;
};

/**
 * Correlation table for in-flight JSON-RPC requests, keyed by stringified id.
 * A request `register`s a waiter before it goes on the wire; the inbound path
 * `settle`s it when the id-matched reply lands. `rejectAll` fails every waiter
 * at once on disconnect or wire-end.
 */
export class PendingRequests {
  private readonly waiters = new Map<string, Pending>();

  register(id: number, waiter: Pending): void {
    this.waiters.set(String(id), waiter);
  }

  /** Drop a waiter without settling it (its caller rejects on the abort/send-failure path). */
  delete(id: number): boolean {
    return this.waiters.delete(String(id));
  }

  /**
   * Resolve the waiter matching `envelope.id` and remove it. Returns false when
   * no waiter is registered for that id (a late, duplicate, or unsolicited reply).
   */
  settle(envelope: JsonRpcEnvelope, meta?: MessageMeta): boolean {
    const waiter = this.waiters.get(String(envelope.id));
    if (!waiter) return false;
    this.waiters.delete(String(envelope.id));
    waiter.resolve(envelope, meta);
    return true;
  }

  /** Reject and clear every outstanding waiter (client disconnect or wire-end). */
  rejectAll(error: unknown): void {
    for (const waiter of this.waiters.values()) waiter.reject(error);
    this.waiters.clear();
  }
}
