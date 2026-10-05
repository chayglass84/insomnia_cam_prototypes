import { expect } from '@playwright/test';

import { test } from '../../playwright/test';

// A streaming chat-completion response used to be undetectable: the shape-detector that powers the
// bubble UI only ever ran against `application/json` bodies, and a real event-stream chat endpoint
// comes back as `text/event-stream` instead — so the follow-up compose box and bubble view wired up
// for it in response-pane.tsx were unreachable dead code (any event-stream request is routed to the
// separate realtime response pane). This exercises the real path: a live Anthropic-shaped SSE
// response rendered as chat bubbles, with model/token-usage summary, inside that realtime pane.
test('AI Gateway chat: a streaming chat-completion response renders as bubbles with a token-usage summary', async ({
  page,
  insomnia,
}) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url http://127.0.0.1:4010/v1/messages ` +
        `-H 'Accept: text/event-stream' -H 'Content-Type: application/json' ` +
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Hi"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect.soft(requestPane.getByTestId('OneLineEditor').getByText('http://127.0.0.1:4010/v1/messages')).toBeVisible();

  await requestPane.getByRole('button', { name: 'Connect' }).click();

  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });

  const chatTab = responsePane.getByRole('tab', { name: 'Chat' });
  await expect.soft(chatTab).toBeVisible();
  await expect.soft(chatTab).toHaveAttribute('aria-selected', 'true');

  // The folded-in request message and the live-accumulated assistant reply both render as bubbles.
  await expect.soft(responsePane.getByText('Hi', { exact: true })).toBeVisible();
  await expect.soft(responsePane.getByText('Hello from mock Anthropic stream!')).toBeVisible();

  // The summary bar surfaces model + final token usage once the stream completes.
  await expect.soft(responsePane.getByText('claude-sonnet-5').first()).toBeVisible();
  await expect.soft(responsePane.getByText('12 in / 8 out')).toBeVisible();
  await expect.soft(responsePane.getByText('end_turn')).toBeVisible();

  // The per-bubble footer beneath the assistant reply also shows model + tokens for that turn.
  await expect.soft(responsePane.getByText('claude-sonnet-5 / 12 tokens in, 8 out')).toBeVisible();

  // The follow-up composer is present so the conversation can be continued from the bubble view.
  await expect.soft(responsePane.getByPlaceholder('Reply to continue the conversation…')).toBeVisible();
});

// The non-streaming chat follow-up composer used to be wired to the realtime "connect" action,
// which only ever applies to event-stream requests — for an ordinary one-shot JSON chat response
// (this pane's actual case, since event-stream requests are routed elsewhere) that meant clicking
// "Send" silently did nothing. It's now a plain re-send instead.
test('AI Gateway chat: the non-streaming follow-up composer actually sends a new request', async ({
  page,
  insomnia,
}) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url http://127.0.0.1:4010/v1/messages-sync ` +
        `-H 'Content-Type: application/json' ` +
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"messages":[{"role":"user","content":"Hi"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect
    .soft(requestPane.getByTestId('OneLineEditor').getByText('http://127.0.0.1:4010/v1/messages-sync'))
    .toBeVisible();

  await requestPane.getByRole('button', { name: 'Send' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });
  await expect.soft(responsePane.getByText('Echo: Hi')).toBeVisible();

  const followUpBox = responsePane.getByPlaceholder('Reply to continue the conversation…');
  await expect.soft(followUpBox).toBeVisible();
  await followUpBox.fill('Second turn');
  await responsePane.getByRole('button', { name: 'Send' }).click();

  await expect.soft(responsePane.getByText('Echo: Second turn')).toBeVisible({ timeout: 10_000 });
});

// Real bug hit by manual testing: an Accept: text/event-stream header alone routes a request to
// the realtime pane and shows "Connect", but most providers also require a `"stream": true` body
// flag to actually stream — without it, the request still sends fine but comes back as one normal
// reply with nothing for the Chat tab to show, which looked like Connect was silently broken. The
// Chat tab now detects exactly this state and offers a one-click fix.
test('AI Gateway chat: missing "stream": true in the body is detected and fixable from the Chat tab', async ({
  page,
  insomnia,
}) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url http://127.0.0.1:4010/v1/messages ` +
        `-H 'Accept: text/event-stream' -H 'Content-Type: application/json' ` +
        // Deliberately missing "stream": true, unlike the streaming test above.
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"messages":[{"role":"user","content":"Hi"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect.soft(requestPane.getByTestId('OneLineEditor').getByText('http://127.0.0.1:4010/v1/messages')).toBeVisible();

  await requestPane.getByRole('button', { name: 'Connect' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });

  const chatTab = responsePane.getByRole('tab', { name: 'Chat' });
  await expect.soft(chatTab).toBeVisible();

  // The banner shows up, and the assistant reply never renders because the inferred streaming
  // JSONPath ($.delta.text) finds nothing in a non-streaming response shape.
  const fixButton = responsePane.getByRole('button', { name: 'Add "stream": true' });
  await expect.soft(fixButton).toBeVisible();
  await expect.soft(responsePane.getByText('Hello from mock Anthropic non-stream reply!')).toBeHidden();

  await fixButton.click();
  await expect.soft(fixButton).toBeHidden();

  // Re-send now that the body has the flag — this time it actually streams and the banner is gone.
  await requestPane.getByRole('button', { name: 'Connect' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });
  await expect.soft(responsePane.getByText('Hello from mock Anthropic stream!')).toBeVisible();
  await expect.soft(responsePane.getByRole('button', { name: 'Add "stream": true' })).toBeHidden();
});

// Real bug: the follow-up composer only ever appended the new user turn to the request body,
// never writing the previous turn's assistant reply back in — so a second follow-up resent the
// conversation as consecutive user-only turns with no assistant turns between them, and the model
// would answer the entire run-on history in one reply. This confirms the fix: after the first
// reply, a follow-up (submitted via Enter, not a Send click, to also cover that fix) must result in
// the *next* request body actually containing that assistant turn.
test('AI Gateway chat: a follow-up correctly threads the previous assistant reply back into the conversation', async ({
  page,
  insomnia,
}) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url 'http://127.0.0.1:4010/v1/messages?reportThreading=1' ` +
        `-H 'Accept: text/event-stream' -H 'Content-Type: application/json' ` +
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"turn1"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await requestPane.getByRole('button', { name: 'Connect' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });

  // First turn: no assistant turns exist yet in the request body.
  await expect.soft(responsePane.getByText('assistantTurns=0 lastUser=turn1')).toBeVisible();

  const followUpBox = responsePane.getByPlaceholder('Reply to continue the conversation…');
  await followUpBox.fill('turn2');
  await followUpBox.press('Enter');

  // Second turn: the request this reconnect sent must now contain exactly one assistant turn
  // (the first reply, threaded back in) and the new user turn as the latest user message.
  await expect.soft(responsePane.getByText('assistantTurns=1 lastUser=turn2')).toBeVisible({ timeout: 10_000 });
});

// User-reported: editing the system prompt mid-conversation (in the Raw body editor) didn't seem
// to change the model's behavior on the next turn. The System-prompt bubble itself did update, so
// the question was whether the edit actually reaches the *next request sent*, or gets lost
// somewhere between the Raw editor and the follow-up composer's connect payload.
test('AI Gateway chat: editing the system prompt mid-conversation reaches the next request sent', async ({
  page,
  insomnia,
}) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url 'http://127.0.0.1:4010/v1/messages?reportThreading=1' ` +
        `-H 'Accept: text/event-stream' -H 'Content-Type: application/json' ` +
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"system":"You are a helpful assistant.","messages":[{"role":"user","content":"turn1"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await requestPane.getByRole('button', { name: 'Connect' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });
  await expect.soft(responsePane.getByText('system=You are a helpful assistant.')).toBeVisible();

  // Edit the system prompt via the Raw body editor (the Chat/Raw compose editor doesn't render for
  // event-stream requests, so this is the only way to edit the body — exactly what the user did).
  // Note: `#raw-editor` is the id CodeMirror's *hidden* source `<textarea>` keeps — the real,
  // visible editing surface is a sibling `.CodeMirror` div it creates next to that textarea, not a
  // descendant of it, so the locator has to be scoped to the Body tabpanel instead.
  await requestPane.getByRole('tab', { name: 'Body' }).click();
  const rawEditor = requestPane.getByRole('tabpanel', { name: 'Body' }).locator('.CodeMirror');
  await rawEditor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(
    JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 100,
      stream: true,
      system: 'Speak like a pirate.',
      messages: [{ role: 'user', content: 'turn1' }],
    }),
  );
  // The System-prompt bubble is a direct, live reflection of the request body text, so its update
  // confirms the edit landed in `activeRequest.body.text` before moving on.
  await expect.soft(responsePane.getByText('Speak like a pirate.')).toBeVisible();

  const followUpBox = responsePane.getByPlaceholder('Reply to continue the conversation…');
  await followUpBox.fill('turn2');
  await followUpBox.press('Enter');

  // The actual request this follow-up sends must carry the edited system prompt, not the original.
  await expect.soft(responsePane.getByText('system=Speak like a pirate.')).toBeVisible({ timeout: 10_000 });
});

// The user's ask: a plain non-streaming POST (no Accept header, no "stream": true) should be fully
// fixed and reconnected in one click of "Enable streaming" — not just the body or just the header,
// and not leave the user to click Connect again themselves afterward.
test('AI Gateway chat: "Enable streaming" fixes the header and body and auto-connects', async ({ page, insomnia }) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url http://127.0.0.1:4010/v1/messages ` +
        `-H 'Content-Type: application/json' ` +
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"messages":[{"role":"user","content":"Hi"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await expect.soft(requestPane.getByTestId('OneLineEditor').getByText('http://127.0.0.1:4010/v1/messages')).toBeVisible();

  await requestPane.getByRole('button', { name: 'Send' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });
  await expect.soft(responsePane.getByText('Hello from mock Anthropic non-stream reply!')).toBeVisible();

  await responsePane.getByRole('button', { name: 'Enable streaming' }).click();
  // The toast renders in a global portal outside the response pane's own DOM subtree.
  const toast = page.getByRole('alertdialog', { name: /Enabled streaming/ });
  await expect.soft(toast).toBeVisible();
  await expect.soft(toast.getByText('Added "stream": true to the body')).toBeVisible();
  await expect.soft(toast.getByText('Added an Accept: text/event-stream header')).toBeVisible();
  await expect.soft(toast.getByText('Connecting…')).toBeVisible();

  // One click took it all the way to a real, live streamed reply — no second Connect click.
  await expect.soft(requestPane.getByRole('button', { name: 'Connect' })).toBeVisible();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });
  const chatTab = responsePane.getByRole('tab', { name: 'Chat' });
  await expect.soft(chatTab).toBeVisible();
  await expect.soft(responsePane.getByText('Hello from mock Anthropic stream!')).toBeVisible();

  // Real bug: this toast is still open and sits bottom-right, the same corner as the follow-up
  // composer's Send button — without the composer sitting above the toast's z-index, Playwright's
  // (and a real user's) click here would hit the toast instead and silently do nothing.
  await expect.soft(toast).toBeVisible();
  const followUpBox = responsePane.getByPlaceholder('Reply to continue the conversation…');
  await followUpBox.fill('typed while toast is open');
  await responsePane.getByRole('button', { name: 'Send' }).click();
  await expect.soft(followUpBox).toHaveValue('');
});

// Real bug: the message list didn't stay scrolled to the bottom as a reply grew past the visible
// height of the pane, leaving the user looking at the top of a long reply instead of its end.
test('AI Gateway chat: the message list stays scrolled to the bottom as a long reply streams in', async ({
  page,
  insomnia,
}) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url 'http://127.0.0.1:4010/v1/messages?longReply=1' ` +
        `-H 'Accept: text/event-stream' -H 'Content-Type: application/json' ` +
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Give me a long reply"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await requestPane.getByRole('button', { name: 'Connect' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });
  await expect.soft(responsePane.getByText('Line 60')).toBeVisible({ timeout: 10_000 });

  const messageList = responsePane.getByTestId('chat-message-list');
  const readScrollState = () =>
    messageList.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

  // The auto-scroll is driven by a ResizeObserver, whose callback fires on a later frame than the
  // DOM mutation that triggered it (and `toBeVisible()` above doesn't itself wait for scrolling
  // within an overflow container) — poll instead of reading scroll position exactly once.
  await expect
    .poll(async () => {
      const { scrollTop, scrollHeight, clientHeight } = await readScrollState();
      return scrollTop + clientHeight >= scrollHeight - 2;
    }, { timeout: 5000 })
    .toBe(true);

  const { scrollHeight, clientHeight } = await readScrollState();
  expect.soft(scrollHeight).toBeGreaterThan(clientHeight); // sanity: the content actually overflows
});

// The user's ask: move the system prompt (and model/temperature/max_tokens) into the summary bar
// as editable fields, and warn when a change needs a reconnect to take effect.
test('AI Gateway chat: editing settings in the bar warns that a reconnect is needed, and reconnect applies them', async ({
  page,
  insomnia,
}) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url 'http://127.0.0.1:4010/v1/messages?reportThreading=1' ` +
        `-H 'Accept: text/event-stream' -H 'Content-Type: application/json' ` +
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"system":"Be terse.","messages":[{"role":"user","content":"turn1"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await requestPane.getByRole('button', { name: 'Connect' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });

  // No bubble for the system prompt anymore — it lives in the settings bar instead. (The mock's
  // reply text contains "Be terse." as a substring — `system=Be terse. model=...` — so this must
  // match exactly, not loosely, or it'll "find" that echoed reply instead of a real bubble.)
  await expect.soft(responsePane.getByTestId('chat-message-list').getByText('Be terse.', { exact: true })).toHaveCount(0);

  const notice = responsePane.getByText('Settings changed — reconnect to use them.');
  const systemField = responsePane.getByRole('textbox', { name: 'System prompt', exact: true });
  await expect.soft(systemField).toHaveValue('Be terse.');

  // Real bug: focusing and blurring a field without actually changing anything (e.g. just
  // clicking in to read a value) used to show the warning anyway, because the "did this change"
  // check compared a trimmed value against an untrimmed one.
  await systemField.click();
  await systemField.blur();
  await expect.soft(notice).toBeHidden();

  await systemField.fill('Speak like a pirate.');
  await systemField.blur();

  // A real edit still warns that the live connection won't see the change until reconnecting.
  await expect.soft(notice).toBeVisible();

  await responsePane.getByRole('button', { name: 'Reconnect' }).click();
  await expect.soft(notice).toBeHidden();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });
  await expect.soft(responsePane.getByText('system=Speak like a pirate.')).toBeVisible();
});

// The user's ask: a dropdown for the model field so they don't have to guess at names.
test('AI Gateway chat: picking a model from the settings-bar dropdown applies it on reconnect', async ({
  page,
  insomnia,
}) => {
  test.slow(process.platform === 'darwin' || process.platform === 'win32', 'Slow app start on these platforms');

  const requestPane = page.getByTestId('request-pane');
  const responsePane = page.getByTestId('response-pane').first();

  await page.getByRole('button', { name: 'Create request collection', exact: true }).click();
  await insomnia.navigationSidebar.openWorkspaceActionsDropdown('My first collection');
  await page.getByRole('menuitemradio', { name: 'From Curl' }).click();
  await page
    .getByRole('dialog')
    .locator('.CodeMirror textarea')
    .fill(
      `curl --request POST --url 'http://127.0.0.1:4010/v1/messages?reportThreading=1' ` +
        `-H 'Accept: text/event-stream' -H 'Content-Type: application/json' ` +
        `--data '{"model":"claude-sonnet-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"turn1"}]}'`,
    );
  await page.getByRole('dialog').getByRole('button', { name: 'Import' }).click();
  await requestPane.getByRole('button', { name: 'Connect' }).click();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });

  const modelField = responsePane.getByRole('combobox', { name: 'Model' });
  await expect.soft(modelField).toHaveValue('claude-sonnet-5');
  await modelField.click();
  // The combobox's popover renders in a portal outside the response pane's own DOM subtree (same
  // as the toast region elsewhere in this file).
  await page.getByRole('option', { name: 'claude-opus-5-5' }).click();
  await expect.soft(modelField).toHaveValue('claude-opus-5-5');

  const notice = responsePane.getByText('Settings changed — reconnect to use them.');
  await expect.soft(notice).toBeVisible();

  await responsePane.getByRole('button', { name: 'Reconnect' }).click();
  await expect.soft(notice).toBeHidden();
  await expect.soft(responsePane.getByTestId('response-status-tag')).toContainText('200', { timeout: 10_000 });
  await expect.soft(responsePane.getByText('model=claude-opus-5-5')).toBeVisible();
});
