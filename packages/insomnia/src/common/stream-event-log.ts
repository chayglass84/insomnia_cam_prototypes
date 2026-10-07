// Prototype (3593AI). A streamed (curl) response keeps an NDJSON log of its events in `bodyPath`; a response from a plain
// send keeps the raw body there. This tells them apart by content, mirroring `isCurlEvent` in main/network/curl.ts
// (which lives in the main process and cannot be imported here).
const EVENT_TYPES = new Set(['open', 'message', 'close', 'error']);

export const isStreamEventLog = (bodyText: string): boolean => {
  const firstLine = bodyText.split('\n').find(line => line.trim());
  if (!firstLine) {
    return false;
  }
  try {
    const parsed = JSON.parse(firstLine);
    return (
      Boolean(parsed) &&
      typeof parsed === 'object' &&
      typeof parsed._id === 'string' &&
      typeof parsed.requestId === 'string' &&
      EVENT_TYPES.has(parsed.type)
    );
  } catch {
    return false;
  }
};

/** True when the body is a real, non-empty HTTP body (not a stream's event log). False for no/empty body. */
export const isPlainHttpBody = (body?: Uint8Array | null): boolean =>
  Boolean(body?.length) && !isStreamEventLog(new TextDecoder().decode(body!));
