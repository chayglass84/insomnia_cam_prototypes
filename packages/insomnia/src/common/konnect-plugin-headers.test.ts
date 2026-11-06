import { describe, expect, it } from 'vitest';

import { buildPreflightPatch, getMissingPluginHints, groupPluginHeaders } from './konnect-plugin-headers';

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

  it('groups CORS headers and summarises allowed origin, methods and credentials', () => {
    const { groups, otherHeaders } = groupPluginHeaders(
      [
        h('Content-Type', 'application/json'),
        h('Access-Control-Allow-Origin', 'https://app.example.com'),
        h('Access-Control-Allow-Methods', 'GET, POST'),
        h('Access-Control-Allow-Headers', 'Authorization, Content-Type'),
        h('Access-Control-Allow-Credentials', 'true'),
        h('Access-Control-Max-Age', '3600'),
      ],
      ['cors'],
    );
    expect(groups[0].id).toBe('cors');
    expect(groups[0].pluginNames).toEqual(['cors']);
    expect(groups[0].summary).toBe('Allows: https://app.example.com, GET/POST, credentials');
    expect(otherHeaders.map(x => x.name)).toEqual(['Content-Type']);
    expect(groupPluginHeaders([h('Access-Control-Allow-Origin', '*')], null).groups[0].summary).toBe(
      'Allows: any domain',
    );
  });

  it('returns no groups when nothing matches', () => {
    expect(groupPluginHeaders([h('Content-Type', 'text/plain')], []).groups).toEqual([]);
  });
});

describe('CORS origin hint', () => {
  const allow = [h('Access-Control-Allow-Origin', 'https://app.example.com')];
  const hintFor = (headers: { name: string; value: string; disabled?: boolean }[]) =>
    groupPluginHeaders(allow, null, { headers }).groups[0].hint;

  it('is silent when the origins match, the allowed origin is *, or the Origin is a template', () => {
    expect(hintFor([h('Origin', 'https://app.example.com')])).toBeNull();
    expect(
      groupPluginHeaders([h('Access-Control-Allow-Origin', '*')], null, { headers: [h('Origin', 'x')] }).groups[0].hint,
    ).toBeNull();
    expect(hintFor([h('Origin', '{{ _.origin }}')])).toBeNull();
  });

  it('flags a mismatch, and a missing (or disabled) Origin header', () => {
    expect(hintFor([h('Origin', 'https://other.com')])).toContain("doesn't match your Origin (https://other.com)");
    expect(hintFor([])).toBe('Origin header missing');
    expect(hintFor([{ ...h('Origin', 'https://app.example.com'), disabled: true }])).toBe('Origin header missing');
  });
});

describe('buildPreflightPatch', () => {
  it('makes an OPTIONS with Origin, request method and the non-safelisted header names; drops the body', () => {
    const patch = buildPreflightPatch(
      {
        method: 'POST',
        headers: [
          h('Origin', 'https://app.example.com'),
          h('apikey', 'k'),
          h('Accept', '*/*'),
          { ...h('X-Off', '1'), disabled: true },
        ],
      },
      'https://fallback.com',
    );
    expect(patch.method).toBe('OPTIONS');
    expect(patch.body).toEqual({});
    expect(patch.headers).toContainEqual(h('Origin', 'https://app.example.com'));
    expect(patch.headers).toContainEqual(h('Access-Control-Request-Method', 'POST'));
    expect(patch.headers).toContainEqual(h('Access-Control-Request-Headers', 'apikey'));
    expect(patch.headers.filter(x => x.name === 'Origin')).toHaveLength(1);
  });

  it('falls back to the allowed origin, but never to *', () => {
    expect(buildPreflightPatch({ method: 'GET', headers: [] }, 'https://a.com').headers).toContainEqual(
      h('Origin', 'https://a.com'),
    );
    expect(buildPreflightPatch({ method: 'GET', headers: [] }, '*').headers).toContainEqual(
      h('Origin', 'https://example.com'),
    );
  });
});

describe('getMissingPluginHints', () => {
  const cors = [{ name: 'cors', config: { origins: ['https://a.com', 'https://b.com'] } }];

  it('explains an attached CORS plugin that sent no headers, listing the allowed origins', () => {
    const [hint] = getMissingPluginHints([h('Content-Type', 'x')], cors, { headers: [h('Origin', 'https://c.com')] });
    expect(hint.id).toBe('cors');
    expect(hint.hint).toBe(
      "No CORS headers came back: your Origin (https://c.com) isn't allowed. Allowed: https://a.com, https://b.com.",
    );
  });

  it('asks for an Origin when there is none', () => {
    expect(getMissingPluginHints([], cors, { headers: [] })[0].hint).toBe('Origin header missing');
  });

  it('stays silent when headers came back, the plugin is not attached or unknown, or the Origin is a template', () => {
    const req = { headers: [h('Origin', 'https://c.com')] };
    expect(getMissingPluginHints([h('Access-Control-Allow-Origin', '*')], cors, req)).toEqual([]);
    expect(getMissingPluginHints([], [{ name: 'key-auth', config: {} }], req)).toEqual([]);
    expect(getMissingPluginHints([], null, req)).toEqual([]);
    expect(getMissingPluginHints([], cors, { headers: [h('Origin', '{{ _.o }}')] })).toEqual([]);
  });
});
