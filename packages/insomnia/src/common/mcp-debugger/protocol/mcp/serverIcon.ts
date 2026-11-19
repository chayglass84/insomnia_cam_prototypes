/**
 * Picking a renderable server icon out of an MCP `serverInfo.icons` array.
 *
 * MCP (2025-11-25, `Implementation extends Icons`) lets a server advertise
 * `icons: { src, mimeType?, sizes?, theme? }[]`, where `src` may be an HTTP(S) URL or a `data:`
 * URI. This app can only render the second kind: the deployed CSP is `img-src 'self' data:`
 * (see firebase.template.json), so a remote `src` would render as a broken image rather than an
 * icon. That restriction also happens to satisfy the spec's own advice that consumers keep icon
 * URLs to trusted origins, and it preserves the invariant that the browser never talks to an MCP
 * server directly (AGENTS.md) — an `<img>` pointing at the server would be exactly that request.
 */

/**
 * Cap on an accepted `src`, in string length — UTF-16 code units, not decoded bytes (a
 * percent-encoded SVG packs ~3 chars per byte; resident memory is ~2 bytes per unit). This
 * bounds what the `Connection` retains and every sidebar row renders; the raw handshake,
 * uncapped `icons` array included, still lands in its trace event regardless.
 */
const MAX_ICON_CHARS = 256 * 1024;

/** `data:` URIs for image types only — never `data:text/html`, which is not an icon.
 *  The trailing `[;,]` is both separators RFC 2397 allows after the media type: `;` when
 *  parameters follow (`;base64,`) and `,` when the data starts immediately. Requiring `;` alone
 *  would reject a plain percent-encoded `data:image/svg+xml,%3Csvg…`, which is the compact way to
 *  inline an SVG icon, and drop that server to the monogram tile with no signal. */
const RENDERABLE_SRC = /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,]/i;

/**
 * The first renderable icon, or undefined when the server advertised none we can draw.
 *
 * A themeless icon wins over a `theme`-tagged one: the result is stored once at connect and read
 * without re-deriving, so a dark-only icon picked during a dark session would still be showing
 * after the user switched to light. Preferring the variant that is valid in both themes keeps a
 * single stored string honest — worth revisiting only if servers start shipping theme pairs.
 *
 * Takes `unknown` because it parses the wire: the handshake result is server-controlled, so every
 * layer of the shape is checked rather than trusted.
 */
export function pickServerIcon(icons: unknown): string | undefined {
  if (!Array.isArray(icons)) return undefined;

  const renderable = icons.filter(
    (icon): icon is { src: string; theme?: unknown } =>
      typeof icon === "object" &&
      icon !== null &&
      typeof (icon as { src?: unknown }).src === "string" &&
      RENDERABLE_SRC.test((icon as { src: string }).src) &&
      (icon as { src: string }).src.length <= MAX_ICON_CHARS,
  );

  return (renderable.find((icon) => icon.theme === undefined) ?? renderable[0])?.src;
}
