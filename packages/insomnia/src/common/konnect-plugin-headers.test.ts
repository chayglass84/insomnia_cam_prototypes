import { describe, expect, it } from 'vitest';

import { groupPluginHeaders } from './konnect-plugin-headers';

const h = (name: string, value: string) => ({ name, value });

describe('groupPluginHeaders', () => {
  it('groups rate-limiting headers and summarises remaining per window, smallest window first', () => {
    const { groups, otherHeaders } = groupPluginHeaders(
      [
        h('Content-Type', 'application/json'),
        h('X-RateLimit-Limit-Hour', '300'),
        h('X-RateLimit-Remaining-Hour', '298'),
        h('X-RateLimit-Limit-Minute', '20'),
        h('X-RateLimit-Remaining-Minute', '19'),
        h('RateLimit-Reset', '42'),
      ],
      ['rate-limiting', 'key-auth'],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].summary).toBe('19 left this minute, 298 left this hour');
    expect(groups[0].pluginNames).toEqual(['rate-limiting']);
    expect(groups[0].headers).toHaveLength(5);
    expect(otherHeaders.map(x => x.name)).toEqual(['Content-Type']);
  });

  it('only claims Retry-After when rate-limit headers are present, and adds it to the summary', () => {
    expect(groupPluginHeaders([h('Retry-After', '5')], null).groups).toHaveLength(0);
    const { groups } = groupPluginHeaders([h('X-RateLimit-Remaining-Second', '0'), h('Retry-After', '5')], null);
    expect(groups[0].summary).toBe('0 left this second, retry after 5s');
  });

  it('handles advanced numeric windows and the plain RateLimit-Remaining header', () => {
    expect(groupPluginHeaders([h('X-RateLimit-Remaining-30', '7')], null).groups[0].summary).toBe('7 left per 30s');
    expect(groupPluginHeaders([h('RateLimit-Remaining', '9')], null).groups[0].summary).toBe('9 left');
  });

  it('returns no groups when nothing matches', () => {
    expect(groupPluginHeaders([h('Content-Type', 'text/plain')], []).groups).toEqual([]);
  });
});
