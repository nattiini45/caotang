/**
 * Pagination — [screenplay.md §5.3](../../../docs/architecture/screenplay.md). A Caotang-owned pass
 * over the element stream: elements and constants in, pages out. It is pure, so the page count and
 * the page-break rules are testable without a PDF library. The PDF writer only draws the lines this
 * pass places.
 *
 * The page-break rules of §5.3, each with a positive and a negative fixture in the tests:
 * - a scene heading is never the last text on a page: it is laid with the element after it, and a
 *   forced break does not separate the two;
 * - a character cue is never separated from its first line of dialogue, and a parenthetical stays
 *   with its cue (it may follow dialogue inside the block);
 * - dialogue splits only after a sentence end, with `(MORE)` at the foot and `NAME (CONT'D)` at the
 *   head of the next page, in every block that crosses a page, a tail included. A sentence end
 *   inside a wrapped row is a break point too: the row splits there, and the rest opens the next page;
 * - a transition never starts a page: it is kept with the element before it, and a forced break is
 *   not an element, so a transition after one goes before the break.
 *
 * Annotations do not print: a boneyard or a note is removed from every line (`printedText`).
 * Dual dialogue (`NAME ^`, screenplay.md §2.2) prints side by side: the first speaker in the left
 * column, the second in the right. A pair moves to the next page whole and never splits; a pair
 * taller than a page is laid one block after the other, which splits by the dialogue rules.
 *
 * Widths are grid columns (width.ts): a Chinese, Japanese or Korean character takes two, every other
 * character one, so the indents, the column widths and the 54-line page hold for CJK text. A line breaks
 * at white space and between Chinese or Japanese characters, with the kinsoku marks kept on their side.
 *
 * Estimates (screenplay.md §2.2, §5.2): a page count is the pagination's own count, and one page is
 * about one minute of screen time. The minute figure is an estimate, never a
 * timing.
 */

import { printedText, sceneNumberOf, stripSceneNumber } from './classify.js';
import type { ScreenplayElement } from './types.js';
import { breakPieces, splitColumns, textColumns } from './width.js';

/**
 * The layout constants (screenplay.md §5.3): 12pt Courier, US Letter, 1.5in left margin,
 * 1.0in elsewhere, single-spaced. All horizontal values are in characters from the left
 * margin, all vertical values in points. Courier Prime (A3) is metrically the same as
 * Courier, so the layout does not change when the embedded font lands with the PDF library.
 */
export const LAYOUT = Object.freeze({
  pageWidth: 612,
  pageHeight: 792,
  marginLeft: 108,
  marginRight: 72,
  marginTop: 72,
  marginBottom: 72,
  charWidth: 7.2,
  lineHeight: 12,
  /** (792 - 72 - 72) / 12. The spec's "~55" is this figure for its own margins. The PDF-library benchmark calibrates it. */
  linesPerPage: 54,
  /** The text width in characters: (612 - 108 - 72) / 7.2. */
  columns: 60,
  /** Baseline of the page number, half an inch from the top edge. */
  pageNumberY: 46,
  sceneNumberLeftX: 54,
  sceneNumberRightInset: 54,
  indent: {
    scene: 0,
    action: 0,
    character: 22,
    parenthetical: 16,
    dialogue: 10,
    transition: 0,
    centered: 0,
  },
  width: {
    scene: 60,
    action: 60,
    character: 38,
    parenthetical: 20,
    dialogue: 35,
    transition: 60,
    centered: 60,
  },
  /**
   * The two columns of a dual-dialogue pair, in characters from the left margin. Each column is 27 characters of
   * dialogue, with a three-column gutter. The dialogue and the parentheticals sit inside their column (the left
   * parenthetical ends by column 3 + 21 = 24, the right one by 33 + 21 = 54). The cue wraps at 23, the room its indent
   * leaves: the left cue ends by column 7 + 23 = 30, where the right column starts, and the right cue by 37 + 23 = 60, the
   * right margin, so neither cue reaches the other column or the margin.
   */
  dual: {
    left: { character: 7, parenthetical: 3, dialogue: 0 },
    right: { character: 37, parenthetical: 33, dialogue: 30 },
    width: { character: 23, parenthetical: 21, dialogue: 27 },
  },
});

export type LineKind =
  | 'scene'
  | 'action'
  | 'character'
  | 'parenthetical'
  | 'dialogue'
  | 'transition'
  | 'centered'
  | 'more'
  | 'continued'
  | 'title'
  | 'pageNumber'
  | 'sceneNumber';

export interface LayoutLine {
  readonly kind: LineKind;
  readonly text: string;
  /** Points from the left edge of the page to the start of the text. */
  readonly x: number;
  /** Baseline in points from the top edge of the page. */
  readonly y: number;
  /** Row within the page's text area, from zero. Null for the title page and the margins. */
  readonly row: number | null;
  /** The scene the line opens, on the first line of a scene heading. */
  readonly scene: number | null;
}

export interface LayoutPage {
  /**
   * The page's number. Script pages count from 1, and the number is printed from page 2 (screenplay.md §5.3). The title
   * page is not counted, as in every screenplay: it is page 0, and it carries no number.
   */
  readonly number: number;
  readonly kind: 'title' | 'script';
  readonly lines: readonly LayoutLine[];
}

export interface PaginateOptions {
  /** Lay out the title page from the title_page element (default true). */
  readonly titlePage?: boolean;
  /** Fallbacks for the title page when the source has no entry for them. */
  readonly title?: string;
  readonly author?: string;
  readonly date?: string;
  /**
   * Scene numbers in the margins. A heading's own `#n#` number is used when it has one,
   * otherwise a running count. Off by default (screenplay.md §5.3).
   */
  readonly sceneNumbers?: 'off' | 'left' | 'right' | 'both';
  /** `(MORE)` and `NAME (CONT'D)` on split dialogue (default true). */
  readonly continued?: boolean;
}

type ParaKind = 'scene' | 'action' | 'character' | 'parenthetical' | 'dialogue' | 'transition' | 'centered';

/** One element, wrapped to its column. */
interface Para {
  readonly kind: ParaKind;
  readonly lines: readonly string[];
  /** What joins each line to the next when a dual-dialogue column rewraps the text: a space, or nothing between CJK characters. */
  readonly joins: readonly string[];
  /** Dialogue only: line i ends a sentence, so the text may split after it. */
  readonly ends: readonly boolean[];
  readonly blankBefore: boolean;
  readonly align: 'left' | 'center' | 'right';
  /** The column a left-aligned line starts at, in characters from the left margin. */
  readonly indent: number;
  /** The scene number printed in the margin, on a scene heading. */
  readonly sceneNumber: string | null;
  /** The scene index, on a scene heading. */
  readonly sceneIndex: number | null;
  /** The cue as printed, on a character element. `(CONT'D)` is appended to it on the next page. */
  readonly cueName: string;
}

/** A cue block still being read: its lead, its cue, its leading parentheticals, and what follows them. */
interface OpenCue {
  /** Scene headings waiting to be laid with this block. */
  readonly lead: readonly Para[];
  readonly cue: Para;
  readonly parens: Para[];
  /** The dialogue and parentheticals after the leading parentheticals, in order. */
  readonly items: Para[];
}

/** One side of a dual-dialogue pair, wrapped to its column: the cue, then the parentheticals and the dialogue. */
interface DualSide {
  readonly cue: Para;
  readonly body: readonly Para[];
}

/**
 * One thing the pager places. `paras` is atomic. `action` splits at any line. `dialogue` is a cue
 * block: its cue, its leading parentheticals, and the dialogue and parentheticals after them (`items`).
 * It splits only after a sentence end of dialogue. `trailer` holds a transition glued to the unit: it
 * is never first on a page, so the unit's last line must keep it company. `break` is a forced page
 * break (`===`). A `lead` is a scene heading that must share a page with the unit after it.
 */
type Unit =
  | { readonly kind: 'paras'; readonly paras: readonly Para[] }
  | { readonly kind: 'action'; readonly lead: readonly Para[]; readonly para: Para; readonly trailer: readonly Para[] }
  | {
      readonly kind: 'dialogue';
      readonly lead: readonly Para[];
      readonly cue: Para;
      readonly parens: readonly Para[];
      readonly items: readonly Para[];
      readonly trailer: readonly Para[];
    }
  | {
      readonly kind: 'dual';
      readonly lead: readonly Para[];
      readonly left: DualSide;
      readonly right: DualSide;
      /** The two blocks as ordinary cue blocks, laid in sequence when the pair is taller than a page. */
      readonly fallback: readonly Unit[];
      readonly trailer: readonly Para[];
    }
  | { readonly kind: 'break' };

/** One printed row of a cue block after its head. A row can split inside, at a sentence end, when the page breaks there. */
interface BlockRow {
  readonly para: Para;
  readonly text: string;
  /** The row ends a sentence of dialogue, so the page may break after it. */
  readonly breakAfter: boolean;
  /** Offsets just after a sentence end that a space follows, inside the row: the page may break at them. */
  readonly cuts: readonly number[];
}

/** A sentence end: Latin `.`, `!`, `?` or `…`, or the CJK `。`, `！`, `？`, each with any closing quotes after it. */
const SENTENCE_END_RE = /(?:[.!?…]["')\]”’]*|[。！？][」』）〉》"”’]*)$/;

/** Wrapped lines, and what joins each line to the one before it when the text is rewrapped: a space, or nothing. */
interface Wrapped {
  readonly lines: string[];
  /** `joins[i]` goes between line i and line i + 1. */
  readonly joins: string[];
}

/**
 * Words wrapped to a column, measured in grid columns (width.ts: a CJK character is two). A line breaks at white space,
 * and also between Chinese or Japanese characters. A piece wider than the column is broken, never dropped.
 */
function wrap(text: string, width: number): Wrapped {
  const words = text.split(/\s+/).filter((word) => word !== '');
  const lines: string[] = [];
  const joins: string[] = [];
  let current = '';
  const push = (line: string, join: string): void => {
    if (lines.length > 0) joins.push(join);
    lines.push(line);
  };
  // What joins the line being built to the line before it.
  let currentJoin = ' ';
  for (const word of words) {
    breakPieces(word).forEach((piece, index) => {
      // The first piece of a word follows a space; the others join the piece before them directly.
      const joint = index === 0 ? ' ' : '';
      let rest = piece;
      while (textColumns(rest) > width) {
        if (current !== '') {
          push(current, currentJoin);
          currentJoin = joint;
          current = '';
        }
        const [head, tail] = splitColumns(rest, width);
        push(head, currentJoin);
        // A word broken at the column edge is one word: a rewrap joins its pieces with nothing between them.
        currentJoin = '';
        rest = tail;
      }
      if (current === '') current = rest;
      else if (textColumns(current) + joint.length + textColumns(rest) <= width) current += `${joint}${rest}`;
      else {
        push(current, currentJoin);
        currentJoin = joint;
        current = rest;
      }
    });
  }
  if (current !== '') push(current, currentJoin);
  return { lines, joins };
}

/** A paragraph's text as its lines join back: the text a rewrap starts from. */
function joinLines(para: Para): string {
  return para.lines.map((line, i) => (i === 0 ? line : `${para.joins[i - 1] ?? ' '}${line}`)).join('');
}

function makePara(
  kind: ParaKind,
  text: string,
  blankBefore: boolean,
  extra: {
    readonly sceneIndex?: number;
    readonly sceneNumber?: string;
    readonly cueName?: string;
    readonly indent?: number;
    readonly width?: number;
  } = {},
): Para {
  const { lines, joins } = wrap(text, extra.width ?? LAYOUT.width[kind]);
  return {
    kind,
    lines,
    joins,
    ends: lines.map((line) => SENTENCE_END_RE.test(line)),
    blankBefore,
    align: kind === 'transition' ? 'right' : kind === 'centered' ? 'center' : 'left',
    indent: extra.indent ?? LAYOUT.indent[kind],
    sceneNumber: extra.sceneNumber ?? null,
    sceneIndex: extra.sceneIndex ?? null,
    cueName: extra.cueName ?? '',
  };
}

/** The offsets in a row where a sentence ends and a space follows (screenplay.md §5.3). */
function sentenceCuts(text: string): number[] {
  const cuts: number[] = [];
  // A Latin sentence end needs a space after it. A CJK one needs only more text: CJK puts no space between sentences.
  const pattern = /[.!?…]["')\]”’]*(?= )|[。！？][」』）〉》"”’]*(?=\S)/g;
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) cuts.push(m.index + m[0].length);
  return cuts;
}

/**
 * The place to break a block whose rows from `at` have `room` rows of page: the last sentence end
 * that fits, after its row or inside it. Null when no sentence end fits (the speech then splits at
 * the page edge, a known gap).
 */
function breakIn(rows: readonly BlockRow[], at: number, room: number): { readonly row: number; readonly cut: number | null } | null {
  if (room < 1) return null;
  for (let j = Math.min(rows.length - 1, at + room - 1); j >= at; j--) {
    const row = rows[j];
    if (row === undefined) continue;
    if (row.breakAfter && j < rows.length - 1) return { row: j, cut: null };
    const cut = row.cuts[row.cuts.length - 1];
    if (cut !== undefined) return { row: j, cut };
  }
  return null;
}

function closeCue(open: OpenCue): Unit {
  if (open.items.length === 0) return { kind: 'paras', paras: [...open.lead, open.cue, ...open.parens] };
  return { kind: 'dialogue', lead: open.lead, cue: open.cue, parens: open.parens, items: open.items, trailer: [] };
}

/** A cue block rewrapped to one column of a dual-dialogue pair. */
function dualSide(open: OpenCue, column: 'left' | 'right'): DualSide {
  const at = LAYOUT.dual[column];
  const width = LAYOUT.dual.width;
  const rewrap = (para: Para, kind: 'parenthetical' | 'dialogue'): Para =>
    makePara(kind, joinLines(para), false, { indent: at[kind], width: width[kind] });
  return {
    cue: makePara('character', open.cue.cueName, true, { cueName: open.cue.cueName, indent: at.character, width: width.character }),
    body: [...open.parens, ...open.items].map((para) => rewrap(para, para.kind === 'parenthetical' ? 'parenthetical' : 'dialogue')),
  };
}

/** The first speaker of a dual pair and the second, as one unit (screenplay.md §2.2: side-by-side columns at render). */
function closeDual(left: OpenCue, right: OpenCue): Unit {
  return {
    kind: 'dual',
    lead: left.lead,
    left: dualSide(left, 'left'),
    right: dualSide(right, 'right'),
    fallback: [closeCue(left), closeCue(right)],
    trailer: [],
  };
}

/**
 * A transition is kept with the element before it, so it never starts a page (screenplay.md §5.3).
 * The element before it may be any unit, and a unit keeps its own splitting: the transition joins
 * the unit's trailer rather than turning the unit atomic. A forced break is not an element, so the
 * transition goes before the break, and the break still starts the next page.
 */
function glueToPrevious(units: Unit[], para: Para): void {
  const breaks: Unit[] = [];
  while (units.length > 0 && units[units.length - 1]?.kind === 'break') breaks.unshift(units.pop() as Unit);
  const last = units[units.length - 1];
  if (last !== undefined && last.kind === 'paras') {
    units[units.length - 1] = { kind: 'paras', paras: [...last.paras, para] };
  } else if (last !== undefined && last.kind !== 'break') {
    units[units.length - 1] = { ...last, trailer: [...last.trailer, para] };
  } else {
    units.push({ kind: 'paras', paras: [para] });
  }
  units.push(...breaks);
}

/**
 * Elements to units. A cue with its parentheticals and dialogue is one dialogue unit, and a scene
 * heading leads the unit after it. Annotations and the title page print nothing, so they do not
 * interrupt a block; an element that prints no text closes a block but adds no unit.
 */
function buildUnits(elements: readonly ScreenplayElement[]): Unit[] {
  const units: Unit[] = [];
  let open: OpenCue | null = null;
  // The first speaker of a dual pair, held while the second block (the cue marked `^`) is read.
  let dualLeft: OpenCue | null = null;
  let lead: Para[] = [];
  let sceneCount = 0;
  const close = (block: OpenCue): void => {
    if (dualLeft !== null) units.push(closeDual(dualLeft, block));
    else units.push(closeCue(block));
    dualLeft = null;
  };

  for (const el of elements) {
    if (
      el.type === 'title_page' ||
      el.type === 'section' ||
      el.type === 'synopsis' ||
      el.type === 'note' ||
      el.type === 'boneyard'
    ) {
      continue;
    }

    // A dual pair (`NAME ^`) is the block before the marked cue and the marked block, side by side. A marked cue with
    // no block straight before it has no partner, so it is an ordinary cue.
    if (el.type === 'character') {
      if (open !== null && el.dual === true && dualLeft === null) dualLeft = open;
      else if (open !== null) close(open);
      const name = printedText(el.text);
      open = { lead, cue: makePara('character', name, true, { cueName: name }), parens: [], items: [] };
      lead = [];
      continue;
    }

    if (el.type === 'parenthetical' || el.type === 'dialogue') {
      const printed = printedText(el.text);
      if (printed === '') continue;
      const para = makePara(el.type, printed, false);
      if (open === null) {
        // Dialogue with no cue above it lays out as action, which splits at any line (screenplay.md §5.3).
        units.push({ kind: 'action', lead, para, trailer: [] });
        lead = [];
      } else if (el.type === 'parenthetical' && open.items.length === 0) {
        open.parens.push(para);
      } else {
        open.items.push(para);
      }
      continue;
    }

    if (open !== null) {
      close(open);
      open = null;
    }

    switch (el.type) {
      case 'scene_heading': {
        sceneCount += 1;
        const printed = printedText(el.text);
        const heading = stripSceneNumber(printed);
        if (heading !== '') {
          lead = [
            ...lead,
            makePara('scene', heading, true, {
              sceneIndex: sceneCount - 1,
              sceneNumber: sceneNumberOf(printed) ?? String(sceneCount),
            }),
          ];
        }
        break;
      }
      case 'action': {
        const printed = printedText(el.text);
        if (printed !== '') {
          units.push({ kind: 'action', lead, para: makePara('action', printed, true), trailer: [] });
          lead = [];
        }
        break;
      }
      case 'centered': {
        const printed = printedText(el.text);
        if (printed !== '') {
          units.push({ kind: 'paras', paras: [...lead, makePara('centered', printed, true)] });
          lead = [];
        }
        break;
      }
      case 'page_break':
        // A scene heading above the break stays with the element after it, so it does not end the page.
        units.push({ kind: 'break' });
        break;
      case 'transition': {
        const printed = printedText(el.text);
        if (printed === '') break;
        const para = makePara('transition', printed, true);
        if (lead.length > 0) {
          units.push({ kind: 'paras', paras: [...lead, para] });
          lead = [];
        } else {
          glueToPrevious(units, para);
        }
        break;
      }
    }
  }
  if (open !== null) close(open);
  if (lead.length > 0) units.push({ kind: 'paras', paras: lead });
  return units;
}

function rowY(row: number): number {
  return LAYOUT.marginTop + row * LAYOUT.lineHeight + 10;
}

function columnOf(para: Para, text: string): number {
  if (para.align === 'right') return LAYOUT.columns - textColumns(text);
  if (para.align === 'center') return Math.floor((LAYOUT.columns - textColumns(text)) / 2);
  return para.indent;
}

function rowsOf(paras: readonly Para[]): number {
  return paras.reduce((n, p) => n + p.lines.length + (p.blankBefore ? 1 : 0), 0);
}

/** Places units on pages. The one stateful part of the pass; every rule is applied here. */
class Pager {
  private readonly done: LayoutLine[][] = [];
  private current: LayoutLine[] = [];
  private used = 0;

  constructor(
    private readonly continued: boolean,
    private readonly sceneNumbers: 'off' | 'left' | 'right' | 'both',
  ) {}

  finish(): LayoutLine[][] {
    if (this.used > 0) this.done.push(this.current);
    this.current = [];
    this.used = 0;
    return this.done;
  }

  placeUnit(unit: Unit): void {
    switch (unit.kind) {
      case 'break':
        this.newPage();
        return;
      case 'paras':
        this.placeAtomic(unit.paras);
        return;
      case 'action':
        this.placeAction(unit.lead, unit.para, unit.trailer);
        return;
      case 'dialogue':
        this.placeDialogue(unit.lead, unit.cue, unit.parens, unit.items, unit.trailer);
        return;
      case 'dual':
        this.placeDual(unit);
        return;
    }
  }

  /**
   * A dual-dialogue pair: the lead, a blank row, then both columns from the same row. The pair is atomic, so it moves to
   * the next page whole. A pair taller than a page is laid as its two blocks in sequence, and the dialogue rules split them.
   */
  private placeDual(unit: Extract<Unit, { kind: 'dual' }>): void {
    const sideRows = (side: DualSide): number => side.cue.lines.length + side.body.reduce((n, p) => n + p.lines.length, 0);
    const pairRows = Math.max(sideRows(unit.left), sideRows(unit.right));
    const need = rowsOf(unit.lead) + 1 + pairRows + rowsOf(unit.trailer);
    if (need > LAYOUT.linesPerPage) {
      // The trailer stays with the second block, so a transition after the pair still never starts a page.
      unit.fallback.forEach((block, i) => {
        if (i < unit.fallback.length - 1 || unit.trailer.length === 0) this.placeUnit(block);
        else if (block.kind === 'dialogue') this.placeUnit({ ...block, trailer: [...block.trailer, ...unit.trailer] });
        else if (block.kind === 'paras') this.placeUnit({ kind: 'paras', paras: [...block.paras, ...unit.trailer] });
        else this.placeUnit(block);
      });
      return;
    }
    if (this.used > 0 && need > this.free()) this.newPage();
    for (const para of unit.lead) this.flow(para);
    this.blankRow();
    const top = this.used;
    for (const side of [unit.left, unit.right]) {
      let row = top;
      for (const para of [side.cue, ...side.body]) {
        for (const text of para.lines) {
          this.current.push({ kind: para.kind, text, x: LAYOUT.marginLeft + columnOf(para, text) * LAYOUT.charWidth, y: rowY(row), row, scene: null });
          row += 1;
        }
      }
    }
    this.used = top + pairRows;
    this.placeAtomic(unit.trailer);
  }

  private free(): number {
    return LAYOUT.linesPerPage - this.used;
  }

  private newPage(): void {
    if (this.used > 0) this.done.push(this.current);
    this.current = [];
    this.used = 0;
  }

  /** A blank row is never the first row of a page. */
  private blankRow(): void {
    if (this.used > 0 && this.used < LAYOUT.linesPerPage) this.used += 1;
  }

  private line(kind: LineKind, text: string, col: number, scene: number | null = null, sceneNumber: string | null = null): void {
    // Every caller makes room first. A line past the foot would be a unit broken without its rules.
    if (this.used >= LAYOUT.linesPerPage) throw new Error('paginate: a line was placed past the foot of its page');
    const row = this.used;
    this.used += 1;
    const y = rowY(row);
    this.current.push({ kind, text, x: LAYOUT.marginLeft + col * LAYOUT.charWidth, y, row, scene });
    if (sceneNumber !== null) {
      const width = textColumns(sceneNumber) * LAYOUT.charWidth;
      if (!['off', 'left', 'right', 'both'].includes(this.sceneNumbers)) {
        // A placement the bus gains must be handled here, not printed as off.
        throw new Error(`Unknown scene-number placement: ${String(this.sceneNumbers)}`);
      }
      if (this.sceneNumbers === 'left' || this.sceneNumbers === 'both') {
        this.current.push({ kind: 'sceneNumber', text: sceneNumber, x: LAYOUT.sceneNumberLeftX, y, row: null, scene });
      }
      if (this.sceneNumbers === 'right' || this.sceneNumbers === 'both') {
        const x = LAYOUT.pageWidth - LAYOUT.sceneNumberRightInset - width;
        this.current.push({ kind: 'sceneNumber', text: sceneNumber, x, y, row: null, scene });
      }
    }
  }

  private textLine(para: Para, text: string, first: boolean): void {
    const number = first && para.kind === 'scene' ? para.sceneNumber : null;
    const scene = first && para.kind === 'scene' ? para.sceneIndex : null;
    this.line(para.kind, text, columnOf(para, text), scene, number);
  }

  /** Lines of one paragraph that are known to fit. */
  private placeTexts(para: Para, texts: readonly string[], first: boolean): void {
    texts.forEach((text, i) => this.textLine(para, text, first && i === 0));
  }

  /** Rows of a block, from `from` up to `to`. The walker has made room for them. */
  private placeRows(rows: readonly BlockRow[], from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const row = rows[i];
      if (row === undefined) continue;
      // Only an oversized block reaches the foot here, and it splits at the page edge (a known gap).
      if (this.free() === 0) this.newPage();
      this.textLine(row.para, row.text, false);
    }
  }

  /** A paragraph's lines, opening a new page where they do not fit. Used where no rule of its own applies. */
  private flow(para: Para): void {
    if (para.blankBefore) this.blankRow();
    para.lines.forEach((text, i) => {
      if (this.free() === 0) this.newPage();
      this.textLine(para, text, i === 0);
    });
  }

  private more(): void {
    const col = LAYOUT.indent.dialogue + Math.floor((LAYOUT.width.dialogue - '(MORE)'.length) / 2);
    this.line('more', '(MORE)', col);
  }

  private continuation(cue: Para): void {
    if (!this.continued) return;
    this.line('continued', `${cue.cueName} (CONT'D)`, LAYOUT.indent.character);
  }

  /** Atomic paragraphs move as one when they fit a page; a larger run splits at the page edge without rules. */
  private placeAtomic(paras: readonly Para[]): void {
    if (paras.length === 0) return;
    if (this.used > 0 && rowsOf(paras) > this.free() && rowsOf(paras) <= LAYOUT.linesPerPage) this.newPage();
    for (const para of paras) this.flow(para);
  }

  private placeAction(lead: readonly Para[], para: Para, trailer: readonly Para[]): void {
    if (lead.length > 0) {
      // The heading and the first lines of the action after it land on one page (screenplay.md §5.3).
      const need = rowsOf(lead) + (para.blankBefore ? 1 : 0) + Math.min(para.lines.length, 2);
      if (this.used > 0 && need > this.free()) this.newPage();
      for (const leading of lead) this.flow(leading);
    }
    const reserve = rowsOf(trailer);
    const blank = para.blankBefore && this.used > 0 ? 1 : 0;
    if (para.lines.length + blank + reserve <= this.free()) {
      this.flow(para);
      this.placeAtomic(trailer);
      return;
    }
    // Widow control: never leave a single line at the foot of a page.
    if (this.used > 0 && this.free() - blank < 2) this.newPage();
    if (para.blankBefore) this.blankRow();
    let rest = [...para.lines];
    let first = true;
    while (rest.length > 0) {
      const free = this.free();
      if (free === 0) {
        this.newPage();
        continue;
      }
      // The last chunk carries the trailer with it, so a transition stays with the line before it.
      if (rest.length + reserve <= free) {
        this.placeTexts(para, rest, first);
        this.placeAtomic(trailer);
        return;
      }
      // Leave at least one line for the next page, and never strand a single line there.
      let n = Math.min(rest.length - 1, free);
      if (rest.length - n === 1 && n > 1) n -= 1;
      if (n < 1) {
        this.newPage();
        continue;
      }
      this.placeTexts(para, rest.slice(0, n), first);
      first = false;
      rest = rest.slice(n);
      this.newPage();
    }
  }

  /** Whether the head and some leading rows of a block fit this page, with a sentence end after them. */
  private splittable(head: number, rows: readonly BlockRow[], more: number): boolean {
    return breakIn(rows, 0, this.free() - head - more) !== null;
  }

  private placeDialogue(
    lead: readonly Para[],
    cue: Para,
    parens: readonly Para[],
    items: readonly Para[],
    trailer: readonly Para[],
  ): void {
    const more = this.continued ? 1 : 0;
    // Every printed row after the head. A row splits at a sentence end inside it when the page breaks there.
    const rows: BlockRow[] = [];
    for (const para of items) {
      const speech = para.kind === 'dialogue';
      para.lines.forEach((text, index) => {
        rows.push({ para, text, breakAfter: speech && para.ends[index] === true, cuts: speech ? sentenceCuts(text) : [] });
      });
    }
    const head = rowsOf(lead) + (cue.blankBefore ? 1 : 0) + cue.lines.length + rowsOf(parens);
    // A head this tall leaves no room for the rules, so it is laid as text and the page edge splits it (a known gap).
    if (head + 2 > LAYOUT.linesPerPage) {
      this.placeAtomic([...lead, cue, ...parens, ...items, ...trailer]);
      return;
    }
    const reserve = rowsOf(trailer);
    const whole = head + rows.length + reserve;
    if (this.used > 0 && whole > this.free()) {
      // A cue block with a tail that fits a page moves whole, as an atomic unit would (screenplay.md §5.3).
      const movesWhole = items.length > 1 && whole <= LAYOUT.linesPerPage;
      if (movesWhole || !this.splittable(head, rows, more)) this.newPage();
    }

    for (const para of lead) this.flow(para);
    this.flow(cue);
    for (const para of parens) this.flow(para);

    let at = 0;
    for (;;) {
      const free = this.free();
      if (rows.length - at + reserve <= free) {
        this.placeRows(rows, at, rows.length);
        this.placeAtomic(trailer);
        return;
      }
      const room = free - more;
      const found = breakIn(rows, at, room);
      let next: number;
      if (found === null) {
        // No sentence end fits on this page, so the speech splits mid-sentence (a known gap).
        next = Math.max(at + 1, Math.min(rows.length - 1, at + room));
        if (next >= rows.length) {
          this.placeRows(rows, at, rows.length);
          this.placeAtomic(trailer);
          return;
        }
        this.placeRows(rows, at, next);
      } else if (found.cut === null) {
        next = found.row + 1;
        this.placeRows(rows, at, next);
      } else {
        // The sentence ends inside a row: its first part stays on this page, and the rest opens the next.
        const row = rows[found.row] as BlockRow;
        const first = row.text.slice(0, found.cut);
        const rest = row.text.slice(found.cut).trimStart();
        rows.splice(
          found.row,
          1,
          { para: row.para, text: first, breakAfter: true, cuts: sentenceCuts(first) },
          { para: row.para, text: rest, breakAfter: row.breakAfter, cuts: sentenceCuts(rest) },
        );
        next = found.row + 1;
        this.placeRows(rows, at, next);
      }
      if (this.continued) this.more();
      this.newPage();
      this.continuation(cue);
      at = next;
    }
  }
}

function pick(entries: Readonly<Record<string, string>>, keys: readonly string[], fallback: string | undefined): string {
  for (const key of keys) {
    const value = entries[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return (fallback ?? '').trim();
}

function titleLine(kind: LineKind, text: string, col: number, row: number): LayoutLine {
  return {
    kind,
    text,
    x: LAYOUT.marginLeft + col * LAYOUT.charWidth,
    y: rowY(row),
    row: null,
    scene: null,
  };
}

/** The title page: title centred a third of the way down, credit and author below it, date at the foot. */
function titleLines(entries: Readonly<Record<string, string>>, opts: PaginateOptions): LayoutLine[] {
  const lines: LayoutLine[] = [];
  const title = pick(entries, ['Title'], opts.title);
  let row = 18;
  for (const text of wrap(title, LAYOUT.columns).lines) {
    lines.push(titleLine('title', text, Math.floor((LAYOUT.columns - textColumns(text)) / 2), row));
    row += 1;
  }
  const author = pick(entries, ['Author', 'Authors'], opts.author);
  const credit = pick(entries, ['Credit'], 'by');
  row += 2;
  if (author !== '') {
    lines.push(titleLine('title', credit, Math.floor((LAYOUT.columns - textColumns(credit)) / 2), row));
    row += 2;
    lines.push(titleLine('title', author, Math.floor((LAYOUT.columns - textColumns(author)) / 2), row));
  }
  const date = pick(entries, ['Draft date', 'Date'], opts.date);
  if (date !== '') lines.push(titleLine('title', date, 0, 47));
  return lines;
}

function pageNumberLine(number: number): LayoutLine {
  const text = `${number}.`;
  return {
    kind: 'pageNumber',
    text,
    x: LAYOUT.pageWidth - LAYOUT.marginRight - text.length * LAYOUT.charWidth,
    y: LAYOUT.pageNumberY,
    row: null,
    scene: null,
  };
}

/**
 * Lays out the elements on pages. Pure: the same elements and options always give the same
 * pages. The title page comes first when the source has a title page (the element the
 * Fountain renderer writes from front matter). It is not counted: script pages count from 1,
 * and the number is printed from page 2 (screenplay.md §5.3). The options only fill in what the
 * title page does not carry.
 */
export function paginate(elements: readonly ScreenplayElement[], opts: PaginateOptions = {}): LayoutPage[] {
  const pager = new Pager(opts.continued !== false, opts.sceneNumbers ?? 'off');
  for (const unit of buildUnits(elements)) pager.placeUnit(unit);
  const script = pager.finish();

  const pages: LayoutPage[] = [];
  let number = 1;
  const titleElement = elements.find((el) => el.type === 'title_page');
  const entries = titleElement !== undefined && titleElement.type === 'title_page' ? titleElement.entries : {};
  if (opts.titlePage !== false && titleElement !== undefined) {
    pages.push({ number: 0, kind: 'title', lines: titleLines(entries, opts) });
  }
  for (const lines of script) {
    const all = number >= 2 ? [...lines, pageNumberLine(number)] : [...lines];
    pages.push({ number, kind: 'script', lines: all });
    number += 1;
  }
  return pages;
}

/** The scene lengths of a pagination, in eighths of a page (FDX SceneProperties Length; screenplay.md §5.2). */
export interface SceneLength {
  /** The scene's index among the scene headings. */
  readonly scene: number;
  /** The page its heading lands on. */
  readonly page: number;
  readonly lengthEighths: number;
}

/** Each scene's length from its heading to the next heading (or the end), measured in layout rows. */
export function sceneLengths(pages: readonly LayoutPage[]): SceneLength[] {
  const marks: { scene: number; page: number; row: number }[] = [];
  let scriptPages = 0;
  let end = 0;
  for (const page of pages) {
    if (page.kind !== 'script') continue;
    for (const line of page.lines) {
      if (line.row === null) continue;
      const row = scriptPages * LAYOUT.linesPerPage + line.row;
      if (line.kind === 'scene' && line.scene !== null) marks.push({ scene: line.scene, page: page.number, row });
      end = Math.max(end, row + 1);
    }
    scriptPages += 1;
  }
  return marks.map((mark, i) => {
    const next = marks[i + 1];
    const rows = Math.max(1, (next?.row ?? end) - mark.row);
    return {
      scene: mark.scene,
      page: mark.page,
      lengthEighths: Math.max(1, Math.round((rows / LAYOUT.linesPerPage) * 8)),
    };
  });
}

/** One page is about one minute of screen time. An estimate, not a timing. */
export const MINUTES_PER_PAGE = 1;

/** The page count of a screenplay: the pagination's own count under the spec's constants. */
export function estimatePageCount(elements: readonly ScreenplayElement[], opts?: PaginateOptions): number {
  return paginate(elements, opts).length;
}

/** The screen-time estimate for a page count, at one minute per page. */
export function estimateRuntimeMinutes(pageCount: number): number {
  return pageCount * MINUTES_PER_PAGE;
}
