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

  // Mirrors handleSendFollowUp's logic in realtime-response-pane.tsx: parse the current body,
  // append the just-finished turn's assistant reply plus the new user turn, then serialize.
  const appendTurn = (bodyText: string, assistantReply: string, userText: string): string => {
    const parsed = parseChatRequestBody(bodyText)!;
    return serializeChatRequestBody(bodyText, parsed.format, {
      model: parsed.model,
      messages: [...parsed.messages, { role: 'assistant', content: assistantReply }, { role: 'user', content: userText }],
    });
  };

  it('carries a mid-conversation system-prompt edit into the next turn sent to the model', () => {
    const turn1Body = JSON.stringify({
      model: 'claude-sonnet-5',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1024,
    });

    const turn2Body = appendTurn(turn1Body, 'Hello there.', 'Tell me a joke.');
    // Simulates the user hand-editing the Raw body's `system` field before sending the next turn —
    // this is exactly what the user did (editing mid-conversation), not a code path, so this
    // reassigns `system` the same way a raw JSON edit would.
    const turn2BodyWithEditedSystem = JSON.stringify({ ...JSON.parse(turn2Body), system: 'Speak like a pirate.' });

    const turn3Body = appendTurn(turn2BodyWithEditedSystem, 'Why did the chicken cross the road?', 'Tell me another.');

    const turn3Parsed = JSON.parse(turn3Body);
    expect(turn3Parsed.system).toBe('Speak like a pirate.');
    expect(turn3Parsed.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello there.' },
      { role: 'user', content: 'Tell me a joke.' },
      { role: 'assistant', content: 'Why did the chicken cross the road?' },
      { role: 'user', content: 'Tell me another.' },
    ]);
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
