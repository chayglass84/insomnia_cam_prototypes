import { describe, expect, it } from 'vitest';

import { parseChatRequestBody, serializeChatRequestBody } from './chat-request';

describe('parseChatRequestBody', () => {
  it('parses an OpenAI-style request body', () => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
      ],
    });
    expect(parseChatRequestBody(body)).toEqual({
      format: 'openai',
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
      ],
    });
  });

  it('parses an Anthropic-style request body, folding system into messages', () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-5',
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1024,
    });
    expect(parseChatRequestBody(body)).toEqual({
      format: 'anthropic',
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
      ],
    });
  });

  it('parses a Gemini-style request body', () => {
    const body = JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello' }] },
      ],
    });
    expect(parseChatRequestBody(body)).toEqual({
      format: 'gemini',
      model: undefined,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ],
    });
  });

  it('returns null for non-chat JSON', () => {
    expect(parseChatRequestBody(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });

  it('returns null (does not throw) for malformed JSON', () => {
    expect(() => parseChatRequestBody('not json')).not.toThrow();
    expect(parseChatRequestBody('not json')).toBeNull();
  });
});

describe('serializeChatRequestBody round-trips', () => {
  it('round-trips an OpenAI-style body', () => {
    const original = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const parsed = parseChatRequestBody(original)!;
    const serialized = serializeChatRequestBody(original, parsed.format, parsed);
    expect(parseChatRequestBody(serialized)).toEqual(parsed);
  });

  it('round-trips an Anthropic-style body', () => {
    const original = JSON.stringify({
      model: 'claude-sonnet-5',
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    const parsed = parseChatRequestBody(original)!;
    const serialized = serializeChatRequestBody(original, parsed.format, parsed);
    expect(parseChatRequestBody(serialized)).toEqual(parsed);
  });

  it('round-trips a Gemini-style body', () => {
    const original = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
    });
    const parsed = parseChatRequestBody(original)!;
    const serialized = serializeChatRequestBody(original, parsed.format, parsed);
    expect(parseChatRequestBody(serialized)).toEqual(parsed);
  });

  it('preserves untouched fields like max_tokens and temperature', () => {
    const original = JSON.stringify({
      model: 'claude-sonnet-5',
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1024,
      temperature: 0.7,
    });
    const parsed = parseChatRequestBody(original)!;
    const serialized = serializeChatRequestBody(original, parsed.format, parsed);
    const reparsed = JSON.parse(serialized);
    expect(reparsed.max_tokens).toBe(1024);
    expect(reparsed.temperature).toBe(0.7);
  });
});
