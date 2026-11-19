import { describe, expect, it } from 'vitest';

import { buildCurl } from './curl-command';

describe('buildCurl', () => {
  it('builds a POST with the JSON-RPC body and headers', () => {
    const { command, envVars } = buildCurl({
      url: 'http://localhost:8787/stateless',
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: "it's" } },
      headers: { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    });
    expect(command).toContain("curl -X POST 'http://localhost:8787/stateless'");
    expect(command).toContain("-H 'Mcp-Name: echo'");
    expect(command).toContain("-H 'Content-Type: application/json'");
    // single quotes inside the body are shell-escaped
    expect(command).toContain(`it'\\''s`);
    expect(envVars).toEqual([]);
  });

  it('never puts a credential in the command, only an env var reference', () => {
    const { command, envVars } = buildCurl({
      url: 'http://x/mcp',
      method: 'tools/list',
      headers: { Authorization: '<redacted>', 'X-Api-Key': '<redacted>' },
    });
    expect(command).not.toContain('<redacted>');
    expect(command).toContain('-H "Authorization: $MCP_AUTHORIZATION"');
    expect(command).toContain('-H "X-Api-Key: $MCP_X_API_KEY"');
    expect(envVars).toEqual(['MCP_AUTHORIZATION', 'MCP_X_API_KEY']);
  });
});
