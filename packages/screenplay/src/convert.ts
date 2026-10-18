/**
 * Line conversion for the Source tab's element menu ([screenplay.md §3](../../../docs/architecture/screenplay.md), the element
 * palette). The writer picks an element for the line the caret is on, and the line is rewritten in that element's Fountain
 * syntax. The body stays raw Fountain: nothing here adds a node type or a command, and the edit is ordinary text.
 *
 * The rules follow the serialiser's doctrine (serialise.ts): a line is forced (`.`, `!`, `@`, `>`) only where the parser would
 * read it as something else, and the answer comes from the parser itself. Each candidate line is parsed in place, and the
 * first one the parser reads as the chosen element is the edit.
 *
 * The line's words are kept. Only the markup of its current element is taken off (a forcing character, the brackets of a
 * parenthetical or a note, the `>` and `<` of a centered line), and the markup of the new element is put on. A heading, a
 * cue and a transition start a block, so a blank line is put above one that sits under text. An action line, a centered line
 * and a page break under a dialogue block get a blank line too, or the block would read them as dialogue.
 */

import { isSceneHeadingText } from './classify.js';
import { parseFountain } from './parse.js';
import type { LocatedElement, ScreenplayElementType } from './types.js';

/** The elements the menu offers, in the order it lists them. */
export const LINE_ELEMENT_TYPES = [
  'scene_heading',
  'action',
  'character',
  'parenthetical',
  'dialogue',
  'transition',
  'centered',
  'note',
  'page_break',
] as const;

export type LineElementType = (typeof LINE_ELEMENT_TYPES)[number];

/** The text after a conversion, and where the caret goes in it. */
export interface LineConversion {
  readonly text: string;
  readonly caret: number;
}

interface LineSpan {
  readonly start: number;
  readonly end: number;
}

/** The start and end offsets of the line `offset` is on. The end is the offset of its newline, or the text's end. */
function lineAt(text: string, offset: number): LineSpan {
  const at = Math.max(0, Math.min(offset, text.length));
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const newline = text.indexOf('\n', at);
  return { start, end: newline === -1 ? text.length : newline };
}

const ANNOTATIONS: ReadonlySet<ScreenplayElementType> = new Set(['note', 'boneyard']);

/**
 * The element the line at `start` belongs to. A text element on the line wins over an annotation on it, so `Anna waits.
 * [[later]]` is action. An annotation is the line's element only when it is the whole line.
 */
function elementOn(elements: readonly LocatedElement[], line: LineSpan, raw: string): LocatedElement | undefined {
  const covering = elements.filter(
    (element) => element.range.from <= line.start && line.start < Math.max(element.range.to, element.range.from + 1),
  );
  const starting = elements.filter((element) => element.range.from > line.start && element.range.from < line.end);
  const all = [...covering, ...starting];
  // A paragraph is read across an annotation (parse.ts), so the action around a note line covers it too: the note wins.
  if (wholeAnnotation(raw.trim()) !== null) {
    const whole = all.find((element) => ANNOTATIONS.has(element.type) && element.range.from >= line.start);
    if (whole !== undefined) return whole;
  }
  return all.find((element) => !ANNOTATIONS.has(element.type)) ?? all[0];
}

/** The text inside a note or a boneyard that is the whole line, or `null` when the line is not one. */
function wholeAnnotation(t: string): string | null {
  const note = /^\[\[((?:(?!\]\]).)*)\]\]$/.exec(t);
  if (note !== null) return (note[1] ?? '').trim();
  const bone = /^\/\*((?:(?!\*\/).)*)\*\/$/.exec(t);
  if (bone !== null) return (bone[1] ?? '').trim();
  return null;
}

/**
 * The element of the line the caret is on, as the parser reads it, or `null` for a blank line, a line of the title page,
 * and a line inside an annotation that runs over several lines.
 */
export function lineElementAt(text: string, caret: number): ScreenplayElementType | null {
  const line = lineAt(text, caret);
  const raw = text.slice(line.start, line.end);
  if (raw.trim() === '') return null;
  const element = elementOn(parseFountain(text).elements, line, raw);
  if (element === undefined || element.type === 'title_page') return null;
  if (ANNOTATIONS.has(element.type) && wholeAnnotation(raw.trim()) === null) return null;
  return element.type;
}

/** The line's words with the markup of its element taken off, and whether it was a dual cue. `null`: not convertible. */
function contentOf(raw: string, type: ScreenplayElementType | null): { readonly words: string; readonly dual: boolean } | null {
  const t = raw.trim();
  switch (type) {
    case null:
      return { words: t, dual: false };
    case 'scene_heading':
      return { words: /^\.(?!\.)/.test(t) ? t.slice(1).trim() : t, dual: false };
    case 'action':
      return { words: t.startsWith('!') ? t.slice(1).trim() : t, dual: false };
    case 'character': {
      let words = t.startsWith('@') ? t.slice(1).trim() : t;
      const dual = words.endsWith('^');
      if (dual) words = words.slice(0, -1).trimEnd();
      return { words, dual };
    }
    case 'parenthetical':
      return { words: t.replace(/^\(/, '').replace(/\)$/, '').trim(), dual: false };
    case 'dialogue':
      return { words: t, dual: false };
    case 'transition':
      return { words: t.startsWith('>') ? t.slice(1).trim() : t, dual: false };
    case 'centered':
      return { words: t.replace(/^>/, '').replace(/<$/, '').trim(), dual: false };
    case 'page_break':
      return { words: '', dual: false };
    case 'section':
      return { words: t.replace(/^#+/, '').trim(), dual: false };
    case 'synopsis':
      return { words: t.replace(/^=/, '').trim(), dual: false };
    case 'note':
    case 'boneyard': {
      const inner = wholeAnnotation(t);
      return inner === null ? null : { words: inner, dual: false };
    }
    case 'title_page':
      return null;
  }
}

/** A way to write a line: the markup before the words and the markup after them. */
interface Form {
  readonly before: string;
  readonly after: string;
}

/** The forms of an element, plainest first. A plain form is tried only while there are words, since an empty line is blank. */
function formsOf(target: LineElementType, words: string, dual: boolean): readonly Form[] {
  const hasWords = words !== '';
  switch (target) {
    case 'scene_heading':
      return hasWords && isSceneHeadingText(words) ? [{ before: '', after: '' }, { before: '.', after: '' }] : [{ before: '.', after: '' }];
    case 'action':
      return hasWords ? [{ before: '', after: '' }, { before: '!', after: '' }] : [{ before: '!', after: '' }];
    case 'character': {
      const after = dual ? ' ^' : '';
      return hasWords ? [{ before: '', after }, { before: '@', after }] : [{ before: '@', after }];
    }
    case 'parenthetical':
      return [{ before: '(', after: ')' }];
    case 'dialogue':
      return [{ before: '', after: '' }];
    case 'transition':
      return hasWords ? [{ before: '', after: '' }, { before: '>', after: '' }] : [{ before: '>', after: '' }];
    case 'centered':
      return [{ before: '> ', after: ' <' }];
    case 'note':
      return [{ before: '[[', after: ']]' }];
    case 'page_break':
      return [{ before: '===', after: '' }];
  }
}

const BLOCK_TYPES: ReadonlySet<ScreenplayElementType> = new Set(['character', 'parenthetical', 'dialogue']);

/**
 * Whether a blank line goes above the converted line. A heading, a cue and a transition start a block (fountain.io), so they
 * get one under any text. Action, a centered line and a page break need one only under a dialogue block, which would read
 * them as dialogue. A note is transparent, and a parenthetical and dialogue belong to the block above them.
 */
function needsBlankAbove(target: LineElementType, above: ScreenplayElementType | null): boolean {
  if (above === null) return false;
  switch (target) {
    case 'scene_heading':
    case 'character':
    case 'transition':
      return true;
    case 'action':
    case 'centered':
    case 'page_break':
      return BLOCK_TYPES.has(above);
    default:
      return false;
  }
}

/** A letter the parser reads as words, put where the words go while a form is checked on an empty line. */
const PROBE = 'x';

/**
 * Rewrites the line the caret is on as `target`. The result keeps the line's words and puts the caret after them (inside
 * the brackets of a parenthetical, a note or a centered line). A line already of that element is returned unchanged. On a
 * line with words, a page break goes on a line of its own above it, and the line itself is kept as it is.
 *
 * `null` when the line cannot be that element where it stands: dialogue or a parenthetical away from a cue, a line of the
 * title page, or a line inside an annotation that runs over several lines.
 */
export function convertLine(text: string, caret: number, target: LineElementType): LineConversion | null {
  const line = lineAt(text, caret);
  const raw = text.slice(line.start, line.end);
  const current = raw.trim() === '' ? null : lineElementAt(text, caret);
  if (raw.trim() !== '' && current === null) return null;
  if (current === target) return { text, caret };
  const content = contentOf(raw, current);
  if (content === null) return null;

  const above = line.start === 0 ? null : aboveElement(text, line.start - 1);
  const gap = needsBlankAbove(target, above) ? '\n' : '';
  const head = text.slice(0, line.start) + gap;
  const tail = text.slice(line.end);
  const at = head.length;

  if (target === 'page_break' && content.words !== '') {
    // The words stay on their line, as they are, and the break goes on a line of its own above them.
    const next = `${head}===\n${raw}${tail}`;
    if (!readsAs(next, at, 'page_break')) return null;
    return { text: next, caret: caret + gap.length + 4 };
  }

  for (const form of formsOf(target, content.words, content.dual)) {
    const probe = content.words === '' && target !== 'page_break' ? PROBE : content.words;
    if (!readsAs(`${head}${form.before}${probe}${form.after}${tail}`, at, target)) continue;
    const written = `${form.before}${content.words}${form.after}`;
    return { text: `${head}${written}${tail}`, caret: at + form.before.length + content.words.length };
  }
  return null;
}

/** The element of the line that ends at `end`, or `null` when that line is blank. */
function aboveElement(text: string, end: number): ScreenplayElementType | null {
  const line = lineAt(text, end);
  const raw = text.slice(line.start, line.end);
  if (raw.trim() === '') return null;
  return elementOn(parseFountain(text).elements, line, raw)?.type ?? 'action';
}

/** Whether the parser reads the line that starts at `start` as `type`. */
function readsAs(text: string, start: number, type: LineElementType): boolean {
  const line = lineAt(text, start);
  return elementOn(parseFountain(text).elements, line, text.slice(line.start, line.end))?.type === type;
}
