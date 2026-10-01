import React, { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';

import { parseChatRequestBody, serializeChatRequestBody } from '~/common/chat-request';
import { debounce } from '~/common/misc';
import { Icon } from '~/ui/components/icon';

import { RawEditor } from './raw-editor';

interface Props {
  bodyText: string;
  onChange: (newBodyText: string) => void;
  contentType: string;
  historyKey: string;
}

const tabClassName =
  'flex h-full shrink-0 cursor-pointer items-center gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm)';

export const ChatRequestEditor: FC<Props> = ({ bodyText, onChange, contentType, historyKey }) => {
  const parsed = parseChatRequestBody(bodyText);

  if (!parsed) {
    return <RawEditor historyKey={historyKey} contentType={contentType} content={bodyText} onChange={onChange} />;
  }

  return (
    <Tabs aria-label="Request body" className="flex h-full w-full flex-1 flex-col">
      <TabList
        className="flex h-(--line-height-sm) w-full shrink-0 items-center border-b border-solid border-b-(--hl-md) bg-(--color-bg)"
        aria-label="Request body tabs"
      >
        <Tab className={tabClassName} id="chat">
          Chat
        </Tab>
        <Tab className={tabClassName} id="raw">
          Raw
        </Tab>
      </TabList>
      <TabPanel className="flex w-full flex-1 flex-col overflow-hidden" id="chat">
        <ChatCompose bodyText={bodyText} format={parsed.format} model={parsed.model} messages={parsed.messages} onChange={onChange} />
      </TabPanel>
      <TabPanel className="flex w-full flex-1 flex-col overflow-hidden" id="raw">
        <RawEditor historyKey={historyKey} contentType={contentType} content={bodyText} onChange={onChange} />
      </TabPanel>
    </Tabs>
  );
};

interface ChatComposeProps {
  bodyText: string;
  format: 'openai' | 'anthropic' | 'gemini';
  model?: string;
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  onChange: (newBodyText: string) => void;
}

// Owns its own state rather than fully re-deriving from props on every render, so a keystroke
// doesn't force a remount (that drops DOM focus mid-edit, since the element being typed into is
// destroyed and recreated). `lastEmittedState` tracks the {model, messages} this component itself
// last produced, compared by value rather than by the raw `bodyText` string: the save round trip
// doesn't guarantee byte-identical JSON back (whitespace/formatting can shift), so a string
// comparison was treating the component's own saved edit as an "external" change on every save
// and needlessly resyncing (visible as flicker) even though nothing had actually changed.
const ChatCompose: FC<ChatComposeProps> = ({ bodyText, format, model, messages, onChange }) => {
  const [localModel, setLocalModel] = useState(model ?? '');
  const [localMessages, setLocalMessages] = useState(messages);
  const lastEmittedBodyText = useRef(bodyText);
  const lastEmittedState = useRef(JSON.stringify({ model, messages }));
  const newRowIndex = useRef<number | null>(null);
  const messageRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  // Patching on every single keystroke (rather than debouncing, same as the CodeMirror-backed
  // Raw editor already does via misc.debounce) lets fast typing fire overlapping async patches
  // whose responses can land out of order, which was intermittently clobbering the field the
  // user was actively typing into with a stale value.
  const debouncedOnChange = useMemo(() => debounce(onChange, 100), [onChange]);

  useEffect(() => {
    const incoming = JSON.stringify({ model, messages });
    if (incoming !== lastEmittedState.current) {
      lastEmittedState.current = incoming;
      lastEmittedBodyText.current = bodyText;
      setLocalModel(model ?? '');
      setLocalMessages(messages);
    }
  }, [bodyText, model, messages]);

  useEffect(() => {
    if (newRowIndex.current !== null) {
      messageRefs.current[newRowIndex.current]?.focus();
      newRowIndex.current = null;
    }
  }, [localMessages]);

  const emit = (next: { model?: string; messages: ChatComposeProps['messages'] }) => {
    lastEmittedState.current = JSON.stringify(next);
    const newBodyText = serializeChatRequestBody(lastEmittedBodyText.current, format, next);
    lastEmittedBodyText.current = newBodyText;
    debouncedOnChange(newBodyText);
  };

  const updateMessage = (index: number, patch: Partial<ChatComposeProps['messages'][number]>) => {
    const next = localMessages.map((message, i) => (i === index ? { ...message, ...patch } : message));
    setLocalMessages(next);
    emit({ model: localModel || undefined, messages: next });
  };

  const removeMessage = (index: number) => {
    const next = localMessages.filter((_, i) => i !== index);
    setLocalMessages(next);
    emit({ model: localModel || undefined, messages: next });
  };

  const addMessage = () => {
    const next = [...localMessages, { role: 'user' as const, content: '' }];
    newRowIndex.current = next.length - 1;
    setLocalMessages(next);
    emit({ model: localModel || undefined, messages: next });
  };

  return (
    <div data-ignore-send-hotkey className="flex h-full flex-col gap-3 overflow-y-auto p-(--padding-sm)">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-(--hl)">Model{format === 'gemini' ? ' (often set via URL for Gemini)' : ''}</span>
        <input
          type="text"
          value={localModel}
          onChange={event => {
            setLocalModel(event.target.value);
            emit({ model: event.target.value || undefined, messages: localMessages });
          }}
          placeholder="model id"
          className="rounded-xs border border-solid border-(--hl-md) bg-(--color-bg) px-2 py-1 text-sm text-(--color-font) outline-hidden focus:border-(--hl)"
        />
      </label>

      <div className="flex flex-col gap-3">
        {localMessages.map((message, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key -- messages have no stable id
            key={index}
            className="flex flex-col gap-1 rounded-md border border-solid border-(--hl-sm) p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <select
                value={message.role}
                onChange={event => updateMessage(index, { role: event.target.value as ChatComposeProps['messages'][number]['role'] })}
                className="rounded-xs border border-solid border-(--hl-md) bg-(--color-bg) px-1 py-0.5 text-xs text-(--color-font)"
              >
                <option value="system">system</option>
                <option value="user">user</option>
                <option value="assistant">assistant</option>
              </select>
              <Button
                onPress={() => removeMessage(index)}
                aria-label="Remove message"
                className="flex items-center justify-center rounded-xs p-1 text-(--hl) outline-hidden hover:bg-(--hl-sm) hover:text-(--color-font)"
              >
                <Icon icon="trash" />
              </Button>
            </div>
            <textarea
              ref={el => {
                messageRefs.current[index] = el;
              }}
              value={message.content}
              onChange={event => updateMessage(index, { content: event.target.value })}
              rows={3}
              className="w-full resize-y rounded-xs border border-solid border-(--hl-md) bg-(--color-bg) px-2 py-1 text-sm text-(--color-font) outline-hidden focus:border-(--hl)"
            />
          </div>
        ))}
      </div>

      <Button
        onPress={addMessage}
        className="flex w-fit items-center gap-2 rounded-xs px-3 py-1 text-sm text-(--hl) outline-hidden hover:bg-(--hl-sm) hover:text-(--color-font)"
      >
        <Icon icon="plus" />
        Add message
      </Button>
    </div>
  );
};
