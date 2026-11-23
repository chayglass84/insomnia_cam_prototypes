import { describe, expect, it } from 'vitest';

import { buildAppSrcdoc, buildCsp, safeSources } from './app-srcdoc';

describe('app srcdoc', () => {
  it('defaults to no network at all', () => {
    const csp = buildCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('adds only the domains the server declared, and drops anything that could break out of the policy', () => {
    const csp = buildCsp({
      connectDomains: ['https://api.example.com', "x; script-src *", 'http://127.0.0.1:8787'],
      resourceDomains: ['https://cdn.example.com', "'unsafe-eval'", '*.fonts.example.com'],
    });
    expect(csp).toContain("connect-src https://api.example.com http://127.0.0.1:8787");
    expect(csp).not.toContain('script-src *');
    expect(csp).toContain("script-src 'unsafe-inline' https://cdn.example.com *.fonts.example.com");
    expect(csp).not.toContain('unsafe-eval');
    expect(safeSources(['a b', 'good.example.com', 'wss://sock.example.com:9000/path'])).toEqual(['good.example.com', 'wss://sock.example.com:9000/path']);
  });

  it('injects the CSP meta as early as possible, however the app is written', () => {
    const withHead = buildAppSrcdoc({ html: '<!doctype html><html><head><title>x</title></head><body>hi</body></html>' });
    expect(withHead.indexOf('Content-Security-Policy')).toBeLessThan(withHead.indexOf('<title>'));
    expect(withHead.startsWith('<!doctype html>')).toBe(true);
    const noHead = buildAppSrcdoc({ html: '<html lang="en"><body>hi</body></html>' });
    expect(noHead).toMatch(/<html lang="en"><head><meta http-equiv="Content-Security-Policy"/);
    const fragment = buildAppSrcdoc({ html: '<div>hi</div>' });
    expect(fragment).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy".*<body><div>hi<\/div><\/body><\/html>$/);
  });
});
