import { describe, expect, it } from 'vitest';

import { toJudgeConfig } from '../judge-config';

const rendered = (overrides: Partial<Parameters<typeof toJudgeConfig>[0]> = {}) => ({
  url: 'http://localhost:8500/might-be-openAI/chat/completions',
  headers: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Accept', value: 'text/event-stream' },
    { name: 'X-Off', value: 'nope', disabled: true },
  ],
  body: { text: '{"model":"4mini","stream":true,"messages":[]}' },
  ...overrides,
});

describe('toJudgeConfig', () => {
  it('keeps url and enabled headers, replacing an SSE Accept header with JSON', () => {
    const config = toJudgeConfig(rendered());
    expect(config.url).toBe('http://localhost:8500/might-be-openAI/chat/completions');
    expect(config.headers).toEqual({ 'Content-Type': 'application/json', 'Accept': 'application/json' });
  });

  it('parses the body as the template', () => {
    expect(toJudgeConfig(rendered()).body).toEqual({ model: '4mini', stream: true, messages: [] });
  });

  it('leaves the body undefined when it is not a JSON object', () => {
    expect(toJudgeConfig(rendered({ body: { text: 'plain text' } })).body).toBeUndefined();
    expect(toJudgeConfig(rendered({ body: { text: '[1,2]' } })).body).toBeUndefined();
    expect(toJudgeConfig(rendered({ body: {} })).body).toBeUndefined();
  });

  it('only includes system when there is some', () => {
    expect(toJudgeConfig(rendered())).not.toHaveProperty('system');
    expect(toJudgeConfig(rendered(), 'Be harsh.').system).toBe('Be harsh.');
  });
});
