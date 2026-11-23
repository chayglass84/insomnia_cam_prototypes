import { describe, expect, it } from 'vitest';

import { splitUrls } from './url-text';

describe('splitUrls', () => {
  it('lifts a trailing URL out of the sentence', () => {
    expect(splitUrls('Opened in your browser: http://127.0.0.1:9100/authorize?a=1&b=2')).toEqual({
      text: 'Opened in your browser',
      urls: ['http://127.0.0.1:9100/authorize?a=1&b=2'],
    });
    expect(splitUrls('issuer: http://127.0.0.1:9000')).toEqual({ text: 'issuer', urls: ['http://127.0.0.1:9000'] });
  });

  it('handles parentheses, lead-in words and a final full stop', () => {
    expect(splitUrls('Found, a client can proceed (http://x/.well-known/oauth-authorization-server)')).toEqual({
      text: 'Found, a client can proceed',
      urls: ['http://x/.well-known/oauth-authorization-server'],
    });
    expect(splitUrls('Dynamic Client Registration available at http://x/register.')).toEqual({
      text: 'Dynamic Client Registration available',
      urls: ['http://x/register'],
    });
  });

  it('returns only the URL when the sentence is nothing but a URL', () => {
    expect(splitUrls('https://example.com/a')).toEqual({ text: '', urls: ['https://example.com/a'] });
  });

  it('keeps a URL that is in the middle of a sentence in the text, and still lists it', () => {
    const input = 'The metadata issuer (http://a) does not match the issuer it was fetched for (http://b).';
    const split = splitUrls(input);
    expect(split.urls).toEqual(['http://a', 'http://b']);
    expect(split.text).toBe('The metadata issuer (http://a) does not match the issuer it was fetched for');
    expect(splitUrls('Go to http://a then press the button').text).toBe('Go to http://a then press the button');
  });

  it('leaves text without URLs alone', () => {
    expect(splitUrls('PKCE S256 supported.')).toEqual({ text: 'PKCE S256 supported.', urls: [] });
  });
});
