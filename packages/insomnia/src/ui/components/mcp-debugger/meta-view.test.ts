import { describe, expect, it } from 'vitest';

import { describeMeta, handshakeCapabilities, metaOf, negotiationOf, parseTraceparent } from './meta-view';

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('traceparent', () => {
  it('decodes a valid W3C traceparent', () => {
    expect(parseTraceparent(TP)).toEqual({ version: '00', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', flags: '01', sampled: true });
    expect(parseTraceparent(TP.replace(/-01$/, '-00'))?.sampled).toBe(false);
  });

  it('rejects malformed or all-zero values', () => {
    expect(parseTraceparent('nope')).toBeNull();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent(`ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`)).toBeNull();
    expect(parseTraceparent(42)).toBeNull();
  });
});

describe('metaOf', () => {
  it('finds _meta in requests, results and notifications', () => {
    expect(metaOf({ method: 'tools/call', params: { _meta: { a: 1 } } })).toEqual({ a: 1 });
    expect(metaOf({ content: [], _meta: { b: 2 } })).toEqual({ b: 2 });
    expect(metaOf({ result: { _meta: { c: 3 } } })).toEqual({ c: 3 });
    expect(metaOf({ method: 'x', params: {} })).toBeUndefined();
    expect(metaOf('text')).toBeUndefined();
  });
});

describe('describeMeta', () => {
  it('puts OpenTelemetry first and the protocol plumbing last, each in plain language', () => {
    const entries = describeMeta({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'Insomnia', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
      progressToken: 'p1',
      tracestate: 'a=1,b=2',
      traceparent: TP,
      'com.acme/flag': 'on',
      ui: { resourceUri: 'ui://x', visibility: ['app'] },
    });
    // Groups in order (trace, progress, app view, vendor, protocol); within a group, the order they arrived in.
    expect(entries.map(e => e.key)).toEqual([
      'tracestate',
      'traceparent',
      'progressToken',
      'ui',
      'com.acme/flag',
      'io.modelcontextprotocol/protocolVersion',
      'io.modelcontextprotocol/clientInfo',
      'io.modelcontextprotocol/clientCapabilities',
    ]);
    const byKey = Object.fromEntries(entries.map(e => [e.key, e]));
    expect(byKey.traceparent.group).toBe('trace');
    expect(byKey.traceparent.summary).toMatch(/trace 4bf92f35….*sampled/);
    expect(byKey.tracestate.summary).toBe('2 vendor entries: a, b');
    expect(byKey.ui.summary).toBe('ui://x, visible to app');
    expect(byKey['com.acme/flag'].group).toBe('vendor');
    expect(byKey['io.modelcontextprotocol/clientCapabilities'].summary).toBe('none declared');
    expect(byKey['io.modelcontextprotocol/clientInfo'].summary).toBe('Insomnia 1');
  });

  it('flags the deprecated flat app-link key', () => {
    const [entry] = describeMeta({ 'ui/resourceUri': 'ui://x' });
    expect(entry).toMatchObject({ group: 'ui', deprecated: true });
    expect(entry.summary).toMatch(/Deprecated flat key/);
    expect(describeMeta({ ui: { resourceUri: 'ui://x' } })[0].deprecated).toBeUndefined();
  });

  it('flags an invalid traceparent instead of hiding it', () => {
    expect(describeMeta({ traceparent: 'garbage' })[0].summary).toMatch(/Not a valid W3C traceparent/);
    expect(describeMeta()).toEqual([]);
  });
});

describe('extension negotiation', () => {
  it('shows which extensions are in effect, offered by one side only, or unknown', () => {
    const n = negotiationOf(
      { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] }, 'com.acme/thing': {} }, sampling: {} },
      { tools: {}, extensions: { 'io.modelcontextprotocol/ui': {}, 'io.modelcontextprotocol/tasks': {} } },
    );
    expect(n.clientCapabilities).toEqual(['sampling']);
    expect(n.serverCapabilities).toEqual(['tools']);
    const rows = Object.fromEntries(n.extensions.map(r => [r.id, r]));
    expect(rows['io.modelcontextprotocol/ui']).toMatchObject({ name: 'MCP Apps (ui:// views)', negotiated: true, known: true });
    expect(rows['io.modelcontextprotocol/tasks']).toMatchObject({ clientOffers: false, serverOffers: true, negotiated: false });
    expect(rows['com.acme/thing']).toMatchObject({ clientOffers: true, serverOffers: false, known: false, name: 'com.acme/thing' });
  });

  it('reads both capability sets from a discover or an initialize call', () => {
    const discover = handshakeCapabilities(
      { method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/clientCapabilities': { a: 1 } } } },
      { capabilities: { b: 2 } },
    );
    expect(discover).toEqual({ clientCaps: { a: 1 }, serverCaps: { b: 2 } });
    const init = handshakeCapabilities({ method: 'initialize', params: { capabilities: { c: 3 } } }, { result: { capabilities: { d: 4 } } });
    expect(init).toEqual({ clientCaps: { c: 3 }, serverCaps: { d: 4 } });
    expect(handshakeCapabilities({ method: 'tools/call', params: {} }, {})).toBeNull();
  });
});
