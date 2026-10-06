import type { AiGatewayModel } from 'insomnia-data';
import { describe, expect, it } from 'vitest';

import { buildAiGatewayRequestSpec, getAiGatewayModelSuggestions, groupModelsByPath } from '../transform';

const model = (overrides: Partial<AiGatewayModel>): AiGatewayModel => ({
  id: 'm',
  displayName: 'Model',
  targetModel: 'target',
  provider: 'claude',
  format: 'anthropic',
  paths: ['/anthropic'],
  routeModelValues: ['opus'],
  enabled: true,
  ...overrides,
});

const opus = model({ id: 'opus', displayName: 'Opus' });
const fable = model({ id: 'fable', displayName: 'Fable', routeModelValues: ['fable'] });
const sonnet = model({
  id: 'sonnet',
  displayName: 'Sonnet',
  paths: ['/other-anthropic'],
  routeModelValues: ['sonnet'],
});

describe('groupModelsByPath', () => {
  it('groups models sharing a path and sorts by path', () => {
    const groups = groupModelsByPath([sonnet, opus, fable]);
    expect(groups.map(([path, models]) => [path, models.map(m => m.id)])).toEqual([
      ['/anthropic', ['opus', 'fable']],
      ['/other-anthropic', ['sonnet']],
    ]);
  });
});

describe('buildAiGatewayRequestSpec', () => {
  it('appends the anthropic endpoint and enables streaming', () => {
    const spec = buildAiGatewayRequestSpec('/anthropic', [opus, fable]);
    expect(spec.path).toBe('/anthropic/v1/messages');
    expect(JSON.parse(spec.body!)).toMatchObject({
      model: 'opus',
      stream: true,
      max_tokens: 4096,
      system: 'Be a helpful assistant.',
      messages: [{ role: 'user', content: 'Tell me how Kong AI Gateway can help me, in five concise bullet points.' }],
    });
  });

  it('appends the openai endpoint', () => {
    const spec = buildAiGatewayRequestSpec('/openai', [model({ format: 'openai', paths: ['/openai'] })]);
    expect(spec.path).toBe('/openai/v1/chat/completions');
    const body = JSON.parse(spec.body!);
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  });

  it('falls back to the bare route path for unsupported formats', () => {
    const spec = buildAiGatewayRequestSpec('/g', [model({ format: 'gemini', paths: ['/g'] })]);
    expect(spec.path).toBe('/g');
    expect(spec.body).toBeUndefined();
    expect(spec.description).toContain('gemini');
  });
});

describe('getAiGatewayModelSuggestions', () => {
  const models = [opus, fable, sonnet];

  it('returns the route model values for the matching path, ignoring the templated host', () => {
    expect(getAiGatewayModelSuggestions('http://{{ _.proxy_host }}/anthropic/v1/messages', models)).toEqual([
      'opus',
      'fable',
    ]);
  });

  it('does not confuse /anthropic with /other-anthropic', () => {
    expect(getAiGatewayModelSuggestions('http://localhost:8000/other-anthropic/v1/messages?x=1', models)).toEqual([
      'sonnet',
    ]);
  });

  it('returns null when no route matches', () => {
    expect(getAiGatewayModelSuggestions('http://localhost:8000/elsewhere', models)).toBeNull();
  });
});
