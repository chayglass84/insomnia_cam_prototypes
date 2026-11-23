import React, { type FC } from 'react';

import { JsonView } from './json-view';
import { describeMeta, type MetaEntry, type MetaGroup, type Negotiation, negotiationOf } from './meta-view';

// Task 4348 S7b: the `_meta` and extension displays in the trace detail. Visual only: they read the message that is
// already in the trace; nothing here changes what is sent (to propagate a trace, add `traceparent` to `_meta` in Edit & replay).

const CHIP = 'shrink-0 rounded-xs border border-solid border-(--hl-md) px-1 py-px text-[10px] leading-none text-(--hl) uppercase';
const GROUP_CHIP: Record<MetaGroup, string> = { trace: 'OTel', progress: 'Progress', ui: 'App', vendor: 'Custom', protocol: 'Protocol' };

const MetaRow: FC<{ entry: MetaEntry }> = ({ entry }) => (
  <details className="py-1" data-testid={`mcp-meta-${entry.key}`}>
    <summary className="flex cursor-pointer items-baseline gap-2">
      <span className={CHIP}>{GROUP_CHIP[entry.group]}</span>
      <span className="font-semibold">{entry.title}</span>
      <span className="min-w-0 truncate text-(--hl)">{entry.summary}</span>
    </summary>
    <div className="mt-1 flex flex-col gap-1 pl-1">
      <code className="text-(--hl)">{entry.key}</code>
      <JsonView value={entry.value} />
    </div>
  </details>
);

/** Decoded `_meta` of one message. Protocol plumbing (present on every stateless request) is folded away. */
export const MetaSection: FC<{ meta: Record<string, unknown> | undefined }> = ({ meta }) => {
  const entries = describeMeta(meta);
  if (entries.length === 0) {
    return null;
  }
  const main = entries.filter(e => e.group !== 'protocol');
  const plumbing = entries.filter(e => e.group === 'protocol');
  return (
    <div className="mt-1 flex flex-col divide-y divide-(--hl-sm) rounded-xs border border-solid border-(--hl-md) px-2 text-xs" data-testid="mcp-meta">
      <div className="py-1 font-bold text-(--hl) uppercase">Metadata (_meta)</div>
      {main.map(entry => (
        <MetaRow key={entry.key} entry={entry} />
      ))}
      {plumbing.length > 0 && (
        <details className="py-1">
          <summary className="cursor-pointer text-(--hl)">Protocol plumbing ({plumbing.length})</summary>
          <div className="divide-y divide-(--hl-sm)">
            {plumbing.map(entry => (
              <MetaRow key={entry.key} entry={entry} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

const APPS_EXTENSION = 'io.modelcontextprotocol/ui';

const Mark: FC<{ on: boolean }> = ({ on }) => (
  <span className={on ? 'text-green-500' : 'text-(--hl)'}>{on ? '✓' : '–'}</span>
);

/** Capabilities and extensions two sides offered in a handshake, and which extensions are actually in effect. */
export const NegotiationSection: FC<{ clientCaps: unknown; serverCaps: unknown }> = ({ clientCaps, serverCaps }) => {
  const n: Negotiation = negotiationOf(clientCaps, serverCaps);
  return (
    <section data-testid="mcp-negotiation">
      <h4 className="mb-1 text-xs font-bold text-(--hl) uppercase">Capabilities and extensions</h4>
      <div className="flex flex-col gap-1 rounded-xs border border-solid border-(--hl-md) p-2 text-xs">
        <p>
          <span className="text-(--hl)">Insomnia offers: </span>
          {n.clientCapabilities.length > 0 ? n.clientCapabilities.join(', ') : 'no capabilities'}
        </p>
        <p>
          <span className="text-(--hl)">Server offers: </span>
          {n.serverCapabilities.length > 0 ? n.serverCapabilities.join(', ') : 'no capabilities'}
        </p>
        {n.extensions.length === 0 ? (
          <p className="text-(--hl)">Neither side offered any extensions.</p>
        ) : (
          <table className="mt-1 w-full text-left">
            <thead className="text-(--hl)">
              <tr>
                <th className="font-normal">Extension</th>
                <th className="w-20 font-normal">Insomnia</th>
                <th className="w-16 font-normal">Server</th>
                <th className="font-normal">Result</th>
              </tr>
            </thead>
            <tbody>
              {n.extensions.map(row => (
                <tr key={row.id} data-testid={`mcp-extension-${row.id}`} data-negotiated={row.negotiated}>
                  <td className="py-0.5">
                    {row.name}
                    {row.known && <span className="ml-2 font-mono text-(--hl)">{row.id}</span>}
                  </td>
                  <td>
                    <Mark on={row.clientOffers} />
                  </td>
                  <td>
                    <Mark on={row.serverOffers} />
                  </td>
                  <td className={row.negotiated ? 'text-green-500' : row.serverOffers ? 'text-amber-500' : 'text-(--hl)'}>
                    {row.negotiated
                      ? `In effect${row.known ? '' : ' (unrecognized)'}`
                      : row.serverOffers
                        ? 'Offered by the server; Insomnia did not offer it, so it is ignored'
                        : row.id === APPS_EXTENSION
                          ? 'Offered by Insomnia. Servers need not echo it; their tools carry _meta.ui instead'
                          : 'Offered by Insomnia; the server did not list it'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};
