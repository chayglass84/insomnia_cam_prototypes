// PROTOTYPE-MOCK: Ardi's config.ts held hosted-proxy URLs. Insomnia talks to servers directly from the main process,
// so there is no proxy: both are undefined and the proxy branches in MCPHTTPProtocol/HTTPTransport are inert.
export const MCP_PROXY_URL = undefined as unknown as string;
export const MCP_TASKS_PROXY_URL = undefined as string | undefined;
