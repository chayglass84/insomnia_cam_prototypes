import { HTTPStatusError, type ProtocolException } from "../../errors";

/** MCP protocol versions we accept, newest first (RC first). */
export const SUPPORTED_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** The stateless RC version — stateless HTTP, no initialize handshake, no session. */
export const STATELESS_VERSION = "2026-07-28" as const;

/** Newest version that uses the `initialize` handshake (legacy era). */
export const LATEST_LEGACY_VERSION = "2025-11-25" as const;

/** Protocol versions valid in the legacy initialize-based era. */
export const LEGACY_VERSIONS: ReadonlySet<string> = new Set(
  SUPPORTED_VERSIONS.filter((v) => v !== STATELESS_VERSION),
);

// Statuses that mean "this isn't a modern Streamable-HTTP endpoint, try the
// legacy SSE transport" — used INSIDE negotiateAndInitialize's transport
// fallback. 406 (Not Acceptable) belongs here: a strict SSE-only server returns
// it when it rejects our `Accept: application/json, text/event-stream` POST,
// which is exactly the wrong-URL case (user pasted a legacy `/sse` URL).
const SSE_TRANSPORT_FALLBACK_STATUS_SET = new Set([400, 404, 405, 406]);

// Statuses that signal a legacy server during ERA DETECTION (the auto-version
// `server/discover` probe). Per spec (Streamable HTTP Backward Compatibility)
// these are 400/404/405 with an empty/non-modern body. 406 is included because
// a strict legacy server may reject the probe's Accept or MCP headers with
// Not Acceptable before it can identify itself as modern.
const ERA_FALLBACK_STATUS_SET = new Set([400, 404, 405, 406]);

/**
 * Returns true when `e` is an HTTPStatusError (or a raw status number) that means
 * the modern Streamable-HTTP POST didn't land and we should try the legacy SSE
 * transport. Used by `negotiateAndInitialize`'s transport fallback only.
 */
export function isLegacyFallbackStatus(e: unknown): boolean {
  if (e instanceof HTTPStatusError) return SSE_TRANSPORT_FALLBACK_STATUS_SET.has(e.status);
  if (typeof e === "number") return SSE_TRANSPORT_FALLBACK_STATUS_SET.has(e);
  return false;
}

/** The `supported` version list a discover failure advertised, from either shape. */
function advertisedVersions(ex: ProtocolException): string[] {
  const err = ex.error;
  // -32004 UnsupportedProtocolVersion carries data.supported[]; our own
  // version-mismatch carries supported[] directly.
  if (err.kind === "protocol-version-mismatch") return err.supported;
  if (err.kind === "protocol-remote" && err.data && typeof err.data === "object") {
    const supported = (err.data as Record<string, unknown>).supported;
    if (Array.isArray(supported))
      return supported.filter((v): v is string => typeof v === "string");
  }
  return [];
}

/**
 * Decide whether a failed stateless `server/discover` probe should fall back to
 * the legacy `initialize` handshake (the "auto" version path). This is the single
 * negotiation policy for the era split:
 *
 * - Legacy-fallback HTTP status (400/404/405 with a non-modern body): the server
 *   has no modern MCP endpoint → fall back.
 * - `schema-parse`: a 200 whose body isn't a usable discover result (e.g. a legacy
 *   server answering the unknown `server/discover` method with `-32601`, or non-JSON)
 *   → not a stateless RC endpoint → fall back.
 * - `protocol-version-mismatch` / `-32004`: the server speaks MCP but not our
 *   stateless version. If it advertises a legacy version we support, fall back so
 *   `initialize` can negotiate it; otherwise it's a genuine unsupported-version
 *   error → surface it. (This client speaks exactly one stateless version, so
 *   "retry with another stateless version" is never possible — the only retry that
 *   can succeed is the legacy handshake.)
 *
 * Everything else (`-32003` missing client capability, CORS, network, timeout,
 * auth, target-blocked) is a real failure against a stateless server → surface it.
 */
export function shouldFallBackToLegacy(ex: ProtocolException): boolean {
  const err = ex.error;
  if (
    "status" in err &&
    typeof err.status === "number" &&
    ERA_FALLBACK_STATUS_SET.has(err.status)
  ) {
    return true;
  }
  if (err.kind === "schema-parse") return true;
  if (err.kind === "protocol-version-mismatch" || err.kind === "protocol-remote") {
    return advertisedVersions(ex).some((v) => LEGACY_VERSIONS.has(v));
  }
  return false;
}
