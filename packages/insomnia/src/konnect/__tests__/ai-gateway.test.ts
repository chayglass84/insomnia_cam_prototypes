import type { AiGatewayModel } from 'insomnia-data';
import { describe, expect, it } from 'vitest';

import {
  applyAiGatewayModelOverride,
  buildAiGatewayRequestSpec,
  findCatalogModelByRequest,
  findCatalogModelByResponseModel,
  getAiGatewayModelSuggestions,
  groupModelsByPath,
  isRotatingModel,
  modelTargets,
  pickLlmPrice,
  priceChatTurn,
  selectAppliedAiGatewayPolicies,
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

describe('pickLlmPrice', () => {
  const price = (provider: string, id: string, input: string, output: string) => ({
    provider: { id: provider },
    model: { id },
    pricing: { input_per_token: input, output_per_token: output },
  });
  const prices = [
    price('bedrock', 'anthropic.claude-opus-4-6-v1', '0.0000055', '0.0000275'),
    price('anthropic', 'claude-opus-4-6', '0.000005', '0.000025'),
    price('azure', 'gpt-4.1-mini', '0.0000005', '0.000002'),
    price('openai', 'gpt-4.1-mini', '0.0000004', '0.0000016'),
  ];

  it('matches the exact model id only, not regional/cloud variants', () => {
    expect(pickLlmPrice(prices, 'claude-opus-4-6', 'claude')).toEqual({
      inputPerToken: 0.000_005,
      outputPerToken: 0.000_025,
    });
    expect(pickLlmPrice(prices, 'claude-opus', 'claude')).toBeNull();
  });

  it('prefers the provider named like the gateway provider entity when several list the id', () => {
    expect(pickLlmPrice(prices, 'gpt-4.1-mini', 'openai')?.inputPerToken).toBe(0.000_000_4);
    expect(pickLlmPrice(prices, 'gpt-4.1-mini', 'azure')?.inputPerToken).toBe(0.000_000_5);
  });

  it('returns null for unparseable prices', () => {
    expect(pickLlmPrice([price('openai', 'x', 'free', 'free')], 'x', 'openai')).toBeNull();
  });
});

describe('catalog lookups for cost', () => {
  const nano = model({
    id: 'nano',
    format: 'openai',
    paths: ['/might-be-openAI'],
    routeModelValues: ['nano4.1'],
    targetModel: 'gpt-4.1-nano',
  });
  const full = model({
    id: 'full',
    format: 'openai',
    paths: ['/might-be-openAI'],
    routeModelValues: ['full'],
    targetModel: 'gpt-4.1',
  });
  const catalog = [full, nano, opus];

  it('finds a model from the provider-reported dated id, preferring the longest target', () => {
    expect(findCatalogModelByResponseModel('gpt-4.1-nano-2025-04-14', catalog)?.id).toBe('nano');
    expect(findCatalogModelByResponseModel('gpt-4.1-2025-04-14', catalog)?.id).toBe('full');
    expect(findCatalogModelByResponseModel('gpt-4.1', catalog)?.id).toBe('full');
    expect(findCatalogModelByResponseModel('claude-unknown', catalog)).toBeUndefined();
  });

  it('finds a model from the request URL and body alias', () => {
    expect(
      findCatalogModelByRequest('http://{{ _.proxy_host }}/might-be-openAI/chat/completions', 'nano4.1', catalog)?.id,
    ).toBe('nano');
    expect(
      findCatalogModelByRequest('http://localhost:8500/anthropic/v1/messages', 'nano4.1', catalog),
    ).toBeUndefined();
  });
});

describe('withUsageFromResponseBody cost', () => {
  const body = JSON.stringify({
    id: 'x',
    object: 'chat.completion',
    model: 'gpt-4.1-nano-2025-04-14',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });

  it('adds costUsd when the target has a price', () => {
    const result = withUsageFromResponseBody({ alias: 'nano4.1', model: 'gpt-4.1-nano' }, body, {
      inputPerToken: 0.000_000_1,
      outputPerToken: 0.000_000_4,
    });
    expect(result.costUsd).toBeCloseTo(0.000_001_8, 12);
  });

  it('leaves costUsd out when there is no price', () => {
    expect('costUsd' in withUsageFromResponseBody({ alias: 'a', model: 'm' }, body)).toBe(false);
  });
});

describe('selectAppliedAiGatewayPolicies', () => {
  const policy = (id: string, name: string, global: boolean) => ({
    id,
    name,
    display_name: name,
    type: 'rate-limiting',
    enabled: true,
    global,
    config: {},
  });
  const policies = [
    policy('p-global', 'global-limit', true),
    policy('p-model', 'opus-only', false),
    policy('p-other', 'other', false),
  ];

  it('lists model-attached policies first, then global ones, and ignores policies attached to other models', () => {
    const applied = selectAppliedAiGatewayPolicies(policies, ['p-model']);
    expect(applied.map(a => [a.policy.name, a.scope])).toEqual([
      ['opus-only', 'Model'],
      ['global-limit', 'Global'],
    ]);
  });

  it('matches attached policies by name as well as id, and lists a global+attached policy once, as global', () => {
    expect(selectAppliedAiGatewayPolicies(policies, ['opus-only']).map(a => a.policy.id)).toEqual([
      'p-model',
      'p-global',
    ]);
    expect(selectAppliedAiGatewayPolicies(policies, ['p-global']).map(a => a.scope)).toEqual(['Global']);
  });

  it('returns only the global policies when the model is unknown', () => {
    expect(selectAppliedAiGatewayPolicies(policies).map(a => a.policy.id)).toEqual(['p-global']);
  });
});

describe('rotating models (several targets behind one alias)', () => {
  const rotating = model({
    id: 'nano',
    format: 'openai',
    provider: 'openai',
    targetModel: 'gpt-4.1-nano',
    paths: ['/rotating-openAI'],
    routeModelValues: ['nano4.1'],
    targets: [
      { name: 'gpt-4.1-nano', provider: 'openai', inputPerToken: 1, outputPerToken: 2 },
      { name: 'gpt-5-nano', provider: 'openai', inputPerToken: 10, outputPerToken: 20 },
    ],
  });

  it('is rotating only with more than one target', () => {
    expect(isRotatingModel(rotating)).toBe(true);
    expect(isRotatingModel(opus)).toBe(false);
    expect(modelTargets(opus)).toEqual([expect.objectContaining({ name: 'target' })]);
  });

  it('prices a response by the target that answered, not the first one', () => {
    const body = JSON.stringify({
      model: 'gpt-5-nano-2025-08-07',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const info = { alias: 'nano4.1', model: '', rotating: true };
    expect(withUsageFromResponseBody(info, body, rotating)).toMatchObject({
      model: 'gpt-5-nano-2025-08-07',
      costUsd: 3 * 10 + 4 * 20,
    });
  });

  it('finds the catalog model through any of its targets, carrying that target price', () => {
    expect(findCatalogModelByResponseModel('gpt-5-nano-2025-08-07', [rotating])).toMatchObject({
      id: 'nano',
      targetModel: 'gpt-5-nano',
      inputPerToken: 10,
    });
  });
});

describe('priceChatTurn', () => {
  const priced = model({
    id: 'priced',
    paths: ['/anthropic'],
    routeModelValues: ['opus'],
    targetModel: 'claude-opus-4-6',
    inputPerToken: 1,
    outputPerToken: 2,
  });
  const rotating = model({
    id: 'rot',
    paths: ['/rotating'],
    routeModelValues: ['nano'],
    targets: [
      { name: 'gpt-4.1-nano', provider: 'openai', inputPerToken: 1, outputPerToken: 1 },
      { name: 'gpt-5-nano', provider: 'openai', inputPerToken: 10, outputPerToken: 10 },
    ],
  });
  const usage = { inputTokens: 2, outputTokens: 3 };

  it('prices by the model that answered', () => {
    expect(priceChatTurn({ model: 'claude-opus-4-6-2026', usage }, {}, [priced])).toEqual({ costUsd: 8 });
  });

  it('falls back to the request route + alias when the response model is just the alias', () => {
    expect(
      priceChatTurn(
        { model: 'opus', usage },
        { url: 'http://{{ _.proxy_host }}/anthropic/v1/messages', alias: 'opus' },
        [priced],
      ),
    ).toEqual({
      costUsd: 8,
    });
  });

  it('will not guess a price for a rotating alias without the answering model', () => {
    expect(
      priceChatTurn({ model: 'nano', usage }, { url: 'http://h/rotating/chat/completions', alias: 'nano' }, [rotating]),
    ).toEqual({
      costUsd: null,
      costNote: 'rotating',
    });
    expect(priceChatTurn({ model: 'gpt-5-nano-2025-08-07', usage }, {}, [rotating])).toEqual({ costUsd: 50 });
  });

  it('reports no price rather than zero, and nothing outside a gateway workspace', () => {
    expect(priceChatTurn({ model: 'mystery', usage }, {}, [priced])).toEqual({ costUsd: null, costNote: 'no-price' });
    expect(priceChatTurn({ model: 'x', usage }, {}, [])).toEqual({ costUsd: null });
  });
});
