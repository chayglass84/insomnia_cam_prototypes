import { utf8FromBase64 } from "../lib/encoding";

import {
  type CapabilityUi,
  UI_MIME_TYPE,
  type UiCspMeta,
  type UiPermissions,
  type UiResource,
  type UiVisibility,
} from "./types";

const VALID_VISIBILITY: ReadonlySet<string> = new Set(["model", "app"]);
const DEFAULT_VISIBILITY: UiVisibility[] = ["model", "app"];

/**
 * Parse a tool's `_meta` for the UI linkage. Nested `_meta.ui.resourceUri` is
 * canonical; the deprecated flat `_meta["ui/resourceUri"]` is tolerated on read
 * and never emitted. `resourceUri` and `visibility` are independent per spec,
 * so a tool that declares only `visibility` (no UI resource of its own) still
 * yields a `CapabilityUi` with `resourceUri` absent — `viewRequestRouter` must
 * see the restriction to enforce it. Returns undefined only when the tool
 * carries neither a valid `ui://` resource nor a `visibility` declaration.
 */
export function detectUi(meta: unknown): CapabilityUi | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  const nested = record.ui;
  let resourceUri: unknown;
  let rawVisibility: unknown;
  if (nested !== null && typeof nested === "object") {
    resourceUri = (nested as Record<string, unknown>).resourceUri;
    rawVisibility = (nested as Record<string, unknown>).visibility;
  }
  if (typeof resourceUri !== "string") resourceUri = record["ui/resourceUri"];
  const validResourceUri =
    typeof resourceUri === "string" && resourceUri.startsWith("ui://") ? resourceUri : undefined;
  if (validResourceUri === undefined && rawVisibility === undefined) return undefined;

  // The permissive default applies ONLY when the key is absent. A declared
  // `visibility` is honoured verbatim, including when filtering leaves it empty:
  // an empty (or wholly unrecognised) list is the server trying to RESTRICT the
  // tool, and widening it back to ["model","app"] would fail open on exactly the
  // malformed input this gate exists to distrust — `viewRequestRouter` reads
  // `includes("app")` to decide whether a sandboxed View may call it at all.
  const visibility: UiVisibility[] =
    rawVisibility === undefined
      ? [...DEFAULT_VISIBILITY]
      : Array.isArray(rawVisibility)
        ? rawVisibility.filter(
            (v): v is UiVisibility => typeof v === "string" && VALID_VISIBILITY.has(v),
          )
        : [];
  return { resourceUri: validResourceUri, visibility };
}

/** Render a mimeType for an error message: quoted if it's a string, stringified otherwise. */
function describeMime(mimeType: unknown): string {
  return typeof mimeType === "string" ? `"${mimeType}"` : String(mimeType);
}

/**
 * Parse one `resources/read` content entry into a UiResource. Returns an
 * `{ error }` sentence (used verbatim as an IntrospectionWarning) instead of
 * throwing — prefetch failures degrade, never fail introspection.
 */
export function parseUiResourceContent(
  uri: string,
  content: unknown,
): UiResource | { error: string } {
  if (content === null || typeof content !== "object") {
    return { error: `resource "${uri}" returned no content object` };
  }
  const record = content as Record<string, unknown>;
  if (record.mimeType !== UI_MIME_TYPE) {
    return {
      error: `resource "${uri}" has mimeType ${describeMime(record.mimeType)}, not "${UI_MIME_TYPE}"`,
    };
  }
  let html: string;
  if (typeof record.text === "string") html = record.text;
  else if (typeof record.blob === "string") {
    try {
      html = utf8FromBase64(record.blob);
    } catch {
      return { error: `resource "${uri}" blob is not valid base64` };
    }
  } else return { error: `resource "${uri}" has no text or blob content` };

  const uiMeta =
    record._meta !== null && typeof record._meta === "object"
      ? ((record._meta as Record<string, unknown>).ui as Record<string, unknown> | undefined)
      : undefined;
  const resource: UiResource = {
    html,
    byteSize: new TextEncoder().encode(html).length,
  };
  if (uiMeta !== null && typeof uiMeta === "object") {
    const csp = sanitizeCsp(uiMeta.csp);
    if (csp) resource.csp = csp;
    const permissions = sanitizePermissions(uiMeta.permissions);
    if (permissions) resource.permissions = permissions;
    if (uiMeta.prefersBorder === true) resource.prefersBorder = true;
    // Surface `_meta.ui.domain` so the controller can derive the pinned stable
    // origin (see pinnedDomain.ts and docs/app-domain-pinning.md).
    if (typeof uiMeta.domain === "string" && uiMeta.domain.length > 0) {
      resource.pinnedDomain = uiMeta.domain;
    }
  }
  return resource;
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items = v.filter((x): x is string => typeof x === "string");
  return items.length > 0 ? items : undefined;
}

function sanitizeCsp(raw: unknown): UiCspMeta | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const csp: UiCspMeta = {};
  const connect = stringArray(record.connectDomains);
  if (connect) csp.connectDomains = connect;
  const resource = stringArray(record.resourceDomains);
  if (resource) csp.resourceDomains = resource;
  const frame = stringArray(record.frameDomains);
  if (frame) csp.frameDomains = frame;
  const base = stringArray(record.baseUriDomains);
  if (base) csp.baseUriDomains = base;
  return Object.keys(csp).length > 0 ? csp : undefined;
}

function sanitizePermissions(raw: unknown): UiPermissions | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const granted: UiPermissions = {};
  for (const key of ["camera", "microphone", "geolocation", "clipboardWrite"] as const) {
    // Truthiness, not `!== undefined`: `{ camera: false }` (or `null`) is a
    // declaration DECLINING the feature, and treating it as a grant would hand
    // the sandbox a capability the server asked us not to delegate. Matches the
    // SDK's own `buildAllowAttribute`, which tests the same way.
    if (record[key]) granted[key] = {};
  }
  return Object.keys(granted).length > 0 ? granted : undefined;
}
