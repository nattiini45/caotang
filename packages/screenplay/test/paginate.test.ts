import { describe, expect, it } from 'vitest';
import {
  LAYOUT,
  PAGE_GEOMETRY,
  estimatePageCount,
  estimateRuntimeMinutes,
  paginate,
  parseFountain,
  sceneLengths,
  textColumns,
  type LayoutLine,
  type LayoutPage,
} from '../src/index.js';
import { SCENE_FILE, SCRIPT_ONE_ACT, SCRIPT_WITH_TITLE_PAGE, text } from './fixtures/corpus.js';

/** Deterministic pseudo-random numbers, so every generated script is the same on every run. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const WORDS = [
  'the', 'lamp', 'turns', 'slowly', 'over', 'grey', 'water', 'and', 'she', 'waits', 'for', 'someone',
  'who', 'never', 'comes', 'back', 'home', 'again', 'silence', 'fills', 'room', 'a', 'door', 'opens',
  'wide', 'letter', 'arrives', 'late', 'night', 'rain',
];

function sentence(r: () => number, min: number, max: number): string {
  const n = min + Math.floor(r() * (max - min + 1));
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(r() * WORDS.length)] ?? 'the');
  const s = words.join(' ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

interface Generated {
  readonly text: string;
  /** How often the generator wrote each case the page-break rules cover (screenplay.md §5.3). */
  readonly cases: { readonly tails: number; readonly headingBreaks: number; readonly transitionsAfterBreaks: number };
}

/**
 * A script of scenes: action, cued dialogue (some split by length), parentheticals, transitions,
 * cue blocks with a tail (a parenthetical after the first dialogue, then a long speech), a forced
 * break under a heading, and a transition straight after a forced break.
 */
function generated(seed: number, scenes: number): Generated {
  const r = rng(seed);
  const blocks: string[] = [];
  const cases = { tails: 0, headingBreaks: 0, transitionsAfterBreaks: 0 };
  for (let s = 0; s < scenes; s++) {
    blocks.push(`INT. ROOM ${s} - ${r() < 0.5 ? 'DAY' : 'NIGHT'}`);
    if (r() < 0.15) {
      blocks.push('===');
      cases.headingBreaks += 1;
    }
    const beats = 2 + Math.floor(r() * 5);
    for (let b = 0; b < beats; b++) {
      const roll = r();
      if (roll < 0.35) {
        blocks.push(Array.from({ length: 1 + Math.floor(r() * 3) }, () => sentence(r, 4, 14)).join(' '));
      } else if (roll < 0.7) {
        const parts = [r() < 0.5 ? 'ANNA' : 'MARCUS (V.O.)'];
        if (r() < 0.3) parts.push('(quietly)');
        parts.push(Array.from({ length: 1 + Math.floor(r() * 6) }, () => sentence(r, 6, 22)).join(' '));
        blocks.push(parts.join('\n'));
      } else if (roll < 0.8) {
        const speech = Array.from({ length: 4 + Math.floor(r() * 26) }, () => sentence(r, 8, 24));
        blocks.push(['ANNA', sentence(r, 4, 10), '(beat)', ...speech].join('\n'));
        cases.tails += 1;
      } else if (roll < 0.9) {
        blocks.push('CUT TO:');
      } else {
        blocks.push('===', 'CUT TO:');
        cases.transitionsAfterBreaks += 1;
      }
    }
    blocks.push(sentence(r, 4, 10));
  }
  return { text: `${blocks.join('\n\n')}\n`, cases };
}

const scriptPages = (pages: readonly LayoutPage[]): LayoutPage[] => pages.filter((page) => page.kind === 'script');

/** The printed body lines of a script page, in order: margin numbers and page numbers excluded. */
function body(page: LayoutPage): LayoutLine[] {
  return page.lines.filter((line) => line.row !== null);
}

const SENTENCE_END = /[.!?…]["')\]”’]*$/;
const isSpeech = (kind: string | undefined): boolean => kind === 'dialogue' || kind === 'parenthetical';

/**
 * The page-break rules of screenplay.md §5.3, checked on every page of a pagination. Each
 * assertion names the rule it enforces. A block that crosses a page is checked on both sides of
 * the break: (MORE) closes the first page and CONT'D opens the next, and no speech crosses bare.
 */
function expectPageBreakRules(pages: readonly LayoutPage[]): void {
  const script = scriptPages(pages);
  script.forEach((page, index) => {
    const lines = body(page);
    lines.forEach((line, i) => {
      const next = lines[i + 1];
      const prev = lines[i - 1];
      // A scene heading is never the last text on a page.
      if (line.kind === 'scene') expect(next, `scene heading at foot of page ${page.number}`).toBeDefined();
      // A cue is never separated from its first line of dialogue; a continued cue the same.
      if (line.kind === 'character' || line.kind === 'continued') {
        expect(['dialogue', 'parenthetical'], `cue "${line.text}" on page ${page.number}`).toContain(next?.kind);
      }
      // A parenthetical stays with its cue, and may follow dialogue inside the same block.
      if (line.kind === 'parenthetical') {
        expect(['character', 'continued', 'dialogue', 'parenthetical'], `parenthetical on page ${page.number}`).toContain(
          prev?.kind,
        );
      }
      // (MORE) is the last row of its page, after dialogue that ends a sentence.
      if (line.kind === 'more') {
        expect(i, `(MORE) is the last row of page ${page.number}`).toBe(lines.length - 1);
        expect(prev?.kind, `(MORE) follows dialogue on page ${page.number}`).toBe('dialogue');
        expect(prev?.text, `(MORE) follows a sentence end on page ${page.number}`).toMatch(SENTENCE_END);
      }
    });
    // A transition never starts a page after the first.
    if (index > 0) expect(lines[0]?.kind, `page ${page.number} top`).not.toBe('transition');
    // A block that crosses the foot of a page is marked on both sides.
    const following = script[index + 1];
    if (following !== undefined) {
      const foot = lines[lines.length - 1]?.kind;
      const top = body(following)[0]?.kind;
      if (foot === 'more') expect(top, `(MORE) on page ${page.number} is followed by CONT'D`).toBe('continued');
      if (top === 'continued') expect(foot, `CONT'D atop page ${following.number} follows (MORE)`).toBe('more');
      expect(isSpeech(foot) && isSpeech(top), `speech crosses from page ${page.number} to ${following.number} with no mark`).toBe(
        false,
      );
    }
  });
}

describe('paginate — the layout constants (screenplay.md §5.3)', () => {
  it('refuses an unknown scene-number placement instead of printing it as off', () => {
    const elements = parseFountain('INT. ROOM - DAY #1#\n\nAction.\n').elements;
    const bogus = { sceneNumbers: 'middle' } as unknown as Parameters<typeof paginate>[1];
    expect(() => paginate(elements, bogus)).toThrow(/Unknown scene-number placement: middle/);
  });

  it('derives the lines per page and the text width from the spec margins', () => {
    expect(LAYOUT.linesPerPage).toBe(54);
    expect(LAYOUT.columns).toBe(60);
    expect(LAYOUT.marginLeft + LAYOUT.columns * LAYOUT.charWidth + LAYOUT.marginRight).toBe(LAYOUT.pageWidth);
  });

  it('places cues, dialogue and parentheticals at their indents and the transition flush right', () => {
    const page = scriptPages(paginate(parseFountain(SCENE_FILE).elements))[0];
    const at = (kind: string): LayoutLine | undefined => page?.lines.find((line) => line.kind === kind);
    expect(at('scene')?.x).toBe(LAYOUT.marginLeft);
    expect(at('character')?.x).toBeCloseTo(LAYOUT.marginLeft + 22 * LAYOUT.charWidth, 5);
    expect(at('parenthetical')?.x).toBeCloseTo(LAYOUT.marginLeft + 16 * LAYOUT.charWidth, 5);
    expect(at('dialogue')?.x).toBeCloseTo(LAYOUT.marginLeft + 10 * LAYOUT.charWidth, 5);
    const transition = at('transition');
    expect((transition?.x ?? 0) + (transition?.text.length ?? 0) * LAYOUT.charWidth).toBeCloseTo(
      LAYOUT.pageWidth - LAYOUT.marginRight,
      5,
    );
  });

  it('keeps dialogue in its column when a note sits between the cue and the speech', () => {
    const lines = scriptPages(paginate(parseFountain(text('ANNA', '[[production note]]', 'Hi there.')).elements))[0]?.lines ?? [];
    expect(lines.find((line) => line.text === 'Hi there.')).toMatchObject({ kind: 'dialogue' });
    expect(lines.find((line) => line.text === 'Hi there.')?.x).toBeCloseTo(LAYOUT.marginLeft + 10 * LAYOUT.charWidth, 5);
    expect(lines.some((line) => line.text.includes('production note'))).toBe(false);
  });

  it('prints a note between two action lines without a gap, so the paragraph stays whole', () => {
    const rows = body(scriptPages(paginate(parseFountain(text('Before.', '[[note]]', 'After.')).elements))[0] as LayoutPage);
    // One paragraph, wrapped as one: the note leaves no blank row and no second paragraph.
    expect(rows.map((line) => [line.text, line.row])).toEqual([['Before. After.', 0]]);
  });
});

describe('paginate — the page-break rules (screenplay.md §5.3)', () => {
  it('keeps every page-break rule on generated scripts with tails, forced breaks and transitions after them', () => {
    const totals = { splits: 0, afterDialogue: 0, tails: 0, headingBreaks: 0, transitionsAfterBreaks: 0 };
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { text: source, cases } = generated(seed, 30);
      const pages = paginate(parseFountain(source).elements);
      expectPageBreakRules(pages);
      totals.tails += cases.tails;
      totals.headingBreaks += cases.headingBreaks;
      totals.transitionsAfterBreaks += cases.transitionsAfterBreaks;
      for (const page of scriptPages(pages)) {
        const rows = body(page);
        totals.splits += rows.filter((line) => line.kind === 'more').length;
        totals.afterDialogue += rows.filter((line, i) => line.kind === 'parenthetical' && rows[i - 1]?.kind === 'dialogue').length;
      }
    }
    // Every case the rules cover must occur in the input and in the output, or the checks prove nothing about it.
    expect(totals.tails).toBeGreaterThan(0);
    expect(totals.headingBreaks).toBeGreaterThan(0);
    expect(totals.transitionsAfterBreaks).toBeGreaterThan(0);
    expect(totals.splits).toBeGreaterThan(0);
    expect(totals.afterDialogue).toBeGreaterThan(0);
  });

  it('splits long dialogue after a sentence end, with (MORE) and the continued cue on the next page', () => {
    // 25 one-line action paragraphs fill 49 rows; the cue group then has 5 rows and the
    // speech is six full-width sentences, so it must split after the second.
    const filler = Array.from({ length: 25 }, (_, i) => `Filler ${i}.`).join('\n\n');
    const sentences = Array.from({ length: 6 }, () => `${'w'.repeat(34)}.`).join(' ');
    const pages = paginate(parseFountain(`${filler}\n\nANNA\n${sentences}\n`).elements);
    const [first, second] = scriptPages(pages);
    const firstKinds = body(first as LayoutPage).map((line) => line.kind);
    expect(firstKinds.slice(-4)).toEqual(['character', 'dialogue', 'dialogue', 'more']);
    expect(body(second as LayoutPage).slice(0, 5).map((line) => [line.kind, line.text])).toEqual([
      ['continued', "ANNA (CONT'D)"],
      ['dialogue', 'w'.repeat(34) + '.'],
      ['dialogue', 'w'.repeat(34) + '.'],
      ['dialogue', 'w'.repeat(34) + '.'],
      ['dialogue', 'w'.repeat(34) + '.'],
    ]);
    expectPageBreakRules(pages);
  });

  it('moves a cue group whole to the next page when dialogue has no sentence end to split at', () => {
    const filler = Array.from({ length: 25 }, (_, i) => `Filler ${i}.`).join('\n\n');
    const unbroken = Array.from({ length: 6 }, () => 'w'.repeat(35)).join(' ');
    const pages = paginate(parseFountain(`${filler}\n\nANNA\n${unbroken}\n`).elements);
    expect(scriptPages(pages)).toHaveLength(2);
    const onFirst = body(scriptPages(pages)[0] as LayoutPage).map((line) => line.kind);
    expect(onFirst).not.toContain('character');
    expect(onFirst).not.toContain('more');
    expect(body(scriptPages(pages)[1] as LayoutPage)[0]).toMatchObject({ kind: 'character', text: 'ANNA' });
    expectPageBreakRules(pages);
  });

  it('writes no (MORE) and no continued cue when the continued option is off', () => {
    const filler = Array.from({ length: 25 }, (_, i) => `Filler ${i}.`).join('\n\n');
    const sentences = Array.from({ length: 6 }, () => `${'w'.repeat(34)}.`).join(' ');
    const pages = paginate(parseFountain(`${filler}\n\nANNA\n${sentences}\n`).elements, { continued: false });
    const kinds = pages.flatMap((page) => body(page).map((line) => line.kind));
    expect(kinds).not.toContain('more');
    expect(kinds).not.toContain('continued');
  });

  it('starts a new page at a page break and never leaves the break on a page of its own', () => {
    const pages = paginate(parseFountain(text('Action.', '', '===', '', 'More action.')).elements);
    expect(scriptPages(pages)).toHaveLength(2);
    expect(body(scriptPages(pages)[1] as LayoutPage)[0]).toMatchObject({ kind: 'action', text: 'More action.' });
  });

  it('moves a scene heading with the action after it, rather than leaving the heading at the foot', () => {
    // 26 one-line actions leave three rows; a heading, its blank row and two action lines need five.
    const filler = Array.from({ length: 26 }, (_, i) => `Beat ${i}.`).join('\n\n');
    const action = `${'x'.repeat(60)} ${'y'.repeat(60)}`;
    const pages = paginate(parseFountain(`${filler}\n\nINT. ROOM - DAY\n\n${action}\n`).elements);
    const [first, second] = scriptPages(pages);
    expect(body(first as LayoutPage).at(-1)).toMatchObject({ kind: 'action', text: 'Beat 25.' });
    expect(body(second as LayoutPage)[0]).toMatchObject({ kind: 'scene', text: 'INT. ROOM - DAY' });
    expectPageBreakRules(pages);
  });

  it('moves a scene heading with the cue after it when the cue group does not fit', () => {
    const filler = Array.from({ length: 26 }, (_, i) => `Beat ${i}.`).join('\n\n');
    const pages = paginate(parseFountain(`${filler}\n\nINT. ROOM - DAY\n\nANNA\n${'w'.repeat(35)}\n`).elements);
    const [first, second] = scriptPages(pages);
    expect(body(first as LayoutPage).some((line) => line.kind === 'scene')).toBe(false);
    expect(body(second as LayoutPage)[0]).toMatchObject({ kind: 'scene' });
    expectPageBreakRules(pages);
  });

  it('never starts a page with a transition, which stays with the element before it', () => {
    // 26 one-line actions leave the page with 51 rows; the last action and its transition need 4.
    const filler = Array.from({ length: 26 }, (_, i) => `Beat ${i}.`).join('\n\n');
    const pages = paginate(parseFountain(`${filler}\n\nCUT TO:\n`).elements);
    expectPageBreakRules(pages);
    const second = scriptPages(pages)[1];
    expect(second === undefined || body(second)[0]?.kind !== 'transition').toBe(true);
  });

  it('keeps a scene heading above a forced break with the element after the break, not at the foot', () => {
    // 26 one-line actions leave the page with 51 rows, so a heading would be the last text on it.
    const filler = Array.from({ length: 26 }, (_, i) => `Beat ${i}.`).join('\n\n');
    const pages = paginate(parseFountain(`${filler}\n\nINT. ROOM - DAY\n\n===\n\nAction.\n`).elements);
    const [first, second] = scriptPages(pages);
    expect(body(first as LayoutPage).at(-1)).toMatchObject({ kind: 'action', text: 'Beat 25.' });
    expect(body(second as LayoutPage).map((line) => [line.kind, line.text])).toEqual([
      ['scene', 'INT. ROOM - DAY'],
      ['action', 'Action.'],
    ]);
    expectPageBreakRules(pages);
  });

  it('moves a transition after a forced break back before the break, so it does not open the page', () => {
    const pages = paginate(parseFountain(text('Action one.', '', '===', '', 'CUT TO:', '', 'Action two.')).elements);
    const [first, second] = scriptPages(pages);
    expect(body(first as LayoutPage).map((line) => line.kind)).toEqual(['action', 'transition']);
    expect(body(second as LayoutPage).map((line) => [line.kind, line.text])).toEqual([['action', 'Action two.']]);
    expectPageBreakRules(pages);
  });

  it('lays a cue block with a tail whole when it fits a page, and keeps every line of its speech', () => {
    // 14 actions leave 27 rows; a cue, one line, a parenthetical and a 30-line speech need 34.
    const filler = Array.from({ length: 14 }, (_, i) => `Beat ${i}.`).join('\n\n');
    const speech = Array.from({ length: 30 }, () => `${'w'.repeat(34)}.`);
    const pages = paginate(parseFountain(`${filler}\n\nANNA\nOne line.\n(beat)\n${speech.join('\n')}\n`).elements);
    const [first, second] = scriptPages(pages);
    expect(body(first as LayoutPage).some((line) => line.kind === 'character')).toBe(false);
    expect(body(second as LayoutPage)[0]).toMatchObject({ kind: 'character', text: 'ANNA' });
    expect(scriptPages(pages).flatMap((page) => body(page)).some((line) => line.kind === 'more')).toBe(false);
    expectPageBreakRules(pages);
    const dialogue = scriptPages(pages).flatMap((page) => body(page).filter((line) => line.kind === 'dialogue').map((line) => line.text));
    expect(dialogue.join(' ')).toBe(`One line. ${speech.join(' ')}`);
  });

  it('splits a cue block with a tail only at sentence ends, with (MORE) and CONT\'D, and never mid-sentence', () => {
    // A cue, a line, a parenthetical, then a speech longer than a page: the block must split inside the speech.
    const speech = Array.from({ length: 70 }, (_, i) => `Sentence ${i} is ${'w'.repeat(20)}.`);
    const pages = paginate(parseFountain(`ANNA\nOne line.\n(beat)\n${speech.join(' ')}\n`).elements);
    expect(scriptPages(pages).length).toBeGreaterThan(1);
    expectPageBreakRules(pages);
    const kinds = scriptPages(pages).flatMap((page) => body(page).map((line) => line.kind));
    expect(kinds).toContain('more');
    expect(kinds).toContain('continued');
    expect(scriptPages(pages).flatMap((page) => body(page).filter((line) => line.kind === 'dialogue').map((line) => line.text)).join(' ')).toBe(
      `One line. ${speech.join(' ')}`,
    );
  });

  it('splits the 30-sentence speech of a tailed cue block that begins mid-page, with (MORE) and CONT\'D, and loses no words', () => {
    // Ten actions, then a cue, one line, a parenthetical and thirty sentences of two rows or more each: the block cannot fit a page.
    const filler = Array.from({ length: 10 }, (_, i) => `Beat ${i}.`).join('\n\n');
    const speech = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here, and it runs on a little further than that.`);
    const pages = paginate(parseFountain(`${filler}\n\nANNA\nOne line.\n(beat)\n${speech.join(' ')}\n`).elements);
    expectPageBreakRules(pages);
    const kinds = scriptPages(pages).flatMap((page) => body(page).map((line) => line.kind));
    expect(kinds).toContain('more');
    expect(kinds).toContain('continued');
    expect(scriptPages(pages).flatMap((page) => body(page).filter((line) => line.kind === 'dialogue').map((line) => line.text)).join(' ')).toBe(
      `One line. ${speech.join(' ')}`,
    );
  });

  it('splits a speech inside a wrapped row, after a sentence end that falls mid-line, and loses no words', () => {
    // Short sentences pack several to a row, so no row ends a sentence: the split falls inside a row.
    const speech = Array.from({ length: 300 }, (_, i) => `Short ${i % 10}.`).join(' ');
    const pages = paginate(parseFountain(`ANNA\n${speech}\n`).elements);
    expect(scriptPages(pages).length).toBeGreaterThan(1);
    expectPageBreakRules(pages);
    expect(scriptPages(pages).flatMap((page) => body(page).filter((line) => line.kind === 'more')).length).toBeGreaterThan(0);
    expect(scriptPages(pages).flatMap((page) => body(page).filter((line) => line.kind === 'dialogue').map((line) => line.text)).join(' ')).toBe(
      speech,
    );
  });

  it('keeps a transition after a long speech with the last line of it, and never lets the speech run past a page', () => {
    const speech = Array.from({ length: 60 }, () => `${'w'.repeat(34)}.`);
    const pages = paginate(parseFountain(`ANNA\n${speech.join('\n')}\n\nCUT TO:\n`).elements);
    expectPageBreakRules(pages);
    const last = body(scriptPages(pages).at(-1) as LayoutPage);
    expect(last.at(-1)).toMatchObject({ kind: 'transition', text: 'CUT TO:' });
    expect(scriptPages(pages).flatMap((page) => body(page).filter((line) => line.kind === 'dialogue')).length).toBe(60);
  });
});

describe('paginate — the title page and page numbers (screenplay.md §5.3)', () => {
  /** The title-page script with enough action after it to fill a second script page. */
  const twoPages = `${SCRIPT_WITH_TITLE_PAGE}\n\n${Array.from({ length: 40 }, (_, i) => `More action ${i}.`).join('\n\n')}\n`;

  it('lays out a title page from the title_page entries, not counted and unnumbered', () => {
    const pages = paginate(parseFountain(SCRIPT_WITH_TITLE_PAGE).elements);
    const [title, script] = pages;
    expect(title).toMatchObject({ number: 0, kind: 'title' });
    const titleText = (title?.lines ?? []).map((line) => line.text);
    expect(titleText).toEqual(expect.arrayContaining(['The Lighthouse Keeper', 'Written by', 'N. Attini', '2026-10-08']));
    expect(title?.lines.some((line) => line.kind === 'pageNumber')).toBe(false);
    // The first script page is page 1 after a title page too, as in every screenplay.
    expect(script).toMatchObject({ number: 1, kind: 'script' });
    expect(script?.lines.some((line) => line.kind === 'pageNumber')).toBe(false);
  });

  it('numbers script pages from page 2 at the top right, as "n."', () => {
    const pages = paginate(parseFountain(twoPages).elements);
    expect(pages.map((page) => page.number)).toEqual([0, 1, 2]);
    const number = pages[2]?.lines.find((line) => line.kind === 'pageNumber');
    expect(number).toMatchObject({ text: '2.', y: 46 });
    expect(number?.x).toBeCloseTo(LAYOUT.pageWidth - LAYOUT.marginRight - 2 * LAYOUT.charWidth, 5);
  });

  it('numbers the script pages the same with the title page on or off', () => {
    const on = paginate(parseFountain(twoPages).elements).filter((page) => page.kind === 'script');
    const off = paginate(parseFountain(twoPages).elements, { titlePage: false });
    expect(on.map((page) => page.number)).toEqual(off.map((page) => page.number));
  });

  it('leaves the title page out when the option is off, so the first page is script page 1', () => {
    const pages = paginate(parseFountain(SCRIPT_WITH_TITLE_PAGE).elements, { titlePage: false });
    expect(pages[0]).toMatchObject({ number: 1, kind: 'script' });
    expect(pages[0]?.lines.some((line) => line.kind === 'pageNumber')).toBe(false);
  });
});

describe('paginate — dual dialogue side by side (screenplay.md §2.2)', () => {
  const PAIR = text('INT. HALL - DAY', '', 'ANNA', 'I go left.', '', 'BEN ^', '(quietly)', 'I go right.');

  it('lays the two speakers in two columns that start on the same row', () => {
    const [page] = paginate(parseFountain(PAIR).elements);
    const lines = page?.lines ?? [];
    const anna = lines.find((line) => line.text === 'ANNA');
    const ben = lines.find((line) => line.text === 'BEN');
    expect(anna?.row).toBe(ben?.row);
    expect(anna?.x).toBeCloseTo(LAYOUT.marginLeft + LAYOUT.dual.left.character * LAYOUT.charWidth, 5);
    expect(ben?.x).toBeCloseTo(LAYOUT.marginLeft + LAYOUT.dual.right.character * LAYOUT.charWidth, 5);
    const left = lines.find((line) => line.text === 'I go left.');
    const paren = lines.find((line) => line.text === '(quietly)');
    const right = lines.find((line) => line.text === 'I go right.');
    expect(left?.row).toBe((anna?.row ?? 0) + 1);
    expect(paren?.row).toBe(left?.row);
    expect(right?.row).toBe((paren?.row ?? 0) + 1);
    expect(left?.x).toBeCloseTo(LAYOUT.marginLeft + LAYOUT.dual.left.dialogue * LAYOUT.charWidth, 5);
    expect(right?.x).toBeCloseTo(LAYOUT.marginLeft + LAYOUT.dual.right.dialogue * LAYOUT.charWidth, 5);
  });

  it('gives the two columns of a pair the same row numbers, and leaves the blank rows out of the lines', () => {
    const long = 'Every word of this speech is here to make it wrap onto several rows of its column.';
    const [page] = paginate(parseFountain(text('INT. HALL - DAY', '', 'ANNA', long, '', 'BEN ^', 'Short.')).elements);
    const lines = (page?.lines ?? []).filter((line) => line.row !== null);
    const rightStart = LAYOUT.marginLeft + LAYOUT.dual.right.dialogue * LAYOUT.charWidth;
    const left = lines.filter((line) => line.kind !== 'scene' && line.x < rightStart - 1e-9);
    const right = lines.filter((line) => line.x >= rightStart - 1e-9);
    const rowsOf = (side: readonly LayoutLine[]): number[] => side.map((line) => line.row ?? -1);
    // The control: the left speech wraps onto more rows than the right, and both start on the same row.
    expect(left.length).toBeGreaterThan(right.length);
    expect(rowsOf(right)).toEqual(rowsOf(left).slice(0, right.length));
    expect(new Set(rowsOf(left)).size).toBe(left.length);
    // The heading's row, a blank row, then the pair: the blank row is a gap in the numbers, with no line in it.
    const rows = lines.map((line) => line.row ?? -1);
    expect(Math.min(...rowsOf(right))).toBe(2);
    expect(rows).not.toContain(1);
    expect((page?.lines ?? []).every((line) => line.text.trim() !== '')).toBe(true);
  });

  it('wraps each column to its own width, so the columns never overlap, cues and parentheticals included', () => {
    const long = 'Every word of this speech is here to make it wrap onto several rows of its column.';
    // Cue names long enough to wrap: 25 characters each, one with no space to break at.
    const leftCue = 'ANNA-MARIA VON HOHENSTEIN';
    const rightCue = 'BARTHOLOMEWJONATHANSMYTHE';
    const source = text(leftCue, '(a long aside, to make it wrap)', long, '', `${rightCue} ^`, '(a long aside, to make it wrap)', long);
    const [page] = paginate(parseFountain(source).elements);
    const lines = (page?.lines ?? []).filter((line) => ['character', 'parenthetical', 'dialogue'].includes(line.kind));
    const column = (line: LayoutLine): number => Math.round((line.x - LAYOUT.marginLeft) / LAYOUT.charWidth);
    const rightStart = LAYOUT.dual.right.dialogue;
    const left = lines.filter((line) => column(line) < rightStart);
    const right = lines.filter((line) => column(line) >= rightStart);
    // Control: both sides hold every kind, so the checks below cannot pass over an empty side.
    for (const side of [left, right]) {
      expect(side.filter((line) => line.kind === 'character').length).toBeGreaterThan(1);
      expect(side.filter((line) => line.kind === 'parenthetical').length).toBeGreaterThan(1);
      expect(side.filter((line) => line.kind === 'dialogue').length).toBeGreaterThan(2);
    }
    expect(left.filter((line) => line.kind === 'character').map((line) => line.text).join(' ')).toBe(leftCue);
    expect(right.filter((line) => line.kind === 'character').map((line) => line.text).join('')).toBe(rightCue);
    const gutter = LAYOUT.dual.left.dialogue + LAYOUT.dual.width.dialogue;
    for (const line of left) {
      const end = column(line) + textColumns(line.text);
      // No left line reaches the right column; its dialogue and parentheticals end before the gutter.
      expect(end, line.text).toBeLessThanOrEqual(rightStart);
      if (line.kind !== 'character') expect(end, line.text).toBeLessThanOrEqual(gutter);
      if (line.kind === 'dialogue') expect(column(line), line.text).toBe(LAYOUT.dual.left.dialogue);
    }
    for (const line of right) {
      // Every right line starts at its own indent and ends inside the right margin.
      expect(column(line), line.text).toBe(LAYOUT.dual.right[line.kind as 'character' | 'parenthetical' | 'dialogue']);
      expect(column(line) + textColumns(line.text), line.text).toBeLessThanOrEqual(LAYOUT.columns);
      expect(line.x + textColumns(line.text) * LAYOUT.charWidth).toBeLessThanOrEqual(LAYOUT.pageWidth - LAYOUT.marginRight + 1e-9);
    }
  });

  it('rewraps a word broken at the column edge without a space inside it', () => {
    // 40 characters with no space: wider than the 35-column dialogue, so the first wrap breaks it after 35, and the dual
    // column rewraps the speech to 27 from the text the lines join back to.
    const word = 'https://example.org/a-long-unbroken-path';
    expect(word).toHaveLength(40);
    const [page] = paginate(parseFountain(text('ANNA', 'Hi.', '', 'BEN ^', `See ${word} now.`)).elements);
    const rightStart = LAYOUT.marginLeft + LAYOUT.dual.right.dialogue * LAYOUT.charWidth;
    const right = (page?.lines ?? []).filter((line) => line.kind === 'dialogue' && line.x >= rightStart - 1e-9);
    // The word is broken at 27 only; a space after its 35th character would have pushed "path" onto the third row apart.
    expect(right.map((line) => line.text)).toEqual(['See', word.slice(0, 27), `${word.slice(27)} now.`]);
  });

  it('a cue marked ^ with no block before it is an ordinary cue', () => {
    const [page] = paginate(parseFountain(text('Action.', '', 'BEN ^', 'Alone.')).elements);
    expect(page?.lines.find((line) => line.text === 'BEN')?.x).toBeCloseTo(LAYOUT.marginLeft + LAYOUT.indent.character * LAYOUT.charWidth, 5);
  });

  it('moves a pair that does not fit the foot of a page to the next page whole', () => {
    const filler = Array.from({ length: 26 }, (_, i) => `Filler ${i}.`);
    const pages = paginate(parseFountain(text(...filler.flatMap((line) => [line, '']), 'ANNA', 'One, and two, and three, and then a long while of nothing at all, before the end.', '', 'BEN ^', 'Four.')).elements);
    expect(pages).toHaveLength(2);
    const second = pages[1]?.lines ?? [];
    expect(second.map((line) => line.text)).toEqual(expect.arrayContaining(['ANNA', 'BEN', 'Four.']));
    expect(pages[0]?.lines.some((line) => line.text === 'ANNA')).toBe(false);
  });

  it('lays a pair taller than a page as two blocks in sequence, split by the dialogue rules', () => {
    const speech = Array.from({ length: 70 }, (_, i) => `Sentence ${i} of a very long speech.`).join(' ');
    const pages = paginate(parseFountain(text('ANNA', speech, '', 'BEN ^', 'Short.')).elements);
    const lines = pages.flatMap((page) => page.lines);
    expect(lines.find((line) => line.text === 'ANNA')?.x).toBeCloseTo(LAYOUT.marginLeft + LAYOUT.indent.character * LAYOUT.charWidth, 5);
    expect(lines.some((line) => line.kind === 'more')).toBe(true);
    expect(lines.find((line) => line.text === 'BEN')?.x).toBeCloseTo(LAYOUT.marginLeft + LAYOUT.indent.character * LAYOUT.charWidth, 5);
  });

  it('keeps a transition after a pair with the pair', () => {
    const pages = paginate(parseFountain(text(PAIR, '', 'CUT TO:')).elements);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.lines.at(-1)).toMatchObject({ kind: 'transition', text: 'CUT TO:' });
  });
});

describe('paginate — scene numbers, lengths and estimates', () => {
  it('prints an existing scene number, and a running count where there is none, in the chosen margins', () => {
    const pages = paginate(parseFountain(text('INT. HALL - DAY #24A#', '', 'Action.', '', 'EXT. YARD - NIGHT', '', 'Action.')).elements, {
      sceneNumbers: 'both',
    });
    const numbers = pages.flatMap((page) => page.lines.filter((line) => line.kind === 'sceneNumber'));
    expect(numbers.map((line) => line.text)).toEqual(['24A', '24A', '2', '2']);
    const headings = pages.flatMap((page) => page.lines.filter((line) => line.kind === 'scene'));
    expect(headings.map((line) => line.text)).toEqual(['INT. HALL - DAY', 'EXT. YARD - NIGHT']);
  });

  it.each(['Letter', 'A4'] as const)('ends a page number at the text block and a right-margin scene number a quarter inch past it, inside the %s page', (paper) => {
    const { pageWidth } = PAGE_GEOMETRY[paper];
    const heading = (number: string): string => text(`INT. HALL - DAY #${number}#`, '', 'Action.');
    for (const number of ['7', '24A', '124A', '1234']) {
      const pages = paginate(parseFountain(heading(number)).elements, { sceneNumbers: 'right' });
      const [line] = pages.flatMap((page) => page.lines.filter((l) => l.kind === 'sceneNumber'));
      expect(line?.text).toBe(number);
      const end = (line?.x ?? 0) + number.length * LAYOUT.charWidth;
      expect(end).toBeCloseTo(558, 5);
      // Inside the page on both papers. The edge is 558 for every length, so only a number of one or two characters starts right of the block's 540.
      if (number.length <= 2) expect(line?.x ?? 0).toBeGreaterThan(540);
      expect(end).toBeLessThanOrEqual(pageWidth);
    }
    const left = paginate(parseFountain(heading('24A')).elements, { sceneNumbers: 'left' });
    expect(left.flatMap((page) => page.lines).find((l) => l.kind === 'sceneNumber')?.x).toBe(54);
    const pages = paginate(parseFountain(generated(5, 30).text).elements);
    const numbered = pages.flatMap((page) => page.lines.filter((l) => l.kind === 'pageNumber'));
    expect(numbered.length).toBeGreaterThan(0);
    for (const line of numbered) expect(line.x + line.text.length * LAYOUT.charWidth).toBeCloseTo(540, 5);
  });

  it('puts the text block at the same place on both papers, and the extra height of A4 below it', () => {
    expect(LAYOUT.textRight).toBe(LAYOUT.marginLeft + LAYOUT.columns * LAYOUT.charWidth);
    for (const geometry of Object.values(PAGE_GEOMETRY)) {
      expect(geometry.pageWidth - geometry.marginRight).toBeCloseTo(LAYOUT.textRight, 5);
      expect(geometry.pageHeight - geometry.marginBottom - LAYOUT.marginTop).toBeCloseTo(LAYOUT.linesPerPage * LAYOUT.lineHeight, 5);
    }
    expect(PAGE_GEOMETRY.Letter).toMatchObject({ pageWidth: LAYOUT.pageWidth, pageHeight: LAYOUT.pageHeight, marginRight: LAYOUT.marginRight, marginBottom: LAYOUT.marginBottom });
    expect(PAGE_GEOMETRY.A4).toMatchObject({ pageWidth: 595.28, pageHeight: 841.89 });
  });

  it('prints no scene numbers unless asked', () => {
    const pages = paginate(parseFountain(SCRIPT_ONE_ACT).elements);
    expect(pages.flatMap((page) => page.lines).some((line) => line.kind === 'sceneNumber')).toBe(false);
  });

  it('measures each scene in eighths of a page, at least one eighth', () => {
    const lengths = sceneLengths(paginate(parseFountain(generated(7, 12).text).elements));
    expect(lengths).toHaveLength(12);
    for (const length of lengths) expect(length.lengthEighths).toBeGreaterThanOrEqual(1);
  });

  it('estimates the page count as the pagination count, and screen time at one minute a page', () => {
    const elements = parseFountain(generated(3, 20).text).elements;
    expect(estimatePageCount(elements)).toBe(paginate(elements).length);
    expect(estimateRuntimeMinutes(3)).toBe(3);
  });
});
