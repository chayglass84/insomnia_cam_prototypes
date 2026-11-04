import React, { type FC, type RefObject, useEffect, useState } from 'react';
import { Button, Popover } from 'react-aria-components';

import type { LlmUrlFormat } from '~/common/llm-url';
import { showSettingsModal } from '~/ui/components/modals/settings-modal';

const AUTO_HIDE_MS = 5000;

const FORMAT_LABEL: Record<LlmUrlFormat, string> = { openai: 'OpenAI', anthropic: 'Anthropic' };

// Prototype (3593AI): small non-modal popover under the Send/Connect button, shown after "Auto-convert LLM
// URLs to SSE Requests" fires. It portals out of the layout (nothing shifts) and covers nothing critical.
// Auto-hides after 5s; hovering pauses the timer (restarts on leave) so Undo can't vanish under the mouse.
export const LlmUrlConvertedPopover: FC<{
  triggerRef: RefObject<HTMLElement | null>;
  format: LlmUrlFormat;
  onUndo: () => void;
  onDismiss: () => void;
}> = ({ triggerRef, format, onUndo, onDismiss }) => {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (hovered) {
      return;
    }
    const timer = setTimeout(onDismiss, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [hovered, onDismiss]);

  return (
    <Popover
      isOpen
      isNonModal
      triggerRef={triggerRef}
      placement="bottom end"
      offset={6}
      onOpenChange={open => {
        if (!open) {
          onDismiss();
        }
      }}
      className="w-64 rounded-md border border-solid border-(--hl-md) bg-(--color-bg) p-3 text-xs text-(--color-font) shadow-md"
    >
      <div
        role="status"
        data-testid="llm-url-converted-popover"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="font-semibold">Converted to a streaming (SSE) request</p>
          <Button aria-label="Dismiss" className="leading-none text-(--hl) hover:text-(--color-font)" onPress={onDismiss}>
            ×
          </Button>
        </div>
        <p className="mt-1 text-(--hl)">Detected an {FORMAT_LABEL[format]}-format chat URL.</p>
        <p className="mt-1 font-semibold">
          Add a "model" to the request's Body tab before connecting.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <Button className="font-semibold underline" onPress={onUndo}>
            Undo
          </Button>
          <Button
            className="text-(--hl) underline hover:text-(--color-font)"
            onPress={() => {
              onDismiss();
              showSettingsModal({ tab: 'general' });
            }}
          >
            Turn off in Preferences
          </Button>
        </div>
      </div>
    </Popover>
  );
};
