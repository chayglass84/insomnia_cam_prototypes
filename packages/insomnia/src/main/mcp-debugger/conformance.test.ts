import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runConformance } from './conformance';

// Integration tests (S6b) against the real mocks: the 2026-07-28 mock, the session-era mock (/mcp and the legacy /sse
// transport) and a closed port.
const MODERN_PORT = 18_817;
const LEGACY_PORT = 18_818;
const modern = `http://127.0.0.1:${MODERN_PORT}/stateless`;
const legacy = `http://127.0.0.1:${LEGACY_PORT}`;
const children: ChildProcess[] = [];

beforeAll(async () => {
  const dir = path.resolve(__dirname, '../../../../insomnia-smoke-test/server/mcp-debugger');
  children.push(
    spawn(process.execPath, [path.join(dir, 'mock-mcp-server.mjs')], { env: { ...process.env, MOCK_MCP_PORT: String(MODERN_PORT) }, stdio: 'ignore' }),
    spawn(process.execPath, [path.join(dir, 'mock-legacy-server.mjs')], { env: { ...process.env, MOCK_LEGACY_PORT: String(LEGACY_PORT) }, stdio: 'ignore' }),
  );
  for (const url of [`http://127.0.0.1:${MODERN_PORT}/health`, `http://127.0.0.1:${LEGACY_PORT}/health`]) {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(url)).ok) {
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
  }
});
afterAll(() => children.forEach(child => child.kill()));

const outcomes = (report: Awaited<ReturnType<typeof runConformance>>) => Object.fromEntries(report.versions.map(v => [v.version, v.outcome]));

describe('runConformance', () => {
  it('reports the modern mock as current, with the stateless checks run', async () => {
    const report = await runConformance({ url: modern, headers: [] });
    expect(report.verdict.level).toBe('current');
    expect(outcomes(report)['2026-07-28']).toBe('accepted');
    const ids = report.checks.map(c => c.id);
    expect(ids).toEqual(expect.arrayContaining(['m-shape', 'm-no-session', 'm-header-mismatch', 'm-unsupported-version', 'm-unknown-method']));
    expect(report.checks.find(c => c.id === 'm-shape')?.status).toBe('pass');
  });

  it('reports a session-era server as behind, with the legacy checks and the versions it accepts', async () => {
    const report = await runConformance({ url: `${legacy}/mcp`, headers: [] });
    expect(report.verdict.level).toBe('behind');
    expect(report.verdict.newestAccepted).toBe('2025-11-25');
    expect(report.verdict.monthsBehind).toBeGreaterThanOrEqual(8);
    expect(outcomes(report)).toMatchObject({ '2026-07-28': 'rejected', '2025-11-25': 'accepted', '2025-06-18': 'accepted', '2025-03-26': 'accepted' });
    expect(report.checks.find(c => c.id === 's-ping')?.status).toBe('pass');
    expect(report.checks.find(c => c.id === 'm-not-modern')?.status).toBe('info');
  });

  it('flags the deprecated HTTP+SSE transport', async () => {
    const report = await runConformance({ url: `${legacy}/sse`, headers: [] });
    expect(report.checks.find(c => c.id === 't-legacy-sse')?.status).toBe('warn');
    expect(outcomes(report)['2024-11-05']).toBe('via-sse');
    expect(report.verdict.level).toBe('legacy-transport');
  });

  it('says so when the server is unreachable', async () => {
    const report = await runConformance({ url: 'http://127.0.0.1:1/', headers: [] });
    expect(report.verdict.level).toBe('unreachable');
  });
});
