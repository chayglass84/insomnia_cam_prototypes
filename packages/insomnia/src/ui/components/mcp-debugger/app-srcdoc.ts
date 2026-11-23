import type { UiCspMeta, UiResource } from '~/common/mcp-debugger/protocol/apps/types';

// Task 4348 S7a: turn a server's `ui://` resource into the document an MCP App runs in. The app is untrusted HTML from
// the server, so it goes in an iframe with an opaque origin (sandbox="allow-scripts", never allow-same-origin) and a
// Content-Security-Policy built from what the server declared in `_meta.ui.csp`, defaulting to no network at all.
// PROTOTYPE-MOCK: enforcement is the sandbox + a meta CSP; the spec's separate sandbox-proxy origin is not built.

// Only plain origins/hosts: anything that could break out of a CSP directive (spaces, `;`, `,`, quotes) is dropped.
const SAFE_SOURCE = /^(?:(?:https?|wss?):\/\/)?(?:\*\.)?[\w-]+(?:\.[\w-]+)*(?::\d{1,5})?(?:\/[\w./%~+-]*)?$/;

export const safeSources = (domains: string[] | undefined): string[] => (domains ?? []).filter(d => SAFE_SOURCE.test(d));

export const buildCsp = (csp?: UiCspMeta): string => {
  const resources = safeSources(csp?.resourceDomains).join(' ');
  const join = (...parts: string[]) => parts.filter(Boolean).join(' ');
  const connect = safeSources(csp?.connectDomains).join(' ');
  const frames = safeSources(csp?.frameDomains).join(' ');
  const base = safeSources(csp?.baseUriDomains).join(' ');
  return [
    "default-src 'none'",
    `script-src ${join("'unsafe-inline'", resources)}`,
    `style-src ${join("'unsafe-inline'", resources)}`,
    `img-src ${join('data: blob:', resources)}`,
    `font-src ${join('data:', resources)}`,
    "media-src data: blob:",
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frames || "'none'"}`,
    `base-uri ${base || "'none'"}`,
    "form-action 'none'",
  ].join('; ');
};

/** The document handed to the iframe's `srcdoc`: the app's HTML with the CSP meta injected as early as possible. */
export const buildAppSrcdoc = (resource: Pick<UiResource, 'html' | 'csp'>): string => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildCsp(resource.csp)}">`;
  const { html } = resource;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  }
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) {
    return `${html.slice(0, root.index + root[0].length)}<head>${meta}</head>${html.slice(root.index + root[0].length)}`;
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
};
