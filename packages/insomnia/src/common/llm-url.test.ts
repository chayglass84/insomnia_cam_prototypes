import { describe, expect, it } from 'vitest';

import {
  autoConvertImportedRequest,
  buildLlmUrlConversion,
  detectLlmUrl,
  isModelMissingInBody,
  shouldAutoConvertLlmUrl,
} from './llm-url';

describe('detectLlmUrl', () => {
  it.each([
    ['https://api.openai.com/v1/chat/completions', 'openai'],
    ['http://localhost:8500/might-be-openAI/chat/completions', 'openai'],
    ['https://api.anthropic.com/v1/messages', 'anthropic'],
    ['http://localhost:8500/anthropic/v1/messages', 'anthropic'],
    ['http://localhost:8500/anthropic/v1/messages/', 'anthropic'],
    ['http://localhost:8500/x/chat/completions?api-version=1#frag', 'openai'],
    ['{{ _.base_url }}/chat/completions', 'openai'],
    ['HTTPS://HOST/V1/MESSAGES', 'anthropic'],
  ])('matches %s', (url, format) => {
    expect(detectLlmUrl(url)).toBe(format);
  });

  it.each([
    '',
    'https://example.com',
    'https://example.com/api/chat-history',
    'https://example.com/chat/completions/123',
    'https://example.com/v1/messages/abc',
    'https://example.com/?next=/chat/completions',
    'https://example.com/v1/responses',
  ])('does not match %s', url => {
    expect(detectLlmUrl(url)).toBeNull();
  });

  it('handles a null URL', () => {
    expect(detectLlmUrl(null)).toBeNull();
  });
});

describe('shouldAutoConvertLlmUrl', () => {
  it('fires only when going from blank to an LLM URL', () => {
    expect(shouldAutoConvertLlmUrl('', 'https://x/chat/completions')).toBe('openai');
    expect(shouldAutoConvertLlmUrl(null, 'https://x/v1/messages')).toBe('anthropic');
    expect(shouldAutoConvertLlmUrl('   ', 'https://x/v1/messages')).toBe('anthropic');
  });

  it('never fires when the URL was already filled in', () => {
    expect(shouldAutoConvertLlmUrl('https://x', 'https://x/chat/completions')).toBeNull();
    expect(shouldAutoConvertLlmUrl('https://x/chat/completions', 'https://y/chat/completions')).toBeNull();
  });

  it('does not fire for blank to a non-LLM URL', () => {
    expect(shouldAutoConvertLlmUrl('', 'https://example.com')).toBeNull();
  });
});

describe('buildLlmUrlConversion', () => {
  const blank = { method: 'GET', headers: [], body: {} };

  it('builds an OpenAI streaming request from a blank request', () => {
    const patch = buildLlmUrlConversion('openai', blank);
    expect(patch.method).toBe('POST');
    expect(patch.headers).toEqual([
      { name: 'Accept', value: 'text/event-stream' },
      { name: 'Content-Type', value: 'application/json' },
    ]);
    expect(patch.body.mimeType).toBe('application/json');
    expect(JSON.parse(patch.body.text!)).toEqual({
      model: '',
      stream: true,
      messages: [{ role: 'user', content: 'Hello!' }],
      stream_options: { include_usage: true },
    });
  });

  it('builds an Anthropic request with max_tokens and no stream_options', () => {
    const body = JSON.parse(buildLlmUrlConversion('anthropic', blank).body.text!);
    expect(body).toEqual({ model: '', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'Hello!' }] });
  });

  it('merges into an existing body and keeps the user fields', () => {
    const patch = buildLlmUrlConversion('openai', {
      method: 'POST',
      headers: [
        { name: 'accept', value: 'application/json' },
        { name: 'content-type', value: 'application/json' },
      ],
      body: { mimeType: 'application/json', text: '{"model":"4mini","temperature":0.2,"messages":[{"role":"user","content":"hi"}]}' },
    });
    const body = JSON.parse(patch.body.text!);
    expect(body.model).toBe('4mini');
    expect(body.temperature).toBe(0.2);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.stream).toBe(true);
    // case-insensitive: reuses existing headers instead of duplicating them
    expect(patch.headers).toEqual([
      { name: 'accept', value: 'text/event-stream' },
      { name: 'content-type', value: 'application/json' },
    ]);
  });

  it('replaces an unparseable body with the starter', () => {
    const body = JSON.parse(buildLlmUrlConversion('anthropic', { ...blank, body: { text: 'not json' } }).body.text!);
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello!' }]);
  });
});

describe('isModelMissingInBody', () => {
  it('is true for a missing, empty, blank or non-string model', () => {
    expect(isModelMissingInBody('{"messages":[]}')).toBe(true);
    expect(isModelMissingInBody('{"model":""}')).toBe(true);
    expect(isModelMissingInBody('{"model":"   "}')).toBe(true);
    expect(isModelMissingInBody('{"model":5}')).toBe(true);
  });

  it('is false when a model is set', () => {
    expect(isModelMissingInBody('{"model":"4mini"}')).toBe(false);
  });

  it('is false when it cannot tell (no body, not JSON, not an object)', () => {
    expect(isModelMissingInBody('')).toBe(false);
    expect(isModelMissingInBody()).toBe(false);
    expect(isModelMissingInBody('not json')).toBe(false);
    expect(isModelMissingInBody('[1]')).toBe(false);
  });
});

describe('autoConvertImportedRequest', () => {
  it('converts an imported LLM request, keeping its own body fields', () => {
    const converted = autoConvertImportedRequest<Record<string, any>>({
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      name: 'keep me',
      headers: [{ name: 'Authorization', value: 'Bearer x' }],
      body: { mimeType: 'application/json', text: '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}]}' },
    });
    expect(converted.name).toBe('keep me');
    expect(converted.method).toBe('POST');
    expect(converted.headers).toEqual([
      { name: 'Authorization', value: 'Bearer x' },
      { name: 'Accept', value: 'text/event-stream' },
      { name: 'Content-Type', value: 'application/json' },
    ]);
    const body = JSON.parse(converted.body.text!);
    expect(body.model).toBe('gpt-4.1');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.stream).toBe(true);
  });

  it('handles a request with no method, headers or body', () => {
    const converted = autoConvertImportedRequest<Record<string, any>>({ url: 'https://x/v1/messages' });
    expect(converted.method).toBe('POST');
    expect(JSON.parse(converted.body.text).stream).toBe(true);
  });

  it('returns non-LLM requests untouched (same object)', () => {
    const request = { url: 'https://example.com/users', method: 'GET' };
    expect(autoConvertImportedRequest(request)).toBe(request);
  });

  it('leaves a non-JSON or non-object body alone', () => {
    const form = { url: 'https://x/chat/completions', body: { mimeType: 'multipart/form-data', text: 'a=b' } };
    const array = { url: 'https://x/chat/completions', body: { text: '[1,2]' } };
    expect(autoConvertImportedRequest(form)).toBe(form);
    expect(autoConvertImportedRequest(array)).toBe(array);
  });
});
