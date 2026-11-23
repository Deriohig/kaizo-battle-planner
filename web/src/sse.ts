// Reads a server-sent event stream from a `fetch` body (a POST stream cannot use EventSource). Follows the WHATWG
// event-stream rules: lines end in LF, CRLF or CR; `:` lines are comments; `data:` lines join with "\n"; a blank line
// dispatches; a frame the stream cuts off before its blank line is dropped. `id` and `retry` are ignored.

export interface SseEvent { event: string; data: string }

const LINE_END = /\r\n|\r|\n/g;

export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: SseEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let data: string[] = [];

  function line(text: string): void {
    if (text === '') {
      if (data.length > 0) onEvent({ event: eventType === '' ? 'message' : eventType, data: data.join('\n') });
      eventType = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventType = value;
    else if (field === 'data') data.push(value);
  }

  /**
   * Handles every complete line in the buffer. A trailing CR waits for the next chunk, which may start with its LF.
   * The kept tail holds no line end before its last character, so the next scan starts there: a long line spread over
   * many chunks is scanned once, not once per chunk.
   */
  let scanFrom = 0;
  function lines(final: boolean): void {
    let start = 0;
    LINE_END.lastIndex = scanFrom;
    for (let m = LINE_END.exec(buffer); m !== null; m = LINE_END.exec(buffer)) {
      if (!final && m[0] === '\r' && m.index === buffer.length - 1) break;
      line(buffer.slice(start, m.index));
      start = m.index + m[0].length;
    }
    buffer = buffer.slice(start);
    scanFrom = Math.max(0, buffer.length - 1);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        lines(true);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      lines(false);
    }
  } catch (err) {
    await reader.cancel(err).catch(() => undefined);      // a throwing onEvent stops the download too
    throw err;
  } finally {
    reader.releaseLock();
  }
}
