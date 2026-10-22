/**
 * Showing a skill's text as it is — for the review card (extensibility.md §10, D13).
 *
 * The card shows each file verbatim as plain text. Text a reader cannot see is the way a skill hides an instruction, so a character
 * that draws nothing (a zero-width space, a bidirectional override, a control character) is shown as its code point in brackets, and the
 * card counts them. An HTML comment is plain text on the card, where a rendered Markdown view would hide it; it is counted too.
 */

/** Whether `code` is a character that draws nothing or changes how text is laid out. A tab and a line break are not. */
export function isHiddenCode(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return false;
  return (
    code < 32 ||
    (code >= 127 && code <= 159) ||
    code === 0xad ||
    code === 0x34f ||
    code === 0x61c ||
    (code >= 0x115f && code <= 0x1160) ||
    (code >= 0x17b4 && code <= 0x17b5) ||
    (code >= 0x180b && code <= 0x180f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0x3164 ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0xfeff ||
    code === 0xffa0 ||
    (code >= 0xfff0 && code <= 0xfffb) ||
    (code >= 0xe0000 && code <= 0xe0fff)
  );
}

export interface HiddenFindings {
  /** Characters that draw nothing, counted. */
  readonly invisible: number;
  /** `<!-- … -->` comments, counted. */
  readonly comments: number;
}

/** `text` with each hidden character replaced by `⟦U+XXXX⟧`, so it can be read. */
export function revealHidden(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += isHiddenCode(code) ? `⟦U+${code.toString(16).toUpperCase().padStart(4, '0')}⟧` : ch;
  }
  return out;
}

/** How much of `text` a reader would not see: hidden characters, and HTML comments. */
export function findHidden(text: string): HiddenFindings {
  let invisible = 0;
  for (const ch of text) if (isHiddenCode(ch.codePointAt(0)!)) invisible += 1;
  let comments = 0;
  let at = text.indexOf('<!--');
  while (at >= 0) {
    comments += 1;
    const end = text.indexOf('-->', at + 4);
    if (end < 0) break;
    at = text.indexOf('<!--', end + 3);
  }
  return { invisible, comments };
}
