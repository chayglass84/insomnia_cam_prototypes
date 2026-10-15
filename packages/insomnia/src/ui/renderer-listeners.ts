import { services } from 'insomnia-data';

import { type RAToastContent, showToast } from '~/ui/components/toast-notification';
import * as themes from '~/ui/plugins/misc';
import { plugins } from '~/ui/plugins/renderer-bridge';
import * as templating from '~/ui/templating/renderer-safe';

import { dispatchEditorUndo, UNDO_PERFORMED_EVENT } from './components/.client/codemirror/editor-undo';
import { showModal } from './components/modals';
import { SettingsModal } from './components/modals/settings-modal';

// Edit-menu Undo/Redo route here so one handler reconciles CodeMirror's history
// with the native undo stack based on what's focused (see editor-undo.ts).
window.main.on('edit:undo', () => dispatchEditorUndo('undo'));
window.main.on('edit:redo', () => dispatchEditorUndo('redo'));

// On Windows/Linux CodeMirror handles Ctrl+Z itself before the menu accelerator
// fires, so the Edit-menu path above never sees it. Observe the shortcut directly
// (capture, no preventDefault) so the undo hint still appears. Redundant but
// harmless on macOS, where the accelerator wins.
window.addEventListener(
  'keydown',
  event => {
    if (event.key.toLowerCase() === 'z' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      window.dispatchEvent(new CustomEvent(UNDO_PERFORMED_EVENT));
    }
  },
  true,
);

window.main.on('toggle-preferences', () => {
  showModal(SettingsModal);
});

window.main.on('reload-plugins', async () => {
  const settings = await services.settings.get();
  await plugins.reloadPlugins();
  await themes.applyColorScheme(settings);
  templating.reload();
  console.log('[plugins] reloaded');
});

window.main.on('toggle-preferences-shortcuts', () => {
  showModal(SettingsModal, { tab: 'keyboard' });
});

window.main.on('show-toast', (_, options: { content: RAToastContent; options?: { timeout?: number } }) => {
  showToast(options.content, options.options);
});

window.main.on('plugins.uiAlert', (_, options: Record<string, any>) => {
  window.showAlert?.(options);
});

window.main.on('plugins.uiDialog', (_, options: Record<string, any>) => {
  window.showWrapper?.(options);
});

window.main.on('ui.prompt', (_, id: string, options: Record<string, any>) => {
  window.showPrompt?.({
    ...options,
    onComplete: (value: string) => {
      window.main.notifyPromptResult(id, value);
    },
    onHide: () => {
      window.main.notifyPromptResult(id, null);
    },
  });
});
