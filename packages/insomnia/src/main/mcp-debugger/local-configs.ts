import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type McpJsonParseResult, type McpServerImport, parseCodexToml, parseMcpJson } from '~/common/mcp-json-import';

// Task 4348 S6c: look for MCP config files that other tools already keep on this machine (Claude Code, Claude Desktop,
// Cursor, Windsurf, VS Code, Gemini CLI, Codex) so a user can pick servers to import instead of hunting for the file.
// Reads only these known paths, only when the user asks (the Import modal's "Scan this machine"), and returns what it
// parsed; nothing is stored until the user imports their selection.
// PROTOTYPE-MOCK: paths are from each tool's documentation as remembered, verified on macOS only; project-level
// `.cursor/mcp.json` and `.vscode/mcp.json` are not searched (no way to know the project), but a Claude Code project's
// `.mcp.json` is, using the project paths listed in ~/.claude.json.

export interface LocalMcpConfig {
  tool: string;
  file: string;
  servers: McpServerImport[];
  skipped: string[];
  error?: string;
}

interface Candidate {
  tool: string;
  file: string;
  format: 'json' | 'toml';
}

export const candidateConfigFiles = ({
  home,
  platform,
  env,
}: {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): Candidate[] => {
  const appData =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
        : (env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  return [
    { tool: 'Claude Code', file: path.join(home, '.claude.json'), format: 'json' },
    { tool: 'Claude Desktop', file: path.join(appData, 'Claude', 'claude_desktop_config.json'), format: 'json' },
    { tool: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'), format: 'json' },
    { tool: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'json' },
    { tool: 'VS Code', file: path.join(appData, 'Code', 'User', 'mcp.json'), format: 'json' },
    { tool: 'Gemini CLI', file: path.join(home, '.gemini', 'settings.json'), format: 'json' },
    { tool: 'Codex', file: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), format: 'toml' },
  ];
};

const readText = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
};

const parse = (candidate: Candidate, text: string): McpJsonParseResult | null =>
  candidate.format === 'toml' ? parseCodexToml(text) : parseMcpJson(text);

export const findLocalMcpConfigs = async ({
  home = os.homedir(),
  platform = process.platform,
  env = process.env,
}: { home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Promise<LocalMcpConfig[]> => {
  const candidates = candidateConfigFiles({ home, platform, env });
  const found: LocalMcpConfig[] = [];

  for (const candidate of candidates) {
    const text = await readText(candidate.file);
    if (text === null) {
      continue;
    }
    try {
      const result = parse(candidate, text);
      if (result) {
        found.push({ tool: candidate.tool, file: candidate.file, servers: result.servers, skipped: result.skipped });
      }
    } catch (err) {
      found.push({ tool: candidate.tool, file: candidate.file, servers: [], skipped: [], error: err instanceof Error ? err.message : String(err) });
    }

    // Claude Code projects keep a `.mcp.json` in their own folder; ~/.claude.json lists the projects.
    if (candidate.tool === 'Claude Code') {
      let projectPaths: string[] = [];
      try {
        projectPaths = Object.keys((JSON.parse(text) as { projects?: Record<string, unknown> }).projects ?? {});
      } catch {}
      for (const projectPath of projectPaths) {
        const file = path.join(projectPath, '.mcp.json');
        const projectText = await readText(file);
        const result = projectText === null ? null : parseMcpJson(projectText);
        if (result) {
          found.push({ tool: 'Claude Code (project)', file, servers: result.servers, skipped: result.skipped });
        }
      }
    }
  }
  return found.filter(f => f.servers.length > 0 || f.skipped.length > 0 || f.error);
};
