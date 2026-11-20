import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '~/common/mcp-debugger/protocol/TraceEvent';

import { responseCodeOf } from './trace-pane';

const ev = (extra: Partial<TraceEvent>): TraceEvent => ({
  id: 'e',
  sequence: 1,
  correlationId: 'c',
  protocol: 'mcp',
  direction: 'server-to-client',
  messageType: 'response',
  timestamp: new Date().toISOString(),
  payload: {},
  rendererKey: 'mcp:response',
  ...extra,
});

describe('responseCodeOf', () => {
  it('prefers the status the transport stamped on the event', () => {
    expect(responseCodeOf(ev({ httpStatus: 200, payload: { status: 500 } }))).toBe(200);
  });
  it('falls back to a numeric status in the payload (HTTP errors, OAuth replies)', () => {
    expect(responseCodeOf(ev({ payload: { status: 401, message: 'Authentication failed' } }))).toBe(401);
  });
  it('ignores non-numeric statuses (task payloads) and missing events', () => {
    expect(responseCodeOf(ev({ payload: { status: 'working' } }))).toBeUndefined();
    expect(responseCodeOf()).toBeUndefined();
  });
});
