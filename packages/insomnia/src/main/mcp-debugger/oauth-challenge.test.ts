import { describe, expect, it } from 'vitest';

import { protocolError } from '~/common/mcp-debugger/protocol/errors';

import { isOAuthChallenge } from './service';

describe('isOAuthChallenge', () => {
  const auth = (extra: object) => protocolError({ kind: 'auth', message: 'Authentication failed', status: 401, ...extra });
  it('is true for a 401 with a Bearer challenge', () => {
    expect(isOAuthChallenge(auth({ wwwAuthenticate: 'Bearer realm="x", resource_metadata="https://h/prm"' }))).toBe(true);
    expect(isOAuthChallenge(auth({ wwwAuthenticate: 'bearer' }))).toBe(true);
  });
  it('is false for other schemes, no challenge, other statuses and other errors', () => {
    expect(isOAuthChallenge(auth({ wwwAuthenticate: 'Basic realm="x"' }))).toBe(false);
    expect(isOAuthChallenge(auth({}))).toBe(false);
    expect(isOAuthChallenge(auth({ status: 403, wwwAuthenticate: 'Bearer' }))).toBe(false);
    expect(isOAuthChallenge(new Error('boom'))).toBe(false);
  });
});
