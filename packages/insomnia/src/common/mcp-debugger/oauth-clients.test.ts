import { describe, expect, it } from 'vitest';

import { clientsForIssuer, forgetClient, isClientSaved, saveClient } from './oauth-clients';

let n = 0;
const id = () => `c${++n}`;

describe('saved OAuth clients', () => {
  it('saves, dedupes by issuer + client_id (renaming), and filters by issuer', () => {
    let list = saveClient(undefined, { name: 'Read only', issuer: 'https://as.test', clientId: 'a' }, id);
    list = saveClient(list, { name: 'Admin', issuer: 'https://as.test', clientId: 'b' }, id);
    list = saveClient(list, { name: 'Other AS', issuer: 'https://other.test', clientId: 'a' }, id);
    expect(list).toHaveLength(3);
    list = saveClient(list, { name: '  Read-only v2  ', issuer: 'https://as.test', clientId: 'a' }, id);
    expect(list).toHaveLength(3);
    expect(list[0].name).toBe('Read-only v2');
    expect(clientsForIssuer(list, 'https://as.test').map(c => c.clientId)).toEqual(['a', 'b']);
  });
  it('falls back to a default name and can forget', () => {
    const list = saveClient([], { name: '   ', issuer: 'i', clientId: 'x' }, () => 'only');
    expect(list[0].name).toBe('OAuth client');
    expect(forgetClient(list, 'only')).toEqual([]);
    expect(isClientSaved(list, 'i', 'x')).toBe(true);
    expect(isClientSaved(list, 'i', 'y')).toBe(false);
    expect(isClientSaved(undefined, 'i', 'x')).toBe(false);
  });
});
