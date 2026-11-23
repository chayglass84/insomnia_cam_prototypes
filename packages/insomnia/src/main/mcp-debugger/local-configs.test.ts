import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { findLocalMcpConfigs } from './local-configs';

const home = path.join(os.tmpdir(), `mcp-local-configs-${process.pid}`);
const write = async (file: string, content: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};
afterAll(() => fs.rm(home, { recursive: true, force: true }));

describe('find local MCP configs', () => {
  it('finds each tool that has a config, parses it, and follows Claude Code project folders', async () => {
    const project = path.join(home, 'work', 'app');
    await write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { c: { url: 'http://cursor' } } }));
    await write(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { user: { url: 'http://u', headers: { Authorization: 'Bearer x' } } }, projects: { [project]: {}, '/nope/gone': {} } }),
    );
    await write(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { proj: { command: 'node', args: ['s.js'] } } }));
    await write(path.join(home, '.codex', 'config.toml'), '[mcp_servers.cx]\nurl = "http://codex"\n');
    await write(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), '{ not json');

    const found = await findLocalMcpConfigs({ home, platform: 'darwin', env: {} });
    expect(found.map(f => [f.tool, f.servers.map(s => s.name)])).toEqual([
      ['Claude Code', ['user']],
      ['Claude Code (project)', ['proj']],
      ['Cursor', ['c']],
      ['Codex', ['cx']],
    ]);
    expect(found[0].servers[0].hasCredentials).toBe(true);
  });

  it('returns nothing when no tool has a config', async () => {
    expect(await findLocalMcpConfigs({ home: path.join(home, 'empty'), platform: 'linux', env: {} })).toEqual([]);
  });
});
