import React, { type FC, useEffect, useMemo, useState } from 'react';
import { Button, Tooltip, TooltipTrigger } from 'react-aria-components';

// Read-only JSON with syntax highlighting, colored like the app's code editor (cm-property / cm-string / cm-number /
// cm-atom in main.css). A tiny tokenizer over pretty-printed JSON: the trace shows small payloads, so a full editor
// per block would be heavier than it is worth.
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export const tokenizeJson = (text: string): { text: string; className?: string }[] => {
  const parts: { text: string; className?: string }[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({ text: text.slice(last, index) });
    }
    const [whole, str, colon, atom] = match;
    if (str !== undefined) {
      parts.push({ text: str, className: colon ? 'text-(--color-success)' : 'text-(--color-notice)' });
      if (colon) {
        parts.push({ text: colon });
      }
    } else if (atom !== undefined) {
      parts.push({ text: whole, className: 'text-(--color-surprise)' });
    } else {
      parts.push({ text: whole, className: 'text-(--color-surprise)' });
    }
    last = index + whole.length;
  }
  if (last < text.length) {
    parts.push({ text: text.slice(last) });
  }
  return parts;
};

export const JsonView: FC<{ value: unknown }> = ({ value }) => {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? 'undefined', [value]);
  const parts = useMemo(() => tokenizeJson(text), [text]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      console.error('[mcp-debugger] copy failed', err);
    }
  };

  return (
    <div className="relative">
      <pre className="overflow-auto rounded-xs bg-(--hl-xs) p-2 pr-8 text-xs">
        {parts.map((part, i) => (
          // eslint-disable-next-line react/no-array-index-key -- tokens have no identity
          <span key={i} className={part.className}>
            {part.text}
          </span>
        ))}
      </pre>
      <TooltipTrigger delay={200}>
        <Button
          aria-label="Copy JSON"
          onPress={copy}
          data-testid="mcp-copy-json"
          className="absolute top-1 right-1 flex h-6 w-6 items-center justify-center rounded-xs text-(--hl) hover:bg-(--hl-sm) hover:text-(--color-font)"
        >
          <i className={`fa ${copied ? 'fa-check' : 'fa-copy'}`} />
        </Button>
        <Tooltip
          offset={8}
          className="rounded-md border border-solid border-(--hl-sm) bg-(--color-bg) px-3 py-2 text-xs text-(--color-font) shadow-lg select-none"
        >
          {copied ? 'Copied' : 'Copy JSON'}
        </Tooltip>
      </TooltipTrigger>
    </div>
  );
};
