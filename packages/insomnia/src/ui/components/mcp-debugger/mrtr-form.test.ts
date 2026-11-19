import { describe, expect, it } from 'vitest';

import { assembleInputResponses, hasUrlModeRequest, isFlatObjectSchema, mergeAnswers } from './mrtr-form';

describe('mrtr form helpers', () => {
  it('treats only a non-empty, non-composed object schema as flat', () => {
    expect(isFlatObjectSchema({ type: 'object', properties: { a: {} } })).toBe(true);
    expect(isFlatObjectSchema({ type: 'object', properties: {} })).toBe(false);
    expect(isFlatObjectSchema({ type: 'string' })).toBe(false);
    expect(isFlatObjectSchema({ type: 'object', properties: { a: {} }, oneOf: [] } as never)).toBe(false);
    expect(isFlatObjectSchema()).toBe(false);
  });

  it('detects url-mode requests', () => {
    expect(hasUrlModeRequest({ k: { method: 'elicitation/create', params: { mode: 'url', url: 'https://x' } } })).toBe(true);
    expect(hasUrlModeRequest({ k: { method: 'elicitation/create', params: { message: 'hi' } } })).toBe(false);
  });

  it('attaches content only for accept', () => {
    expect(assembleInputResponses(['a'], 'accept', { a: { n: 1 } })).toEqual({ a: { action: 'accept', content: { n: 1 } } });
    expect(assembleInputResponses(['a'], 'decline', { a: { n: 1 } })).toEqual({ a: { action: 'decline' } });
  });

  it('parses raw JSON answers and names a bad key', () => {
    expect(mergeAnswers(['a'], {}, { a: '{"x":1}' })).toEqual({ ok: true, content: { a: { x: 1 } } });
    expect(mergeAnswers(['a'], {}, { a: '{nope' })).toEqual({ ok: false, error: 'Answer for "a" is not valid JSON.' });
    expect(mergeAnswers(['a'], {}, { a: '5' })).toEqual({ ok: false, error: 'Answer for "a" must be a JSON object.' });
  });
});
