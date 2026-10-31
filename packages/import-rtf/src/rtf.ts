/**
 * The RTF reader (issue #274): RTF bytes → the import block list (`ImportDocument`) and everything it could not keep.
 *
 * Scrivener stores every text as `content.rtf` (Apple's TextKit "Cocoa" RTF on a Mac, its own writer on Windows), and TextEdit, Word,
 * Bear, Ulysses and Scrivener's Compile write `.rtf` too. No JavaScript RTF library fits the app's rules (rtf.js is 2.1 MB and needs
 * the DOM; the others are Node streams), so this is an own single-pass reader with no dependencies and no DOM: it runs on the main
 * thread, in a `'self'` Worker and in Node. Behaviour was checked against `banisterious/obsidian-draft-bench`'s MIT converter and
 * the RTF 1.9.1 specification; no code is copied.
 *
 * What it keeps and how (each drop or approximation is counted in `losses`; nothing is dropped silently):
 * - Paragraphs, `\line` as a hard break, `\b` `\i` `\strike` as Markdown, underline as italics (counted; the schema has no underline).
 * - `\ucN` honoured per group (Cocoa writes `\uc0`), `\uN` with negative N, surrogate pairs from two `\u`, and 8-bit text through
 *   `\ansicpg`, `\mac` and each font's `\fcharset`/`\cpg`, decoded with the host's `TextDecoder` (GBK, Shift-JIS, Big5, macintosh…).
 * - Structure as signals for the splitter: `\qc` and friends → `align`, `\sN` + stylesheet → `styleName`, `\outlinelevel` (on the
 *   paragraph or its style) → `outlineLevel`, all bold, all caps, relative font size, `\page` and `\sect` → page breaks, `\pagebb`.
 * - Lists (`\ls`/`\ilvl` with the list table's number format, or the visible `\listtext`) → Markdown list items.
 * - `\footnote` → an inline `[^n]` reference and a footnote (decision 3); `{\*\annotation}` → a comment.
 * - `\pict` PNG and JPEG → assets; EMF, WMF, PICT and bitmaps are skipped and named. `\NeXTGraphic` attachments of an `.rtfd`
 *   package are resolved through `options.attachment`.
 * - Tables → one block per row, cells joined by " | ", counted.
 * - HYPERLINK fields → Markdown links when the target is safe (the paste rule); other targets keep their text and are listed in
 *   `links` (Scrivener's `scrivcmt://` among them, for the Scrivener pass, #277); other fields keep their shown text, counted.
 * - Hidden text (`\v`) and deleted revisions are dropped, counted, and handed to the injection scan in `scanExtra`.
 * - Fonts, colours, highlights, sizes beyond the signal, super- and subscript: dropped and counted.
 *
 * Scrivener's inline annotations and footnotes are escaped text in the file (`{\Scrv_annot …}`), not control words, so they come out
 * as literal text here; the Scrivener post-pass (#277) removes them from the blocks' `text` and `md`.
 *
 * Hardening: input size, group depth, image size and count are capped; control words and numbers are bounded (the idea of
 * rtf-stream-parser's `maxTokenSize`); a deadline and a cancel flag are checked as it reads. Malformed input (a missing `}`, a stray
 * `}`, text after the end) is read as far as it goes and reported, never thrown.
 */

import { DEFAULT_CODE_PAGE, SYMBOL_CHARSET, codePageOfCharset, decodeCodePage } from './codepage.js';
import { NO_MARKS, escapeLineStarts, isSafeLinkTarget, plainOf, renderRuns, type Marks, type Run } from './markdown.js';
import type { Align, ImportAsset, ImportBlock, ImportComment, ImportDocument, ImportFootnote, ImportMetadata, LossCode, LossWarning, Signals } from './model.js';

export interface RtfLimits {
  /** The largest input accepted, in bytes. */
  readonly maxInputBytes: number;
  /** The deepest group nesting accepted. */
  readonly maxDepth: number;
  /** The largest single picture kept; a larger one is skipped and named. */
  readonly maxImageBytes: number;
  /** The most pictures kept from one file. */
  readonly maxImages: number;
  /** How long one file may take to read, in milliseconds. */
  readonly timeoutMs: number;
}

const MB = 1024 * 1024;

export const RTF_LIMITS: RtfLimits = Object.freeze({
  maxInputBytes: 256 * MB,
  maxDepth: 1024,
  maxImageBytes: 64 * MB,
  maxImages: 5000,
  timeoutMs: 60_000,
});

export interface RtfReadOptions {
  readonly limits?: Partial<RtfLimits>;
  /** Underline becomes italics (the default, counted) or is dropped (counted). */
  readonly underlineAs?: 'italic' | 'none';
  /** Prefix for asset refs (`rtf-image-1.png`); a Scrivener reader passes one per document so refs stay unique across a project. */
  readonly assetPrefix?: string;
  /** The bytes of an attachment an `.rtfd` package names in a `\NeXTGraphic` group, by file name. */
  readonly attachment?: (name: string) => Uint8Array | undefined;
  /** Checked as the file is read; when it reports aborted, the read stops with `cancelled`. An `AbortSignal` fits. */
  readonly signal?: { readonly aborted: boolean };
  /** The clock for the deadline; tests pass their own. */
  readonly now?: () => number;
}

export type RtfErrorCode = 'not-rtf' | 'too-large' | 'too-deep' | 'timeout' | 'cancelled';

export class RtfReadError extends Error {
  override readonly name = 'RtfReadError';
  constructor(
    readonly code: RtfErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A link field whose target this reader did not turn into a Markdown link, kept for a later pass and for the scan. */
export interface RtfLink {
  readonly blockIndex: number;
  readonly target: string;
  /** The link's shown text, which stays in the block. */
  readonly text: string;
}

export interface RtfImport {
  readonly document: ImportDocument;
  /** The bytes of each asset in `document.assets`, by ref. */
  readonly assetData: ReadonlyMap<string, Uint8Array>;
  /**
   * Text the reader did not put in a block, footnote or comment, which the injection scan (`scanImport`) must still read: hidden
   * text, deleted revisions, field instructions and link targets.
   */
  readonly scanExtra: readonly { readonly where: string; readonly text: string }[];
  /** Link fields left as their text: unsafe targets, internal bookmarks and Scrivener's `scrivcmt://` links. */
  readonly links: readonly RtfLink[];
  /** The document's code page as its header names it (1252 when it names none). */
  readonly codePage: number;
}

export type RtfReadResult = { readonly ok: true; readonly value: RtfImport } | { readonly ok: false; readonly error: RtfReadError };

// ---------------------------------------------------------------------------------------------------------------------------------
// State

type Dest =
  | 'body'
  | 'skip'
  | 'fonttbl'
  | 'stylesheet'
  | 'style'
  | 'info'
  | 'infofield'
  | 'listtable'
  | 'listoverridetable'
  | 'listtext'
  | 'footnote'
  | 'annotation'
  | 'atnauthor'
  | 'fldinst'
  | 'pict'
  | 'nextgraphic'
  | 'object';

interface CharProps {
  b: boolean;
  i: boolean;
  ul: boolean;
  strike: boolean;
  hidden: boolean;
  deleted: boolean;
  caps: boolean;
  script: boolean;
  font: number;
  fs: number;
  cf: number;
  highlight: number;
}

interface ParaProps {
  align: Align;
  style: number;
  outline: number | undefined;
  ls: number;
  ilvl: number;
  intbl: boolean;
  pagebb: boolean;
}

interface Field {
  inst: string;
  /** Where the field's shown text starts: the paragraph object and the run index in it. */
  start?: { readonly para: Para; readonly run: number };
}

interface Group {
  dest: Dest;
  /** The group has seen no token yet, so its first control word may name a destination. */
  fresh: boolean;
  starred: boolean;
  uc: number;
  chr: CharProps;
  par: ParaProps;
  sink: Sink;
  field: Field | undefined;
  inToc: boolean;
  /** For `infofield`: the metadata key. For `style`: the style being defined. */
  key?: string;
  style?: StyleDef;
  pict?: Pict;
  /** For `listtext` and `fldinst`, `atnauthor`, `infofield`, `nextgraphic`: the text collected. */
  collect?: { text: string };
}

interface StyleDef {
  index: number;
  kind: 'para' | 'other';
  outline: number | undefined;
  name: string;
}

interface FontDef {
  charset: number | undefined;
  cpg: number | undefined;
}

interface Pict {
  kind: string;
  hex: Uint8Array;
  length: number;
  half: number;
  odd: boolean;
  tooBig: boolean;
}

interface Para {
  runs: Run[];
  listText?: string;
  /** Characters per font size (half-points), for the paragraph's size signal. */
  sizes: Map<number, number>;
  chars: number;
  boldChars: number;
  capsChars: number;
  /** Swallow the attachment character Cocoa writes after a `\NeXTGraphic` group. */
  swallow: boolean;
  /** Runs before this index are not merged with new text: a field's shown text starts here. */
  barrier: number;
}

const newPara = (): Para => ({ runs: [], sizes: new Map(), chars: 0, boldChars: 0, capsChars: 0, swallow: false, barrier: 0 });

/** Where text goes: the body (blocks) or a note (a footnote's or a comment's paragraphs). */
interface Sink {
  readonly kind: 'body' | 'note';
  para: Para;
  /** A note's paragraphs as Markdown. */
  readonly paras: string[];
  /** The body's table row being built: each finished cell's Markdown and text. */
  cells: { md: string; text: string }[];
  cellParts: { md: string; text: string }[];
  /** For a footnote: its label and the block that holds its reference. */
  readonly label?: string;
  readonly blockIndex?: number;
  readonly author?: string;
}

const newSink = (kind: 'body' | 'note', extra: Partial<Pick<Sink, 'label' | 'blockIndex' | 'author'>> = {}): Sink => ({
  kind,
  para: newPara(),
  paras: [],
  cells: [],
  cellParts: [],
  ...extra,
});

const defaultChar = (font: number): CharProps => ({
  b: false,
  i: false,
  ul: false,
  strike: false,
  hidden: false,
  deleted: false,
  caps: false,
  script: false,
  font,
  fs: 24,
  cf: 0,
  highlight: 0,
});

const defaultPara = (): ParaProps => ({ align: 'left', style: 0, outline: undefined, ls: 0, ilvl: 0, intbl: false, pagebb: false });

/** Destinations this reader skips whole, whether or not they are starred. */
const SKIPPED = new Set([
  'colortbl',
  'filetbl',
  'revtbl',
  'rsidtbl',
  'pgdsctbl',
  'xmlnstbl',
  'latentstyles',
  'themedata',
  'colorschememapping',
  'datastore',
  'generator',
  'mmathPr',
  'nonshppict',
  'objdata',
  'objclass',
  'objname',
  'fldtype',
  'ftnsep',
  'ftnsepc',
  'ftncn',
  'aftnsep',
  'aftnsepc',
  'aftncn',
  'atnid',
  'atndate',
  'atnref',
  'atnicn',
  'atrfstart',
  'atrfend',
  'bkmkstart',
  'bkmkend',
  'xe',
  'tc',
  'tcn',
  'pn',
  'pnseclvl',
  'listpicture',
  'protusertbl',
  'userprops',
  'docvar',
  'wgrffmtfilter',
  'pgptbl',
  'template',
  'fchars',
  'lchars',
  'background',
  'falt',
  'panose',
  'fname',
  'listname',
  'levelmarker',
  'expandedcolortbl',
]);

const HEADERS = new Set(['header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf']);
const INFO_FIELDS: Readonly<Record<string, string>> = { title: 'title', author: 'author', subject: 'subject', keywords: 'keywords', doccomm: 'comment' };
const PICT_KINDS = new Set(['pngblip', 'jpegblip', 'emfblip', 'wmetafile', 'macpict', 'pmmetafile', 'dibitmap', 'wbitmap']);
const ORDERED_NFC = new Set([0, 1, 2, 3, 4, 5, 6, 22]);

const SYMBOLS: Readonly<Record<string, string>> = {
  emdash: '\u2014',
  endash: '\u2013',
  bullet: '\u2022',
  lquote: '\u2018',
  rquote: '\u2019',
  ldblquote: '\u201C',
  rdblquote: '\u201D',
  emspace: '\u2003',
  enspace: '\u2002',
  qmspace: '\u2005',
  zwj: '\u200D',
  zwnj: '\u200C',
  zwbo: '\u200B',
  zwnbo: '\u2060',
  ltrmark: '\u200E',
  rtlmark: '\u200F',
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The reader

/** Reads RTF bytes (or a string of byte values, as a file read as Latin-1 gives) into the block list and its losses. */
export function readRtf(input: Uint8Array | string, options: RtfReadOptions = {}): RtfReadResult {
  const limits = limitsOf(options.limits);
  const bytes = typeof input === 'string' ? latin1Bytes(input) : input;
  if (bytes.length > limits.maxInputBytes) {
    return fail('too-large', `The file is ${bytes.length} bytes; the largest RTF file this import reads is ${limits.maxInputBytes} bytes.`);
  }
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (start < bytes.length && isSpace(bytes[start] as number)) start += 1;
  if (!startsWith(bytes, start, '{\\rtf')) return fail('not-rtf', 'The file does not start with {\\rtf, so it is not an RTF file.');
  try {
    return { ok: true, value: new Reader(bytes, start, limits, options).read() };
  } catch (error) {
    if (error instanceof RtfReadError) return { ok: false, error };
    throw error;
  }
}

function fail(code: RtfErrorCode, message: string): RtfReadResult {
  return { ok: false, error: new RtfReadError(code, message) };
}

function limitsOf(overrides: Partial<RtfLimits> | undefined): RtfLimits {
  const out: Record<string, number> = { ...RTF_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out as unknown as RtfLimits;
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let k = 0; k < text.length; k += 1) out[k] = text.charCodeAt(k) & 0xff;
  return out;
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isLetter = (c: number): boolean => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  for (let k = 0; k < text.length; k += 1) if (bytes[at + k] !== text.charCodeAt(k)) return false;
  return true;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

/** The longest control word and parameter read; anything longer is cut there (RTF's own limits are 32 letters and a 16-bit number). */
const MAX_WORD = 32;
const MAX_DIGITS = 10;

class Reader {
  private readonly stack: Group[] = [];
  private group: Group;
  private readonly body: Sink = newSink('body');
  private readonly blocks: ImportBlock[] = [];
  /** Per block: its dominant font size, for `fontSizeRel`. */
  private readonly blockSizes: { index: number; size: number; chars: number }[] = [];
  private readonly footnotes: ImportFootnote[] = [];
  private readonly comments: ImportComment[] = [];
  private readonly metadata: ImportMetadata = {};
  private readonly assets: ImportAsset[] = [];
  private readonly assetData = new Map<string, Uint8Array>();
  private readonly scanExtra: { where: string; text: string }[] = [];
  private readonly links: RtfLink[] = [];
  private readonly losses = new Map<string, { code: LossCode; message: string; count: number }>();
  private readonly fonts = new Map<number, FontDef>();
  private readonly styles = new Map<number, StyleDef>();
  private readonly lists = new Map<number, number[]>();
  private readonly overrides = new Map<number, number>();
  private readonly listCounters = new Map<string, number>();
  private curList: { id: number; levels: number[] } | undefined;
  private curOverride: { listId: number; ls: number } | undefined;
  private curFont: number | undefined;
  private docCodePage = DEFAULT_CODE_PAGE;
  private defaultFont = 0;
  private ucSkip = 0;
  private highSurrogate: number | undefined;
  private pending: number[] = [];
  private pendingCp = DEFAULT_CODE_PAGE;
  private hidden = '';
  private deleted = '';
  private footnoteCount = 0;
  private imageCount = 0;
  private tablesSeen = 0;
  private inTableRun = false;
  private pendingAuthor: string | undefined;
  private readonly usedFonts = new Set<number>();
  private readonly usedColours = new Set<number>();
  private readonly usedHighlights = new Set<number>();
  private readonly deadline: number;
  private readonly now: () => number;
  private unknownCodePages = new Set<number>();
  private ended = false;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly start: number,
    private readonly limits: RtfLimits,
    private readonly options: RtfReadOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.deadline = this.now() + limits.timeoutMs;
    this.group = {
      dest: 'body',
      fresh: true,
      starred: false,
      uc: 1,
      chr: defaultChar(0),
      par: defaultPara(),
      sink: this.body,
      field: undefined,
      inToc: false,
    };
  }

  read(): RtfImport {
    const { bytes } = this;
    const n = bytes.length;
    let k = this.start;
    let ticks = 0;
    let depth = 0;
    let trailing = false;
    this.checkTime();
    while (k < n) {
      ticks += 1;
      if ((ticks & 0xfff) === 0) this.checkTime();
      const c = bytes[k] as number;
      if (this.ended) {
        if (!isSpace(c) && c !== 0) trailing = true;
        k += 1;
        continue;
      }
      if (c === 0x7b) {
        // {
        this.flushBytes();
        this.ucSkip = 0;
        depth += 1;
        if (depth > this.limits.maxDepth) throw new RtfReadError('too-deep', `The file nests groups more than ${this.limits.maxDepth} deep.`);
        this.push();
        k += 1;
      } else if (c === 0x7d) {
        // }
        this.flushBytes();
        this.ucSkip = 0;
        if (depth === 0) {
          this.ended = true;
        } else {
          // The document's own group keeps the last paragraph's formatting, so its paragraph ends before the group does.
          if (depth === 1) this.endParagraph('end');
          depth -= 1;
          this.pop();
          if (depth === 0) this.ended = true;
        }
        k += 1;
      } else if (c === 0x5c) {
        // backslash
        k = this.control(k);
      } else if (c === 0x0d || c === 0x0a) {
        k += 1;
      } else if (c >= 0x20 && c < 0x80 && this.ucSkip === 0 && this.group.dest !== 'pict' && (this.pending.length === 0 || !DOUBLE_BYTE.has(this.pendingCp))) {
        // A run of plain ASCII is text as it stands, in every code page this reader decodes; it is taken whole. (A pending
        // double-byte lead byte takes the slow path, since its trail byte can be ASCII.)
        let end = k + 1;
        while (end < n) {
          const d = bytes[end] as number;
          if (d < 0x20 || d >= 0x80 || d === 0x7b || d === 0x7d || d === 0x5c) break;
          end += 1;
        }
        this.flushBytes();
        this.text(asciiOf(bytes, k, end));
        k = end;
      } else {
        if (this.group.dest === 'pict') {
          this.pictHex(c);
        } else if (c === 0x09) {
          this.flushBytes();
          if (!this.consumeSkip()) this.text('\t');
        } else if (!this.consumeSkip()) {
          this.byte(c);
        }
        k += 1;
      }
    }
    this.flushBytes();
    if (!this.ended || depth > 0) {
      // A truncated file: close what is open, so a footnote or a picture in progress is kept.
      while (this.stack.length > 0) this.pop();
      this.loss('unsupported', 'The file ends before its last group is closed; everything up to the end is kept.');
    }
    if (trailing) this.loss('unsupported', 'The file has text after its end; that text is not read.');
    this.endParagraph('end');
    this.flushRow();
    return this.finish();
  }

  private checkTime(): void {
    if (this.options.signal?.aborted === true) throw new RtfReadError('cancelled', 'The import was cancelled.');
    if (this.now() > this.deadline) throw new RtfReadError('timeout', `Reading the file took longer than ${Math.round(this.limits.timeoutMs / 1000)} seconds.`);
  }

  // ---- groups ----

  private push(): void {
    const g = this.group;
    this.stack.push(g);
    this.group = {
      dest: g.dest,
      fresh: true,
      starred: false,
      uc: g.uc,
      chr: { ...g.chr },
      par: { ...g.par },
      sink: g.sink,
      field: g.field,
      inToc: g.inToc,
      style: g.style,
      pict: g.pict,
      collect: g.collect,
      key: g.key,
    };
  }

  private pop(): void {
    const closing = this.group;
    const parent = this.stack.pop();
    if (parent === undefined) return;
    this.group = parent;
    this.closeGroup(closing, parent);
  }

  /** What a group's end does, by the destination the group opened (a child that inherited its destination does nothing). */
  private closeGroup(g: Group, parent: Group): void {
    const opened = g.dest !== parent.dest || g.sink !== parent.sink || g.field !== parent.field || g.pict !== parent.pict;
    if (!opened) return;
    switch (g.dest) {
      case 'style':
        if (g.style !== undefined && g.style !== parent.style && g.style.kind === 'para') {
          g.style.name = g.style.name.replace(/;\s*$/, '').trim();
          this.styles.set(g.style.index, g.style);
        }
        return;
      case 'infofield':
        if (g.key !== undefined && g.collect !== undefined && g.collect !== parent.collect) {
          const value = g.collect.text.trim();
          if (value.length > 0) this.metadata[g.key] = value;
        }
        return;
      case 'listtext':
        if (g.collect !== undefined && g.collect !== parent.collect) g.sink.para.listText = g.collect.text;
        return;
      case 'fldinst':
        if (g.collect !== undefined && g.collect !== parent.collect && g.field !== undefined) g.field.inst += g.collect.text;
        return;
      case 'atnauthor':
        if (g.collect !== undefined && g.collect !== parent.collect) this.pendingAuthor = g.collect.text.trim() || undefined;
        return;
      case 'nextgraphic':
        if (g.collect !== undefined && g.collect !== parent.collect) this.attachmentPicture(g.collect.text.trim(), parent);
        return;
      case 'pict':
        if (g.pict !== undefined && g.pict !== parent.pict) this.finishPict(g.pict, parent);
        return;
      case 'footnote':
      case 'annotation':
        if (g.sink !== parent.sink) this.finishNote(g.sink);
        return;
      default:
        break;
    }
    if (g.field !== undefined && g.field !== parent.field) this.finishField(g.field, parent.sink);
  }

  /** The first control word of a group can make it a destination. Returns true when it did (the word is then consumed). */
  private destination(word: string, param: number | undefined): boolean {
    const g = this.group;
    const wasFresh = g.fresh;
    g.fresh = false;
    if (!wasFresh) return false;
    if (g.dest === 'skip') return true;
    if (SKIPPED.has(word)) {
      g.dest = 'skip';
      return true;
    }
    if (HEADERS.has(word)) {
      g.dest = 'skip';
      this.loss('unsupported', 'Page headers and footers are not imported.');
      return true;
    }
    switch (word) {
      case 'fonttbl':
        g.dest = 'fonttbl';
        return true;
      case 'stylesheet':
        g.dest = 'stylesheet';
        return true;
      case 'info':
        g.dest = 'info';
        return true;
      case 'listtable':
        g.dest = 'listtable';
        return true;
      case 'listoverridetable':
        g.dest = 'listoverridetable';
        return true;
      case 'listtext':
      case 'pntext':
        g.dest = 'listtext';
        g.collect = { text: '' };
        return true;
      case 'footnote':
        if (g.sink.kind === 'note') {
          g.dest = 'skip';
          return true;
        }
        this.openFootnote();
        return true;
      case 'annotation':
        g.dest = 'annotation';
        g.sink = newSink('note', { blockIndex: this.blocks.length, ...(this.pendingAuthor === undefined ? {} : { author: this.pendingAuthor }) });
        this.pendingAuthor = undefined;
        g.chr = defaultChar(this.defaultFont);
        g.par = defaultPara();
        return true;
      case 'atnauthor':
        g.dest = 'atnauthor';
        g.collect = { text: '' };
        return true;
      case 'field':
        g.field = { inst: '' };
        return true;
      case 'fldinst':
        g.dest = 'fldinst';
        g.collect = { text: '' };
        return true;
      case 'fldrslt':
        if (g.field !== undefined) {
          g.field.start = { para: g.sink.para, run: g.sink.para.runs.length };
          g.sink.para.barrier = g.sink.para.runs.length;
          if (/^\s*TOC\b/i.test(g.field.inst)) g.inToc = true;
        }
        return true;
      case 'pict':
        g.dest = 'pict';
        g.pict = { kind: 'unknown', hex: new Uint8Array(0), length: 0, half: -1, odd: false, tooBig: false };
        return true;
      case 'shppict':
        return true;
      case 'shp':
      case 'shpgrp':
        g.dest = 'skip';
        this.loss('text-box', 'Text boxes and drawn shapes are not imported.');
        return true;
      case 'object':
        g.dest = 'object';
        this.loss('embedded-object', 'Embedded objects are kept as the picture or text the file shows for them, where it has one.');
        return true;
      case 'result':
        if (g.dest === 'object') g.dest = 'body';
        return true;
      case 'NeXTGraphic':
        g.dest = 'nextgraphic';
        g.collect = { text: '' };
        return true;
      default:
        if (INFO_FIELDS[word] !== undefined && g.dest === 'info') {
          g.dest = 'infofield';
          g.key = INFO_FIELDS[word];
          g.collect = { text: '' };
          return true;
        }
        if (g.dest === 'info') {
          g.dest = 'skip';
          return true;
        }
        if (g.starred) {
          g.dest = 'skip';
          return true;
        }
        void param;
        return false;
    }
  }

  // ---- control words ----

  private control(at: number): number {
    const { bytes } = this;
    const c = bytes[at + 1];
    if (c === undefined) return at + 1;
    if (isLetter(c)) {
      let k = at + 1;
      let word = '';
      while (k < bytes.length && isLetter(bytes[k] as number)) {
        if (word.length < MAX_WORD) word += String.fromCharCode(bytes[k] as number);
        k += 1;
      }
      let param: number | undefined;
      let negative = false;
      if (bytes[k] === 0x2d && isDigit(bytes[k + 1] ?? 0)) {
        negative = true;
        k += 1;
      }
      if (isDigit(bytes[k] ?? 0)) {
        let digits = 0;
        let value = 0;
        while (k < bytes.length && isDigit(bytes[k] as number)) {
          if (digits < MAX_DIGITS) value = value * 10 + ((bytes[k] as number) - 0x30);
          digits += 1;
          k += 1;
        }
        param = negative ? -value : value;
      }
      if (bytes[k] === 0x20) k += 1;
      if (this.group.dest === 'pict' && word === 'bin' && param !== undefined && param > 0) {
        this.pictBinary(k, param);
        return k + param;
      }
      if (word === 'bin' && param !== undefined && param > 0) return k + param;
      this.word(word, param);
      return k;
    }
    if (c === 0x27) {
      // \'hh
      const hi = hexValue(bytes[at + 2] ?? 0);
      const lo = hexValue(bytes[at + 3] ?? 0);
      if (hi < 0 || lo < 0) return at + 2;
      if (!this.consumeSkip()) this.byte(hi * 16 + lo);
      return at + 4;
    }
    this.flushBytes();
    this.group.fresh = false;
    if (c === 0x2a) {
      // \*
      this.group.starred = true;
      this.group.fresh = true;
      return at + 2;
    }
    if (this.consumeSkip()) return at + 2;
    switch (c) {
      case 0x5c:
      case 0x7b:
      case 0x7d:
        this.text(String.fromCharCode(c));
        break;
      case 0x7e:
        this.text('\u00A0');
        break;
      case 0x5f:
        this.text('\u2011');
        break;
      case 0x0a:
      case 0x0d:
        this.endParagraph('par');
        break;
      case 0x09:
        this.text('\t');
        break;
      default:
        // \- (optional hyphen), \: (index subentry), \| (formula) and anything else: nothing to show.
        break;
    }
    return at + 2;
  }

  private word(word: string, param: number | undefined): void {
    if (word === 'u') {
      // \u is text, so a pending run of bytes ends here; the skip count starts after it.
      this.flushBytes();
      this.group.fresh = false;
      if (this.consumeSkip()) return;
      this.unicode(param ?? 0);
      this.ucSkip = this.group.uc;
      return;
    }
    this.flushBytes();
    if (this.consumeSkip()) return;
    if (this.destination(word, param)) return;
    const g = this.group;
    switch (g.dest) {
      case 'skip':
        return;
      case 'fonttbl':
        this.fontWord(word, param);
        return;
      case 'stylesheet':
      case 'style':
        this.styleWord(word, param);
        return;
      case 'listtable':
        this.listWord(word, param);
        return;
      case 'listoverridetable':
        if (word === 'listoverride') this.curOverride = { listId: 0, ls: 0 };
        else if (word === 'listid' && this.curOverride !== undefined) this.curOverride.listId = param ?? 0;
        else if (word === 'ls' && this.curOverride !== undefined) {
          this.curOverride.ls = param ?? 0;
          this.overrides.set(this.curOverride.ls, this.curOverride.listId);
        }
        return;
      case 'pict':
        this.pictWord(word, param);
        return;
      case 'fldinst':
      case 'infofield':
      case 'atnauthor':
      case 'listtext':
        if (word === 'tab' && g.collect !== undefined) g.collect.text += '\t';
        else if (SYMBOLS[word] !== undefined && g.collect !== undefined) g.collect.text += SYMBOLS[word];
        else if (word === 'uc') g.uc = Math.max(0, param ?? 1);
        else if (word === 'f') g.chr.font = param ?? 0;
        return;
      case 'nextgraphic':
        // The file name is the text before the first control word (`\width`, `\height`, …); the rest of the group is not text.
        g.key = 'named';
        return;
      default:
        this.bodyWord(word, param);
    }
  }

  private bodyWord(word: string, param: number | undefined): void {
    const g = this.group;
    const on = param === undefined || param !== 0;
    switch (word) {
      // Header
      case 'rtf':
        return;
      case 'ansicpg':
        this.docCodePage = param ?? DEFAULT_CODE_PAGE;
        return;
      case 'mac':
        this.docCodePage = 10000;
        return;
      case 'pc':
        this.docCodePage = 437;
        return;
      case 'pca':
        this.docCodePage = 850;
        return;
      case 'deff':
        this.defaultFont = param ?? 0;
        g.chr.font = this.defaultFont;
        return;
      case 'uc':
        g.uc = Math.max(0, param ?? 1);
        return;
      // Paragraphs
      case 'par':
        this.endParagraph('par');
        return;
      case 'line':
        this.raw('\\\n', '\n');
        return;
      case 'page':
        if (g.sink.kind === 'body') {
          this.endParagraph('break');
          this.flushRow();
          this.blocks.push({ kind: 'pagebreak' });
        }
        return;
      case 'sect':
        if (g.sink.kind === 'body') {
          this.endParagraph('break');
          this.flushRow();
          this.blocks.push({ kind: 'pagebreak' });
        }
        return;
      case 'pard':
        g.par = defaultPara();
        return;
      case 'plain':
        g.chr = defaultChar(this.defaultFont);
        return;
      case 'ql':
        g.par.align = 'left';
        return;
      case 'qc':
        g.par.align = 'center';
        return;
      case 'qr':
        g.par.align = 'right';
        return;
      case 'qj':
      case 'qd':
        g.par.align = 'justify';
        return;
      case 's':
        g.par.style = param ?? 0;
        return;
      case 'outlinelevel':
        g.par.outline = param !== undefined && param >= 0 && param <= 8 ? param + 1 : undefined;
        return;
      case 'ls':
        g.par.ls = param ?? 0;
        return;
      case 'ilvl':
        g.par.ilvl = Math.max(0, Math.min(8, param ?? 0));
        return;
      case 'intbl':
        g.par.intbl = true;
        return;
      case 'itap':
        g.par.intbl = (param ?? 1) > 0;
        return;
      case 'pagebb':
        g.par.pagebb = on;
        return;
      case 'cell':
      case 'nestcell':
        this.endParagraph('cell');
        return;
      case 'row':
      case 'nestrow':
        this.endParagraph('cell-end');
        this.flushRow();
        return;
      // Characters
      case 'b':
        g.chr.b = on;
        return;
      case 'i':
        g.chr.i = on;
        return;
      case 'ul':
      case 'uld':
      case 'uldash':
      case 'uldashd':
      case 'uldashdd':
      case 'uldb':
      case 'ulhwave':
      case 'ulldash':
      case 'ulth':
      case 'ulthd':
      case 'ulthdash':
      case 'ulthdashd':
      case 'ulthdashdd':
      case 'ulthldash':
      case 'ululdbwave':
      case 'ulw':
      case 'ulwave':
        g.chr.ul = on;
        return;
      case 'ulnone':
        g.chr.ul = false;
        return;
      case 'strike':
      case 'striked':
        g.chr.strike = on;
        return;
      case 'v':
        g.chr.hidden = on;
        return;
      case 'deleted':
        g.chr.deleted = on;
        return;
      case 'caps':
      case 'scaps':
        g.chr.caps = on;
        return;
      case 'super':
      case 'sub':
        g.chr.script = true;
        return;
      case 'nosupersub':
        g.chr.script = false;
        return;
      case 'up':
      case 'dn':
        g.chr.script = (param ?? 6) !== 0;
        return;
      case 'f':
        g.chr.font = param ?? 0;
        return;
      case 'fs':
        g.chr.fs = param ?? 24;
        return;
      case 'cf':
        g.chr.cf = param ?? 0;
        return;
      case 'highlight':
      case 'cb':
      case 'chcbpat':
        g.chr.highlight = param ?? 0;
        return;
      case 'tab':
        this.text('\t');
        return;
      case 'chftn':
      case 'chatn':
        return;
      default:
        if (SYMBOLS[word] !== undefined) this.text(SYMBOLS[word]);
    }
  }

  private fontWord(word: string, param: number | undefined): void {
    if (word === 'f') {
      this.curFont = param ?? 0;
      if (!this.fonts.has(this.curFont)) this.fonts.set(this.curFont, { charset: undefined, cpg: undefined });
    } else if (word === 'fcharset' && this.curFont !== undefined) {
      (this.fonts.get(this.curFont) as FontDef).charset = param;
    } else if (word === 'cpg' && this.curFont !== undefined) {
      (this.fonts.get(this.curFont) as FontDef).cpg = param;
    }
  }

  private styleWord(word: string, param: number | undefined): void {
    const g = this.group;
    if (g.dest === 'stylesheet' && (word === 's' || word === 'cs' || word === 'ds' || word === 'ts')) {
      g.dest = 'style';
      g.style = { index: param ?? 0, kind: word === 's' ? 'para' : 'other', outline: undefined, name: '' };
      return;
    }
    if (g.dest === 'stylesheet' && g.fresh === false && g.style === undefined) {
      // A style group with no \s (style 0, "Normal") starts with its formatting.
      g.dest = 'style';
      g.style = { index: 0, kind: 'para', outline: undefined, name: '' };
    }
    if (g.style === undefined) return;
    if (word === 's' || word === 'cs' || word === 'ds' || word === 'ts') {
      g.style.index = param ?? 0;
      g.style.kind = word === 's' ? 'para' : 'other';
    } else if (word === 'outlinelevel' && param !== undefined && param >= 0 && param <= 8) {
      g.style.outline = param + 1;
    }
  }

  private listWord(word: string, param: number | undefined): void {
    if (word === 'list') {
      this.curList = { id: 0, levels: [] };
    } else if (word === 'listlevel' && this.curList !== undefined) {
      this.curList.levels.push(23);
    } else if (word === 'levelnfc' && this.curList !== undefined && this.curList.levels.length > 0) {
      this.curList.levels[this.curList.levels.length - 1] = param ?? 0;
    } else if (word === 'listid' && this.curList !== undefined) {
      this.curList.id = param ?? 0;
      this.lists.set(this.curList.id, this.curList.levels);
    }
  }

  // ---- text ----

  /** Skips one character of a `\u`'s fallback when one is due. */
  private consumeSkip(): boolean {
    if (this.ucSkip > 0) {
      this.ucSkip -= 1;
      return true;
    }
    return false;
  }

  private codePageNow(): number {
    const font = this.fonts.get(this.group.chr.font);
    if (font !== undefined) {
      if (font.cpg !== undefined && font.cpg > 0) return font.cpg;
      if (font.charset !== undefined) {
        const cp = codePageOfCharset(font.charset);
        if (cp !== undefined) return cp;
        if (font.charset === SYMBOL_CHARSET && this.group.dest === 'body') this.loss('formatting', 'Text set in a symbol font is kept as the letters its codes stand for, not as the symbols.');
      }
    }
    return this.docCodePage;
  }

  private byte(b: number): void {
    const cp = this.codePageNow();
    if (this.pending.length > 0 && cp !== this.pendingCp) this.flushBytes();
    this.pendingCp = cp;
    this.pending.push(b);
  }

  private flushBytes(): void {
    if (this.pending.length === 0) return;
    const { text, known } = decodeCodePage(Uint8Array.from(this.pending), this.pendingCp);
    if (!known && !this.unknownCodePages.has(this.pendingCp)) {
      this.unknownCodePages.add(this.pendingCp);
      this.loss('formatting', `Text in code page ${this.pendingCp} was read as Windows Western (1252); check its accented letters.`);
    }
    this.pending = [];
    this.text(text);
  }

  private unicode(value: number): void {
    let code = value < 0 ? value + 65536 : value;
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.highSurrogate !== undefined) this.text('\uFFFD');
      this.highSurrogate = code;
      return;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      if (this.highSurrogate === undefined) {
        this.text('\uFFFD');
        return;
      }
      code = 0x10000 + ((this.highSurrogate - 0xd800) << 10) + (code - 0xdc00);
      this.highSurrogate = undefined;
      this.text(String.fromCodePoint(code));
      return;
    }
    this.text(String.fromCharCode(code));
  }

  private text(text: string): void {
    if (text.length === 0) return;
    if (this.highSurrogate !== undefined) {
      this.highSurrogate = undefined;
      this.emitText('\uFFFD');
    }
    this.emitText(text);
  }

  private emitText(text: string): void {
    const g = this.group;
    switch (g.dest) {
      case 'body':
      case 'footnote':
      case 'annotation':
        break;
      case 'style':
        if (g.style !== undefined) g.style.name += text;
        return;
      case 'fonttbl':
        if (text.includes(';')) this.curFont = undefined;
        return;
      case 'fldinst':
      case 'infofield':
      case 'atnauthor':
      case 'listtext':
        if (g.collect !== undefined) g.collect.text += text;
        return;
      case 'nextgraphic':
        if (g.collect !== undefined && g.key !== 'named') g.collect.text += text;
        return;
      default:
        return;
    }
    const c = g.chr;
    if (c.hidden || c.deleted) {
      if (c.hidden) this.hidden += text;
      else this.deleted += text;
      return;
    }
    const para = g.sink.para;
    if (para.swallow) {
      para.swallow = false;
      if (text[0] === '\u00AC' || text[0] === '\uFFFC') text = text.slice(1);
      if (text.length === 0) return;
    }
    const clean = text.replace(/\t/g, ' ');
    const italic = c.i || (c.ul && this.options.underlineAs !== 'none');
    const marks: Marks = c.b || italic || c.strike ? { b: c.b, i: italic, s: c.strike } : NO_MARKS;
    const last = para.runs[para.runs.length - 1];
    if (last !== undefined && last.kind === 'text' && para.runs.length > para.barrier && sameMarks(last.marks, marks)) para.runs[para.runs.length - 1] = { kind: 'text', text: last.text + clean, marks };
    else para.runs.push({ kind: 'text', text: clean, marks });
    if (g.sink.kind === 'body') this.countRun(clean, c);
  }

  private countRun(text: string, c: CharProps): void {
    const para = this.body.para;
    const visible = text.replace(/\s/g, '').length;
    if (visible === 0) return;
    para.chars += visible;
    para.sizes.set(c.fs, (para.sizes.get(c.fs) ?? 0) + visible);
    if (c.b) para.boldChars += visible;
    if (c.caps || (/\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text))) para.capsChars += visible;
    if (c.ul) this.loss('formatting', this.options.underlineAs === 'none' ? 'Underlined text is kept without its underline.' : 'Underlined text is set in italics, since a scene has no underline.');
    if (c.caps) this.loss('formatting', 'Text set in capitals or small capitals by formatting is kept as typed.');
    if (c.script) this.loss('formatting', 'Superscript and subscript text is kept as ordinary text.');
    this.usedFonts.add(c.font);
    if (c.cf > 0) this.usedColours.add(c.cf);
    if (c.highlight > 0) this.usedHighlights.add(c.highlight);
  }

  /** Markdown written as is (a footnote reference, a hard break, an image) into the current paragraph. */
  private raw(md: string, text: string, image?: { ref: string; alt: string }): void {
    const g = this.group;
    if (g.chr.hidden || g.chr.deleted) return;
    const c = g.chr;
    const marks: Marks = { b: c.b, i: c.i, s: c.strike };
    g.sink.para.runs.push(image === undefined ? { kind: 'raw', md, text, marks } : { kind: 'raw', md, text, marks, image });
  }

  // ---- paragraphs, rows and blocks ----

  private endParagraph(how: 'par' | 'cell' | 'cell-end' | 'break' | 'end'): void {
    const g = this.group;
    const sink = how === 'end' ? this.body : g.sink;
    const para = sink.para;
    sink.para = newPara();
    const props = how === 'end' && g.sink !== this.body ? defaultPara() : g.par;
    const listText = para.listText;
    const runs = trimRuns(para.runs);
    let md = escapeLineStarts(renderRuns(runs).trim());
    const text = plainOf(runs).trim();
    if (sink.kind === 'note') {
      if (md.length > 0) sink.paras.push(md);
      return;
    }
    const inTable = how === 'cell' || how === 'cell-end' || props.intbl;
    if (inTable && how !== 'end') {
      if (md.length > 0) sink.cellParts.push({ md, text });
      if (how === 'cell' || how === 'cell-end') {
        if (how === 'cell' || sink.cellParts.length > 0) {
          sink.cells.push({ md: sink.cellParts.map((p) => p.md).join(' '), text: sink.cellParts.map((p) => p.text).join(' ') });
        }
        sink.cellParts = [];
      }
      return;
    }
    this.flushRow();
    if ((how === 'break' || how === 'end') && runs.length === 0 && listText === undefined) return;
    // Pictures alone on their line are image blocks.
    if (runs.length > 0 && runs.every((r) => r.kind === 'raw' && r.image !== undefined)) {
      for (const r of runs) if (r.kind === 'raw' && r.image !== undefined) this.blocks.push({ kind: 'image', assetRef: r.image.ref, alt: r.image.alt });
      return;
    }
    const listPrefix = this.listPrefix(props, listText);
    if (listPrefix !== undefined && md.length > 0) md = listPrefix + md;
    else if (listPrefix === undefined) this.resetListCounters();
    const src = this.signals(props, para, text);
    const index = this.blocks.length;
    this.blocks.push(src === undefined ? { kind: 'para', md, text } : { kind: 'para', md, text, src });
    if (para.chars > 0) {
      let size = 24;
      let best = -1;
      for (const [fs, count] of para.sizes) if (count > best) [size, best] = [fs, count];
      this.blockSizes.push({ index, size, chars: para.chars });
    }
    if (props.align !== 'left' && props.align !== 'justify' && text.length > 0) this.loss('formatting', 'Centred and right-aligned paragraphs are kept as ordinary paragraphs.');
  }

  private flushRow(): void {
    const sink = this.body;
    if (sink.cellParts.length > 0) {
      sink.cells.push({ md: sink.cellParts.map((p) => p.md).join(' '), text: sink.cellParts.map((p) => p.text).join(' ') });
      sink.cellParts = [];
    }
    if (sink.cells.length === 0) {
      this.inTableRun = false;
      return;
    }
    const cells = sink.cells;
    sink.cells = [];
    // A row of empty cells (Cocoa closes a table with one) adds nothing.
    if (cells.every((c) => c.md.length === 0)) return;
    if (!this.inTableRun) {
      this.inTableRun = true;
      this.tablesSeen += 1;
    }
    this.blocks.push({ kind: 'other', md: cells.map((c) => c.md).join(' | '), loss: 'table' });
  }

  private listPrefix(props: ParaProps, listText: string | undefined): string | undefined {
    if (props.ls <= 0 && listText === undefined) return undefined;
    const marker = (listText ?? '').replace(/[\s\u00A0]+/g, ' ').trim();
    const levels = this.lists.get(this.overrides.get(props.ls) ?? -1);
    const nfc = levels?.[props.ilvl];
    const shown = /^(\d{1,9})[.)]?$/.exec(marker) ?? /^([0-9A-Za-z]{1,6})[.)]$/.exec(marker);
    const ordered = shown !== null || (marker.length === 0 && nfc !== undefined && ORDERED_NFC.has(nfc));
    const key = `${props.ls}:${props.ilvl}`;
    // Deeper levels restart when a shallower item comes.
    for (const k of [...this.listCounters.keys()]) {
      const [ls, lvl] = k.split(':').map(Number);
      if (ls === props.ls && (lvl ?? 0) > props.ilvl) this.listCounters.delete(k);
    }
    if (!ordered) return `${'  '.repeat(props.ilvl)}- `;
    const counted = (this.listCounters.get(key) ?? 0) + 1;
    this.listCounters.set(key, counted);
    const number = shown !== null && /^\d+$/.test(shown[1] ?? '') ? Number(shown[1]) : counted;
    if (shown !== null && !/^\d+$/.test(shown[1] ?? '')) this.loss('formatting', 'List items numbered with letters or Roman numerals are numbered with digits.');
    return `${'   '.repeat(props.ilvl)}${number}. `;
  }

  private resetListCounters(): void {
    this.listCounters.clear();
  }

  private signals(props: ParaProps, para: Para, text: string): Signals | undefined {
    // An empty paragraph is itself the signal; only a page break before it adds to that.
    if (text.length === 0) return props.pagebb ? { pageBreakBefore: true } : undefined;
    const src: Signals = {};
    const style = this.styles.get(props.style);
    if (style !== undefined && style.name.length > 0 && !/^(normal|default|standard|body text)$/i.test(style.name)) src.styleName = style.name;
    const outline = props.outline ?? style?.outline;
    if (outline !== undefined) src.outlineLevel = outline;
    if (props.align !== 'left') src.align = props.align;
    if (para.chars > 0 && para.boldChars === para.chars) src.allBold = true;
    if (para.chars > 0 && para.capsChars === para.chars && /\p{L}/u.test(text)) src.allCaps = true;
    if (props.pagebb) src.pageBreakBefore = true;
    if (this.group.inToc) src.toc = true;
    return Object.keys(src).length === 0 ? undefined : src;
  }

  // ---- footnotes, comments, fields ----

  private openFootnote(): void {
    const g = this.group;
    this.footnoteCount += 1;
    const label = String(this.footnoteCount);
    // The reference goes where the footnote stands in the text; `\chftn` (Word's automatic number) writes nothing.
    this.raw(`[^${label}]`, '');
    const blockIndex = this.blocks.length;
    g.dest = 'footnote';
    g.sink = newSink('note', { label, blockIndex });
    g.chr = defaultChar(this.defaultFont);
    g.par = defaultPara();
  }

  private finishNote(sink: Sink): void {
    // End the note's last paragraph inside the note.
    const md = escapeLineStarts(renderRuns(trimRuns(sink.para.runs)).trim());
    if (md.length > 0) sink.paras.push(md);
    sink.para = newPara();
    const body = sink.paras.join('\n\n');
    if (sink.label !== undefined) {
      this.footnotes.push({ blockIndex: sink.blockIndex ?? this.blocks.length, label: sink.label, md: body });
    } else {
      const comment: ImportComment = sink.author === undefined ? { blockIndex: sink.blockIndex ?? this.blocks.length, md: body } : { blockIndex: sink.blockIndex ?? this.blocks.length, md: body, author: sink.author };
      if (body.length > 0) this.comments.push(comment);
    }
  }

  private finishField(field: Field, sink: Sink): void {
    const inst = field.inst.trim();
    const name = /^([A-Za-z]+)/.exec(inst)?.[1]?.toUpperCase() ?? '';
    if (inst.length > 0) this.scanExtra.push({ where: `field ${name || 'instruction'}`, text: inst });
    if (name !== 'HYPERLINK') {
      if (name.length > 0 && name !== 'TOC') this.loss('field', `${name} fields are kept as the text they showed.`);
      if (name === 'TOC') this.loss('field', 'A table of contents field is kept as its text and marked as a table of contents.');
      return;
    }
    const quoted = /HYPERLINK\s+(?:\\[a-z]\s+)*"([^"]*)"/i.exec(inst) ?? /HYPERLINK\s+(?:\\[a-z]\s+)*(\S+)/i.exec(inst);
    const internal = /\\l\b/.test(inst);
    const target = quoted?.[1] ?? '';
    const start = field.start;
    const para = sink.para;
    if (start === undefined || start.para !== para) {
      if (target.length > 0) this.links.push({ blockIndex: this.blocks.length, target, text: '' });
      return;
    }
    const inner = para.runs.slice(start.run);
    const text = plainOf(inner);
    if (target.length > 0 && !internal && isSafeLinkTarget(target) && /^(https?:|mailto:)/i.test(target) && inner.length > 0) {
      para.runs.splice(start.run, inner.length, { kind: 'link', href: target, runs: inner });
      return;
    }
    if (target.length > 0) {
      this.links.push({ blockIndex: this.blocks.length, target: internal ? `#${target}` : target, text });
      if (!/^scrivcmt:/i.test(target)) this.loss('field', internal ? 'Links to a place inside the document are kept as their text.' : 'Links to targets other than web and mail addresses are kept as their text.');
    }
  }

  // ---- pictures ----

  private pictWord(word: string, param: number | undefined): void {
    const pict = this.group.pict;
    if (pict === undefined) return;
    if (PICT_KINDS.has(word)) pict.kind = word;
    void param;
  }

  private pictHex(c: number): void {
    const pict = this.group.pict;
    if (pict === undefined || pict.tooBig) return;
    const v = hexValue(c);
    if (v < 0) return;
    if (!pict.odd) {
      pict.half = v;
      pict.odd = true;
      return;
    }
    pict.odd = false;
    this.pictPush(pict, pict.half * 16 + v);
  }

  private pictBinary(at: number, count: number): void {
    const pict = this.group.pict;
    if (pict === undefined) return;
    const end = Math.min(this.bytes.length, at + count);
    for (let k = at; k < end && !pict.tooBig; k += 1) this.pictPush(pict, this.bytes[k] as number);
  }

  private pictPush(pict: Pict, byte: number): void {
    if (pict.length >= this.limits.maxImageBytes) {
      pict.tooBig = true;
      return;
    }
    if (pict.length === pict.hex.length) {
      const grown = new Uint8Array(Math.max(1024, pict.hex.length * 2));
      grown.set(pict.hex);
      pict.hex = grown;
    }
    pict.hex[pict.length] = byte;
    pict.length += 1;
  }

  private finishPict(pict: Pict, parent: Group): void {
    if (parent.chr.hidden || parent.chr.deleted) return;
    const bytes = pict.hex.subarray(0, pict.length);
    if (pict.tooBig) {
      this.loss('image-unreadable', `A picture larger than ${Math.round(this.limits.maxImageBytes / MB)} MB is not imported.`);
      return;
    }
    const mime = sniffImage(bytes);
    if (mime === undefined) {
      const what = PICT_NAMES[pict.kind] ?? 'a picture in a format this import cannot read';
      this.loss('image-unreadable', `Pictures saved as ${what} are not imported.`);
      return;
    }
    this.addPicture(bytes.slice(), mime, '', parent);
  }

  private attachmentPicture(name: string, parent: Group): void {
    parent.sink.para.swallow = true;
    if (name.length === 0) return;
    const bytes = this.options.attachment?.(name);
    if (bytes === undefined) {
      this.loss('image-unreadable', `The attached file "${name}" is not in the package, so it is not imported.`);
      return;
    }
    const mime = sniffImage(bytes);
    if (mime === undefined) {
      this.loss('embedded-object', `The attached file "${name}" is not a PNG or JPEG picture, so it is not imported.`);
      return;
    }
    this.addPicture(bytes, mime, name, parent);
  }

  private addPicture(bytes: Uint8Array, mime: string, name: string, parent: Group): void {
    if (this.imageCount >= this.limits.maxImages) {
      this.loss('image-unreadable', `Only the first ${this.limits.maxImages} pictures of a file are imported.`);
      return;
    }
    this.imageCount += 1;
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const ref = `${this.options.assetPrefix ?? 'rtf-image-'}${this.imageCount}.${ext}`;
    this.assets.push(name.length > 0 ? { ref, name, mime, bytes: bytes.length } : { ref, mime, bytes: bytes.length });
    this.assetData.set(ref, bytes);
    const alt = name.replace(/\.[A-Za-z0-9]+$/, '');
    const saved = this.group;
    this.group = parent;
    this.raw(`![${escapeAlt(alt)}](${ref})`, '', { ref, alt });
    this.group = saved;
  }

  // ---- result ----

  private loss(code: LossCode, message: string, count = 1): void {
    const key = `${code}\u0000${message}`;
    const entry = this.losses.get(key);
    if (entry === undefined) this.losses.set(key, { code, message, count });
    else entry.count += count;
  }

  private finish(): RtfImport {
    // Relative font sizes against the body text's size: the size most characters are set in.
    const totals = new Map<number, number>();
    for (const { size, chars } of this.blockSizes) totals.set(size, (totals.get(size) ?? 0) + chars);
    let bodySize = 24;
    let best = -1;
    for (const [size, chars] of totals) if (chars > best) [bodySize, best] = [size, chars];
    for (const { index, size } of this.blockSizes) {
      const block = this.blocks[index];
      if (block === undefined || block.kind !== 'para' || size === bodySize || bodySize <= 0) continue;
      block.src = { ...block.src, fontSizeRel: Math.round((size / bodySize) * 100) / 100 };
    }
    if (this.hidden.trim().length > 0) {
      this.loss('formatting', 'Hidden text is not imported; it is listed for the scan.', countChars(this.hidden));
      this.scanExtra.push({ where: 'hidden text', text: this.hidden });
    }
    if (this.deleted.trim().length > 0) {
      this.loss('tracked-change', 'Text marked as deleted in tracked changes is not imported; inserted text is kept.', countChars(this.deleted));
      this.scanExtra.push({ where: 'deleted text', text: this.deleted });
    }
    if (this.tablesSeen > 0) this.loss('table', 'Tables are kept as one paragraph per row, with the cells separated by " | ".', this.tablesSeen);
    const fonts = this.usedFonts.size;
    if (fonts > 1) this.loss('formatting', 'Fonts are not kept; scenes use the project font.', fonts);
    if (this.usedColours.size > 0) this.loss('formatting', 'Text colours are not kept.', this.usedColours.size);
    if (this.usedHighlights.size > 0) this.loss('formatting', 'Highlights are not kept.', this.usedHighlights.size);
    const losses: LossWarning[] = [...this.losses.values()].map(({ code, message, count }) => ({ code, message, count }));
    const doc: ImportDocument = { blocks: this.blocks };
    if (this.footnotes.length > 0) doc.footnotes = this.footnotes;
    if (this.comments.length > 0) doc.comments = this.comments;
    if (Object.keys(this.metadata).length > 0) doc.metadata = this.metadata;
    if (this.assets.length > 0) doc.assets = this.assets;
    if (losses.length > 0) doc.losses = losses;
    return { document: doc, assetData: this.assetData, scanExtra: this.scanExtra, links: this.links, codePage: this.docCodePage };
  }
}

const PICT_NAMES: Readonly<Record<string, string>> = {
  emfblip: 'Windows enhanced metafiles (EMF)',
  wmetafile: 'Windows metafiles (WMF)',
  pmmetafile: 'OS/2 metafiles',
  macpict: 'Mac PICT drawings',
  dibitmap: 'Windows bitmaps (DIB)',
  wbitmap: 'Windows bitmaps',
};

const DOUBLE_BYTE = new Set([932, 936, 949, 950, 10001, 10002, 10003, 10008, 20936, 54936]);

function asciiOf(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let k = from; k < to; k += 8192) out += String.fromCharCode(...bytes.subarray(k, Math.min(to, k + 8192)));
  return out;
}

function sniffImage(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return undefined;
}

function escapeAlt(alt: string): string {
  return alt.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

function sameMarks(a: Marks, b: Marks): boolean {
  return a.b === b.b && a.i === b.i && a.s === b.s;
}

function countChars(text: string): number {
  return [...text.replace(/\s/g, '')].length;
}

/** Leading and trailing whitespace of a paragraph's runs, and a hard break at its end, are not part of it. */
function trimRuns(runs: readonly Run[]): Run[] {
  const out = [...runs];
  while (out.length > 0) {
    const last = out[out.length - 1] as Run;
    if (last.kind === 'raw' && last.md === '\\\n') out.pop();
    else if (last.kind === 'text' && last.text.trim().length === 0) out.pop();
    else break;
  }
  while (out.length > 0) {
    const first = out[0] as Run;
    if (first.kind === 'raw' && first.md === '\\\n') out.shift();
    else if (first.kind === 'text' && first.text.trim().length === 0) out.shift();
    else break;
  }
  return out;
}
