import { describe, expect, it } from 'vitest';

import { diffJson, hasChanges } from './line-diff';

describe('diffJson', () => {
  it('reports no changes for equal values', () => {
    expect(hasChanges(diffJson({ a: 1 }, { a: 1 }))).toBe(false);
  });

  it('marks changed and added lines', () => {
    const lines = diffJson({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    expect(lines.filter(l => l.kind === 'remove').map(l => l.text.trim())).toEqual(['"b": 2']);
    expect(lines.filter(l => l.kind === 'add').map(l => l.text.trim())).toEqual(['"b": 3,', '"c": 4']);
  });
});
