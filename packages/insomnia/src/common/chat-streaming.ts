import type { RequestHeader } from 'insomnia-data';

// Whether the request body already opts into streaming. Only OpenAI/Anthropic use a `stream: true`
// body flag — Gemini streams via a distinct `:streamGenerateContent` URL suffix instead, so this
// deliberately only answers "is the generic body flag set", not "will this actually stream".
export const hasStreamingBodyFlag = (bodyText?: string): boolean => {
  if (!bodyText) {
    return false;
  }
  try {
    const parsed = JSON.parse(bodyText);
    return parsed?.stream === true;
  } catch {
    return false;
  }
};

// Returns the body text with `stream: true` merged in, or null if the body isn't currently valid
// JSON (caller decides how to surface that) or the flag is already set (nothing to do).
export const ensureStreamingBodyFlag = (bodyText?: string): string | null => {
  try {
    const parsed = bodyText ? JSON.parse(bodyText) : {};
    if (parsed?.stream === true) {
      return null;
    }
    return JSON.stringify({ ...parsed, stream: true });
  } catch {
    return null;
  }
};

// OpenAI-format streams only report token usage (so cost) when the body sets `stream_options.include_usage`.
export const hasIncludeUsageFlag = (bodyText?: string): boolean => {
  try {
    return JSON.parse(bodyText || '')?.stream_options?.include_usage === true;
  } catch {
    return false;
  }
};

// Returns the body text with `stream_options.include_usage: true` merged in (keeping other stream_options and a
// multi-line body's indentation), or null if the body isn't valid JSON or the flag is already set.
export const ensureIncludeUsageFlag = (bodyText?: string): string | null => {
  try {
    const parsed = bodyText ? JSON.parse(bodyText) : {};
    if (parsed?.stream_options?.include_usage === true) {
      return null;
    }
    const next = { ...parsed, stream_options: { ...parsed?.stream_options, include_usage: true } };
    return JSON.stringify(next, null, bodyText?.includes('\n') ? 2 : undefined);
  } catch {
    return null;
  }
};

// Finds an existing Accept header by name case-insensitively (HTTP header names are
// case-insensitive, and a duplicated/hand-edited request may not match the app's own default
// casing) and sets its value, or appends a fresh "Accept" header if none exists.
export const ensureEventStreamAcceptHeader = (
  headers: RequestHeader[],
): { headers: RequestHeader[]; changed: boolean } => {
  const existingIndex = headers.findIndex(header => header.name.toLowerCase() === 'accept');
  if (existingIndex === -1) {
    return { headers: [...headers, { name: 'Accept', value: 'text/event-stream' }], changed: true };
  }
  if (headers[existingIndex].value === 'text/event-stream') {
    return { headers, changed: false };
  }
  return {
    headers: headers.map((header, index) =>
      index === existingIndex ? { ...header, value: 'text/event-stream' } : header,
    ),
    changed: true,
  };
};
