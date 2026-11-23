import { describe, expect, it } from 'vitest';

import type { Capability } from '~/common/mcp-debugger/protocol/Protocol';

import { clampHeight, decideAppRequest, initialAppNotifications } from './app-bridge';

const tool = (name: string, visibility?: ('model' | 'app')[]) =>
  ({ type: 'tool', metadata: { name }, ...(visibility ? { ui: { visibility } } : {}) }) as unknown as Capability;
const ctx = { toolName: 'ui-chart', theme: 'dark' as const, tools: [tool('ui-chart', ['model', 'app']), tool('model-only', ['model'])] };

describe('decideAppRequest', () => {
  it('answers ui/initialize with the host context', () => {
    const d = decideAppRequest({ id: 1, method: 'ui/initialize' }, ctx);
    expect(d).toMatchObject({ kind: 'reply', result: { hostContext: { theme: 'dark', displayMode: 'inline', toolInfo: { tool: { name: 'ui-chart' } } } } });
  });

  it('relays tools/call, but enforces _meta.ui.visibility', () => {
    expect(decideAppRequest({ id: 2, method: 'tools/call', params: { name: 'ui-chart' } }, ctx).kind).toBe('relay');
    expect(decideAppRequest({ id: 3, method: 'tools/call', params: { name: 'model-only' } }, ctx)).toMatchObject({ kind: 'error', code: -32_000 });
    expect(decideAppRequest({ id: 4, method: 'tools/call', params: { name: 'unlisted' } }, ctx).kind).toBe('relay');
  });

  it('logs ui/message, declines links, refuses unknown methods', () => {
    expect(decideAppRequest({ id: 5, method: 'ui/message' }, ctx)).toMatchObject({ kind: 'reply', log: expect.stringMatching(/model/) });
    expect(decideAppRequest({ id: 6, method: 'ui/open-link', params: { url: 'https://example.com' } }, ctx).kind).toBe('error');
    expect(decideAppRequest({ id: 7, method: 'sampling/createMessage' }, ctx)).toMatchObject({ kind: 'error', code: -32_601 });
    expect(decideAppRequest({ id: 8, method: 'prompts/list' }, ctx)).toMatchObject({ kind: 'error', code: -32_601 });
  });

  it('pushes the tool input and result once the app is initialized', () => {
    const [input, result] = initialAppNotifications({ a: 1 }, { content: [] });
    expect(input).toMatchObject({ method: 'ui/notifications/tool-input', params: { arguments: { a: 1 } } });
    expect(result).toMatchObject({ method: 'ui/notifications/tool-result', params: { content: [] } });
  });

  it('clamps reported sizes', () => {
    expect(clampHeight(50)).toBe(120);
    expect(clampHeight(5000)).toBe(900);
    expect(clampHeight(300.2)).toBe(301);
    expect(clampHeight('x')).toBeNull();
  });
});
