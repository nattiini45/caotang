/**
 * The contact sheet — [storyboard.md](../../../docs/architecture/storyboard.md) §6, `ContactSheetPdfRenderer`.
 *
 * Two halves, and the split is the point of the module:
 *
 * - The **page plan** is pure. Cards, geometry and text go in; the position of every card, picture,
 *   chip and line of text comes out, in points with the origin at the top left. The plan has all the
 *   structure a contact sheet has (page count, capacity, reading order, what sits inside the page), and
 *   the tests check it directly.
 * - The **emitter** turns a plan into PDF bytes, and this package names no PDF library. The PDF the app and the
 *   MCP server write comes from `@caotang/exporter`'s `contact-sheet-pdf` format, which does not go through
 *   {@link ContactSheetPdfRenderer}: it calls {@link planContactSheet} and draws that plan itself
 *   (`drawContactSheet`, over `pdf-lib`, loaded lazily).
 *   {@link ContactSheetPdfRenderer} takes the emitter as an injected port ({@link ContactSheetEmitter}), and no
 *   package wires one into it today: {@link ContactSheetPdfRenderer.render} refuses without one, and
 *   {@link ContactSheetPdfRenderer.build} works without one, returning the plan and the image bytes an emitter
 *   would be given.
 *
 * {@link planContactSheet} is the plan from the project, with no reads: the caller says which pictures can be
 * drawn. The exporter uses it, because a compile plans synchronously and reads the image bytes later.
 *
 * Each page's header carries the title (from the header template), the page label, and a summary line:
 * the shot count, the animatic total and the shots left out of it for want of a duration (§2.2, the
 * board header's three numbers).
 *
 * Text width is estimated, not measured. Helvetica averages about half an em per character, and the
 * layout uses {@link SHEET_LAYOUT}`.charWidthEm` of 0.55 so a wrapped line stays inside its card. A wide
 * character (Chinese, Japanese kana, Korean Hangul, full-width forms) counts one em
 * ({@link SHEET_LAYOUT}`.wideCharWidthEm`), the width the PDF's CJK font gives it. An estimate that errs wide
 * is the safe error here: it wraps early rather than overflow, and the emitter cuts with the real font.
 *
 * An Arabic letter counts 0.5 em and a Hebrew letter 0.55 em (`arabicCharWidthEm`, `hebrewCharWidthEm`: the averages of Noto Sans Arabic
 * and Noto Sans Hebrew), and a mark of either none, since the PDF leaves marks out. Text wraps in logical order, which is right for
 * both directions; the emitter puts each line in visual order.
 *
 * An emoji is measured, wrapped and cut as one unit however many code points it has (a ZWJ family, a flag, a keycap, a
 * skin tone: `./emoji.ts`), and counts {@link SHEET_LAYOUT}`.emojiWidthEm`, the advance the PDF's emoji font gives it. A line
 * may break between two emoji, as between two Chinese characters, and never inside one.
 *
 * Lines break at spaces, and between two Chinese or Japanese characters, since those scripts put no spaces
 * between words. Korean is written with spaces, so a Hangul word breaks at its spaces, as Latin does. A closing
 * mark (。、，」 and the like) stays on the line before it, and an opening mark (「（ and the like) on the line
 * after it.
 */

import { nodeById, type ArtifactFs, type ProjectState } from '@caotang/store';

import { animaticTotals } from './animatic.js';
import { graphemesOf, isEmojiPicture, isRtlMark, rtlScriptOf } from '@caotang/pdf-fonts';
import { readImage, type LoadedImage } from './assets.js';
import { cardSpecRowOf, durationText, isStoryboardFolder } from './model.js';
import { shotFieldOf } from './nodes.js';
import { exportNumbers, shotsInBinderOrder } from './ordering.js';
import { readShotMeta, storedOf } from './shot-meta.js';
import { ok, refuse, type StoryboardResult } from './result.js';

/** Page sizes in points: A4 and US Letter. */
export const PAGE_SIZES = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
} as const;

export type PageSize = keyof typeof PAGE_SIZES;

/** The layout constants. Exported so a test, or a later layout, reads the numbers the plan was built from. */
export const SHEET_LAYOUT = {
  margin: 36,
  headerHeight: 36,
  gutter: 12,
  columns: 3,
  /** Image height over width: 16:9 landscape cards, the shape a storyboard frame has. */
  imageAspect: 9 / 16,
  /** Text lines of action each card shows. The spec's "action line" is one line; two lines keep a useful excerpt. */
  actionLines: 2,
  /**
   * Text lines of the spec row each card shows. The row is the shot editor's words, about a third longer than the tokens, so it takes
   * two lines at {@link specFontSize}; the longest all-set row fits them on A4 and Letter.
   */
  specLines: 2,
  gap: 4,
  /** The space above the spec row and below the action. Smaller than {@link gap} so the second spec line leaves 15 cards on A4. */
  textGap: 3,
  lineHeight: 10,
  specLineHeight: 8.5,
  chipFontSize: 8,
  specFontSize: 7,
  actionFontSize: 8,
  headerFontSize: 11,
  /** The header's second line: the shot count and the animatic total. */
  summaryFontSize: 8,
  charWidthEm: 0.55,
  /** The width of a wide (East Asian) character, in em: the advance the PDF's CJK font gives it. */
  wideCharWidthEm: 1,
  /** The width of an emoji, however many code points it has, in em: the PDF's emoji font (Noto Emoji) draws it 2600/2048 em across. */
  emojiWidthEm: 1.3,
  /** The average advance of a letter of Noto Sans Arabic, and of Noto Sans Hebrew, in em. A mark of either adds none. */
  arabicCharWidthEm: 0.5,
  hebrewCharWidthEm: 0.55,
  chipHeight: 12,
} as const;

export const ELLIPSIS = '…';

/**
 * Whether a character is wide: drawn one em across, as East Asian scripts are. The ranges cover every Wide and Fullwidth code
 * point of Unicode 15.1's East Asian Width property that is not an emoji (an emoji is measured on its own, wider still), by
 * block: Hangul Jamo, the angle brackets 〈 and 〉 (U+2329, U+232A), the CJK radicals to Yi (with kana, bopomofo and the unified
 * ideographs), Hangul syllables, the compatibility ideographs, the vertical and small forms, the full-width forms, the
 * ideographic symbols, Tangut, Khitan, the kana supplements and Nüshu, the enclosed ideographic supplement, and the
 * supplementary ideographic planes. Taken by block, the ranges also hold a few unassigned or narrow code points; those count
 * wide too, which is the safe error (see the header).
 */
export function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x16fe0 && code <= 0x16fff) ||
    (code >= 0x17000 && code <= 0x18cff) ||
    (code >= 0x18d00 && code <= 0x18d7f) ||
    (code >= 0x1aff0 && code <= 0x1b2ff) ||
    (code >= 0x1f200 && code <= 0x1f2ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Marks that must not start a line: closing brackets and quotes, and the comma, full stop and other marks after a word. */
const NO_LINE_START = new Set([...'、。，．：；！？）」』】〕〉》〗〙〛｝］〟’”・ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ…‥']);
/** Narrow marks that must not start a line when they follow a wide character: `走进茶馆, orders` keeps the comma with 馆. */
const NARROW_NO_LINE_START = new Set([...',.;:!?)]}%']);
/** Marks that must not end a line: opening brackets and quotes. */
const NO_LINE_END = new Set([...'（「『【〔〈《〖〘〚｛［〝‘“']);

/** The estimated advance of one character, in em: Arabic and Hebrew letters at their fonts' averages, their marks at none. */
function charEms(char: string): number {
  const script = rtlScriptOf(char.codePointAt(0) ?? 0);
  if (script !== undefined) return isRtlMark(char) ? 0 : script === 'arabic' ? SHEET_LAYOUT.arabicCharWidthEm : SHEET_LAYOUT.hebrewCharWidthEm;
  return isWide(char) ? SHEET_LAYOUT.wideCharWidthEm : SHEET_LAYOUT.charWidthEm;
}

/** Estimated width of a run of text at a font size. See the header on why this is an estimate. */
export function measureText(text: string, fontSize: number): number {
  let ems = 0;
  for (const cluster of graphemesOf(text)) {
    if (isEmojiPicture(cluster)) ems += SHEET_LAYOUT.emojiWidthEm;
    else for (const char of cluster) ems += charEms(char);
  }
  return ems * fontSize;
}

/** A wrapped line may be this much wider than its box, for floating-point error, and still fit. */
const FIT_EPSILON = 1e-6;

function fits(text: string, maxWidth: number, fontSize: number): boolean {
  return measureText(text, fontSize) <= maxWidth + FIT_EPSILON;
}

/** Hangul: wide, but a Korean word breaks at its spaces, not between its syllables. */
function isHangul(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f) || (code >= 0xa960 && code <= 0xa97f) || (code >= 0xac00 && code <= 0xd7af);
}

/**
 * The pieces a word may break between. A run of other characters is one piece; each Chinese or Japanese character, and each
 * emoji, is a piece of its own, so a line may break between any two of them. A mark that must not start a line joins the
 * piece before it, and one that must not end a line joins the piece after it. The word is read by grapheme cluster, so an
 * emoji sequence or a letter with its marks is never split.
 */
function piecesOf(word: string): string[] {
  const raw: string[] = [];
  let narrow = '';
  for (const char of graphemesOf(word)) {
    if ((isWide(char) && !isHangul(char)) || isEmojiPicture(char) || NO_LINE_START.has(char) || NO_LINE_END.has(char)) {
      if (narrow !== '') raw.push(narrow);
      narrow = '';
      raw.push(char);
    } else {
      narrow += char;
    }
  }
  if (narrow !== '') raw.push(narrow);

  const pieces: string[] = [];
  let carry = '';
  for (const piece of raw) {
    if (NO_LINE_END.has(piece)) {
      carry += piece;
    } else if ((NO_LINE_START.has(piece) || NARROW_NO_LINE_START.has([...piece][0] ?? '')) && pieces.length > 0 && carry === '') {
      appendToLast(pieces, piece);
    } else {
      pieces.push(carry + piece);
      carry = '';
    }
  }
  if (carry !== '') appendToLast(pieces, carry);
  return pieces;
}

/** Joins text onto the last piece, or starts the first piece with it when there is none yet. */
function appendToLast(pieces: string[], text: string): void {
  const last = pieces.pop();
  pieces.push(last === undefined ? text : last + text);
}

/** The longest start of `text` that fits the width, at least one grapheme cluster, so a line always moves on. */
function longestFit(text: string, maxWidth: number, fontSize: number): string {
  const chars = graphemesOf(text);
  let keep = 1;
  while (keep < chars.length && fits(chars.slice(0, keep + 1).join(''), maxWidth, fontSize)) keep += 1;
  return chars.slice(0, keep).join('');
}

/**
 * Wraps text to a width in at most `maxLines` lines. Words wrap on spaces and between wide characters (see the header), a
 * piece longer than a line is broken, and text past the last line is cut with an ellipsis on that line, so a reader sees
 * that more follows. Deterministic: the same text, width and size always give the same lines.
 */
export function wrapText(text: string, maxWidth: number, fontSize: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  const flush = (): void => {
    if (line !== '') lines.push(line);
    line = '';
  };

  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    let joiner = line === '' ? '' : ' ';
    for (const piece of piecesOf(word)) {
      let rest = piece;
      if (fits(`${line}${joiner}${rest}`, maxWidth, fontSize)) {
        line = `${line}${joiner}${rest}`;
      } else {
        flush();
        while (!fits(rest, maxWidth, fontSize)) {
          const head = longestFit(rest, maxWidth, fontSize);
          lines.push(head);
          rest = rest.slice(head.length);
        }
        line = rest;
      }
      joiner = '';
    }
  }
  flush();

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const chars = graphemesOf(kept[maxLines - 1] ?? '');
  while (chars.length > 0 && !fits(`${chars.join('')}${ELLIPSIS}`, maxWidth, fontSize)) chars.pop();
  kept[maxLines - 1] = `${chars.join('')}${ELLIPSIS}`;
  return kept;
}

/** One card's content, before it has a position. */
export interface SheetCard {
  readonly shotId: string;
  readonly shotNumber: number;
  readonly specRow: string;
  readonly action: string;
  /** Whether the image loaded. When false the card draws a placeholder with {@link placeholder}. */
  readonly image: boolean;
  readonly placeholder: string;
}

export interface PlacedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A run of text at a baseline. `y` is the baseline, measured down from the top of the page. */
export interface PlacedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
}

export interface PlacedCard {
  readonly shotId: string;
  readonly shotNumber: number;
  /** The whole card: image, chip, spec row and action lines. */
  readonly frame: PlacedRect;
  /** The image box, or the placeholder box when there is no image. */
  readonly image: PlacedRect;
  readonly hasImage: boolean;
  readonly chip: PlacedRect;
  readonly chipText: PlacedText;
  /** The spec row's lines: none for an empty row, otherwise up to {@link SHEET_LAYOUT}`.specLines`, the last cut with an ellipsis. */
  readonly spec: readonly PlacedText[];
  readonly action: readonly PlacedText[];
  readonly placeholder?: PlacedText;
  /**
   * The placeholder's text and place, present on every card. An emitter that cannot draw a planned picture (its
   * bytes are gone, or the PDF engine cannot read them) draws this instead, so the card is never left blank.
   */
  readonly fallback: PlacedText;
}

export interface SheetPage {
  /** 0-based. */
  readonly index: number;
  readonly title: PlacedText;
  readonly pageLabel: PlacedText;
  /** The header's second line, when the plan was given one: the shot count and the animatic total. */
  readonly summary?: PlacedText;
  readonly cards: readonly PlacedCard[];
  /** Set on the single page of an empty sheet. */
  readonly emptyNote?: PlacedText;
}

export interface SheetGeometry {
  readonly width: number;
  readonly height: number;
  readonly margin: number;
  readonly headerHeight: number;
  readonly gutter: number;
  readonly columns: number;
}

export interface SheetPlan {
  readonly pageSize: PageSize;
  readonly geometry: SheetGeometry;
  readonly cardWidth: number;
  readonly cardHeight: number;
  readonly cardsPerPage: number;
  readonly pages: readonly SheetPage[];
}

export interface PaginateOptions {
  readonly pageSize?: PageSize;
  readonly columns?: number;
  /** The header text, already filled. Cut to one line, and to the room the page label leaves. */
  readonly headerText?: string;
  /** The header's second line, on every page. Cut to one line of the content width. */
  readonly summaryText?: string;
  readonly emptyText?: string;
}

/**
 * The page plan for a list of cards. Cards fill each page row by row, left to right then down, in the
 * order given, which is binder order. A sheet with no cards is one page with a note, not zero pages, so
 * a printed sheet always has something on it.
 */
export function paginate(cards: readonly SheetCard[], options: PaginateOptions = {}): SheetPlan {
  const pageSize = options.pageSize ?? 'A4';
  const size = PAGE_SIZES[pageSize];
  const columns = options.columns ?? SHEET_LAYOUT.columns;
  if (!Number.isInteger(columns) || columns < 1 || columns > 6) {
    throw new Error('contact-sheet columns must be a whole number from 1 to 6');
  }

  const { margin, headerHeight, gutter, textGap, lineHeight, specLineHeight, specLines, actionLines, imageAspect } = SHEET_LAYOUT;
  const geometry: SheetGeometry = { width: size.width, height: size.height, margin, headerHeight, gutter, columns };
  const contentWidth = size.width - 2 * margin;
  const cardWidth = (contentWidth - gutter * (columns - 1)) / columns;
  const imageHeight = cardWidth * imageAspect;
  const cardHeight = imageHeight + textGap + specLines * specLineHeight + actionLines * lineHeight + textGap;
  const contentHeight = size.height - 2 * margin - headerHeight;
  const rows = Math.floor((contentHeight + gutter) / (cardHeight + gutter));
  if (rows < 1) throw new Error('the page is too small for one contact-sheet card at this column count');
  const cardsPerPage = rows * columns;

  const pageCount = Math.max(1, Math.ceil(cards.length / cardsPerPage));
  const headerRoom = contentWidth - 12;
  const pages: SheetPage[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const label = `Page ${index + 1} of ${pageCount}`;
    const labelWidth = measureText(label, SHEET_LAYOUT.headerFontSize);
    const headerLine = wrapText(options.headerText ?? '', Math.max(0, headerRoom - labelWidth), SHEET_LAYOUT.headerFontSize, 1)[0] ?? '';
    const summaryLine =
      options.summaryText === undefined ? undefined : (wrapText(options.summaryText, contentWidth, SHEET_LAYOUT.summaryFontSize, 1)[0] ?? '');
    const page = cards.slice(index * cardsPerPage, (index + 1) * cardsPerPage);
    const placed = page.map((card, slot) => placeCard(card, slot, columns, cardWidth, cardHeight, imageHeight));
    const emptyNote =
      index === 0 && cards.length === 0
        ? {
            text: options.emptyText ?? 'No shots yet.',
            x: margin,
            y: margin + headerHeight + 24,
            fontSize: SHEET_LAYOUT.headerFontSize,
          }
        : undefined;
    pages.push({
      index,
      title: { text: headerLine, x: margin, y: margin + SHEET_LAYOUT.headerFontSize, fontSize: SHEET_LAYOUT.headerFontSize },
      pageLabel: {
        text: label,
        x: size.width - margin - labelWidth,
        y: margin + SHEET_LAYOUT.headerFontSize,
        fontSize: SHEET_LAYOUT.headerFontSize,
      },
      ...(summaryLine === undefined
        ? {}
        : {
            summary: {
              text: summaryLine,
              x: margin,
              y: margin + SHEET_LAYOUT.headerFontSize + 4 + SHEET_LAYOUT.summaryFontSize,
              fontSize: SHEET_LAYOUT.summaryFontSize,
            },
          }),
      cards: placed,
      ...(emptyNote !== undefined ? { emptyNote } : {}),
    });
  }
  return { pageSize, geometry, cardWidth, cardHeight, cardsPerPage, pages };
}

/** Places one card in its slot on a page, and everything inside it. */
function placeCard(
  card: SheetCard,
  slot: number,
  columns: number,
  cardWidth: number,
  cardHeight: number,
  imageHeight: number,
): PlacedCard {
  const { margin, headerHeight, gutter, gap, textGap, lineHeight, specLineHeight, specLines, actionLines, chipFontSize, chipHeight, specFontSize, actionFontSize } = SHEET_LAYOUT;
  const column = slot % columns;
  const row = Math.floor(slot / columns);
  const x = margin + column * (cardWidth + gutter);
  const y = margin + headerHeight + row * (cardHeight + gutter);

  const chipText = String(card.shotNumber);
  const chipWidth = Math.max(14, measureText(chipText, chipFontSize) + 6);
  const specY = y + imageHeight + textGap + specFontSize;
  const actionY = y + imageHeight + textGap + specLines * specLineHeight + actionFontSize;
  const specText = wrapText(card.specRow, cardWidth, specFontSize, specLines);
  const actionText = wrapText(card.action, cardWidth, actionFontSize, actionLines);
  const fallback: PlacedText = {
    text: wrapText(card.placeholder, cardWidth - 2 * gap, actionFontSize, 1)[0] ?? '',
    x: x + gap,
    y: y + imageHeight / 2 + actionFontSize / 2,
    fontSize: actionFontSize,
  };
  const placeholder = card.image ? undefined : fallback;

  return {
    shotId: card.shotId,
    shotNumber: card.shotNumber,
    frame: { x, y, width: cardWidth, height: cardHeight },
    image: { x, y, width: cardWidth, height: imageHeight },
    hasImage: card.image,
    chip: { x: x + gap, y: y + gap, width: chipWidth, height: chipHeight },
    chipText: { text: chipText, x: x + gap + 3, y: y + gap + chipFontSize + 1, fontSize: chipFontSize },
    spec: specText.map((text, index) => ({ text, x, y: specY + index * specLineHeight, fontSize: specFontSize })),
    action: actionText.map((text, index) => ({
      text,
      x,
      y: actionY + index * lineHeight,
      fontSize: actionFontSize,
    })),
    ...(placeholder !== undefined ? { placeholder } : {}),
    fallback,
  };
}

/** The filled template. `{name}` is replaced; a name with no value is left as written, so a typo shows (the exporter's rule). */
export function fillTemplate(pattern: string, values: Readonly<Record<string, string>>): string {
  return pattern.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? (values[name] ?? '') : whole,
  );
}

export interface ContactSheetOptions {
  readonly pageSize?: PageSize;
  readonly columns?: number;
  /** A header template. `{project}`, `{storyboard}` and `{date}` are filled. Defaults to `{storyboard}`. */
  readonly headerTemplate?: string;
  readonly project?: string;
  readonly storyboard?: string;
  /** The date `{date}` shows, as YYYY-MM-DD. Wins over {@link now}; the exporter passes the writer's local day. */
  readonly date?: string;
  /** The moment `{date}` is taken from when no {@link date} is given (its UTC day). Defaults to now. Pass it in tests. */
  readonly now?: Date;
}

/** Whether a planned picture can be drawn, and, when it cannot, the note that says why. */
export type SheetImageStatus = { readonly drawn: true } | { readonly drawn: false; readonly note: string };

/** The plan of a contact sheet, with what it was built from: the notes, and the picture each drawn card points at. */
export interface ContactSheetPlan {
  readonly plan: SheetPlan;
  readonly notes: readonly string[];
  /** Shot id to the asset id of the picture its card draws. Only the cards whose picture {@link SheetImageStatus} said can be drawn. */
  readonly pictures: ReadonlyMap<string, string>;
  /** How many shots the sheet holds. */
  readonly shotCount: number;
}

/**
 * The spec row a contact-sheet card prints: the board's M-size row (§3.1), `shotSize · cameraAngle · cameraMovement ·
 * durationSec s`, with `lens · transition` after it when they are set, in the shot editor's words ({@link cardSpecRowOf}).
 */
export function sheetSpecRowOf(stored: Readonly<Record<string, unknown>>): string {
  return cardSpecRowOf(stored);
}

/**
 * The header's summary line: the shot count, the animatic total, and how many shots are left out of it because they
 * have no duration (§2.2). The board's header says the same three numbers. `selection` is read as a selection, as
 * {@link animaticTotals} reads it: a folder stands for the shots under it, each shot counts once, and an id that is no
 * shot counts for nothing, so the count and the total are always over the same shots.
 */
export function sheetSummaryOf(state: ProjectState, selection: readonly string[]): string {
  const totals = animaticTotals(state, selection);
  const count = totals.timedCount + totals.untimed.length;
  const shots = `${count} ${count === 1 ? 'shot' : 'shots'}`;
  const untimed = totals.untimed.length;
  const left = untimed === 0 ? '' : ` (${untimed} ${untimed === 1 ? 'shot' : 'shots'} without a duration left out)`;
  return `${shots} · ${durationText(totals.seconds)} s of animatic${left}`;
}

/**
 * The plan of a contact sheet from the project, with no reads. `imageStatus` says, for each asset id a shot names,
 * whether its picture can be drawn; a card whose picture cannot be drawn shows its caption (`imageAlt`), or "No image",
 * and the note is kept once per asset. Cards are the shots under the selection in binder order, numbered 1 to n as the
 * shot list numbers them.
 */
export function planContactSheet(
  state: ProjectState,
  selection: readonly string[] | undefined,
  imageStatus: (assetId: string) => SheetImageStatus,
  options: ContactSheetOptions = {},
): ContactSheetPlan {
  const notes: string[] = [];
  for (const id of selection ?? []) {
    if (nodeById(state, id) === undefined) notes.push(`no node "${id}" in the project, so nothing was drawn for it`);
  }

  const shots = shotsInBinderOrder(state, selection);
  const numbers = exportNumbers(shots);
  const pictures = new Map<string, string>();
  const statuses = new Map<string, SheetImageStatus>();
  const cards: SheetCard[] = [];

  for (const node of shots) {
    const read = readShotMeta(shotFieldOf(node));
    const assetId = read.meta.image;
    let hasImage = false;
    if (assetId !== undefined) {
      let status = statuses.get(assetId);
      if (status === undefined) {
        status = imageStatus(assetId);
        statuses.set(assetId, status);
        if (!status.drawn) notes.push(status.note);
      }
      if (status.drawn) {
        hasImage = true;
        pictures.set(node.id, assetId);
      }
    }
    cards.push({
      shotId: node.id,
      shotNumber: numbers.get(node.id) ?? 0,
      specRow: sheetSpecRowOf(storedOf(shotFieldOf(node)) ?? {}),
      action: read.meta.action ?? '',
      image: hasImage,
      placeholder: read.meta.imageAlt ?? 'No image',
    });
  }

  const storyboardName = options.storyboard ?? storyboardNameOf(state, selection, shots);
  const date = options.date ?? (options.now ?? new Date()).toISOString().slice(0, 10);
  const headerText = fillTemplate(options.headerTemplate ?? '{storyboard}', {
    project: options.project ?? '',
    storyboard: storyboardName,
    date,
  });

  const plan = paginate(cards, {
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.columns !== undefined ? { columns: options.columns } : {}),
    headerText,
    summaryText: sheetSummaryOf(
      state,
      shots.map((node) => node.id),
    ),
  });
  return { plan, notes, pictures, shotCount: shots.length };
}

/**
 * The name `{storyboard}` fills: the one storyboard folder the selection names, else the one storyboard every shot sits in,
 * else "All shots".
 */
function storyboardNameOf(state: ProjectState, selection: readonly string[] | undefined, shots: readonly { readonly parentId: string | null }[]): string {
  const single = selection?.length === 1 && selection[0] !== undefined ? nodeById(state, selection[0]) : undefined;
  if (single !== undefined && isStoryboardFolder(single)) return single.title;
  const parents = new Set(shots.map((node) => node.parentId));
  if (parents.size === 1) {
    const [parentId] = [...parents];
    const parent = parentId === null || parentId === undefined ? undefined : nodeById(state, parentId);
    if (parent !== undefined && isStoryboardFolder(parent)) return parent.title;
  }
  return 'All shots';
}

/** What an emitter is given: the plan, and the image bytes its cards point at. */
export interface ContactSheetDocument {
  readonly plan: SheetPlan;
  readonly images: ReadonlyMap<string, LoadedImage>;
  readonly notes: readonly string[];
}

/** The PDF port of {@link ContactSheetPdfRenderer}. Nothing in this module names a library, and no package wires one in today (see the header). */
export interface ContactSheetEmitter {
  emit(document: ContactSheetDocument): Promise<Uint8Array>;
}

/** The contact sheet renderer, as the exporter's recipe names it. The emitter is optional by design (see the header). */
export class ContactSheetPdfRenderer {
  readonly id = 'contact-sheet-pdf';
  readonly mime = 'application/pdf';

  constructor(private readonly emitter?: ContactSheetEmitter) {}

  /**
   * The plan and the images, with no PDF. Works without an emitter, so the layout can be seen and
   * tested before the library is chosen.
   */
  async build(
    fs: ArtifactFs,
    state: ProjectState,
    selection?: readonly string[],
    options: ContactSheetOptions = {},
  ): Promise<ContactSheetDocument> {
    const images = new Map<string, LoadedImage>();
    for (const node of shotsInBinderOrder(state, selection)) {
      const assetId = readShotMeta(shotFieldOf(node)).meta.image;
      if (assetId === undefined || images.has(assetId)) continue;
      const loaded = await readImage(fs, assetId);
      if (loaded !== undefined) images.set(assetId, loaded);
    }
    const planned = planContactSheet(
      state,
      selection,
      (assetId) =>
        images.has(assetId)
          ? { drawn: true }
          : { drawn: false, note: `image ${assetId} could not be read from assets/, so its cards draw a placeholder` },
      options,
    );
    return { plan: planned.plan, images, notes: planned.notes };
  }

  /** The PDF bytes, when an emitter is wired. Refused with the reason otherwise, never a silent empty file. */
  async render(
    fs: ArtifactFs,
    state: ProjectState,
    selection?: readonly string[],
    options: ContactSheetOptions = {},
  ): Promise<StoryboardResult<{ readonly bytes: Uint8Array; readonly pages: number; readonly notes: readonly string[] }>> {
    if (this.emitter === undefined) {
      return refuse(
        'pdf-engine-not-wired',
        'the contact sheet is laid out, but no PDF engine is wired into this renderer: compile the contact-sheet-pdf format through the exporter, which draws the PDF itself.',
      );
    }
    const document = await this.build(fs, state, selection, options);
    const bytes = await this.emitter.emit(document);
    return ok({ bytes, pages: document.plan.pages.length, notes: document.notes });
  }
}
