/**
 * Server-sent events, parsed incrementally — the wire format §3 names ("SSE parsing of
 * `data:` lines per the OpenAI wire format").
 *
 * Line endings may be `\n`, `\r\n` or a lone `\r`, and a network chunk can end between
 * the `\r` and the `\n` of one ending. A trailing `\r` is therefore held back until the
 * next chunk says whether a `\n` follows, instead of being counted as two line ends.
 *
 * Each event is delivered as an `{event, data}` pair: Anthropic and OpenAI Responses
 * name their events (`message_start`, `response.completed`, …) and the adapter needs
 * the name, so unlike a generic SSE consumer this parser keeps it. Comments (lines
 * beginning with `:`, which providers use as keep-alives) and `id:` carry nothing the
 * gateway uses. An event is the fields between blank lines, with its `data:` lines
 * joined with `\n` as the spec requires.
 */

export interface SseEvent {
  /** The `event:` name, when the stream declared one. */
  readonly event?: string;
  /** The event's `data:` lines, joined with `\n`. */
  readonly data: string;
}

export interface SseParser {
  /** Feeds decoded text and returns every event it completed. */
  push(text: string): SseEvent[];
  /** Ends the stream and returns any event still open. A truncated final event is kept, so the caller reports it as malformed rather than losing it silently. */
  end(): SseEvent[];
}

export function createSseParser(): SseParser {
  let pending = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let completed: SseEvent[] = [];

  const field = (line: string): void => {
    if (line === '') {
      if (dataLines.length > 0) {
        const data = dataLines.join('\n');
        // An event with no payload is a keep-alive in practice, not a message.
        if (data !== '') completed.push(eventName === undefined ? { data } : { event: eventName, data });
        dataLines = [];
      }
      // The event name belongs to the event it was declared in: the spec clears it on every
      // blank line, one that dispatched an event and one that dispatched nothing.
      eventName = undefined;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') dataLines.push(value);
    else if (name === 'event') eventName = value;
  };

  const drain = (): SseEvent[] => {
    const out = completed;
    completed = [];
    return out;
  };

  return {
    push(text) {
      pending += text;
      let start = 0;
      for (let i = 0; i < pending.length; i += 1) {
        const ch = pending[i];
        if (ch === '\n') {
          field(pending.slice(start, i));
          start = i + 1;
        } else if (ch === '\r') {
          // The last character may be half of a \r\n split across chunks: wait for more.
          if (i + 1 === pending.length) break;
          field(pending.slice(start, i));
          if (pending[i + 1] === '\n') i += 1;
          start = i + 1;
        }
      }
      pending = pending.slice(start);
      return drain();
    },
    end() {
      if (pending !== '') {
        // A held-back \r is a line ending now that no \n can follow it.
        field(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
        pending = '';
      }
      if (dataLines.length > 0) {
        const data = dataLines.join('\n');
        if (data !== '') completed.push(eventName === undefined ? { data } : { event: eventName, data });
        dataLines = [];
        eventName = undefined;
      }
      return drain();
    },
  };
}
