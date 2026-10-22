import { describe, expect, it } from 'vitest';
import { paginate, parseFountain, type LayoutLine, type LayoutPage } from '../src/index.js';
import { SCRIPT_WITH_TITLE_PAGE } from './fixtures/corpus.js';

const GENERATED = ['more', 'continued', 'pageNumber', 'sceneNumber', 'title'];

/** Every line of every page. */
function linesOf(pages: readonly LayoutPage[]): LayoutLine[] {
  return pages.flatMap((page) => page.lines);
}

/** The text a range holds, in the form a layout line can be found in: case and white space do not count. */
function norm(text: string): string {
  return text.toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function sliceOf(source: string, line: LayoutLine): string {
  if (line.source === null) throw new Error(`no source on ${line.text}`);
  return source.slice(line.source.from, line.source.to);
}

/** Generated lines have no range, and the range of every other line slices back to text that holds it. */
function expectMapped(source: string, pages: readonly LayoutPage[]): void {
  for (const line of linesOf(pages)) {
    if (GENERATED.includes(line.kind)) {
      expect(line.source, `${line.kind} ${line.text}`).toBeNull();
    } else {
      expect(norm(sliceOf(source, line)), line.text).toContain(norm(line.text));
    }
  }
}

function parsed(source: string, opts: Parameters<typeof paginate>[1] = {}): LayoutPage[] {
  return paginate(parseFountain(source).elements, opts);
}

/** A sentence about as long as a row and a half of dialogue, numbered so each is its own text. */
const sentence = (n: number): string => `Sentence number ${n} says something fairly long about the lamp and the sea.`;

function unlocated(source: string) {
  return parseFountain(source).elements.map((el) => {
    const { range: _range, ...rest } = el;
    return rest;
  });
}

describe('LayoutLine.source (screenplay.md §5.3)', () => {
  it('maps a heading, a wrapped action, a cue and its speech to their elements, forcing characters included', () => {
    const action = 'A long action line that surely wraps over the sixty columns of the action width, and then some more words follow it.';
    const source = ['.int. hall - day', '', action, '', '@anna', '(softly)', 'Hello there.', '', '> CUT TO:'].join('\n');
    const lines = linesOf(parsed(source));
    expect(lines.filter((line) => line.source !== null).map((line) => [line.kind, sliceOf(source, line)])).toEqual([
      ['scene', '.int. hall - day'],
      ['action', action],
      ['action', action],
      ['character', '@anna'],
      ['parenthetical', '(softly)'],
      ['dialogue', 'Hello there.'],
      ['transition', '> CUT TO:'],
    ]);
    expectMapped(source, parsed(source));
  });

  it('leaves the title page, the page numbers and the scene numbers without a range', () => {
    const pages = parsed(SCRIPT_WITH_TITLE_PAGE, { sceneNumbers: 'both' });
    expect(pages[0]?.kind).toBe('title');
    expect(pages[0]?.lines.every((line) => line.source === null)).toBe(true);
    const numbers = linesOf(pages).filter((line) => line.kind === 'sceneNumber');
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.every((line) => line.source === null)).toBe(true);
    expectMapped(SCRIPT_WITH_TITLE_PAGE, pages);
  });

  it("keeps a speech split by (MORE) and (CONT'D) on its own range, and the generated lines out of it", () => {
    const speech = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
    const source = ['INT. HALL - DAY', '', 'ANNA', speech].join('\n');
    const pages = parsed(source);
    expect(pages.length).toBeGreaterThan(1);
    const kinds = linesOf(pages).map((line) => line.kind);
    expect(kinds).toContain('more');
    expect(kinds).toContain('continued');
    const start = source.indexOf(speech);
    const dialogue = linesOf(pages).filter((line) => line.kind === 'dialogue');
    expect(new Set(dialogue.map((line) => JSON.stringify(line.source)))).toEqual(new Set([JSON.stringify({ from: start, to: start + speech.length })]));
    // NAME (CONT'D) is generated text, so it maps nowhere; the real cue maps to its line.
    const cue = linesOf(pages).filter((line) => line.kind === 'character');
    expect(cue).toHaveLength(1);
    expect(sliceOf(source, cue[0] as LayoutLine)).toBe('ANNA');
    expectMapped(source, pages);
  });

  it('keeps a split speech on its own range when (MORE) is off', () => {
    const speech = Array.from({ length: 40 }, (_, i) => sentence(i)).join(' ');
    const source = ['INT. HALL - DAY', '', 'ANNA', speech].join('\n');
    const pages = parsed(source, { continued: false });
    expect(linesOf(pages).some((line) => line.kind === 'more')).toBe(false);
    expectMapped(source, pages);
  });

  it('never maps the right column of a dual pair into the left one', () => {
    const speech = 'I go left, and this line is long enough to wrap in its narrow column, for sure.';
    const source = ['INT. HALL - DAY', '', 'ANNA', '(softly)', speech, '', 'BEN ^', 'I go right.'].join('\n');
    const lines = linesOf(parsed(source)).filter((line) => line.kind !== 'scene');
    const left = lines.filter((line) => line.x < 200);
    const right = lines.filter((line) => line.x >= 200);
    expect(right.map((line) => sliceOf(source, line))).toEqual(['BEN ^', 'I go right.']);
    expect(left.map((line) => sliceOf(source, line)).slice(0, 3)).toEqual(['ANNA', '(softly)', speech]);
    expect(new Set(left.slice(2).map((line) => sliceOf(source, line)))).toEqual(new Set([speech]));
    expectMapped(source, parsed(source));
  });

  it('maps the lines after a forced page break to the elements after it', () => {
    const source = ['INT. HALL - DAY', '', 'Before.', '', '===', '', 'After.'].join('\n');
    const pages = parsed(source);
    expect(pages.map((page) => page.lines.filter((line) => line.source !== null).map((line) => sliceOf(source, line)))).toEqual([
      ['INT. HALL - DAY', 'Before.'],
      ['After.'],
    ]);
  });

  it('maps a parenthetical with no cue, which lays out as action', () => {
    const source = ['INT. HALL - DAY', '', 'ANNA', '(softly)', 'One.', '', '(oops)'].join('\n');
    expectMapped(source, parsed(source));
  });

  it('leaves every line unmapped for elements that were not located', () => {
    const lines = linesOf(paginate(unlocated('INT. HALL - DAY\n\nHello.')));
    expect(lines.map((line) => line.source)).toEqual([null, null]);
  });

  it('lays out the same pages with or without the ranges', () => {
    const strip = (pages: readonly LayoutPage[]) => pages.map((page) => ({ ...page, lines: page.lines.map(({ source: _source, ...line }) => line) }));
    expect(strip(paginate(parseFountain(SCRIPT_WITH_TITLE_PAGE).elements))).toEqual(strip(paginate(unlocated(SCRIPT_WITH_TITLE_PAGE))));
  });
});
