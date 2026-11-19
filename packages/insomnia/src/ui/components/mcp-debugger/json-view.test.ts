import { describe, expect, it } from 'vitest';

import { tokenizeJson } from './json-view';

describe('tokenizeJson', () => {
  it('classifies keys, strings, numbers and atoms', () => {
    const classes = Object.fromEntries(
      tokenizeJson('{\n  "a": "x",\n  "b": 12,\n  "c": null\n}')
        .filter(p => p.className)
        .map(p => [p.text, p.className]),
    );
    expect(classes['"a"']).toBe('text-(--color-success)');
    expect(classes['"x"']).toBe('text-(--color-notice)');
    expect(classes['12']).toBe('text-(--color-surprise)');
    expect(classes['null']).toBe('text-(--color-surprise)');
  });

  it('preserves the text exactly', () => {
    const text = JSON.stringify({ a: [1, true, 'q"uote'], b: { c: -1.5e3 } }, null, 2);
    expect(
      tokenizeJson(text)
        .map(p => p.text)
        .join(''),
    ).toBe(text);
  });
});
