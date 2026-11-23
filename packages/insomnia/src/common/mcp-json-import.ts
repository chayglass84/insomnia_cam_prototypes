import { stringify } from 'yaml';

import { INSOMNIA_SCHEMA_VERSION } from '~/common/insomnia-schema-migrations/schema-version';

// Task 4348 S6: detect an `mcp.json` (the shape Claude Desktop/Code, Cursor, Windsurf, Gemini CLI and VS Code all use) and
// turn each server into an Insomnia MCP client, one workspace per server (an MCP workspace holds exactly one request).
// Shapes: `{ "mcpServers": { name: server } }` (Claude, Cursor, Windsurf, Gemini) or `{ "servers": { name: server } }` (VS Code).
// A server is remote (`url`, or Windsurf's `serverUrl`, or Gemini's `httpUrl`; optional `headers`) or local stdio
// (`command`, `args`, `env`). Isomorphic: no window, no database.
// PROTOTYPE-MOCK: legacy `type: "sse"` servers are imported as streamable-http (pick 2024-11-05 in the version picker);
// `${input:...}` placeholders are kept as written; env values are imported as plain strings, not secrets.

export interface McpServerImport {
  name: string;
  transportType: 'streamable-http' | 'stdio';
  /** The URL for a remote server, the shell command line for stdio (how Insomnia stores a stdio request). */
  url: string;
  headers: { name: string; value: string }[];
  env: { id: string; name: string; value: string; type: 'str' }[];
  /** True when a header or env value looks like a credential (a token, key or secret) that is not already a `{{ _.VAR }}` reference. */
  hasCredentials: boolean;
  /** Where inside the file it came from, when that is not obvious (e.g. a Claude Code project path). */
  origin?: string;
  /** Plain-language things the importer changed or could not carry over, for the import summary. */
  notes: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `${env:NAME}` and `${NAME}` become Insomnia's `{{ _.NAME }}`; `${input:id}` and anything else stay as written. */
const convertPlaceholders = (value: string): string =>
  value.replaceAll(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, '{{ _.$1 }}');

const CREDENTIAL_NAME = /auth|token|secret|password|passwd|api[-_]?key|credential|cookie|bearer|private[-_]?key/i;
const looksSecret = (name: string, value: string) => {
  // What is left once variable references and an auth scheme are removed: a literal value is what makes it a credential.
  const literal = value.replaceAll(/\{\{[^}]*\}\}/g, '').replace(/^\s*(bearer|basic)\b/i, '').trim();
  return literal.length > 0 && (CREDENTIAL_NAME.test(name) || /^(bearer|basic)\s/i.test(value) || /^sk-[\w-]{16,}/.test(literal));
};

const shellQuote = (arg: string) => (/^[\w./:=@%+,-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", String.raw`'\''`)}'`);

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const readServer = (name: string, raw: unknown): McpServerImport | string => {
  if (!isRecord(raw)) {
    return `"${name}" is not an object`;
  }
  const notes: string[] = [];
  const remoteUrl = stringOf(raw.url) ?? stringOf(raw.serverUrl) ?? stringOf(raw.httpUrl);
  const command = stringOf(raw.command);
  if (raw.disabled === true) {
    notes.push('was marked disabled');
  }
  if (remoteUrl && raw.type !== 'stdio') {
    if (!/^https?:\/\//i.test(remoteUrl)) {
      return `"${name}" has a url that is not http(s): ${remoteUrl}`;
    }
    if (raw.type === 'sse') {
      notes.push('was an SSE server; imported as streamable-http, pick protocol 2024-11-05 to talk to a legacy server');
    }
    const headers = isRecord(raw.headers)
      ? Object.entries(raw.headers)
          .filter(([, value]) => typeof value === 'string')
          .map(([headerName, value]) => ({ name: headerName, value: convertPlaceholders(value as string) }))
      : [];
    return {
      name,
      transportType: 'streamable-http',
      url: convertPlaceholders(remoteUrl),
      headers,
      env: [],
      hasCredentials: headers.some(h => looksSecret(h.name, h.value)) || /[?&](key|token|api_?key|access_token)=[^&{]/i.test(remoteUrl),
      notes,
    };
  }
  if (command) {
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
    const env = isRecord(raw.env)
      ? Object.entries(raw.env)
          .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
          .map(([envName, value], index) => ({
            id: `env-${index}`,
            name: envName,
            value: convertPlaceholders(String(value)),
            type: 'str' as const,
          }))
      : [];
    return {
      name,
      transportType: 'stdio',
      url: [command, ...args].map(part => shellQuote(convertPlaceholders(part))).join(' '),
      headers: [],
      env,
      hasCredentials: env.some(e => looksSecret(e.name, e.value)),
      notes,
    };
  }
  return `"${name}" has neither a url nor a command`;
};

export interface McpJsonParseResult {
  servers: McpServerImport[];
  /** Servers that could not be read, with the reason. */
  skipped: string[];
}

/** Returns null when `content` is not an mcp.json at all, so other importers get a turn. */
export const parseMcpJson = (content: string): McpJsonParseResult | null => {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const top = isRecord(parsed.mcpServers) ? parsed.mcpServers : isRecord(parsed.servers) ? parsed.servers : {};
  // Claude Code's ~/.claude.json also keeps servers per project: projects.<path>.mcpServers
  const projectTables = isRecord(parsed.projects)
    ? Object.entries(parsed.projects).flatMap(([projectPath, project]) =>
        isRecord(project) && isRecord(project.mcpServers) && Object.keys(project.mcpServers).length > 0
          ? [{ projectPath, table: project.mcpServers }]
          : [],
      )
    : [];
  if (Object.keys(top).length === 0 && projectTables.length === 0) {
    return null;
  }
  // `servers` is a common key elsewhere (e.g. OpenAPI), so require every entry to look like an MCP server.
  if (
    !isRecord(parsed.mcpServers) &&
    projectTables.length === 0 &&
    !Object.values(top).every(v => isRecord(v) && ('url' in v || 'command' in v || 'serverUrl' in v))
  ) {
    return null;
  }
  const servers: McpServerImport[] = [];
  const skipped: string[] = [];
  const add = (name: string, raw: unknown, origin?: string) => {
    const result = readServer(name, raw);
    if (typeof result === 'string') {
      skipped.push(result);
    } else {
      servers.push(origin ? { ...result, origin } : result);
    }
  };
  for (const [name, raw] of Object.entries(top)) {
    add(name, raw);
  }
  for (const { projectPath, table } of projectTables) {
    for (const [name, raw] of Object.entries(table)) {
      add(name, raw, `project ${projectPath}`);
    }
  }
  return { servers, skipped };
};

export const mcpServerToInsomniaV5Yaml = (server: McpServerImport): string =>
  stringify({
    type: 'mcpClient.insomnia/5.0',
    schema_version: INSOMNIA_SCHEMA_VERSION,
    name: server.name,
    mcpRequest: {
      name: server.name,
      url: server.url,
      transportType: server.transportType,
      ...(server.headers.length > 0 ? { headers: server.headers } : {}),
      ...(server.env.length > 0 ? { env: server.env } : {}),
    },
  });

/** One Insomnia v5 YAML document per server, ready to feed the importer; null when `content` is not an mcp.json. */
export const mcpJsonToImportEntries = (content: string): { contentStr: string; oriFileName: string }[] | null => {
  const result = parseMcpJson(content);
  if (!result) {
    return null;
  }
  if (result.servers.length === 0) {
    throw new Error(`No importable MCP servers found: ${result.skipped.join('; ')}`);
  }
  return result.servers.map(server => ({ contentStr: mcpServerToInsomniaV5Yaml(server), oriFileName: server.name }));
};

// ---------- Codex (~/.codex/config.toml) ----------
// A deliberately small TOML reader: enough for `[mcp_servers.<name>]` tables (strings, numbers, booleans, string arrays,
// inline tables, comments, multi-line arrays). PROTOTYPE-MOCK: swap for a real TOML library (e.g. smol-toml) when this ships.

const skipSpace = (text: string, i: number) => {
  let j = i;
  while (j < text.length && /[\s,]/.test(text[j])) {
    j++;
  }
  return j;
};

const readTomlValue = (text: string, start: number): { value: unknown; end: number } => {
  let i = start;
  const ch = text[i];
  if (ch === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') {
      j += text[j] === '\\' ? 2 : 1;
    }
    return { value: JSON.parse(text.slice(i, j + 1)), end: j + 1 };
  }
  if (ch === "'") {
    const j = text.indexOf("'", i + 1);
    return { value: text.slice(i + 1, j), end: j + 1 };
  }
  if (ch === '[') {
    const items: unknown[] = [];
    i = skipSpace(text, i + 1);
    while (text[i] !== ']' && i < text.length) {
      const item = readTomlValue(text, i);
      items.push(item.value);
      i = skipSpace(text, item.end);
    }
    return { value: items, end: i + 1 };
  }
  if (ch === '{') {
    const table: Record<string, unknown> = {};
    i = skipSpace(text, i + 1);
    while (text[i] !== '}' && i < text.length) {
      const keyMatch = /^\s*("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)\s*=\s*/.exec(text.slice(i));
      if (!keyMatch) {
        break;
      }
      const item = readTomlValue(text, i + keyMatch[0].length);
      table[keyMatch[1].startsWith('"') ? JSON.parse(keyMatch[1]) : keyMatch[1]] = item.value;
      i = skipSpace(text, item.end);
    }
    return { value: table, end: i + 1 };
  }
  const bare = /^[^\s,\]}#]+/.exec(text.slice(i))?.[0] ?? '';
  const value = bare === 'true' ? true : bare === 'false' ? false : Number.isNaN(Number(bare)) ? bare : Number(bare);
  return { value, end: i + bare.length };
};

const splitTomlPath = (path: string): string[] =>
  [...path.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+)/g)].map(m => m[1] ?? m[2] ?? m[3]);

/** Parse the subset of TOML Codex's config uses into nested objects; unsupported lines are ignored. */
export const parseTomlSubset = (content: string): Record<string, unknown> => {
  const root: Record<string, unknown> = {};
  let current = root;
  let i = 0;
  while (i < content.length) {
    i = skipSpace(content, i);
    if (content[i] === '#') {
      i = !content.includes('\n', i) ? content.length : content.indexOf('\n', i);
      continue;
    }
    if (content[i] === '[') {
      const end = content.indexOf(']', i);
      if (content[i + 1] === '[') {
        // [[array of tables]]: not used for MCP servers, skip the header and let its keys land in a scratch object.
        current = {};
        i = content.indexOf(']]', i) + 2;
        continue;
      }
      let node = root;
      for (const part of splitTomlPath(content.slice(i + 1, end))) {
        node = (isRecord(node[part]) ? node[part] : (node[part] = {})) as Record<string, unknown>;
      }
      current = node;
      i = end + 1;
      continue;
    }
    const keyMatch = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)\s*=\s*/.exec(content.slice(i));
    if (!keyMatch) {
      i = !content.includes('\n', i) ? content.length : content.indexOf('\n', i);
      continue;
    }
    const { value, end } = readTomlValue(content, i + keyMatch[0].length);
    current[keyMatch[1].startsWith('"') ? JSON.parse(keyMatch[1]) : keyMatch[1]] = value;
    i = end;
  }
  return root;
};

/** Codex `[mcp_servers.<name>]` tables, mapped onto the same server shape the JSON files use. */
export const parseCodexToml = (content: string): McpJsonParseResult | null => {
  const table = parseTomlSubset(content).mcp_servers;
  if (!isRecord(table) || Object.keys(table).length === 0) {
    return null;
  }
  const mapped = Object.fromEntries(
    Object.entries(table).map(([name, raw]) => {
      if (!isRecord(raw)) {
        return [name, raw];
      }
      const headers: Record<string, string> = isRecord(raw.http_headers) ? { ...(raw.http_headers as Record<string, string>) } : {};
      if (isRecord(raw.env_http_headers)) {
        for (const [header, variable] of Object.entries(raw.env_http_headers)) {
          headers[header] = `{{ _.${String(variable)} }}`;
        }
      }
      if (typeof raw.bearer_token_env_var === 'string') {
        headers.Authorization = `Bearer {{ _.${raw.bearer_token_env_var} }}`;
      }
      return [name, { ...raw, ...(Object.keys(headers).length > 0 ? { headers } : {}), ...(raw.enabled === false ? { disabled: true } : {}) }];
    }),
  );
  return parseMcpJson(JSON.stringify({ mcpServers: mapped }));
};
