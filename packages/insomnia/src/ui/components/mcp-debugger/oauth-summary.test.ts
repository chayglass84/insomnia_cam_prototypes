import { describe, expect, it } from 'vitest';

import type { OAuthStep } from '~/main/mcp-debugger/oauth-discovery';

import { summarizeSteps } from './oauth-discovery-panel';

const mk = (status: OAuthStep['status']): OAuthStep => ({ id: 'challenge', title: 't', status, summary: '', exchanges: [], findings: [] });

describe('summarizeSteps', () => {
  const idle = { idle: 'Not started' };
  it('reports idle and active states', () => {
    expect(summarizeSteps([], 3, idle).label).toBe('Not started');
    expect(summarizeSteps([mk('ok')], 3, { ...idle, active: 'Running…' })).toEqual({ label: 'Running…', tone: 'active' });
  });
  it('reports a complete run', () => {
    expect(summarizeSteps([mk('ok'), mk('ok'), mk('ok')], 3, idle)).toEqual({ label: 'Complete, 3 of 3 successful', tone: 'ok' });
  });
  it('counts warnings as successful but says so', () => {
    expect(summarizeSteps([mk('ok'), mk('ok'), mk('warn')], 3, idle)).toEqual({ label: 'Complete, 3 of 3 successful (1 with warnings)', tone: 'warn' });
  });
  it('reports a stop on error', () => {
    expect(summarizeSteps([mk('ok'), mk('error'), mk('skipped')], 3, idle)).toEqual({ label: 'Stopped, 1 of 3 successful', tone: 'error' });
  });
  it('reports a server that needs no OAuth', () => {
    expect(summarizeSteps([mk('skipped'), mk('skipped'), mk('skipped')], 3, idle).label).toBe('Not applicable, 0 of 3 successful');
  });
  it('treats a partial registration failure as stopped', () => {
    expect(summarizeSteps([mk('error')], 3, idle).label).toBe('Stopped, 0 of 3 successful');
  });
});
