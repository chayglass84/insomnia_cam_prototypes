import { describe, expect, it } from 'vitest';

import {
  buildCurlPreview,
  groupTransformChanges,
  parseRequestTransformer,
  previewRequestTransformer,
  summarizeRequestTransformer,
} from './request-transformer';

const config = {
  http_method: 'POST',
  remove: { headers: ['X-Debug'], querystring: [], body: ['secret'] },
  rename: { headers: ['X-Old:X-New'] },
  replace: { uri: '/v2/flights', headers: ['Host:internal.example.com'] },
  add: { headers: ['X-Source:gateway', 'X-Trace:$(headers.x-request-id)'], querystring: ['via:kong'] },
  append: { headers: ['X-Tag:a:b'] },
};

describe('parseRequestTransformer', () => {
  it('parses every operation, splitting entries on the FIRST colon only', () => {
    const changes = parseRequestTransformer(config);
    expect(changes).toContainEqual({ op: 'append', target: 'headers', name: 'X-Tag', value: 'a:b', template: false });
    expect(changes).toContainEqual({ op: 'rename', target: 'headers', name: 'X-Old', value: 'X-New', template: false });
    expect(changes).toContainEqual({ op: 'remove', target: 'body', name: 'secret', value: undefined, template: false });
    expect(changes).toContainEqual({ op: 'replace', target: 'uri', name: '', value: '/v2/flights', template: false });
    expect(changes).toContainEqual({ op: 'replace', target: 'method', name: '', value: 'POST', template: false });
  });

  it('flags $(...) templates and lists operations in Kong order (remove before add)', () => {
    const changes = parseRequestTransformer(config);
    expect(changes.find(c => c.name === 'X-Trace')?.template).toBe(true);
    const ops = changes.filter(c => c.target === 'headers').map(c => c.op);
    expect(ops.indexOf('remove')).toBeLessThan(ops.indexOf('add'));
    expect(ops.indexOf('add')).toBeLessThan(ops.indexOf('append'));
  });

  it('copes with missing, null or empty sections', () => {
    expect(parseRequestTransformer({})).toEqual([]);
    expect(parseRequestTransformer({ remove: null, add: { headers: null }, http_method: null })).toEqual([]);
  });
});

describe('groupTransformChanges / summarizeRequestTransformer', () => {
  it('groups by target in display order and summarises with counts', () => {
    expect(groupTransformChanges(parseRequestTransformer(config)).map(g => g.target)).toEqual([
      'method',
      'uri',
      'headers',
      'querystring',
      'body',
    ]);
    expect(
      summarizeRequestTransformer({
        add: { headers: ['A:1', 'B:2'], querystring: ['q:1'] },
        remove: { headers: ['C'] },
      }),
    ).toBe('Changes: 3 headers, 1 param');
    expect(summarizeRequestTransformer({})).toBeNull();
  });
});

describe('previewRequestTransformer', () => {
  const req = {
    method: 'GET',
    url: 'https://api.example.com/flights?limit=5',
    headers: [
      { name: 'X-Debug', value: '1' },
      { name: 'X-Old', value: 'v' },
      { name: 'x-off', value: 'z', disabled: true },
    ],
    parameters: [{ name: 'limit', value: '5' }],
  };

  it('applies header rules: remove, rename, add-if-absent, replace-if-present, append', () => {
    const { rows } = previewRequestTransformer(
      {
        remove: { headers: ['x-debug'] },
        rename: { headers: ['X-Old:X-New'] },
        replace: { headers: ['X-Missing:nope', 'X-New:replaced'] },
        add: { headers: ['X-Source:gateway', 'X-New:ignored'] },
        append: { headers: ['X-Tag:a'] },
      },
      req,
    );
    const find = (name: string) => rows.find(r => r.name === name);
    expect(find('X-Debug')).toMatchObject({ kind: 'removed', before: '1' });
    expect(find('X-Old')).toMatchObject({ kind: 'removed' });
    expect(find('X-New')).toMatchObject({ kind: 'added', after: 'replaced' });
    expect(find('X-Source')).toMatchObject({ kind: 'added', after: 'gateway' });
    expect(find('X-Tag')).toMatchObject({ kind: 'added', after: 'a' });
    expect(find('X-Missing')).toBeUndefined();
    expect(find('x-off')).toBeUndefined();
  });

  it('handles query params (case-sensitive), URI and method, and flags templates', () => {
    const { rows, notes } = previewRequestTransformer(
      {
        add: { querystring: ['via:kong'], headers: ['X-Trace:$(headers.x-request-id)'] },
        replace: { uri: '/v2/flights' },
        http_method: 'POST',
      },
      req,
    );
    expect(rows.find(r => r.name === 'via')).toMatchObject({ target: 'querystring', kind: 'added', after: 'kong' });
    expect(rows.find(r => r.target === 'uri')).toMatchObject({ before: '/flights', after: '/v2/flights' });
    expect(rows.find(r => r.target === 'method')).toMatchObject({ before: 'GET', after: 'POST' });
    expect(rows.find(r => r.name === 'X-Trace')?.template).toBe(true);
    expect(notes.join(' ')).toContain('(template)');
  });

  it('previews JSON body rules and says when the body is not JSON', () => {
    const json = { ...req, bodyText: '{"keep":1,"secret":"s","old":"o"}' };
    const { rows } = previewRequestTransformer(
      { remove: { body: ['secret'] }, rename: { body: ['old:new'] }, add: { body: ['extra:x'] } },
      json,
    );
    expect(rows.map(r => `${r.kind}:${r.name}`).sort()).toEqual([
      'added:extra',
      'added:new',
      'removed:old',
      'removed:secret',
    ]);
    const text = previewRequestTransformer({ add: { body: ['a:b'] } }, { ...req, bodyText: 'not json' });
    expect(text.rows).toEqual([]);
    expect(text.notes.join(' ')).toContain("isn't a JSON object");
  });
});

describe('buildCurlPreview', () => {
  const req = {
    method: 'POST',
    url: 'https://api.example.com/flights?limit=5',
    headers: [
      { name: 'X-Debug', value: '1' },
      { name: 'Content-Type', value: 'application/json' },
    ],
    parameters: [{ name: 'page', value: '2' }],
    bodyText: '{"keep":1,"secret":"s"}',
  };
  const text = (l: { segments: { text: string }[] }) => l.segments.map(x => x.text).join('');

  it('renders a cURL with removed and added lines marked, and backslashes only on lines that stay', () => {
    const { lines } = buildCurlPreview(
      {
        remove: { headers: ['X-Debug'], body: ['secret'] },
        add: { headers: ['X-Source:gateway'], querystring: ['via:kong'], body: ['extra:x'] },
        replace: { uri: '/v2/flights' },
        http_method: 'PUT',
      },
      req,
    );
    const by = (needle: string) => lines.find(l => text(l).includes(needle))!;
    expect(text(lines[0])).toBe('curl --request POST PUT \\');
    expect(lines[0].segments.map(x => x.kind)).toEqual(['same', 'removed', 'added', 'same']);
    expect(by('--url').kind).toBe('changed');
    expect(text(by('--url'))).toContain('/flights/v2/flights?limit=5&page=2&via=kong');
    expect(by('X-Debug')).toMatchObject({ kind: 'removed' });
    expect(text(by('X-Debug'))).not.toContain('\\');
    expect(by('X-Source')).toMatchObject({ kind: 'added' });
    expect(by('"secret"').kind).toBe('removed');
    expect(by('"extra"').kind).toBe('added');
    expect(text(by('"keep"'))).toBe('    "keep": 1,');
    expect(text(by('"extra"'))).toBe('    "extra": "x"');
    expect(text(lines[lines.length - 1])).toBe("  }'");
    expect(text(by('Content-Type'))).toMatch(/ \\$/);
  });

  it('shows an untouched request as plain lines, and copes with a templated URL and a non-JSON body', () => {
    const { lines } = buildCurlPreview(
      { add: { headers: ['A:1'] } },
      { ...req, url: '{{ _.base }}/flights', bodyText: 'plain text' },
    );
    expect(lines.every(l => l.kind === 'same' || l.kind === 'added')).toBe(true);
    expect(text(lines.find(l => text(l).includes('--url'))!)).toContain('{{ _.base }}/flights');
    expect(text(lines[lines.length - 1])).toBe("  --data 'plain text'");
  });
});
