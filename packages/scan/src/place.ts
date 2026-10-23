/**
 * Where a finding sits in the file the folder holds — [coherence.md §10](../../../docs/architecture/coherence.md).
 *
 * A finding's evidence is `from`/`to` offsets into the body projection (project-format.md §3): the stored file minus its
 * front matter. A workflow annotation names a line of the stored file, so the front matter's lines are added back here.
 * An Ink container has no front matter (dialogue-narrative.md §2.2), so its body is the file and its offset is 0.
 *
 * Pure: the caller reads the file. Lines are 1-based and count `\n`, so a CRLF file and an LF file give the same line.
 */

import { INK_BODY_EXT, parseDocumentFile } from '@caotang/store';

/** The lines a finding's quote spans in the stored file, 1-based, `endLine >= line`. */
export interface PlacedLines {
  readonly line: number;
  readonly endLine: number;
}

/** One fence line is `---` and nothing after it but spaces and tabs (the document codec's own rule). */
function isFence(line: string): boolean {
  if (!line.startsWith('---')) return false;
  for (let i = 3; i < line.length; i += 1) {
    const char = line.charCodeAt(i);
    if (char !== 32 && char !== 9) return false;
  }
  return true;
}

/** The text of the line starting at `start`, without its terminator, and where the next line starts. */
function lineAt(text: string, start: number): { readonly content: string; readonly next: number } {
  const newline = text.indexOf('\n', start);
  const end = newline < 0 ? text.length : newline;
  const content = text.slice(start, end);
  return { content: content.endsWith('\r') ? content.slice(0, -1) : content, next: newline < 0 ? text.length : newline + 1 };
}

/**
 * Where the body starts in the stored text of a body file: 0 for an Ink file and for a file whose front matter the loader cannot
 * read (it keeps such a file whole as the body, read.ts), otherwise the index after the closing fence and the one blank line the
 * envelope puts before the body (file-body.ts `readBody`).
 */
export function bodyStartOf(storedFileText: string, path: string): number {
  if (path.endsWith(`.${INK_BODY_EXT}`)) return 0;
  try {
    parseDocumentFile(storedFileText);
  } catch {
    return 0;
  }
  const opening = lineAt(storedFileText, 0);
  const crlf = storedFileText.startsWith('\r\n', opening.content.length);
  let cursor = opening.next;
  while (cursor < storedFileText.length) {
    const line = lineAt(storedFileText, cursor);
    cursor = line.next;
    if (!isFence(line.content)) continue;
    if (storedFileText.startsWith(crlf ? '\r\n' : '\n', cursor)) return cursor + (crlf ? 2 : 1);
    return crlf && storedFileText.startsWith('\n', cursor) ? cursor + 1 : cursor;
  }
  return 0;
}

/** The number of `\n` before `index`, plus one. */
function lineNumberOf(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at >= 0 && at < index; at = text.indexOf('\n', at + 1)) line += 1;
  return line;
}

/**
 * The lines of a finding's quote in the stored file. `bodyOffset` is where the body starts in `storedFileText` (`bodyStartOf`).
 * An offset that cannot be resolved (not a whole number, reversed, or past the end of the file) places the finding on line 1,
 * so a stale finding still annotates the file it names.
 */
export function placeFinding(evidence: { readonly from: number; readonly to: number }, storedFileText: string, bodyOffset: number): PlacedLines {
  const { from, to } = evidence;
  const resolvable =
    Number.isInteger(from) && Number.isInteger(to) && Number.isInteger(bodyOffset) && from >= 0 && to >= from && bodyOffset >= 0 && bodyOffset + from <= storedFileText.length;
  if (!resolvable) return { line: 1, endLine: 1 };
  const start = bodyOffset + from;
  const end = Math.min(bodyOffset + to, storedFileText.length);
  const line = lineNumberOf(storedFileText, start);
  // The last character of the quote decides the end line, so a quote that ends at a line break stays on its own line.
  const endLine = end > start ? lineNumberOf(storedFileText, end - 1) : line;
  return { line, endLine };
}
