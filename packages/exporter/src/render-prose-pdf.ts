/**
 * The prose PDF — a paginated print of the manuscript (exporter.md §3), for Study and
 * Professional Hall. It shares the screenplay PDF's engine (`packages/screenplay/pdf.ts`)
 * and fonts: Courier Prime embedded (A3), Cousine or the base-14 Courier by the `scriptFont`
 * recipe option, and the CJK, emoji, Arabic, Hebrew and Devanagari fallbacks loaded lazily
 * only for the text that needs them. A new manuscript format, not a second writer.
 *
 * The layout is the manuscript's: one-inch margins, 65 columns, 27 rows a page at a double
 * space, each new chapter a page of its own with a centred heading a third of the way down,
 * the page number on the right of every page but the first and the title page. A paragraph
 * takes a first-line indent of half an inch; a block quote indents five columns; a figure is
 * the `[Picture: caption]` line the plain-text export writes (the PDF does not draw pictures).
 *
 * The work is split like the screenplay's. {@link layoutProsePdf} is synchronous and pure — it
 * paginates, so the page count is known before anything is drawn and the plan can refuse a
 * compile that prints nothing without loading a font. {@link prepareProsePdf} loads the fonts
 * and the shapers the text needs, by a dynamic import, and lays out again with the measured
 * widths when Arabic, Hebrew or Devanagari change the line breaks. `drawPdf` of
 * `@caotang/screenplay` writes the file.
 */

import {
  countMarks,
  devanagariFontMaps,
  devanagariFontPrints,
  emojiFontMaps,
  emojiPrint,
  fallbackCovers,
  firstCodePoint,
  hasDevanagari,
  hasRtlScript,
  isBidiControl,
  isEmojiCluster,
  rtlFontPrints,
  rtlScriptOf,
  isRtlMark,
  type RtlScript,
  type ShapedScript,
} from '@caotang/pdf-fonts';
import { languageDirection, paragraphDirection, type Direction } from '@caotang/pdf-fonts/bidi';
import {
  drawPdf,
  isPrintable,
  loadCjkFallback,
  loadColourEmojiFallback,
  loadEmojiFallback,
  loadRtlFallback,
  loadRtlSupport,
  loadScriptFont,
  PAGE_GEOMETRY,
  splitColumns,
  textColumns,
  textUnits,
  withMeasure,
  PDF_MIME,
  type LayoutLine,
  type LayoutPage,
  type MeasureRun,
  type PageSize,
  type PdfCidFont,
  type PdfColourEmojiFont,
  type PdfEmojiFont,
  type PdfFont,
  type PdfFontLoaders,
  type PdfLayout,
  type PdfRtlFonts,
  type RtlSupport,
  type ScriptFont,
} from '@caotang/screenplay';
import { placementCaptionOf } from '@caotang/pictures';

import { generatedChapterHeading } from './boilerplate.js';
import { parseProse, type ParsedProse, type ProseBlock, type Run } from './prose.js';
import { boilerplateOf, headingsByBlock, sectionTitle, type RenderInput } from './render-input.js';

export type ProsePdfOptions = {
  /** The project's language (a BCP 47 tag), as the screenplay PDF's `language` reads it. */
  readonly language?: string;
  /** The paper (default Letter). The grid — columns, rows, margins — is the same on both papers. */
  readonly pageSize?: PageSize;
  /** The Latin face (default Courier Prime). Only {@link prepareProsePdf} reads it, because it loads the font. */
  readonly scriptFont?: ScriptFont;
  /** Colour emoji: an emoji Noto Color Emoji has prints in colour. Absent is off, as for the screenplay PDF. */
  readonly colourEmoji?: boolean;
  /** Where a footnote's text goes: `footnote` (absent = this) at the page's foot, `endnote` on pages of their own at the book's end. */
  readonly notes?: 'footnote' | 'endnote';
};

/**
 * The manuscript grid. The text block is 468 points wide — Letter's page less its one-inch
 * margins, which on A4 leaves the right margin the geometry gives — at 7.2 points a column of
 * Courier; 27 rows at a 24-point double space; footnotes at the 12-point single space the
 * screenplay's lines take.
 */
const PROSE_LAYOUT = Object.freeze({
  columns: 65,
  rows: 27,
  charWidth: 7.2,
  marginLeft: 72,
  marginTop: 72,
  leading: 24,
  noteLeading: 12,
  /** Baseline of the page number, half an inch from the top edge, as the screenplay PDF's is. */
  headerY: 54,
  /** A chapter's heading sits on row 6 — a third of the way down, the manuscript convention. */
  chapterRow: 6,
});

const BODY_BASELINE = 10;

/** A wrapped line before it has a page: its columns, whether it is centred, and the notes it marks. */
interface FlowLine {
  readonly kind: 'line';
  readonly text: string;
  /** The left column; a centred or right-aligned line carries 0 and takes its column from its text at draw. */
  readonly col: number;
  readonly centred?: true;
  /** The paragraph is right to left: the line is drawn from its right edge, as the screenplay's `rtl` lines are. */
  readonly rtl?: true;
  /** The footnote numbers this line's text marks, in order. */
  readonly notes: readonly number[];
  /** A footnote-area line, placed at the page's foot in the footnote pass — never a body row. */
  readonly foot?: true;
}

type Flow = FlowLine | { readonly kind: 'blank' } | { readonly kind: 'page' };

/** One word of a paragraph, with the footnote numbers glued to it, or a hard line break. */
interface Token {
  readonly text: string;
  readonly notes: readonly number[];
  readonly br?: true;
}

/**
 * The note calls a compile has numbered. A marker's number is fixed by the order it first
 * appears in the text, and `byId` scopes an identifier to the scene's own `notes` map — two
 * scenes may both write `[^1]`, as the plain-text export's `numbered` map allows.
 */
interface NoteBook {
  readonly byId: Map<ParsedProse['notes'], Map<string, number>>;
  /** Number → the note, indexed by number - 1. `defs` is the scene's `notes` map the note's own markers read. */
  readonly bodies: { readonly blocks: readonly ProseBlock[]; readonly defs: ParsedProse['notes'] }[];
}

interface NoteNumbers {
  readonly book: NoteBook;
  /** The marker's number, or undefined when the body defines no note for it (the marker stays literal text). */
  readonly number: (defs: ParsedProse['notes'], noteId: string) => number | undefined;
}

function noteBookOf(): NoteNumbers {
  const byId: NoteBook['byId'] = new Map();
  const bodies: NoteBook['bodies'] = [];
  return {
    book: { byId, bodies },
    number: (defs, noteId) => {
      const scoped = byId.get(defs) ?? new Map<string, number>();
      byId.set(defs, scoped);
      const known = scoped.get(noteId);
      if (known !== undefined) return known;
      const blocks = defs.get(noteId);
      if (blocks === undefined) return undefined;
      const num = bodies.length + 1;
      bodies.push({ blocks, defs });
      scoped.set(noteId, num);
      return num;
    },
  };
}

/**
 * A paragraph's runs as the words the line breaker sees. A footnote marker glues `[n]` to the
 * word before it — the way the plain-text export prints it — so it never hangs off a line end.
 * A hard line break is its own token, and ends the current line.
 */
function tokensOf(runs: readonly Run[], number: (noteId: string) => number | undefined): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let notes: number[] = [];
  const flush = (): void => {
    if (text !== '') tokens.push({ text, notes });
    text = '';
    notes = [];
  };
  for (const run of runs) {
    if (run.br === true) {
      flush();
      tokens.push({ text: '', notes: [], br: true });
      continue;
    }
    if (run.noteId !== undefined) {
      const num = number(run.noteId);
      if (num === undefined) continue;
      // The marker writes straight onto what precedes it: "word[3]", or "[3]" at a boundary.
      text += `[${num}]`;
      notes.push(num);
      continue;
    }
    for (const piece of run.text.split(/(\s+)/)) {
      if (piece === '') continue;
      if (/^\s+$/.test(piece)) flush();
      else text += piece;
    }
  }
  flush();
  return tokens;
}

interface WrappedLine {
  readonly text: string;
  readonly col: number;
  readonly notes: readonly number[];
}

/**
 * The lines a token stream wraps to at `width` columns, breaking at its spaces and, inside a
 * word longer than a line, between its units (`splitColumns`). `indents` is the left column of
 * each successive line — a first-line indent, then the hanging indent.
 */
function wrapTokens(tokens: readonly Token[], width: number, indents: readonly number[]): WrappedLine[] {
  const lines: { text: string; notes: number[] }[] = [];
  let current = '';
  let notes: number[] = [];
  let col = indents[0] ?? 0;
  const flush = (): void => {
    lines.push({ text: current, notes });
    current = '';
    notes = [];
    col = indents[Math.min(lines.length, indents.length - 1)] ?? 0;
  };
  for (const token of tokens) {
    if (token.br === true) {
      flush();
      continue;
    }
    let piece = token.text;
    let pieceNotes = token.notes;
    for (;;) {
      const space = current === '' ? 0 : 1;
      const fits = col + space + textColumns(piece) <= width;
      if (fits) {
        current += (space === 1 ? ' ' : '') + piece;
        notes.push(...pieceNotes);
        col += space + textColumns(piece);
        break;
      }
      const [head, rest] = splitColumns(piece, Math.max(1, width - col - space));
      if (head !== '' && head !== piece) {
        current += (space === 1 ? ' ' : '') + head;
        // The word's notes stay with the line its head broke on.
        notes.push(...pieceNotes);
        pieceNotes = [];
        col += space + textColumns(head);
        piece = rest;
      }
      flush();
    }
  }
  if (current !== '' || lines.length === 0) flush();
  return lines.map((line, index) => ({ text: line.text, col: indents[Math.min(index, indents.length - 1)] ?? 0, notes: line.notes }));
}

/** "this character … it is" or "these N characters … they are", for the log. */
function counted(list: readonly string[], one: string, many: string): { what: string; verb: string; shown: string } {
  return {
    what: list.length === 1 ? `this ${one}` : `these ${list.length} ${many}`,
    verb: list.length === 1 ? 'it is' : 'they are',
    shown: `${list.slice(0, 10).join(' ')}${list.length > 10 ? ' …' : ''}`,
  };
}

/** What the pages hold that Courier Prime cannot print — the same analysis the screenplay PDF's layout makes. */
interface Unprintable {
  readonly cjk: string[];
  readonly emoji: string[];
  readonly colour: string[];
  readonly partial: string[];
  readonly missing: string[];
  readonly scripts: ShapedScript[];
}

function unprintable(lines: readonly LayoutLine[], colour?: (cluster: string) => boolean): Unprintable {
  const seen = new Set<string>();
  const found: Unprintable = { cjk: [], emoji: [], colour: [], partial: [], missing: [], scripts: [] };
  for (const line of lines) {
    for (const unit of textUnits(line.text)) {
      if (seen.has(unit)) continue;
      seen.add(unit);
      if ((unit.length > 1 || unit.charCodeAt(0) >= 0x231a) && isEmojiCluster(unit)) {
        if (colour?.(unit) === true) {
          found.colour.push(unit);
          continue;
        }
        const print = emojiPrint(unit);
        if (print === 'none') found.missing.push(unit);
        else found.emoji.push(unit);
        if (print === 'base') found.partial.push(unit);
        continue;
      }
      const base = firstCodePoint(unit);
      if (isPrintable(base)) continue;
      if (isBidiControl(base)) continue;
      const script = rtlFontPrints(base) ?? (devanagariFontPrints(base) ? 'devanagari' : undefined);
      if (script === 'devanagari') {
        if (!found.scripts.includes(script)) found.scripts.push(script);
        for (const ch of unit) if (!devanagariFontMaps(ch) && !found.missing.includes(ch)) found.missing.push(ch);
      } else if (script !== undefined) {
        if (!found.scripts.includes(script)) found.scripts.push(script);
      } else if (fallbackCovers(base)) {
        if (!found.cjk.includes(base)) found.cjk.push(base);
      } else if (emojiFontMaps(base)) found.emoji.push(unit);
      else if (!found.missing.includes(base)) found.missing.push(base);
    }
  }
  return found;
}

/** The marks of Arabic and Hebrew the pages hold, by script: they are left out of the print (rtl-script.ts). */
function marksOf(lines: readonly LayoutLine[]): Record<RtlScript, number> {
  const counts = { arabic: 0, hebrew: 0 };
  for (const line of lines) {
    if (!hasRtlScript(line.text) || countMarks(line.text) === 0) continue;
    for (const ch of line.text) if (isRtlMark(ch)) counts[rtlScriptOf(ch.codePointAt(0) ?? 0) ?? 'arabic'] += 1;
  }
  return counts;
}

/** Where in its column the line's text is drawn, given `centred`, `rtl` and the plain left column. */
function lineX(line: FlowLine): number {
  if (line.centred === true) return PROSE_LAYOUT.marginLeft + Math.max(0, Math.floor((PROSE_LAYOUT.columns - textColumns(line.text)) / 2)) * PROSE_LAYOUT.charWidth;
  if (line.rtl === true) return PROSE_LAYOUT.marginLeft + Math.max(0, PROSE_LAYOUT.columns - textColumns(line.text)) * PROSE_LAYOUT.charWidth;
  return PROSE_LAYOUT.marginLeft + line.col * PROSE_LAYOUT.charWidth;
}

/** The page number line, on the right half an inch down — the manuscript page header. */
function headerLine(number: number): LayoutLine {
  const text = String(number);
  return {
    kind: 'action',
    text,
    x: PROSE_LAYOUT.marginLeft + (PROSE_LAYOUT.columns - textColumns(text)) * PROSE_LAYOUT.charWidth,
    y: PROSE_LAYOUT.headerY,
    row: null,
    scene: null, source: null,
  };
}

/** The wrapped lines of one note: `[n] ` then its blocks' text, hanging four columns. */
function noteLines(
  num: number,
  blocks: readonly ProseBlock[],
  defs: ParsedProse['notes'],
  number: (defs: ParsedProse['notes'], noteId: string) => number | undefined,
  separator: string,
  pictures: 'placeholder' | 'drop',
  discovered: number[],
): FlowLine[] {
  const mark = (noteId: string): number | undefined => {
    const n = number(defs, noteId);
    if (n !== undefined) discovered.push(n);
    return n;
  };
  const out: FlowLine[] = [];
  let first = true;
  const paragraph = (runs: readonly Run[], indents: readonly number[], prefix?: string): void => {
    let tokens = tokensOf(runs, mark);
    if (prefix !== undefined && tokens.length > 0) {
      const [head, ...rest] = tokens;
      if (head !== undefined && head.br !== true) tokens = [{ text: `${prefix}${head.text}`, notes: head.notes }, ...rest];
    }
    for (const wrapped of wrapTokens(tokens, PROSE_LAYOUT.columns, indents)) {
      out.push({ kind: 'line', text: wrapped.text, col: wrapped.col, notes: wrapped.notes, foot: true });
    }
    first = false;
  };
  const blocksFlow = (items: readonly ProseBlock[], indents: readonly number[]): void => {
    for (const block of items) {
      switch (block.kind) {
        case 'paragraph':
        case 'heading':
          paragraph(block.runs, indents, first && (indents[0] ?? 0) === 0 ? `[${num}] ` : undefined);
          break;
        case 'break':
          out.push({ kind: 'line', text: separator, col: 0, centred: true, notes: [], foot: true });
          break;
        case 'quote':
          blocksFlow(block.blocks, indents.map((n) => n + 4));
          break;
        case 'list':
          block.items.forEach((item, i) => {
            const marker = block.ordered ? `${i + 1}.` : '•';
            for (const sub of item) {
              if (sub.kind === 'paragraph') {
                const tokens = [{ text: marker, notes: [] }, ...tokensOf(sub.runs, mark)];
                for (const wrapped of wrapTokens(tokens, PROSE_LAYOUT.columns, indents.map((n) => n + 4))) {
                  out.push({ kind: 'line', text: wrapped.text, col: wrapped.col, notes: wrapped.notes, foot: true });
                }
              }
            }
          });
          break;
        case 'code':
          for (const row of block.text.split('\n')) {
            let rest = row;
            while (rest !== '') {
              const [head, tail] = splitColumns(rest, PROSE_LAYOUT.columns - (indents[0] ?? 0) - 4);
              out.push({ kind: 'line', text: head, col: (indents[0] ?? 0) + 4, notes: [], foot: true });
              rest = tail;
            }
          }
          break;
        case 'figure':
          if (pictures === 'placeholder') {
            const caption = placementCaptionOf(block.image.title);
            out.push({ kind: 'line', text: `[Picture: ${caption !== '' ? caption : block.image.alt}]`, col: (indents[0] ?? 0) + 4, notes: [], foot: true });
          }
          break;
      }
    }
  };
  blocksFlow(blocks, [0, 4]);
  return out;
}

/**
 * The manuscript's flow: the flattened blocks as wrapped lines, page and blank-line markers.
 * The walk is the plain-text export's (`render-text.ts`): a chapter is a centred heading on a
 * page of its own, a `section`-styled scene keeps its heading, a separator is the template's
 * line centred, and a paragraph takes a half-inch first-line indent. Emphasis marks are
 * dropped, as plain text drops them; a figure is the `[Picture: caption]` placeholder
 * (pictures.md §4) unless the recipe drops pictures.
 */
function flowOf(input: RenderInput, neutral: Direction, number: NoteNumbers['number']): { flows: Flow[]; bodyLines: number } {
  const flows: Flow[] = [];
  let bodyLines = 0;
  const line = (flow: FlowLine): void => {
    flows.push(flow);
    bodyLines += 1;
  };
  const blank = (): void => {
    flows.push({ kind: 'blank' });
  };
  const page = (): void => {
    flows.push({ kind: 'page' });
  };
  const pictures = input.pictures === 'drop' ? 'drop' : 'placeholder';
  const separator = input.template.separator.plain;
  const columns = PROSE_LAYOUT.columns;

  const para = (runs: readonly Run[], defs: ParsedProse['notes'], indents: readonly number[], centred = false): void => {
    const tokens = tokensOf(runs, (noteId) => number(defs, noteId));
    const text = tokens.map((token) => token.text).join(' ');
    const dir = paragraphDirection(text, neutral);
    for (const wrapped of wrapTokens(tokens, columns, indents)) {
      line({ kind: 'line', text: wrapped.text, col: wrapped.col, ...(centred ? { centred: true as const } : {}), ...(dir === 'rtl' ? { rtl: true as const } : {}), notes: wrapped.notes });
    }
  };

  const blocksFlow = (blocks: readonly ProseBlock[], defs: ParsedProse['notes'], indent: number): void => {
    for (const block of blocks) {
      switch (block.kind) {
        case 'paragraph':
          para(block.runs, defs, [indent + 5, indent]);
          break;
        case 'heading':
          blank();
          para(block.runs, defs, [0], true);
          blank();
          break;
        case 'break':
          line({ kind: 'line', text: separator, col: 0, centred: true, notes: [] });
          break;
        case 'quote':
          blocksFlow(block.blocks, defs, indent + 5);
          break;
        case 'list':
          block.items.forEach((item, index) => {
            const marker = block.ordered ? `${index + 1}.` : '•';
            let markerOn = true;
            for (const sub of item) {
              if (sub.kind === 'paragraph') {
                const tokens = [{ text: markerOn ? `${marker} ` : '', notes: [] }, ...tokensOf(sub.runs, (noteId) => number(defs, noteId))].filter((t) => t.text !== '');
                for (const wrapped of wrapTokens(tokens, columns, [indent + 4, indent + 4])) {
                  const dir = paragraphDirection(wrapped.text, neutral);
                  line({ kind: 'line', text: wrapped.text, col: wrapped.col, ...(dir === 'rtl' ? { rtl: true as const } : {}), notes: wrapped.notes });
                }
                markerOn = false;
              } else {
                blocksFlow([sub], defs, indent + 4);
              }
            }
          });
          break;
        case 'code':
          for (const row of block.text.split('\n')) {
            let rest = row;
            if (rest === '') {
              line({ kind: 'line', text: '', col: indent + 5, notes: [] });
              continue;
            }
            while (rest !== '') {
              const [head, tail] = splitColumns(rest, columns - indent - 5);
              line({ kind: 'line', text: head, col: indent + 5, notes: [] });
              rest = tail;
            }
          }
          break;
        case 'figure':
          if (pictures === 'placeholder') {
            const caption = placementCaptionOf(block.image.title);
            line({ kind: 'line', text: `[Picture: ${caption !== '' ? caption : block.image.alt}]`, col: 0, centred: true, notes: [] });
          }
          break;
      }
    }
  };

  const words = boilerplateOf(input);
  const byBlock = headingsByBlock(input);
  input.blocks.forEach((block, index) => {
    switch (block.kind) {
      case 'frontmatter':
        break;
      case 'chapter': {
        page();
        for (let i = 0; i < PROSE_LAYOUT.chapterRow; i++) blank();
        const heading = byBlock.get(index)?.label ?? block.title;
        const text = block.part === true || block.title.trim() === '' ? heading.toUpperCase() : `${generatedChapterHeading(words, block.number)}. ${block.title.trim()}`.toUpperCase();
        para([{ text }], new Map(), [0], true);
        blank();
        break;
      }
      case 'scene': {
        const section = sectionTitle(block, words.untitled);
        if (section !== undefined) {
          blank();
          para([{ text: section.toUpperCase() }], new Map(), [0], true);
          blank();
        }
        const parsed = parseProse(block.body);
        blocksFlow(parsed.blocks, parsed.notes, 0);
        blank();
        break;
      }
      case 'separator':
        line({ kind: 'line', text: separator, col: 0, centred: true, notes: [] });
        break;
      case 'backmatter':
        break;
    }
  });
  return { flows, bodyLines };
}

/** The wrapped lines of every note a page's body calls, carried continuations first. */
function footnoteLines(
  pageRows: readonly FlowLine[],
  carried: readonly FlowLine[],
  book: NoteBook,
  number: NoteNumbers['number'],
  separator: string,
  pictures: 'placeholder' | 'drop',
): FlowLine[] {
  const lines = [...carried];
  const nums = [...new Set(pageRows.flatMap((row) => row.notes))];
  const emitted = new Set<number>();
  const queue = [...nums];
  while (queue.length > 0) {
    const num = queue.shift();
    if (num === undefined || emitted.has(num)) continue;
    emitted.add(num);
    const body = book.bodies[num - 1];
    if (body === undefined) continue;
    const discovered: number[] = [];
    lines.push(...noteLines(num, body.blocks, body.defs, number, separator, pictures, discovered));
    for (const next of discovered) if (!emitted.has(next)) queue.push(next);
  }
  return lines;
}

/**
 * Paginates the manuscript. Pure and synchronous: the same input, options and measure always
 * give the same pages. `measure` is the width of a shaped word of Arabic or Hebrew in columns,
 * as the screenplay's layout reads it; `colour` says which emoji the colour set prints.
 */
export function layoutProsePdf(input: RenderInput, opts: ProsePdfOptions, measure?: MeasureRun, colour?: (cluster: string) => boolean): PdfLayout {
  const allText = input.blocks.map((block) => (block.kind === 'scene' ? block.body : block.kind === 'chapter' ? block.title : '')).join('\n');
  const holdsRtl = hasRtlScript(allText);
  const neutral: Direction = holdsRtl ? languageDirection(opts.language) : 'ltr';
  const { book, number: noteNumber } = noteBookOf();
  const { flows, bodyLines } = withMeasure(holdsRtl || hasDevanagari(allText) ? measure : undefined, () => flowOf(input, neutral, noteNumber));
  const pageSize = opts.pageSize ?? 'Letter';
  const geometry = PAGE_GEOMETRY[pageSize];
  const pageHeight = geometry.pageHeight;
  const footRoom = (rows: number): number => pageHeight - geometry.marginBottom - PROSE_LAYOUT.marginTop - rows * PROSE_LAYOUT.leading;

  // The flow into pages: a 'page' marker starts a new page, a 'blank' a skipped row, a line a
  // row of the 27.
  const pages: { rows: FlowLine[] }[] = [];
  const openPage = (): { rows: FlowLine[] } => {
    const page = { rows: [] };
    pages.push(page);
    return page;
  };
  let current = openPage();
  for (const flow of flows) {
    if (flow.kind === 'page') {
      current = openPage();
      continue;
    }
    if (flow.kind === 'blank') {
      if (current.rows.length < PROSE_LAYOUT.rows) current.rows.push({ kind: 'line', text: '', col: 0, notes: [] });
      continue;
    }
    if (current.rows.length >= PROSE_LAYOUT.rows) current = openPage();
    current.rows.push(flow);
  }

  // The footnote pass: a page's notes sit at its foot, single-spaced under a short rule. A note
  // that does not fit pushes the last body rows down to the next page — which may carry the
  // marker's own note with it — and what still does not fit on a page of notes alone continues
  // at the next page's foot.
  if ((opts.notes ?? 'footnote') === 'footnote') {
    const carried = new Map<number, FlowLine[]>();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i] ?? { rows: [] };
      let lines = footnoteLines(page.rows, carried.get(i) ?? [], book, noteNumber, input.template.separator.plain, input.pictures === 'drop' ? 'drop' : 'placeholder');
      let guard = page.rows.length + 4;
      const need = (): number => (lines.length === 0 ? 0 : lines.length * PROSE_LAYOUT.noteLeading + PROSE_LAYOUT.leading);
      while (need() > footRoom(page.rows.length) && guard > 0) {
        const last = page.rows.findLastIndex((row) => row.foot !== true && row.text !== '');
        if (last === -1) break;
        const moved = page.rows.splice(last);
        const next = i + 1 < pages.length ? (pages[i + 1] ?? openPage()) : openPage();
        next.rows.unshift(...moved);
        lines = footnoteLines(page.rows, carried.get(i) ?? [], book, noteNumber, input.template.separator.plain, input.pictures === 'drop' ? 'drop' : 'placeholder');
        guard -= 1;
      }
      const room = Math.max(0, Math.floor((footRoom(page.rows.length) - PROSE_LAYOUT.leading) / PROSE_LAYOUT.noteLeading));
      const placed = lines.slice(0, room).map((row) => ({ ...row, foot: true as const }));
      const rest = lines.slice(room);
      if (rest.length > 0) carried.set(i + 1, [...rest, ...(carried.get(i + 1) ?? [])]);
      page.rows.push(...placed);
    }
  }

  // The drawn pages: the title page, then the script pages with their headers and footnotes.
  const layoutPages: LayoutPage[] = [];
  if (input.blocks.some((block) => block.kind === 'frontmatter' && block.fmKind === 'titlepage')) {
    const rows: { row: number; text: string }[] = [
      { row: 9, text: input.title },
      { row: 11, text: input.author },
      { row: 15, text: input.date },
    ];
    layoutPages.push({
      number: 0,
      kind: 'title',
      lines: rows
        .filter((row) => row.text !== '')
        .map((row) => ({
          kind: 'action',
          text: row.text,
          x: PROSE_LAYOUT.marginLeft + Math.max(0, Math.floor((PROSE_LAYOUT.columns - textColumns(row.text)) / 2)) * PROSE_LAYOUT.charWidth,
          y: PROSE_LAYOUT.marginTop + row.row * PROSE_LAYOUT.leading + BODY_BASELINE,
          row: null,
          scene: null, source: null,
        })),
    });
  }
  let pageNum = 0;
  for (const page of pages) {
    const body = page.rows.filter((row) => row.foot !== true);
    const foot = page.rows.filter((row) => row.foot === true);
    if (body.length === 0 && foot.length === 0) continue;
    pageNum += 1;
    const drawn: LayoutLine[] = body.map((row, rowIndex) => ({
      kind: 'action',
      text: row.text,
      x: lineX(row),
      y: PROSE_LAYOUT.marginTop + rowIndex * PROSE_LAYOUT.leading + BODY_BASELINE,
      row: rowIndex,
      scene: null, source: null,
      ...(row.rtl === true ? { rtl: true as const } : {}),
    }));
    if (foot.length > 0) {
      const firstY = pageHeight - geometry.marginBottom - foot.length * PROSE_LAYOUT.noteLeading;
      drawn.push({ kind: 'action', text: '—'.repeat(20), x: PROSE_LAYOUT.marginLeft, y: firstY - 2, row: null, scene: null, source: null });
      foot.forEach((row, i) => {
        drawn.push({ kind: 'action', text: row.text, x: lineX(row), y: firstY + i * PROSE_LAYOUT.noteLeading + BODY_BASELINE - 2, row: null, scene: null, source: null, ...(row.rtl === true ? { rtl: true as const } : {}) });
      });
    }
    layoutPages.push({ number: pageNum, kind: 'script', lines: pageNum >= 2 ? [headerLine(pageNum), ...drawn] : drawn });
  }

  // Endnotes: pages of their own at the book's end, headed NOTES in the project's language.
  if (opts.notes === 'endnote' && book.bodies.length > 0) {
    const discovered: number[] = [];
    const endLines: FlowLine[] = [{ kind: 'line', text: wordsOf(input).toUpperCase(), col: 0, centred: true, notes: [] }];
    for (let i = 0; i < book.bodies.length; i++) {
      const body = book.bodies[i];
      if (body === undefined) continue;
      endLines.push(...noteLines(i + 1, body.blocks, body.defs, noteNumber, input.template.separator.plain, input.pictures === 'drop' ? 'drop' : 'placeholder', discovered));
      endLines.push({ kind: 'line', text: '', col: 0, notes: [] });
    }
    // A note can mark a note of its own: those are appended at the end, numbered in turn.
    const endDone = new Set<number>(book.bodies.map((_, i) => i + 1));
    for (let i = 0; i < discovered.length; i++) {
      const num = discovered[i] ?? 0;
      if (endDone.has(num)) continue;
      endDone.add(num);
      const body = book.bodies[num - 1];
      if (body === undefined) continue;
      endLines.push(...noteLines(num, body.blocks, body.defs, noteNumber, input.template.separator.plain, input.pictures === 'drop' ? 'drop' : 'placeholder', discovered));
      endLines.push({ kind: 'line', text: '', col: 0, notes: [] });
    }
    for (let start = 0; start < endLines.length; start += PROSE_LAYOUT.rows) {
      pageNum += 1;
      const drawn = endLines.slice(start, start + PROSE_LAYOUT.rows).map((row, rowIndex) => ({
        kind: 'action' as const,
        text: row.text,
        x: lineX(row),
        y: PROSE_LAYOUT.marginTop + rowIndex * PROSE_LAYOUT.leading + BODY_BASELINE,
        row: rowIndex,
        scene: null, source: null,
        ...(row.rtl === true ? { rtl: true as const } : {}),
      }));
      layoutPages.push({ number: pageNum, kind: 'script', lines: pageNum >= 2 ? [headerLine(pageNum), ...drawn] : drawn });
    }
  }

  const allLines = layoutPages.flatMap((page) => page.lines);
  const outside = unprintable(allLines, colour);
  const notes: string[] = [];
  if (outside.missing.length > 0) {
    const { what, verb, shown } = counted(outside.missing, 'character', 'characters');
    notes.push(`pdf: neither Courier Prime nor the CJK or emoji fallback font can print ${what}, so ${verb} printed as "?": ${shown}`);
  }
  if (outside.partial.length > 0) {
    const { what, verb, shown } = counted(outside.partial, 'emoji sequence', 'emoji sequences');
    notes.push(`pdf: the emoji font has no glyph for ${what}, so ${verb} printed as ${outside.partial.length === 1 ? 'its' : 'their'} first emoji: ${shown}`);
  }
  const colourNotes: string[] = [];
  if (colour !== undefined && outside.emoji.length > 0) {
    const plain = outside.emoji.filter((unit) => isEmojiCluster(unit));
    if (plain.length > 0) {
      const { what, verb, shown } = counted(plain, 'emoji', 'emoji');
      colourNotes.push(`pdf: Noto Color Emoji has no picture for ${what}, so ${verb} printed in black and white: ${shown}`);
    }
  }
  const marks = outside.scripts.length === 0 ? { arabic: 0, hebrew: 0 } : marksOf(allLines);
  if (marks.hebrew > 0) {
    const n = marks.hebrew;
    notes.push(`pdf: ${n} Hebrew ${n === 1 ? 'point or cantillation mark is' : 'points and cantillation marks are'} left out of the print, because the font's placement of marks cannot be checked; the text of the file still holds ${n === 1 ? 'it' : 'them'}`);
  }
  if (marks.arabic > 0) {
    const n = marks.arabic;
    notes.push(`pdf: ${n} Arabic ${n === 1 ? 'mark (a haraka, shadda or the like) is' : 'marks (harakat, shadda and the like) are'} left out of the print, because the font's placement of marks cannot be checked; the text of the file still holds ${n === 1 ? 'it' : 'them'}`);
  }

  return {
    pages: layoutPages,
    pageSize,
    scriptPageCount: bodyLines === 0 ? 0 : layoutPages.filter((page) => page.kind === 'script').length,
    title: input.title,
    ...(input.author === '' ? {} : { author: input.author }),
    notes,
    fallbackCharacters: outside.cjk,
    emojiCharacters: outside.emoji,
    colourCharacters: outside.colour,
    colourNotes,
    shapedScripts: outside.scripts,
  };
}

/** The word the endnotes page is headed with, in the project's language. */
function wordsOf(input: RenderInput): string {
  return boilerplateOf(input).notes;
}

/**
 * Lays the manuscript out, loads the fonts the layout needs, and lays it out again when the
 * Arabic, Hebrew or Devanagari fonts change the widths — the screenplay's `preparePdf` for the
 * prose input. A document without any is laid out once, with no shaper and no such font loaded.
 */
export async function prepareProsePdf(
  input: RenderInput,
  opts: ProsePdfOptions,
  loaders: PdfFontLoaders = {},
): Promise<{
  readonly layout: PdfLayout;
  readonly font?: PdfFont;
  readonly cjk?: PdfCidFont;
  readonly emoji?: PdfEmojiFont;
  readonly rtl?: PdfRtlFonts;
  readonly colour?: PdfColourEmojiFont;
  readonly colourNotes: readonly string[];
}> {
  // Colour emoji need the colour set's coverage before the first layout: it decides which emoji the monochrome font is asked for.
  const colourOn = opts.colourEmoji === true && loaders.colourEmoji !== undefined;
  const colourCovers = colourOn ? (await import('@caotang/pdf-fonts/colour')).colourEmojiCovers : undefined;
  let layout = layoutProsePdf(input, opts, undefined, colourCovers);
  let support: RtlSupport | undefined;
  if (layout.shapedScripts.length > 0 && (loaders.arabic !== undefined || loaders.hebrew !== undefined || loaders.devanagari !== undefined)) {
    support = await loadRtlSupport(layout.shapedScripts, loaders, undefined, opts.language === undefined ? {} : { language: opts.language });
    layout = layoutProsePdf(input, opts, support.measure, colourCovers);
  }
  const colourNotes = [...layout.colourNotes];
  let colour: PdfColourEmojiFont | undefined;
  if (colourCovers !== undefined && layout.colourCharacters.length > 0 && loaders.colourEmoji !== undefined) {
    try {
      colour = await loadColourEmojiFallback(layout, loaders.colourEmoji);
    } catch (error) {
      // The whole file falls back to the monochrome font, and says so.
      layout = layoutProsePdf(input, opts, support?.measure);
      colourNotes.splice(0, colourNotes.length, `pdf: the colour emoji could not be read (${error instanceof Error ? error.message : String(error)}), so the emoji are printed in black and white`);
    }
  }
  const [font, cjk, emoji, rtl] = await Promise.all([
    loadScriptFont(opts.scriptFont),
    loadCjkFallback(layout, loaders.cjk, opts.language),
    loadEmojiFallback(layout, loaders.emoji),
    loadRtlFallback(layout, support),
  ]);
  return { layout, ...(font === undefined ? {} : { font }), ...(cjk === undefined ? {} : { cjk }), ...(emoji === undefined ? {} : { emoji }), ...(rtl === undefined ? {} : { rtl }), ...(colour === undefined ? {} : { colour }), colourNotes };
}

/** Writes a prepared layout as a PDF, the way the screenplay's `drawPdf` writes its own. */
export function drawProsePdf(prepared: Awaited<ReturnType<typeof prepareProsePdf>>): Uint8Array<ArrayBuffer> {
  return drawPdf(prepared.layout, prepared.font, prepared.cjk, prepared.emoji, prepared.rtl, prepared.colour);
}

export { PDF_MIME };
