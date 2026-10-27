/**
 * A server's progress report on a running call — [extensibility.md §3.3](../../../docs/architecture/extensibility.md).
 *
 * `notifications/progress` is the server's text and numbers, so what leaves the wire is cleaned once, here: the numbers are finite,
 * and the message is plain text of at most {@link PROGRESS_MESSAGE_CAP} characters with no control or direction-changing characters.
 * It is shown on the running card as the server's words and is never sent to the model. No SDK import: the wire, the mock and
 * the harness all read this file.
 */

/** The most characters of a server's progress message that are kept. */
export const PROGRESS_MESSAGE_CAP = 200;

/** One report: how far the call is, out of `total` when the server says, and what it is doing. `message` is the server's own text. */
export interface WireProgress {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

/** Whether a character may stay in a progress message: not a control character, and not one that changes the direction of the text around it. */
function keepable(code: number): boolean {
  if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
  // The bidirectional controls: embeddings and overrides (U+202A..U+202E), isolates (U+2066..U+2069), and the marks (U+200E, U+200F, U+061C).
  if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return false;
  return code !== 0x200e && code !== 0x200f && code !== 0x061c;
}

/** The message as plain text: a run of removed characters becomes one space, the ends are trimmed, and it is cut to the cap with an ellipsis. */
export function cleanProgressMessage(raw: string): string {
  const kept: string[] = [];
  let gap = false;
  for (const character of raw) {
    if (!keepable(character.codePointAt(0) ?? 0)) {
      gap = kept.length > 0;
      continue;
    }
    if (gap && character !== ' ') kept.push(' ');
    gap = false;
    if (character === ' ' && kept.length === 0) continue;
    kept.push(character);
  }
  const text = kept.join('').trimEnd();
  if (kept.length <= PROGRESS_MESSAGE_CAP) return text;
  return `${kept.slice(0, PROGRESS_MESSAGE_CAP - 1).join('').trimEnd()}…`;
}

/** What a server's report says, or `undefined` for one with no usable number. A `total` that is not a positive number is dropped. */
export function cleanProgress(raw: { readonly progress?: unknown; readonly total?: unknown; readonly message?: unknown }): WireProgress | undefined {
  const { progress, total, message } = raw;
  if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0) return undefined;
  const text = typeof message === 'string' ? cleanProgressMessage(message) : '';
  return {
    progress,
    ...(typeof total === 'number' && Number.isFinite(total) && total > 0 ? { total } : {}),
    ...(text === '' ? {} : { message: text }),
  };
}
