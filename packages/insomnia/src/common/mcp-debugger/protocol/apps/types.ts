/**
 * Minimal local types for the MCP Apps extension subset Ardi implements
 * (SEP-1865, spec version 2026-01-26). Deliberately NOT the full SDK surface —
 * only what the host reads/writes. Protocol-agnostic naming: consumers see
 * "ui"/"app", never "mcp".
 */

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const UI_MIME_TYPE = "text/html;profile=mcp-app";
/** The extension dialect version Ardi speaks (ui/initialize protocolVersion). */
export const UI_PROTOCOL_VERSION = "2026-01-26";
/**
 * Inner-iframe sandbox tokens for a PINNED session: `allow-same-origin` makes
 * the srcdoc View inherit the proxy page's (pinned) origin — real storage and
 * a real `Origin` header, the point of `_meta.ui.domain`. Sent by the host in
 * `sandbox-resource-ready` alongside `pinned: true`; the proxy only honors
 * `allow-same-origin` when that flag rides the same origin-checked message.
 */
export const PINNED_INNER_SANDBOX = "allow-scripts allow-same-origin";

/** View → host requests the host handles (or declines). */
export const UI_METHODS = {
  initialize: "ui/initialize",
  openLink: "ui/open-link",
  message: "ui/message",
  updateModelContext: "ui/update-model-context",
  requestDisplayMode: "ui/request-display-mode",
  resourceTeardown: "ui/resource-teardown",
  downloadFile: "ui/download-file",
} as const;

export const UI_NOTIFICATIONS = {
  initialized: "ui/notifications/initialized",
  toolInput: "ui/notifications/tool-input",
  toolResult: "ui/notifications/tool-result",
  toolCancelled: "ui/notifications/tool-cancelled",
  sizeChanged: "ui/notifications/size-changed",
  hostContextChanged: "ui/notifications/host-context-changed",
  requestTeardown: "ui/notifications/request-teardown",
  sandboxProxyReady: "ui/notifications/sandbox-proxy-ready",
  sandboxResourceReady: "ui/notifications/sandbox-resource-ready",
  /** Proxy signal that the inner View self-navigated (nav-death); host tears down. */
  sandboxResourceNavigated: "ui/notifications/sandbox-resource-navigated",
  /** Standard MCP logging notification, surfaced as an app log line. */
  logMessage: "notifications/message",
} as const;

export type UiVisibility = "model" | "app";

/**
 * The tool→UI linkage detected from `_meta.ui`. `resourceUri` and `visibility`
 * are independent per spec — a tool can declare `visibility` to restrict
 * app-callability without carrying a UI resource at all — so `resourceUri` is
 * absent whenever the tool has no (valid) `ui://` resource.
 */
export interface CapabilityUi {
  resourceUri?: string;
  visibility: UiVisibility[];
}

/** `_meta.ui.csp` on the resource. Field names are camelCase per spec. */
export interface UiCspMeta {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/** `_meta.ui.permissions`: presence of a key requests that permission. */
export interface UiPermissions {
  camera?: object;
  microphone?: object;
  geolocation?: object;
  clipboardWrite?: object;
}

/**
 * A validated ui:// resource, fetched lazily on first render attempt (never
 * eagerly on tools/list, and never auto-rendered). Carries no `uri` of its
 * own: consumers always reach a resource through the uri-keyed map in the
 * app view store's `resourcesByConnection`.
 */
export interface UiResource {
  html: string;
  byteSize: number;
  csp?: UiCspMeta;
  permissions?: UiPermissions;
  prefersBorder?: boolean;
  /**
   * `_meta.ui.domain`: the server opts into a STABLE sandbox origin (the
   * spec's exception to the ephemeral per-session default — for apps whose
   * OAuth redirect URIs / CORS / API-key allowlists need a fixed origin).
   * Honored via the bound-hash derivation in `pinnedDomain.ts`; see
   * docs/app-domain-pinning.md for the host-specific format.
   */
  pinnedDomain?: string;
}
