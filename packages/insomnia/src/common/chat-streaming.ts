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
