import type { AiGatewayModel } from 'insomnia-data';
import { describe, expect, it } from 'vitest';

import {
  applyAiGatewayModelOverride,
  buildAiGatewayRequestSpec,
  getAiGatewayModelSuggestions,
  groupModelsByPath,
  withUsageFromResponseBody,
} from '../transform';

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
    expect(spec.path).toBe('/openai/chat/completions');
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

describe('applyAiGatewayModelOverride', () => {
  const catalog = [opus, fable, sonnet];
  const request = {
    url: 'http://{{ _.proxy_host }}/anthropic/v1/messages?x=1',
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Accept', value: 'text/event-stream' },
    ],
    body: {
      text: JSON.stringify({
        model: 'opus',
        stream: true,
        max_tokens: 4096,
        system: 'Hi',
        messages: [{ role: 'user', content: 'Q' }],
      }),
    },
  };

  it('retargets path and model, turns streaming off, keeps the rest of the body and the query', () => {
    const result = applyAiGatewayModelOverride(request, sonnet, catalog);
    expect('skipReason' in result).toBe(false);
    if ('skipReason' in result) {
      return;
    }
    expect(result.url).toBe('http://{{ _.proxy_host }}/other-anthropic/v1/messages?x=1');
    expect(JSON.parse(result.bodyText)).toMatchObject({
      model: 'sonnet',
      stream: false,
      max_tokens: 4096,
      system: 'Hi',
    });
    expect(result.headers.find(h => h.name === 'Accept')?.value).toBe('application/json');
  });

  it('keeps the same route when the target shares it', () => {
    const result = applyAiGatewayModelOverride(request, fable, catalog);
    if ('skipReason' in result) {
      throw new Error(result.skipReason);
    }
    expect(result.url).toBe('http://{{ _.proxy_host }}/anthropic/v1/messages?x=1');
    expect(JSON.parse(result.bodyText).model).toBe('fable');
  });

  it('skips when the target has a different format', () => {
    const gpt = model({ id: 'gpt', format: 'openai', paths: ['/openai'], routeModelValues: ['gpt'] });
    const result = applyAiGatewayModelOverride(request, gpt, [...catalog, gpt]);
    expect('skipReason' in result && result.skipReason).toBe(
      "This request uses the anthropic format, but gpt (target) uses the openai format, and the two request bodies aren't compatible.",
    );
  });

  it('skips when the URL matches no route or the body is not a chat request', () => {
    const noRoute = applyAiGatewayModelOverride({ ...request, url: 'http://localhost:8000/elsewhere' }, opus, catalog);
    expect('skipReason' in noRoute && noRoute.skipReason).toContain("URL doesn't match any route");
    const notChat = applyAiGatewayModelOverride({ ...request, body: { text: '{"hello":1}' } }, opus, catalog);
    expect('skipReason' in notChat && notChat.skipReason).toContain("body isn't a chat request");
  });
});

describe('withUsageFromResponseBody', () => {
  const info = { alias: 'fable', model: 'claude-fable-5' };
  const body = JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-fable-5-20260101',
    content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'Hello' },
    ],
    usage: { input_tokens: 44, output_tokens: 379 },
  });

  it('reads usage and the provider-reported model from a string body', () => {
    expect(withUsageFromResponseBody(info, body)).toEqual({
      alias: 'fable',
      model: 'claude-fable-5-20260101',
      inputTokens: 44,
      outputTokens: 379,
    });
  });

  it('reads a Uint8Array body, which is what a Buffer becomes over IPC', () => {
    const result = withUsageFromResponseBody(info, new TextEncoder().encode(body));
    expect(result).toMatchObject({ inputTokens: 44, outputTokens: 379 });
  });

  it('keeps the catalog model and reports no usage when the body is not a chat completion', () => {
    expect(withUsageFromResponseBody(info, '{"error":"nope"}')).toEqual({
      alias: 'fable',
      model: 'claude-fable-5',
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });
});
