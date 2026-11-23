import { describe, expect, it } from 'vitest';

import { mcpJsonToImportEntries, parseCodexToml, parseMcpJson } from './mcp-json-import';

describe('mcp.json import', () => {
  it('reads Claude/Cursor style mcpServers: remote with headers and stdio with args and env', () => {
    const result = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${env:TOKEN}' } },
          local: { command: 'npx', args: ['-y', '@scope/server', '--root', '/my dir'], env: { API_KEY: '${API_KEY}', N: 1 } },
        },
      }),
    )!;
    expect(result.skipped).toEqual([]);
    expect(result.servers[0]).toMatchObject({
      name: 'remote',
      transportType: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer {{ _.TOKEN }}' }],
    });
    expect(result.servers[1]).toMatchObject({ name: 'local', transportType: 'stdio', url: "npx -y @scope/server --root '/my dir'" });
    expect(result.servers[1].env.map(e => [e.name, e.value])).toEqual([['API_KEY', '{{ _.API_KEY }}'], ['N', '1']]);
  });

  it('reads VS Code servers, Windsurf serverUrl and Gemini httpUrl, and notes SSE', () => {
    const vscode = parseMcpJson(JSON.stringify({ servers: { a: { type: 'sse', url: 'http://x/sse' } } }))!;
    expect(vscode.servers[0].notes[0]).toMatch(/SSE/);
    expect(parseMcpJson(JSON.stringify({ mcpServers: { w: { serverUrl: 'http://w' }, g: { httpUrl: 'http://g' } } }))!.servers.map(s => s.url)).toEqual([
      'http://w',
      'http://g',
    ]);
  });

  it('skips unreadable servers with a reason and leaves other JSON alone', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { bad: {}, ftp: { url: 'ftp://x' }, ok: { url: 'http://ok' } } }))!;
    expect(result.servers.map(s => s.name)).toEqual(['ok']);
    expect(result.skipped).toHaveLength(2);
    expect(parseMcpJson(JSON.stringify({ servers: [{ url: 'http://x' }] }))).toBeNull();
    expect(parseMcpJson(JSON.stringify({ openapi: '3.0.0', servers: { x: { description: 'prod' } } }))).toBeNull();
    expect(parseMcpJson('not json')).toBeNull();
    expect(parseMcpJson('type: collection.insomnia.rest/5.0')).toBeNull();
  });

  it('produces one MCP client YAML per server', () => {
    const entries = mcpJsonToImportEntries(JSON.stringify({ mcpServers: { a: { url: 'http://a' }, b: { command: 'node', args: ['s.js'] } } }))!;
    expect(entries.map(e => e.oriFileName)).toEqual(['a', 'b']);
    expect(entries[0].contentStr).toContain('type: mcpClient.insomnia/5.0');
    expect(entries[1].contentStr).toContain('transportType: stdio');
    expect(() => mcpJsonToImportEntries(JSON.stringify({ mcpServers: { bad: {} } }))).toThrow(/No importable/);
  });

  it('flags servers that carry credentials, but not references to variables', () => {
    const result = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          bearer: { url: 'https://x', headers: { Authorization: 'Bearer abc123' } },
          ref: { url: 'https://x', headers: { Authorization: 'Bearer ${env:TOKEN}' } },
          env: { command: 'node', env: { GITHUB_TOKEN: 'ghp_x', DEBUG: '1' } },
          plain: { url: 'https://x', headers: { 'X-Trace': 'on' } },
          query: { url: 'https://x/mcp?api_key=abc' },
        },
      }),
    )!;
    expect(result.servers.map(s => [s.name, s.hasCredentials])).toEqual([
      ['bearer', true],
      ['ref', false],
      ['env', true],
      ['plain', false],
      ['query', true],
    ]);
  });

  it('reads Claude Code per-project servers from ~/.claude.json', () => {
    const result = parseMcpJson(
      JSON.stringify({
        numStartups: 3,
        mcpServers: { user: { url: 'http://u' } },
        projects: { '/Users/me/app': { mcpServers: { local: { command: 'node', args: ['a.js'] } } }, '/x': { mcpServers: {} } },
      }),
    )!;
    expect(result.servers.map(s => [s.name, s.origin])).toEqual([
      ['user', undefined],
      ['local', 'project /Users/me/app'],
    ]);
    // only per-project servers, no top-level table
    expect(parseMcpJson(JSON.stringify({ projects: { '/a': { mcpServers: { s: { url: 'http://s' } } } } }))!.servers).toHaveLength(1);
    expect(parseMcpJson(JSON.stringify({ projects: { '/a': {} } }))).toBeNull();
  });

  it('reads Codex config.toml', () => {
    const toml = `
model = "gpt-5"  # not an mcp setting

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp", '--flag']
env = { API_KEY = "abc", REGION = "eu" }

[mcp_servers."remote one"]
url = "https://example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Team" = "core" }

[mcp_servers.tbl]
command = "t"

[mcp_servers.tbl.env]
EXTRA = "1"

[mcp_servers.off]
command = "x"
enabled = false
`;
    const result = parseCodexToml(toml)!;
    const byName = Object.fromEntries(result.servers.map(s => [s.name, s]));
    expect(byName.docs.url).toBe('npx -y docs-mcp --flag');
    expect(byName.docs.env.map(e => [e.name, e.value])).toEqual([['API_KEY', 'abc'], ['REGION', 'eu']]);
    expect(byName.docs.hasCredentials).toBe(true);
    expect(byName.tbl.env.map(e => [e.name, e.value])).toEqual([['EXTRA', '1']]);
    expect(byName.tbl.hasCredentials).toBe(false);
    expect(byName['remote one'].headers).toEqual([
      { name: 'X-Team', value: 'core' },
      { name: 'Authorization', value: 'Bearer {{ _.REMOTE_TOKEN }}' },
    ]);
    expect(byName.off.notes[0]).toMatch(/disabled/);
    expect(parseCodexToml('model = "x"')).toBeNull();
  });
});
