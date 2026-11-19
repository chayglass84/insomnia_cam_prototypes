import { REDACTED } from '~/common/mcp-debugger/protocol/mcp/traceEvents';

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** `Authorization` -> `MCP_AUTHORIZATION`, `X-Api-Key` -> `MCP_X_API_KEY`. */
const envNameFor = (headerName: string) => `MCP_${headerName.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`;

/**
 * A copy-pasteable cURL for a traced MCP request. Credential headers (shown as redacted in the trace) become
 * environment-variable references, e.g. `-H "Authorization: $MCP_AUTHORIZATION"`, so no secret is ever in the clipboard.
 */
export const buildCurl = ({
  url,
  method,
  params,
  headers,
}: {
  url: string;
  method: string;
  params?: unknown;
  headers: Record<string, string>;
}): { command: string; envVars: string[] } => {
  const envVars: string[] = [];
  const merged: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  const headerArgs = Object.entries(merged).map(([name, value]) => {
    if (value === REDACTED) {
      const env = envNameFor(name);
      envVars.push(env);
      return `-H "${name}: $${env}"`;
    }
    return `-H ${shellQuote(`${name}: ${value}`)}`;
  });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
  const command = [`curl -X POST ${shellQuote(url)}`, ...headerArgs, `--data-raw ${shellQuote(body)}`].join(' \\\n  ');
  return { command, envVars };
};
