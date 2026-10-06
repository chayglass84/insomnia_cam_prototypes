import { describe, expect, it } from 'vitest';

import {
  ensureEventStreamAcceptHeader,
  ensureIncludeUsageFlag,
  ensureStreamingBodyFlag,
  hasIncludeUsageFlag,
  hasStreamingBodyFlag,
} from './chat-streaming';

describe('hasStreamingBodyFlag', () => {
  it('returns true when stream is true', () => {
    expect(hasStreamingBodyFlag(JSON.stringify({ stream: true }))).toBe(true);
  });

  it('returns false when stream is missing, falsy, not valid JSON, or body is empty', () => {
    expect(hasStreamingBodyFlag(JSON.stringify({ model: 'x' }))).toBe(false);
    expect(hasStreamingBodyFlag(JSON.stringify({ stream: false }))).toBe(false);
    expect(hasStreamingBodyFlag('not json')).toBe(false);
    expect(hasStreamingBodyFlag()).toBe(false);
    expect(hasStreamingBodyFlag('')).toBe(false);
  });
});

describe('ensureStreamingBodyFlag', () => {
  it('merges stream: true into an existing JSON body without disturbing other fields', () => {
    const result = ensureStreamingBodyFlag(JSON.stringify({ model: 'x', messages: [] }));
    expect(result && JSON.parse(result)).toEqual({ model: 'x', messages: [], stream: true });
  });

  it('returns null when the flag is already set (nothing to do)', () => {
    expect(ensureStreamingBodyFlag(JSON.stringify({ stream: true }))).toBeNull();
  });

  it('returns null for invalid JSON rather than clobbering the body', () => {
    expect(ensureStreamingBodyFlag('not json')).toBeNull();
  });

  it('produces a fresh body with just the flag when the original body is empty', () => {
    expect(ensureStreamingBodyFlag()).toBe(JSON.stringify({ stream: true }));
  });
});

describe('ensureEventStreamAcceptHeader', () => {
  it('appends an Accept header when none exists', () => {
    const { headers, changed } = ensureEventStreamAcceptHeader([{ name: 'Content-Type', value: 'application/json' }]);
    expect(changed).toBe(true);
    expect(headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Accept', value: 'text/event-stream' },
    ]);
  });

  it('replaces an existing Accept header value by name case-insensitively, keeping its original casing', () => {
    const { headers, changed } = ensureEventStreamAcceptHeader([{ name: 'accept', value: 'application/json' }]);
    expect(changed).toBe(true);
    expect(headers).toEqual([{ name: 'accept', value: 'text/event-stream' }]);
  });

  it('reports no change when the header is already correct', () => {
    const headers = [{ name: 'Accept', value: 'text/event-stream' }];
    expect(ensureEventStreamAcceptHeader(headers)).toEqual({ headers, changed: false });
  });
});

describe('include_usage flag', () => {
  it('detects and adds stream_options.include_usage, keeping other options and indentation', () => {
    expect(hasIncludeUsageFlag('{"stream":true}')).toBe(false);
    expect(hasIncludeUsageFlag('{"stream_options":{"include_usage":true}}')).toBe(true);
    expect(ensureIncludeUsageFlag('{"stream":true,"stream_options":{"x":1}}')).toBe(
      '{"stream":true,"stream_options":{"x":1,"include_usage":true}}',
    );
    expect(ensureIncludeUsageFlag('{\n  "stream": true\n}')).toBe(
      '{\n  "stream": true,\n  "stream_options": {\n    "include_usage": true\n  }\n}',
    );
  });

  it('does nothing when already set or the body is not JSON', () => {
    expect(ensureIncludeUsageFlag('{"stream_options":{"include_usage":true}}')).toBeNull();
    expect(ensureIncludeUsageFlag('not json')).toBeNull();
  });
});
