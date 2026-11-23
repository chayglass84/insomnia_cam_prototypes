// Task 4348 S7b: read the `_meta` of a message in plain language. `_meta` is where MCP carries protocol plumbing
// (version, client info), progress tokens, app-view links and, for OpenTelemetry, the W3C trace context
// (`traceparent`, `tracestate`, `baggage`). Pure and shared by the trace detail, so a developer can see at a glance
// whether a trace is being propagated and what each key means. Visual only: nothing here changes what is sent.

export type MetaGroup = 'trace' | 'progress' | 'ui' | 'protocol' | 'vendor';

export interface MetaEntry {
  key: string;
  group: MetaGroup;
  title: string;
  /** One readable line (decoded for traceparent, a count for tracestate, ...). */
  summary: string;
  value: unknown;
  /** Still read by Insomnia, but replaced by a newer form. */
  deprecated?: boolean;
}

export interface Traceparent {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
  sampled: boolean;
}

/** W3C Trace Context `traceparent`: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`; all-zero ids are invalid. */
export const parseTraceparent = (value: unknown): Traceparent | null => {
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(typeof value === 'string' ? value.trim() : '');
  if (!match || match[1] === 'ff' || /^0+$/.test(match[2]) || /^0+$/.test(match[3])) {
    return null;
  }
  return { version: match[1], traceId: match[2], spanId: match[3], flags: match[4], sampled: (Number.parseInt(match[4], 16) & 1) === 1 };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `_meta` object of a trace payload: a request's `params._meta`, a result's `_meta`, or a notification's `params._meta`. */
export const metaOf = (payload: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(payload)) {
    return undefined;
  }
  const candidates = [isRecord(payload.params) ? payload.params._meta : undefined, payload._meta, isRecord(payload.result) ? payload.result._meta : undefined];
  return candidates.find(isRecord);
};

const short = (id: string) => `${id.slice(0, 8)}…`;

export const describeMeta = (meta?: unknown): MetaEntry[] => {
  if (!isRecord(meta)) {
    return [];
  }
  const entries: MetaEntry[] = Object.entries(meta).map(([key, value]): MetaEntry => {
    switch (key) {
      case 'traceparent': {
        const tp = parseTraceparent(value);
        return {
          key,
          group: 'trace',
          title: 'OpenTelemetry trace context',
          summary: tp
            ? `trace ${short(tp.traceId)}, span ${tp.spanId.slice(0, 8)}…, ${tp.sampled ? 'sampled' : 'not sampled'}`
            : 'Not a valid W3C traceparent (expected 00-<trace id>-<span id>-<flags>)',
          value,
        };
      }
      case 'tracestate': {
        const parts = typeof value === 'string' ? value.split(',').filter(p => p.trim()) : [];
        return { key, group: 'trace', title: 'Trace state', summary: `${parts.length} vendor entr${parts.length === 1 ? 'y' : 'ies'}: ${parts.map(p => p.split('=')[0].trim()).join(', ')}`, value };
      }
      case 'baggage': {
        const count = typeof value === 'string' ? value.split(',').filter(p => p.trim()).length : 0;
        return { key, group: 'trace', title: 'Baggage', summary: `${count} propagated key${count === 1 ? '' : 's'}`, value };
      }
      case 'progressToken': {
        return { key, group: 'progress', title: 'Progress token', summary: 'The server may send progress notifications carrying this token.', value };
      }
      case 'ui': {
        const ui = isRecord(value) ? value : {};
        return {
          key,
          group: 'ui',
          title: 'MCP App view',
          summary: [typeof ui.resourceUri === 'string' ? ui.resourceUri : undefined, Array.isArray(ui.visibility) ? `visible to ${ui.visibility.join(' and ')}` : undefined].filter(Boolean).join(', ') || 'App view settings',
          value,
        };
      }
      case 'ui/resourceUri': {
        return {
          key,
          group: 'ui',
          title: 'MCP App view link',
          summary: `${String(value)}. Deprecated flat key; use _meta.ui.resourceUri`,
          value,
          deprecated: true,
        };
      }
      case 'io.modelcontextprotocol/protocolVersion': {
        return { key, group: 'protocol', title: 'Protocol version', summary: String(value), value };
      }
      case 'io.modelcontextprotocol/clientInfo': {
        return { key, group: 'protocol', title: 'Client', summary: isRecord(value) ? `${String(value.name ?? '?')} ${String(value.version ?? '')}`.trim() : String(value), value };
      }
      case 'io.modelcontextprotocol/clientCapabilities': {
        return { key, group: 'protocol', title: 'Client capabilities', summary: isRecord(value) && Object.keys(value).length > 0 ? Object.keys(value).join(', ') : 'none declared', value };
      }
      case 'io.modelcontextprotocol/subscriptionId': {
        return { key, group: 'protocol', title: 'Subscription', summary: String(value), value };
      }
      case 'io.modelcontextprotocol/related-task': {
        return { key, group: 'protocol', title: 'Related task', summary: isRecord(value) && typeof value.taskId === 'string' ? value.taskId : 'Linked to a task', value };
      }
      default: {
        return {
          key,
          group: key.startsWith('io.modelcontextprotocol/') ? 'protocol' : 'vendor',
          title: key.includes('/') ? `Extension key (${key.slice(0, key.indexOf('/'))})` : 'Custom key',
          summary: typeof value === 'string' ? value : isRecord(value) || Array.isArray(value) ? 'See the raw value' : String(value),
          value,
        };
      }
    }
  });
  const order: MetaGroup[] = ['trace', 'progress', 'ui', 'vendor', 'protocol'];
  return entries.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
};

// ---------- extension negotiation ----------

/** Extensions Insomnia knows by id; anything else is shown as-is. */
const KNOWN_EXTENSIONS: Record<string, string> = {
  'io.modelcontextprotocol/ui': 'MCP Apps (ui:// views)',
  'io.modelcontextprotocol/tasks': 'Tasks',
};

export interface ExtensionRow {
  id: string;
  name: string;
  known: boolean;
  clientOffers: boolean;
  serverOffers: boolean;
  /** Both sides offered it, so it is in effect. */
  negotiated: boolean;
  clientValue?: unknown;
  serverValue?: unknown;
}

export interface Negotiation {
  clientCapabilities: string[];
  serverCapabilities: string[];
  extensions: ExtensionRow[];
}

const extensionsOf = (caps: unknown): Record<string, unknown> => (isRecord(caps) && isRecord(caps.extensions) ? caps.extensions : {});
const capabilityNames = (caps: unknown) => (isRecord(caps) ? Object.keys(caps).filter(k => k !== 'extensions') : []);

/** What the two sides of a handshake offered: capabilities, and which extensions ended up in effect. */
export const negotiationOf = (clientCaps: unknown, serverCaps: unknown): Negotiation => {
  const client = extensionsOf(clientCaps);
  const server = extensionsOf(serverCaps);
  const ids = [...new Set([...Object.keys(client), ...Object.keys(server)])];
  return {
    clientCapabilities: capabilityNames(clientCaps),
    serverCapabilities: capabilityNames(serverCaps),
    extensions: ids.map(id => ({
      id,
      name: KNOWN_EXTENSIONS[id] ?? id,
      known: id in KNOWN_EXTENSIONS,
      clientOffers: id in client,
      serverOffers: id in server,
      negotiated: id in client && id in server,
      clientValue: client[id],
      serverValue: server[id],
    })),
  };
};

/**
 * Pull the two capability sets out of a handshake call. `server/discover` carries the client's in `_meta` and returns the
 * server's in its result; `initialize` carries them in `params.capabilities` and `result.capabilities`.
 */
export const handshakeCapabilities = (
  requestPayload: unknown,
  replyPayload: unknown,
): { clientCaps: unknown; serverCaps: unknown } | null => {
  if (!isRecord(requestPayload) || (requestPayload.method !== 'server/discover' && requestPayload.method !== 'initialize')) {
    return null;
  }
  const params = isRecord(requestPayload.params) ? requestPayload.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const result = isRecord(replyPayload) && isRecord(replyPayload.result) ? replyPayload.result : replyPayload;
  return {
    clientCaps: meta['io.modelcontextprotocol/clientCapabilities'] ?? params.capabilities,
    serverCaps: isRecord(result) ? result.capabilities : undefined,
  };
};
