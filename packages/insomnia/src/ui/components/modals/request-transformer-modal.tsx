import React, { useEffect, useRef } from 'react';

import {
  buildCurlPreview,
  type CurlKind,
  type CurlLine,
  groupTransformChanges,
  parseRequestTransformer,
  type PreviewRequest,
  TRANSFORM_TARGET_LABELS,
  type TransformChange,
  type TransformOp,
} from '~/common/request-transformer';

import type { KonnectPlugin } from '../../../konnect/api';
import { Modal, type ModalHandle, type ModalProps } from '../base/modal';
import { ModalBody } from '../base/modal-body';
import { ModalHeader } from '../base/modal-header';
import { KongLogo } from '../kong-logo';

interface Props extends ModalProps {
  plugin: KonnectPlugin;
  /** The request the preview is applied to. */
  request: PreviewRequest;
}

const GUTTER: Record<CurlLine['kind'], string> = { same: ' ', added: '+', removed: '−', changed: '~' };
const LINE_CLASSES: Record<CurlLine['kind'], string> = {
  same: 'text-(--hl)',
  added: 'bg-green-500/15 text-green-500',
  removed: 'bg-red-500/15 text-red-500 line-through',
  changed: 'bg-(--color-warning)/10 text-(--hl)',
};
const SEGMENT_CLASSES: Record<CurlKind, string> = {
  same: '',
  added: 'text-green-500',
  removed: 'text-red-500 line-through',
};

const OP_LABELS: Record<TransformOp, string> = {
  allow: 'Allow only',
  remove: 'Remove',
  rename: 'Rename',
  replace: 'Replace',
  add: 'Add',
  append: 'Append',
};

const describe = (c: TransformChange) => {
  if (c.target === 'uri' || c.target === 'method') {
    return c.value;
  }
  if (c.op === 'rename') {
    return `${c.name} → ${c.value}`;
  }
  return c.value === undefined ? c.name : `${c.name}: ${c.value}`;
};

// Prototype (3593AI): one scrolling window with two sections. Config explains the rules; Preview applies them to the
// current request and diffs it. (Tabs were tried and dropped: switching them closed the modal for an unknown reason.)
export const RequestTransformerModal = ({ plugin, request, onHide }: Props) => {
  const modalRef = useRef<ModalHandle>(null);

  useEffect(() => {
    modalRef.current?.show();
  }, []);

  const groups = groupTransformChanges(parseRequestTransformer(plugin.config));
  const hasTemplate = groups.some(g => g.changes.some(c => c.template));
  const preview = buildCurlPreview(plugin.config, request);
  const scope = plugin.route ? 'route' : plugin.service ? 'service' : plugin.consumer ? 'consumer' : 'global';

  return (
    <Modal ref={modalRef} onHide={onHide} wide>
      <ModalHeader>
        <span className="flex items-center gap-2">
          <KongLogo width={20} height={18} />
          Request Transformer
        </span>
      </ModalHeader>
      <ModalBody className="p-4">
        <div>
          <h2 className="mb-2 text-base font-semibold">Config</h2>
          <div>
            <p className="mb-3 text-sm text-(--hl)">
              Kong changes the request with these rules before it reaches your upstream ({scope}-scoped
              {plugin.enabled ? '' : ', currently disabled'}). The upstream sees the result, not what you sent.
            </p>
            {groups.length === 0 ? (
              <p className="text-sm">This plugin doesn't change anything yet.</p>
            ) : (
              groups.map(group => (
                <div key={group.target} className="mb-3">
                  <h3 className="mb-1 text-sm font-semibold">{TRANSFORM_TARGET_LABELS[group.target]}</h3>
                  <ul className="rounded-xs border border-solid border-(--hl-md) text-sm">
                    {group.changes.map(c => (
                      <li
                        key={`${c.op}|${c.name}|${c.value}`}
                        className="grid grid-cols-[6rem_1fr] gap-x-3 border-b border-solid border-(--hl-md) px-3 py-1 last:border-b-0"
                      >
                        <span className="font-semibold">{OP_LABELS[c.op]}</span>
                        <span className="min-w-0 font-mono break-words text-(--hl)">
                          {describe(c)}
                          {c.template && <span className="font-sans italic"> (template)</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
            <p className="text-xs text-(--hl)">
              Kong applies these in order: allow, remove, rename, replace, add, append.
              {hasTemplate &&
                ' Values marked (template) are filled in by Kong from the request, e.g. a header or URI capture.'}
            </p>
          </div>
          <h2 className="mt-4 mb-2 text-base font-semibold">Preview</h2>
          <p className="mb-2 text-sm text-(--hl)">
            Your saved request as cURL, with this plugin's changes marked:{' '}
            <span className="text-green-500">+ added</span>, <span className="text-red-500">− removed</span>, ~ changed.
            Other plugins on the route can change it further.
          </p>
          <div className="overflow-x-auto rounded-xs border border-solid border-(--hl-md) bg-(--hl-xs) py-1 font-mono text-xs">
            {preview.lines.map(line => (
              <div
                key={line.segments.map(x => `${x.kind}${x.text}`).join('')}
                className={`grid grid-cols-[1.5rem_1fr] ${LINE_CLASSES[line.kind]}`}
              >
                <span className="text-center select-none">{GUTTER[line.kind]}</span>
                <span className="break-all whitespace-pre-wrap">
                  {line.segments.map(seg => (
                    <span
                      key={`${seg.kind}${seg.text}`}
                      className={line.kind === 'changed' ? SEGMENT_CLASSES[seg.kind] : ''}
                    >
                      {seg.text}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
          {preview.notes.map(note => (
            <p key={note} className="mt-1 text-xs text-(--hl)">
              {note}
            </p>
          ))}
        </div>
      </ModalBody>
    </Modal>
  );
};
