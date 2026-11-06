import type { ResponseHeader } from 'insomnia-data';
import React, { type FC, Fragment, useMemo } from 'react';

import { KONNECT_PLUGIN_TEXT_CLASS, type PluginHeaderGroup } from '~/common/konnect-plugin-headers';

import { CopyButton } from '../base/copy-button';
import { Link } from '../base/link';

interface Props {
  headers: ResponseHeader[];
  onCopyAll?: () => void;
  // Prototype (3593AI): headers owned by Kong plugins are pulled into labelled, coloured groups above the rest.
  pluginGroups?: PluginHeaderGroup[];
  otherHeaders?: ResponseHeader[];
}

const validateURL = ({ value }: ResponseHeader) => {
  try {
    const parsedUrl = new URL(value);
    return Boolean(parsedUrl.hostname);
  } catch {
    return false;
  }
};

const headerAsString = (header: ResponseHeader) => `${header.name}: ${header.value}`;

export const ResponseHeadersViewer: FC<Props> = ({ headers, onCopyAll, pluginGroups = [], otherHeaders }) => {
  const headersString = useMemo(() => headers.map(headerAsString).join('\n'), [headers]);

  // `indentClass` nudges plugin headers in under their plugin name so the groups scan as a tree.
  const renderRow = (header: ResponseHeader, indentClass?: string) => (
    <tr className="selectable" key={headerAsString(header)}>
      <td className="force-wrap w-1/2">
        <div className={indentClass}>{header.name}</div>
      </td>
      <td className="force-wrap w-1/2">
        {validateURL(header) ? <Link href={header.value}>{header.value}</Link> : header.value}
      </td>
    </tr>
  );

  return (
    <Fragment>
      <table className="table--fancy table--striped table--compact">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {pluginGroups.length > 0 && (
            <tr>
              <th colSpan={2} className={`text-left ${KONNECT_PLUGIN_TEXT_CLASS}`}>
                Konnect Plugins
              </th>
            </tr>
          )}
          {pluginGroups.map(group => (
            <Fragment key={group.id}>
              <tr>
                <td colSpan={2} className={KONNECT_PLUGIN_TEXT_CLASS}>
                  <div className="pl-2">
                    {group.pluginNames.length > 0 ? group.pluginNames.join(', ') : group.label}
                  </div>
                </td>
              </tr>
              {group.headers.map(header => renderRow(header, 'pl-5'))}
            </Fragment>
          ))}
          {pluginGroups.length > 0 && (otherHeaders ?? headers).length > 0 && (
            <tr>
              <th colSpan={2} className="text-left">
                Other headers
              </th>
            </tr>
          )}
          {(otherHeaders ?? headers).map(header => renderRow(header))}
        </tbody>
      </table>
      <p key="copy" className="pad-top">
        <CopyButton className="pull-right" content={headersString} onClick={onCopyAll} />
      </p>
    </Fragment>
  );
};
