import { describe, expect, it } from 'vitest';

import { decodeJwt } from './jwt';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('decodeJwt', () => {
  it('decodes header and payload without verifying', () => {
    const token = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'u1', aud: 'mcp', exp: 1_900_000_000, name: 'Zoë' })}.sig`;
    expect(decodeJwt(token)).toEqual({ header: { alg: 'RS256', typ: 'JWT' }, payload: { sub: 'u1', aud: 'mcp', exp: 1_900_000_000, name: 'Zoë' } });
  });
  it('returns null for opaque tokens and garbage', () => {
    expect(decodeJwt('opaque-token-value')).toBeNull();
    expect(decodeJwt('a.b.c')).toBeNull();
    expect(decodeJwt(`${b64([1])}.${b64([1])}.s`)).toBeNull();
  });
});
