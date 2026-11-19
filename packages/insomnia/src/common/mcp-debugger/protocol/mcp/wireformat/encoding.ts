import { base64Utf8 } from "../../lib/encoding";

import type { JSONSchema } from "../../Protocol";

/**
 * Wire-format value encoding for the 2026-07-28 RC `x-mcp-header` mirroring.
 * Pure functions with no connection or era knowledge: given values and schema,
 * produce header-safe strings and the param→header-name map.
 */

/**
 * Safe plain-text header value per spec Value Encoding: visible ASCII (plus
 * internal space/tab), no leading or trailing whitespace, not matching the
 * sentinel pattern. Strings outside this shape must be base64-encoded.
 */
const SAFE_HEADER_VALUE_RE = /^[\x21-\x7E]([\t\x20-\x7E]*[\x21-\x7E])?$|^[\x21-\x7E]$/;

/**
 * Sentinel prefix/suffix for base64-encoded Mcp-Param-* values (spec Value Encoding).
 * A plain-ASCII value that already matches this pattern must also be encoded to
 * avoid ambiguity.
 */
const BASE64_SENTINEL_RE = /^=\?base64\?.*\?=$/;

function toBase64Encoded(s: string): string {
  return `=?base64?${base64Utf8(s)}?=`;
}

/**
 * Encode one param value as an `Mcp-Param-{Name}` header value per the
 * 2026-07-28 RC spec:
 * - string: plain ASCII if safe; base64-encoded otherwise (non-ASCII, control
 *   chars, leading/trailing whitespace, or matching the sentinel pattern)
 * - boolean: "true" or "false"
 * - integer (number): decimal string, truncated to integer
 * - null/undefined: header omitted (caller should skip)
 *
 * Returns `undefined` when the value should be omitted (null, undefined, or
 * a type that can't be encoded as a header).
 */
export function encodeMcpParamHeader(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    // Empty string is safe as-is; the sentinel check is N/A.
    if (value === "") return value;
    if (!SAFE_HEADER_VALUE_RE.test(value) || BASE64_SENTINEL_RE.test(value)) {
      return toBase64Encoded(value);
    }
    return value;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    // Spec MUST: integer values must be within JavaScript safe range. A non-safe
    // or non-integer number would produce a header that mismatches the body value
    // and cause a server-side -32001 HeaderMismatch — omit instead.
    if (!Number.isSafeInteger(value)) return undefined;
    return String(value);
  }
  return undefined;
}

/**
 * Resolve a dot-path (e.g. "address.city") into a nested args object. Only reads
 * own enumerable properties of plain objects: an array or non-object intermediate
 * yields undefined, so a path segment like "length" can't leak a builtin (e.g.
 * Array.prototype.length) into a header the user never set.
 */
function resolvePath(args: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = args;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Build the `Mcp-Param-{Name}` header map for an invocation. `xcMcpHeaders`
 * maps dot-path param keys to header name values (extracted at introspection
 * time by `extractXMcpHeaders`). `args` is the user-supplied argument map.
 * Params with no annotation or unencodable values are silently omitted.
 */
export function buildMcpParamHeaders(
  xcMcpHeaders: Record<string, string>,
  args: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [paramPath, headerName] of Object.entries(xcMcpHeaders)) {
    const encoded = encodeMcpParamHeader(resolvePath(args, paramPath));
    if (encoded !== undefined) result[`Mcp-Param-${headerName}`] = encoded;
  }
  return result;
}

/**
 * RFC9110 token character set: any visible ASCII except delimiters.
 * Used to validate x-mcp-header header name values.
 */
const RFC9110_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const MAX_SCHEMA_DEPTH = 32;

/** The primitive JSON Schema types an x-mcp-header param may carry (spec: number forbidden). */
const HEADER_PARAM_TYPES = new Set(["string", "integer", "boolean"]);

/** Outcome of validating one tool's x-mcp-header annotations. */
export type XMcpHeaderExtraction = {
  /** param dot-path → header name, for the params that passed validation. */
  headers: Record<string, string>;
  /**
   * Count of annotations that VIOLATED the spec (bad name, wrong type, collision).
   * Non-zero means the tool MUST be excluded from tools/list. A schema deeper than
   * MAX_SCHEMA_DEPTH is a traversal *diagnostic*, not a violation, so it does not
   * count here — the tool stays usable.
   */
  violations: number;
};

/**
 * Validate and extract the x-mcp-header param→headerName map from a tool's
 * inputSchema (2026-07-28 RC client MUST). Recurses into nested object
 * properties; keys in the returned map are dot-paths (e.g. "address.city").
 *
 * Each annotation is checked against the spec rules below; a failure calls `warn`
 * and increments `violations` (the caller excludes the tool). Exceeding
 * MAX_SCHEMA_DEPTH warns but does NOT count as a violation — it only stops
 * traversal, leaving the otherwise-valid tool usable.
 *
 * Conformance rules from the spec:
 * - Type MUST be a primitive: string, integer, or boolean (number forbidden).
 * - Header name MUST be a non-empty RFC9110 token.
 * - Header names MUST be case-insensitively unique across the tool.
 * - MAY appear at any nesting depth within the inputSchema.
 */
export function extractXMcpHeaders(
  schema: JSONSchema | null,
  toolId: string,
  warn: (message: string) => void,
): XMcpHeaderExtraction {
  const headers: Record<string, string> = {};
  const seenLower = new Set<string>();
  let violations = 0;

  // Record a spec violation: warn, count it, and signal the caller to skip this param.
  const violation = (path: string, detail: string): true => {
    warn(`Tool "${toolId}" param "${path}": ${detail}; skipping`);
    violations++;
    return true;
  };

  function walk(properties: JSONSchema["properties"], pathPrefix: string, depth: number): void {
    if (!properties) return;
    if (depth > MAX_SCHEMA_DEPTH) {
      // A diagnostic, not a violation: deep schemas are unusual but legal, so we
      // stop descending without excluding the tool.
      warn(
        `Tool "${toolId}": schema nesting exceeds ${MAX_SCHEMA_DEPTH} levels; stopping traversal`,
      );
      return;
    }
    for (const [propName, propSchema] of Object.entries(properties)) {
      const path = pathPrefix ? `${pathPrefix}.${propName}` : propName;
      validateAnnotation(propSchema["x-mcp-header"], propSchema.type, path);

      // Recurse into nested object properties regardless of annotation presence.
      if (propSchema.type === "object" && propSchema.properties) {
        walk(propSchema.properties, path, depth + 1);
      }
    }
  }

  // Validate one property's x-mcp-header annotation as a flat sequence of guards,
  // each of which records a violation and bails. The param is only accepted when
  // every rule passes.
  function validateAnnotation(annotation: unknown, schemaType: unknown, path: string): void {
    if (annotation === undefined) return;
    if (typeof annotation !== "string" || annotation.length === 0) {
      violation(path, "x-mcp-header must be a non-empty string");
      return;
    }
    if (!RFC9110_TOKEN_RE.test(annotation)) {
      violation(path, `x-mcp-header "${annotation}" is not a valid RFC9110 token`);
      return;
    }
    // Allowlist the permitted primitive types: this rejects "number", "object",
    // "array", a union like ["number","null"], and a missing/absent type — all of
    // which the spec disallows for a header-mirrored param.
    if (typeof schemaType !== "string" || !HEADER_PARAM_TYPES.has(schemaType)) {
      const shown = typeof schemaType === "string" ? schemaType : JSON.stringify(schemaType);
      violation(path, `x-mcp-header requires a string/integer/boolean type, not ${shown}`);
      return;
    }
    const lower = annotation.toLowerCase();
    if (seenLower.has(lower)) {
      violation(
        path,
        `x-mcp-header "${annotation}" collides case-insensitively with another param`,
      );
      return;
    }
    seenLower.add(lower);
    headers[path] = annotation;
  }

  walk(schema?.properties, "", 0);
  return { headers, violations };
}
