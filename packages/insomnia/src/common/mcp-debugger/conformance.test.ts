import { describe, expect, it } from 'vitest';

import {
  checkListResult,
  checkUnknownMethod,
  type ConformanceCheck,
  jsonRpcError,
  listMethodsFor,
  makeCheck,
  monthsBetween,
  summarizeConformance,
  type VersionResult,
} from './conformance';

const versions = (accepted: Record<string, VersionResult['outcome']>): VersionResult[] =>
  (['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const).map(version => ({
    version,
    outcome: accepted[version] ?? 'rejected',
    note: '',
  }));

describe('conformance helpers', () => {
  it('counts whole months between spec versions', () => {
    expect(monthsBetween('2025-03-26', '2026-07-28')).toBe(16);
    expect(monthsBetween('2025-11-25', '2026-07-28')).toBe(8);
    expect(monthsBetween('2026-07-28', '2026-07-28')).toBe(0);
    expect(monthsBetween('2025-11-29', '2026-07-28')).toBe(7);
  });

  it('reads JSON-RPC errors and the list methods a server declares', () => {
    expect(jsonRpcError({ error: { code: -32_601, message: 'nope' } })).toEqual({ code: -32_601, message: 'nope', data: undefined });
    expect(jsonRpcError({ result: {} })).toBeUndefined();
    expect(listMethodsFor({ tools: {}, logging: {}, prompts: { listChanged: true } })).toEqual(['tools/list', 'prompts/list']);
  });

  it('judges list results', () => {
    const extra = {};
    expect(checkListResult('tools/list', 'modern', { tools: [{ name: 'a', inputSchema: { type: 'object' } }] }, undefined, extra, 'm').status).toBe('pass');
    expect(checkListResult('tools/list', 'modern', { tools: [{ name: 'a' }] }, undefined, extra, 'm').status).toBe('fail');
    expect(checkListResult('tools/list', 'modern', { tools: [{ name: 'a', inputSchema: { type: 'string' } }] }, undefined, extra, 'm').status).toBe('warn');
    expect(checkListResult('tools/list', 'modern', {}, undefined, extra, 'm').status).toBe('fail');
    expect(checkListResult('resources/list', 'modern', undefined, { code: -32_601, message: 'x' }, extra, 'm').status).toBe('fail');
    expect(checkListResult('prompts/list', 'modern', { prompts: [{ name: 'p' }] }, undefined, extra, 'm').status).toBe('pass');
  });

  it('expects -32601 for an unknown method', () => {
    expect(checkUnknownMethod('modern', 'm', 200, { error: { code: -32_601, message: '' } }, {}).status).toBe('pass');
    expect(checkUnknownMethod('modern', 'm', 200, { error: { code: -32_000, message: 'x' } }, {}).status).toBe('warn');
    expect(checkUnknownMethod('modern', 'm', 200, { result: {} }, {}).status).toBe('warn');
  });
});

describe('summarizeConformance', () => {
  const checks: ConformanceCheck[] = [];
  it('is current when the newest protocol is accepted', () => {
    const v = summarizeConformance({ versions: versions({ '2026-07-28': 'accepted' }), checks, reachable: true, authBlocked: false });
    expect(v.level).toBe('current');
    expect(v.detail).toBe('Every check passed.');
  });

  it('notes sessions on a modern server as partly migrated', () => {
    const v = summarizeConformance({
      versions: versions({ '2026-07-28': 'accepted' }),
      checks: [makeCheck('m-no-session', 'modern', 't', 'warn', 'd')],
      reachable: true,
      authBlocked: false,
    });
    expect(v.level).toBe('current');
    expect(v.detail).toMatch(/1 warning\./);
    expect(v.detail).toMatch(/partly migrated/);
  });

  it('says how far behind an older server is', () => {
    const v = summarizeConformance({ versions: versions({ '2025-03-26': 'accepted', '2024-11-05': 'accepted' }), checks, reachable: true, authBlocked: false });
    expect(v.level).toBe('behind');
    expect(v.newestAccepted).toBe('2025-03-26');
    expect(v.monthsBehind).toBe(16);
    expect(v.headline).toMatch(/2025-03-26/);
  });

  it('flags a server that only has the HTTP+SSE transport', () => {
    expect(summarizeConformance({ versions: versions({ '2024-11-05': 'via-sse' }), checks, reachable: true, authBlocked: false }).level).toBe('legacy-transport');
  });

  it('handles unreachable, auth-blocked and unrecognized servers', () => {
    expect(summarizeConformance({ versions: [], checks, reachable: false, authBlocked: false }).level).toBe('unreachable');
    expect(summarizeConformance({ versions: versions({}), checks, reachable: true, authBlocked: true }).level).toBe('auth-blocked');
    expect(summarizeConformance({ versions: versions({}), checks, reachable: true, authBlocked: false }).level).toBe('unknown');
  });

  it('does not count a counter-offer as acceptance', () => {
    const v = summarizeConformance({ versions: versions({ '2025-11-25': 'accepted', '2025-06-18': 'counter-offered' }), checks, reachable: true, authBlocked: false });
    expect(v.newestAccepted).toBe('2025-11-25');
  });
});
