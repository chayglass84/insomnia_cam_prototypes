import React, { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';

import type { KonnectPlugin } from '../../../konnect/api';
import { Modal, type ModalHandle, type ModalProps } from '../base/modal';
import { ModalBody } from '../base/modal-body';
import { ModalHeader } from '../base/modal-header';
import { Icon } from '../icon';

interface Props extends ModalProps {
  plugin: KonnectPlugin;
  controlPlaneName: string;
  // True for a suggested-but-not-yet-applied plugin, so the snippet reads as
  // "add" rather than "edit".
  isNew?: boolean;
}

// PROTOTYPE SHORTCUT: this is an illustrative decK snippet built from the
// plugin's config, not real `deck` CLI output or a validated decK document.
// The `--konnect-control-plane-name` value is real (pulled from the synced
// Project), but the command itself is not run/validated against decK.
function buildDeckCommand(plugin: KonnectPlugin, controlPlaneName: string, isNew: boolean): string {
  const config = JSON.stringify(plugin.config, null, 2)
    .split('\n')
    .map(line => `      ${line}`)
    .join('\n')
    .trimStart();

  const step2 = isNew
    ? `# 2. Add a "${plugin.name}" plugin block in kong.yaml, e.g.:\n#   - name: ${plugin.name}\n#     enabled: true\n#     config:\n${config}`
    : `# 2. Edit the "${plugin.name}" plugin block in kong.yaml, e.g.:\n#   - name: ${plugin.name}\n#     enabled: ${plugin.enabled}\n#     config:\n${config}`;

  return `# 1. Export the current config for this control plane\ndeck gateway dump --konnect-control-plane-name "${controlPlaneName}" -o kong.yaml\n\n${step2}\n\n# 3. Apply the change back to Konnect\ndeck gateway sync kong.yaml --konnect-control-plane-name "${controlPlaneName}"`;
}

export const DeckCommandModal = ({ plugin, controlPlaneName, isNew = false, onHide }: Props) => {
  const modalRef = useRef<ModalHandle>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    modalRef.current?.show();
  }, []);

  const command = buildDeckCommand(plugin, controlPlaneName, isNew);

  return (
    <Modal ref={modalRef} onHide={onHide} wide>
      <ModalHeader>decK command · {plugin.name}</ModalHeader>
      <ModalBody className="p-4">
        <p className="mb-2 text-sm text-(--hl)">
          decK is Kong's declarative config CLI. This is an illustrative example of how you'd manage this plugin
          with decK — not a live-generated or validated command.
        </p>
        <pre className="max-h-96 overflow-auto rounded-xs border border-solid border-(--hl-md) bg-(--hl-xs) p-3 text-xs whitespace-pre-wrap">
          {command}
        </pre>
        <Button
          className="mt-3 flex items-center gap-2 rounded-xs border border-solid border-(--hl-md) px-3 py-1 text-sm hover:bg-(--hl-xs)"
          onPress={() => {
            navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Icon icon={copied ? 'check' : 'copy'} />
          {copied ? 'Copied!' : 'Copy command'}
        </Button>
      </ModalBody>
    </Modal>
  );
};
