import { describe, expect, it } from 'vitest';

import { oauthPromptKind, oauthPromptText } from './oauth-prompt';

const base = { oauthRequired: true, status: 'error', dismissed: false };

describe('oauthPromptKind', () => {
  it('offers sign-in when nothing is configured', () => {
    expect(oauthPromptKind({ ...base, authType: undefined })).toBe('sign-in');
    expect(oauthPromptKind({ ...base, authType: 'none' })).toBe('sign-in');
  });

  it('still shows when auth is configured, because a stale token is the common case', () => {
    expect(oauthPromptKind({ ...base, authType: 'bearer' })).toBe('rejected');
    expect(oauthPromptKind({ ...base, authType: 'oauth2' })).toBe('rejected');
    expect(oauthPromptKind({ ...base, authType: 'basic' })).toBe('rejected');
  });

  it('stays hidden without an OAuth challenge, after a dismissal, or unless the connect failed', () => {
    expect(oauthPromptKind({ ...base, oauthRequired: false })).toBeNull();
    expect(oauthPromptKind({ ...base, oauthRequired: undefined })).toBeNull();
    expect(oauthPromptKind({ ...base, dismissed: true })).toBeNull();
    expect(oauthPromptKind({ ...base, status: 'connected' })).toBeNull();
    expect(oauthPromptKind({ ...base, status: 'connecting' })).toBeNull();
  });
});

describe('oauthPromptText', () => {
  it('says what happened and what is offered', () => {
    expect(oauthPromptText('sign-in', false)).toMatch(/discover how to sign in/);
    expect(oauthPromptText('sign-in', true)).toMatch(/enterprise-managed authorization \(XAA\)/);
    expect(oauthPromptText('rejected', false)).toMatch(/rejected, most likely an expired or revoked token/);
    expect(oauthPromptText('rejected', true)).toMatch(/\(XAA\), or with standard OAuth/);
  });
});
