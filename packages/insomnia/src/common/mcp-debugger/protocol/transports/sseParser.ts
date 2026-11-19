export interface SSEFrame {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental Server-Sent-Events parser. Call `push(textChunk)` as bytes
 * arrive; it returns any frames completed by that chunk and buffers the rest.
 * Follows the WHATWG event-stream framing rules we need: `\n\n` or `\r\n\r\n` ends a frame,
 * `data:` lines join with `\n`, lines starting with `:` are comments. A frame with
 * no data — or an empty data field, e.g. the spec's reconnect-priming event
 * (`id: …` + empty `data:`) — carries no JSON-RPC message and is skipped.
 */
export class SSEFrameParser {
  private buffer = "";

  push(chunk: string): SSEFrame[] {
    this.buffer += chunk;
    const frames: SSEFrame[] = [];

    let frameEnd: number;
    while ((frameEnd = this.indexOfFrameEnd(this.buffer)) !== -1) {
      const raw = this.buffer.slice(0, frameEnd);
      this.buffer = this.buffer.slice(frameEnd).replace(/^[\r\n]+/, "");
      const frame = this.parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private indexOfFrameEnd(text: string): number {
    const lf = text.indexOf("\n\n");
    const crlf = text.indexOf("\r\n\r\n");
    if (lf === -1) return crlf;
    if (crlf === -1) return lf;
    return Math.min(lf, crlf);
  }

  private parseFrame(raw: string): SSEFrame | null {
    let event = "message";
    let id: string | undefined;
    const dataLines: string[] = [];

    for (const line of raw.split(/\r?\n/)) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
      else if (field === "id") id = value;
    }

    const data = dataLines.join("\n");
    if (data === "") return null;
    return { event, data, ...(id !== undefined ? { id } : {}) };
  }
}
