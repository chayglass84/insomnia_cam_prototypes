import { describe, expect, it } from 'vitest';

import { isPlainHttpBody, isStreamEventLog } from '../stream-event-log';

const event = (type: string) => JSON.stringify({ _id: 'e1', requestId: 'req_1', type, timestamp: 1 });
const bytes = (text: string) => new TextEncoder().encode(text);

describe('isStreamEventLog', () => {
  it('recognises an NDJSON event log', () => {
    expect(isStreamEventLog(`${event('open')}\n${event('message')}\n`)).toBe(true);
  });

  it('does not mistake JSON bodies for events', () => {
    expect(isStreamEventLog('{"id":"msg_1","content":[{"type":"text","text":"hi"}],"usage":{}}')).toBe(false);
    expect(isStreamEventLog('{\n  "choices": []\n}')).toBe(false);
    expect(isStreamEventLog('[1,2]')).toBe(false);
    expect(isStreamEventLog('plain text')).toBe(false);
  });

  it('requires a known event type and the ids', () => {
    expect(isStreamEventLog(JSON.stringify({ _id: 'e', requestId: 'r', type: 'weird' }))).toBe(false);
    expect(isStreamEventLog(JSON.stringify({ type: 'open' }))).toBe(false);
  });

  it('is false for an empty body', () => {
    expect(isStreamEventLog('')).toBe(false);
    expect(isStreamEventLog('\n\n')).toBe(false);
  });
});

describe('isPlainHttpBody', () => {
  it('is true for an ordinary JSON body', () => {
    expect(isPlainHttpBody(bytes('{"choices":[{"message":{"content":"hi"}}]}'))).toBe(true);
  });

  it('is false for an event log, an empty body, or no body', () => {
    expect(isPlainHttpBody(bytes(`${event('open')}\n`))).toBe(false);
    expect(isPlainHttpBody(bytes(''))).toBe(false);
    expect(isPlainHttpBody()).toBe(false);
    expect(isPlainHttpBody(null)).toBe(false);
  });
});
