import { describe, expect, it } from 'vitest';

import { fromEditable, singleUseNote, toEditable } from './oauth-replay';

const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

describe('oauth replay editing', () => {
  it('shows a form body as an object and re-encodes it after an edit', () => {
    const editable = toEditable(
      { method: 'POST', url: 'http://x/token', body: 'grant_type=authorization_code&code=abc&resource=http%3A%2F%2Fmcp' },
      formHeaders,
    );
    expect(editable.body).toEqual({ grant_type: 'authorization_code', code: 'abc', resource: 'http://mcp' });
    const { resource: _dropped, ...rest } = editable.body as Record<string, string>;
    const result = fromEditable(JSON.stringify({ ...editable, body: rest }));
    expect('request' in result && result.request.body).toBe('grant_type=authorization_code&code=abc');
  });

  it('keeps repeated form keys as an array and round-trips them', () => {
    const editable = toEditable({ method: 'POST', url: 'http://x', body: 'a=1&a=2' }, formHeaders);
    expect(editable.body).toEqual({ a: ['1', '2'] });
    const result = fromEditable(JSON.stringify(editable));
    expect('request' in result && result.request.body).toBe('a=1&a=2');
  });

  it('leaves JSON bodies as objects', () => {
    const editable = toEditable({ method: 'POST', url: 'http://x', body: { a: 1 } }, { 'content-type': 'application/json' });
    const result = fromEditable(JSON.stringify(editable));
    expect('request' in result && result.request.body).toEqual({ a: 1 });
  });

  it('rejects a bad method, url or headers', () => {
    expect(fromEditable('{"method":"","url":"http://x"}')).toHaveProperty('error');
    expect(fromEditable('{"method":"GET","url":"ftp://x"}')).toHaveProperty('error');
    expect(fromEditable('{"method":"GET","url":"http://x","headers":{"a":1}}')).toHaveProperty('error');
    expect(fromEditable('nope')).toHaveProperty('error');
  });

  it('flags single-use credentials', () => {
    expect(singleUseNote({ body: 'grant_type=authorization_code&code=1' })).toMatch(/works once/);
    expect(singleUseNote({ body: 'grant_type=refresh_token&refresh_token=1' })).toMatch(/rotate/);
    expect(singleUseNote({ body: 'client_id=1' })).toBeUndefined();
    expect(singleUseNote({})).toBeUndefined();
  });
});
