import { describe, expect, it } from 'vitest';

import { extractChatCompletion, supportsStreaming } from './chat-completion';

describe('extractChatCompletion', () => {
  it('extracts an OpenAI chat completion response', () => {
    const response = JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    expect(extractChatCompletion(response)).toEqual({
      messages: [{ role: 'assistant', content: 'Hi there' }],
      model: 'gpt-4o-mini',
      usage: { inputTokens: 10, outputTokens: 3 },
      stopReason: 'stop',
    });
  });

  it('extracts an Anthropic messages response', () => {
    const response = JSON.stringify({
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Hi there' }],
      usage: { input_tokens: 10, output_tokens: 3 },
      stop_reason: 'end_turn',
    });
    expect(extractChatCompletion(response)).toEqual({
      messages: [{ role: 'assistant', content: 'Hi there' }],
      model: 'claude-sonnet-5',
      usage: { inputTokens: 10, outputTokens: 3 },
      stopReason: 'end_turn',
    });
  });

  it('extracts a Gemini generateContent response', () => {
    const response = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Hi there' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    });
    expect(extractChatCompletion(response)).toEqual({
      messages: [{ role: 'assistant', content: 'Hi there' }],
      usage: { inputTokens: 10, outputTokens: 3 },
      stopReason: 'STOP',
    });
  });

  it('returns null for non-matching JSON', () => {
    expect(extractChatCompletion(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });

  it('returns null (does not throw) for malformed JSON', () => {
    expect(() => extractChatCompletion('not json')).not.toThrow();
    expect(extractChatCompletion('not json')).toBeNull();
  });

  it('folds Anthropic request system + messages in ahead of the assistant reply', () => {
    const requestBody = JSON.stringify({
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    const response = JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
      usage: { input_tokens: 5, output_tokens: 1 },
      stop_reason: 'end_turn',
    });
    expect(extractChatCompletion(response, requestBody)).toEqual({
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Say hi' },
        { role: 'assistant', content: 'Hi' },
      ],
      usage: { inputTokens: 5, outputTokens: 1 },
      stopReason: 'end_turn',
    });
  });

  it('ignores an unparseable request body rather than throwing', () => {
    const response = JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi' }],
    });
    expect(() => extractChatCompletion(response, 'mid-edit {')).not.toThrow();
    expect(extractChatCompletion(response, 'mid-edit {')).toEqual({
      messages: [{ role: 'assistant', content: 'Hi' }],
      model: undefined,
      usage: undefined,
      stopReason: undefined,
    });
  });
});

describe('supportsStreaming', () => {
  it('is true for a known streaming endpoint', () => {
    expect(supportsStreaming('https://api.anthropic.com/v1/messages')).toBe(true);
  });

  it('is false for an unknown endpoint', () => {
    expect(supportsStreaming('https://example.com/v1/unknown')).toBe(false);
  });
});
