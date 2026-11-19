import React, { type FC, useMemo } from 'react';

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
  const parts = useMemo(() => tokenizeJson(JSON.stringify(value, null, 2) ?? 'undefined'), [value]);
  return (
    <pre className="overflow-auto rounded-xs bg-(--hl-xs) p-2 text-xs">
      {parts.map((part, i) => (
        // eslint-disable-next-line react/no-array-index-key -- tokens have no identity
        <span key={i} className={part.className}>
          {part.text}
        </span>
      ))}
    </pre>
  );
};
