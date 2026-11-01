/**
 * The plain-text reader (issue #283): a `.txt` manuscript from Word's "Save as text", an old tool or a phone, in any common
 * encoding, turned into the block list every import shares (`@caotang/import-core`, import-core.md §2). Two halves, so the
 * preview can re-run the cheap one on every toggle:
 *
 *   - {@link decodePlainText} reads the bytes through the store's encoding detection (`@caotang/store/encoding`: UTF-8, a UTF-16
 *     byte-order mark or NUL parity, a Windows-1252 guess) and answers `ask` when it cannot name the encoding, with every
 *     candidate scored for the writer to pick from. It keeps no decoder of its own: Windows-1252 goes through the store's
 *     `decodeAs`, the one place that encoding is decoded.
 *   - {@link plainTextBlocks} turns the decoded text into blocks: line endings and no-break spaces normalised, paragraphs split at
 *     blank lines or one per line ("Save as text" writes no blank lines; detected, and the preview can toggle it), scene-break
 *     lines (`* * *`) as breaks, a form feed as a page break, and every paragraph's Markdown escaped so prose is never read as
 *     markup. Finding chapters and scenes is the splitter's job (`splitImport`); this reader only keeps the signals text has.
 *
 * Pure, no DOM, no Node built-ins and no eval: it runs on the main thread, in a `'self'` Worker and in Node.
 */

import type { ImportBlock, ImportDocument, LossWarning, Signals } from '@caotang/import-core';
import { breakMarkerOf, isShortLine, matchFamily, specialOf } from '@caotang/import-core';
import {
  decodeAs,
  detectEncoding,
  type DecodableEncoding,
  type EncodingDetection,
  type ScoredEncodingCandidate,
} from '@caotang/store/encoding';

/** The largest text file the reader takes: a 200k-word novel is about 1.2 MB, so 32 MiB is far past any manuscript. */
export const MAX_TEXT_BYTES = 32 * 1024 * 1024;

/**
 * The most lines (line breaks and form feeds, blank lines included) the reader takes. The byte cap alone does not bound memory:
 * 32 MiB of one-character lines is 16 million lines, and each would become a string and a block. A 200k-word novel hard-wrapped at
 * 70 characters is about 17,000 lines, and a whole series about 100,000, so 250,000 is far past any manuscript while keeping the
 * block list to a few tens of megabytes. Counted on the decoded text in one pass, before anything is split or allocated.
 */
export const MAX_TEXT_LINES = 250_000;

/** How paragraphs are found: at blank lines, one per line, or whichever {@link detectParagraphMode} picks. */
export type ParagraphMode = 'blank' | 'line';

export interface DecodePlainTextOptions {
  /** The writer's pick from the preview; decodes as this encoding whatever the detection says. */
  encoding?: DecodableEncoding;
}

/** The bytes decoded: the text, the encoding it was read as, and whether that encoding is a guess the preview should show. */
export interface DecodedPlainText {
  status: 'decoded';
  text: string;
  encoding: DecodableEncoding;
  /** True when no byte-order mark or valid UTF-8 named the encoding: a Windows-1252 guess, or the writer's own pick. */
  guessed: boolean;
  /** Every scored reading, best first, for the preview's encoding picker (empty for UTF-8 and a UTF-16 byte-order mark). */
  candidates: readonly ScoredEncodingCandidate[];
}

/** The reader cannot name the encoding: the preview asks, offering `detection.candidates` with `suggested` selected. */
export interface AskEncoding {
  status: 'ask';
  detection: EncodingDetection;
  /** The best-scoring candidate, preselected in the picker. */
  suggested: DecodableEncoding | undefined;
}

/** The file is larger than {@link MAX_TEXT_BYTES}; nothing was decoded. */
export interface TextTooLarge {
  status: 'too-large';
  bytes: number;
  limit: number;
}

/** The decoded text has more than {@link MAX_TEXT_LINES} lines; no blocks were built. */
export interface TextTooManyLines {
  status: 'too-many-lines';
  /** The lines counted before the count stopped: the limit plus one, not the file's full count. */
  lines: number;
  limit: number;
}

export type PlainTextDecode = DecodedPlainText | AskEncoding | TextTooLarge | TextTooManyLines;

/** Thrown by {@link plainTextBlocks} for text past {@link MAX_TEXT_LINES}; text from {@link decodePlainText} never reaches it. */
export class PlainTextLimitError extends RangeError {
  readonly lines: number;
  readonly limit: number;
  constructor(lines: number, limit: number) {
    super(`The text has more than ${limit} lines.`);
    this.name = 'PlainTextLimitError';
    this.lines = lines;
    this.limit = limit;
  }
}

/**
 * Count line breaks (LF, CR, CRLF as one, U+2028, U+2029, U+0085) and form feeds, plus one for the first line, stopping at
 * `limit + 1`: one pass, no allocation, so a file of millions of short lines is refused before it is split.
 */
export function countPlainTextLines(text: string, limit: number = MAX_TEXT_LINES): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || c === 0x0c || c === 0x2028 || c === 0x2029 || c === 0x85 || (c === 0x0d && text.charCodeAt(i + 1) !== 0x0a)) {
      if (++lines > limit) return lines;
    }
  }
  return lines;
}

const tooManyLines = (text: string): TextTooManyLines | null => {
  const lines = countPlainTextLines(text);
  return lines > MAX_TEXT_LINES ? { status: 'too-many-lines', lines, limit: MAX_TEXT_LINES } : null;
};

/**
 * Decode a text file's bytes. UTF-8 (with or without a byte-order mark) and UTF-16 with a byte-order mark are certain; UTF-16
 * without one and a Windows-1252 reading are decoded as a guess; any other best reading (GB18030, Big5, Shift JIS, …) or no
 * credible reading at all answers `ask`, because a wrong confident guess would import mojibake.
 */
export function decodePlainText(bytes: Uint8Array, options: DecodePlainTextOptions = {}): PlainTextDecode {
  if (bytes.length > MAX_TEXT_BYTES) return { status: 'too-large', bytes: bytes.length, limit: MAX_TEXT_BYTES };
  const detection = detectEncoding(bytes);
  if (options.encoding) {
    const text = decodeAs(bytes, options.encoding).text;
    return tooManyLines(text) ?? { status: 'decoded', text, encoding: options.encoding, guessed: !detection.certain || detection.best !== options.encoding, candidates: detection.candidates };
  }
  const best = detection.best;
  if (best === 'utf-8' || best === 'utf-16le' || best === 'utf-16be' || best === 'windows-1252') {
    const text = decodeAs(bytes, best).text;
    return tooManyLines(text) ?? { status: 'decoded', text, encoding: best, guessed: !detection.certain, candidates: detection.candidates };
  }
  return { status: 'ask', detection, suggested: detection.candidates[0]?.encoding };
}

export interface PlainTextBlockOptions {
  /** `'auto'` (the default) detects the mode; the preview passes the writer's toggle. */
  paragraphs?: ParagraphMode | 'auto';
  /** The file's name, kept as the document's title (without its extension) when the splitter finds none. */
  fileName?: string;
}

export interface PlainTextBlocks {
  doc: ImportDocument;
  /** The mode the blocks were built with, and the one detection picked, so the preview can show the toggle's state. */
  paragraphs: ParagraphMode;
  detectedParagraphs: ParagraphMode;
}

/**
 * Lines that look like one paragraph each: at least this many non-blank lines, and blank lines at most
 * {@link LINE_MODE_BLANK_RATIO} of them. Word's "Save as text" writes one line per paragraph and no blank lines at all; a
 * blank-separated or hard-wrapped file has a blank line every paragraph.
 */
const LINE_MODE_MIN_LINES = 8;
const LINE_MODE_BLANK_RATIO = 0.05;

const isBlank = (line: string): boolean => line.trim() === '';

/** Text as the reader sees it: LF line endings, a no-break space as a space, no byte-order mark. */
export function normalisePlainText(text: string): { text: string; noBreakSpaces: number; controls: number } {
  let noBreakSpaces = 0;
  let controls = 0;
  const out = text
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?|\u2028|\u2029|\u0085/gu, '\n')
    .replace(/[\u00A0\u202F\u2007]/gu, () => {
      noBreakSpaces++;
      return ' ';
    })
    // C0 controls other than tab, LF and the form feed (a page break), DEL and C1 controls carry nothing a manuscript keeps.
    // eslint-disable-next-line no-control-regex -- these control characters are what is removed, which is the point of the rule
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/gu, () => {
      controls++;
      return '';
    });
  return { text: out, noBreakSpaces, controls };
}

/** "One line = one paragraph" when there are many lines and almost no blank lines; otherwise blank lines separate paragraphs. */
export function detectParagraphMode(text: string): ParagraphMode {
  let lines = 0;
  let blanks = 0;
  // Walk the lines by index rather than splitting, so detection allocates one line at a time.
  for (let start = 0; start <= text.length; ) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (text.slice(start, end).replace(/\f/gu, '').trim() === '') blanks++;
    else lines++;
    start = end + 1;
  }
  // A trailing newline leaves one empty "line" after the last; it is not a blank line between paragraphs.
  if (text.endsWith('\n')) blanks--;
  return lines >= LINE_MODE_MIN_LINES && blanks <= lines * LINE_MODE_BLANK_RATIO ? 'line' : 'blank';
}

/**
 * Escape what CommonMark would read as markup, so the prose stays the prose: backslashes, emphasis and code characters,
 * brackets, `<`, GFM strike `~` and entity-like `&…;` anywhere, and at the start of the paragraph a heading `#`, a quote `>`,
 * a list marker (`-`, `+`, `*` or `1.` / `1)` before a space) or a thematic-break line.
 */
export function escapePlainMarkdown(text: string): string {
  let md = text.replace(/[\\`*_[\]<~]/gu, (c) => `\\${c}`).replace(/&(?=#?[A-Za-z0-9]+;)/gu, '&amp;');
  md = md.replace(/^(#{1,6})(?=\s|$)/u, (m) => `\\${m}`);
  md = md.replace(/^>/u, '\\>');
  md = md.replace(/^([-+])(?=\s|$)/u, '\\$1');
  md = md.replace(/^(\d{1,9})([.)])(?=\s|$)/u, '$1\\$2');
  md = md.replace(/^(=+|-+)\s*$/u, (m) => `\\${m}`);
  return md;
}

/** Every letter is a capital, and there are at least two: "CHAPTER ONE", not "I" or "1.". */
function isAllCaps(text: string): boolean {
  let letters = 0;
  for (const ch of text) {
    if (ch.toLowerCase() !== ch.toUpperCase()) {
      if (ch !== ch.toUpperCase()) return false;
      letters++;
    }
  }
  return letters >= 2;
}

/** A setext-style underline: three or more `=` or `-` and nothing else. */
const UNDERLINE = /^\s*(?:={3,}|-{3,})\s*$/u;

/** A line that should stand alone even inside a blank-separated paragraph: a chapter, part or prologue line. */
function standsAlone(line: string): boolean {
  const t = line.trim();
  return isShortLine(t) && (matchFamily(t) !== null || specialOf(t) !== null);
}

/**
 * A line a setext underline can make a heading of: short, and a chapter line, all capitals, title case (every word of four or
 * more letters capitalised: "The Landing", "Return to the Lighthouse") or in a script without capitals. "She closed the door
 * behind her" is prose, and the `---` under it stays a scene break.
 */
function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (!isShortLine(t)) return false;
  if (standsAlone(t) || isAllCaps(t)) return true;
  for (const word of t.split(/\s+/u)) {
    const letters = [...word].filter((ch) => ch.toLowerCase() !== ch.toUpperCase());
    const first = letters[0];
    if (first !== undefined && letters.length >= 4 && first === first.toLowerCase()) return false;
  }
  return true;
}

/**
 * Turn decoded text into the shared block list. Paragraphs are blank-line separated, their lines joined with a space (a
 * hard-wrapped file reads as prose), or one per line. Within a blank-separated paragraph a chapter-like first line or a line with
 * a setext underline becomes its own paragraph, so "CHAPTER ONE" directly above the text still reads as a chapter line. A
 * symbol-only line is a break, a form feed a page break. Blank lines beyond the one that separates paragraphs are kept as
 * `emptyBefore` / `emptyAfter`, the splitter's weak scene signal. Leading indentation is dropped (four spaces would make a code
 * block) and reported, as are the normalised no-break spaces and removed control characters: nothing changes silently. Spaces and
 * tabs inside a line are kept as written. Throws {@link PlainTextLimitError} past {@link MAX_TEXT_LINES} lines.
 */
export function plainTextBlocks(input: string, options: PlainTextBlockOptions = {}): PlainTextBlocks {
  const lineCount = countPlainTextLines(input);
  if (lineCount > MAX_TEXT_LINES) throw new PlainTextLimitError(lineCount, MAX_TEXT_LINES);
  const { text, noBreakSpaces, controls } = normalisePlainText(input);
  const detected = detectParagraphMode(text);
  const mode: ParagraphMode = options.paragraphs && options.paragraphs !== 'auto' ? options.paragraphs : detected;

  const blocks: ImportBlock[] = [];
  let indented = 0;
  let replacement = 0;
  /** Blank lines seen since the last block. */
  let blanks = 0;
  let started = false;

  const extraEmpties = (): number => (mode === 'blank' ? Math.max(0, blanks - 1) : blanks);

  const pushPara = (raw: string): void => {
    // Only the paragraph's edges are trimmed: internal spaces and tabs are the writer's and stay.
    const textLine = raw.trim();
    if (!textLine) return;
    const src: Signals = {};
    const empties = started ? extraEmpties() : 0;
    if (empties > 0) src.emptyBefore = empties;
    if (isAllCaps(textLine)) src.allCaps = true;
    const prev = blocks[blocks.length - 1];
    if (empties > 0 && prev && (prev.kind === 'para' || prev.kind === 'break')) {
      prev.src = { ...(prev.src ?? {}), emptyAfter: empties };
    }
    const marker = breakMarkerOf(textLine, true);
    if (marker !== null) {
      blocks.push(Object.keys(src).length ? { kind: 'break', marker, src } : { kind: 'break', marker });
    } else {
      for (const ch of textLine) if (ch === '\uFFFD') replacement++;
      const block: ImportBlock = { kind: 'para', md: escapePlainMarkdown(textLine), text: textLine };
      if (Object.keys(src).length) block.src = src;
      blocks.push(block);
    }
    blanks = 0;
    started = true;
  };

  const flushParagraph = (lines: string[]): void => {
    if (lines.length === 0) return;
    if (mode === 'line') {
      for (const line of lines) pushPara(line);
      return;
    }
    let current: string[] = [];
    const flush = (): void => {
      if (current.length) pushPara(current.map((l) => l.trim()).join(' '));
      current = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const next = lines[i + 1];
      // An underline makes a heading only of a heading-like first line ("The Landing"); under prose, `---` is a scene break.
      if (next !== undefined && UNDERLINE.test(next) && current.length === 0 && looksLikeHeading(line) && !UNDERLINE.test(line)) {
        flush();
        pushPara(line);
        i++; // the underline is the heading's decoration, not text
        continue;
      }
      if (breakMarkerOf(line.trim(), true) !== null || (current.length === 0 && i < lines.length - 1 && standsAlone(line))) {
        flush();
        pushPara(line);
        continue;
      }
      current.push(line);
    }
    flush();
  };

  // Split at form feeds first (each is a page break), then at blank lines.
  const pages = text.split('\f');
  pages.forEach((page, p) => {
    if (p > 0 && started) blocks.push({ kind: 'pagebreak' });
    let para: string[] = [];
    for (const line of page.split('\n')) {
      if (isBlank(line)) {
        flushParagraph(para);
        para = [];
        blanks++;
        continue;
      }
      if (/^[ \t]+\S/u.test(line)) indented++;
      para.push(line);
    }
    flushParagraph(para);
    para = [];
  });

  const losses: LossWarning[] = [];
  if (noBreakSpaces > 0) {
    losses.push({ code: 'formatting', count: noBreakSpaces, message: 'No-break spaces were read as ordinary spaces.' });
  }
  if (indented > 0) {
    losses.push({ code: 'formatting', count: indented, message: 'Leading indentation was dropped from lines that had it.' });
  }
  if (controls > 0) {
    losses.push({ code: 'unsupported', count: controls, message: 'Control characters that are not text were removed.' });
  }
  if (replacement > 0) {
    losses.push({ code: 'unsupported', count: replacement, message: 'Some bytes did not decode in the chosen encoding and show as \uFFFD.' });
  }

  const doc: ImportDocument = { blocks };
  const title = options.fileName ? titleFromFileName(options.fileName) : '';
  if (title) doc.metadata = { title };
  if (losses.length) doc.losses = losses;
  return { doc, paragraphs: mode, detectedParagraphs: detected };
}

/** "My Novel (final).txt" → "My Novel (final)"; a path keeps only its last part. */
function titleFromFileName(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? '';
  return base.replace(/\.(?:txt|text|asc)$/iu, '').trim();
}

export type PlainTextRead =
  | ({ status: 'read' } & PlainTextBlocks & Omit<DecodedPlainText, 'status' | 'text'>)
  | AskEncoding
  | TextTooLarge
  | TextTooManyLines;

/** Both halves in one call: decode the bytes, then build the blocks. A preview toggling only paragraphs re-runs {@link plainTextBlocks}. */
export function readPlainText(bytes: Uint8Array, options: DecodePlainTextOptions & PlainTextBlockOptions = {}): PlainTextRead {
  const decoded = decodePlainText(bytes, options);
  if (decoded.status !== 'decoded') return decoded;
  return {
    status: 'read',
    ...plainTextBlocks(decoded.text, options),
    encoding: decoded.encoding,
    guessed: decoded.guessed,
    candidates: decoded.candidates,
  };
}
