import { UI_EXTENSION_ID, UI_MIME_TYPE } from "../../apps/types";
import { CLIENT_INFO } from "../client";

/**
 * Build the `_meta` object required on every stateless RC (2026-07-28) request.
 * Merges into an existing params object so callers can pass the result directly.
 */
export function withStatelessMeta(
  protocolVersion: string,
  params?: unknown,
): Record<string, unknown> {
  const base =
    params !== null && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  // Only merge an existing _meta when it's a plain object; a non-object _meta
  // (string/array) would spread junk keys into the protocol metadata.
  const baseMeta =
    base._meta !== null && typeof base._meta === "object" && !Array.isArray(base._meta)
      ? (base._meta as Record<string, unknown>)
      : undefined;
  return {
    ...base,
    _meta: {
      ...baseMeta,
      "io.modelcontextprotocol/protocolVersion": protocolVersion,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      // We support form-mode elicitation (see InputRequiredDetail). The spec requires a client to
      // declare the capability or the server MUST NOT send elicitation requests. Url mode is not
      // supported here, so we declare form only.
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: {
          "io.modelcontextprotocol/tasks": {},
          // MCP Apps (SEP-1865): mirrors INITIALIZE_REQUEST's advertisement
          // (handshake.ts) for the stateless RC era, so a server on either era
          // may attach _meta.ui to tools. See handshake.ts's comment for why
          // this is not a detection gate.
          [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] },
        },
        elicitation: { form: {} },
      },
    },
  };
}
