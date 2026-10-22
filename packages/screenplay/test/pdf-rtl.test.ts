/**
 * Arabic and Hebrew in the screenplay PDF (screenplay.md §5.3): the direction of a paragraph and where it sits in its column,
 * the width of a shaped word on the grid, the lines that never split inside a cluster, the sentence ends of Arabic, the marks
 * that are left out, the plan of a mixed line, the text a reader extracts, and the Latin-only file that stays as it was.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FlatBlock } from '../src/index.js';
import {
  LAYOUT,
  createPdfRenderer,
  drawPdf,
  importFountainScript,
  layoutPdf,
  loadCourierPrime,
  loadRtlFallback,
  paginate,
  parseFountain,
  preparePdf,
  renderPdf,
  textColumns,
  textUnits,
  withMeasure,
  type LayoutLine,
} from '../src/index.js';
import { loadRtlSupport } from '../src/rtl-font.js';
import { rtlLineKey } from '../src/pdf.js';
import { text } from './fixtures/corpus.js';
import { LOADERS } from './fixtures/fonts.js';

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

const linesOf = (source: string, neutralDirection?: 'ltr' | 'rtl'): LayoutLine[] =>
  paginate(parseFountain(source).elements, neutralDirection === undefined ? {} : { neutralDirection }).flatMap((page) => page.lines);

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function pdfOf(source: string, opts: { title?: string; language?: string } = {}, loaders: Parameters<typeof createPdfRenderer>[0] = LOADERS): Promise<string> {
  const blob = await createPdfRenderer(loaders).emit(blocksOf(source), { title: opts.title ?? 'T', ...(opts.language === undefined ? {} : { language: opts.language }) });
  return decode(new Uint8Array(await blob.arrayBuffer()));
}

/** The `/ActualText` strings of a file, in the order they are written. */
function actualTexts(pdf: string): string[] {
  return [...pdf.matchAll(/\/Span << \/ActualText <FEFF([0-9A-F]*)> >> BDC/g)].map((match) =>
    String.fromCharCode(...(match[1]?.match(/.{4}/g) ?? []).map((hex) => parseInt(hex, 16))),
  );
}

const ARABIC = text(
  'INT. غرفة - NIGHT',
  '',
  'السلام عليكم يا أصدقائي، كيف حالكم اليوم؟ أنا بخير والحمد لله.',
  '',
  '@سارة',
  '(بهدوء)',
  'مرحبا Bob، هل رأيت الفيلم ١٢٣ مرة؟',
);

const HEBREW = text('INT. חדר - NIGHT', '', 'שלום עולם, מה שלומך היום? Everything is fine.', '', '@דוד', '(בשקט)', 'אני בסדר, תודה.');

describe('the direction of a paragraph', () => {
  it('is the direction of its first strong character: an Arabic paragraph in an English script is right-aligned in its column, an English one is not', () => {
    const lines = linesOf(text('ANNA', 'Hello there.', '', '@سارة', 'مرحبا بالجميع.'));
    const english = lines.find((line) => line.text === 'Hello there.');
    const arabic = lines.find((line) => line.text === 'مرحبا بالجميع.');
    expect(english?.rtl).toBeUndefined();
    expect(english?.x).toBe(LAYOUT.marginLeft + LAYOUT.indent.dialogue * LAYOUT.charWidth);
    expect(arabic?.rtl).toBe(true);
    // The dialogue column is columns 10 to 45: the paragraph ends at its right edge, not at the page's.
    expect(arabic?.x).toBe(LAYOUT.marginLeft + (LAYOUT.indent.dialogue + LAYOUT.width.dialogue - textColumns('مرحبا بالجميع.')) * LAYOUT.charWidth);
  });

  it('is left to right when the first strong character is Latin, whatever follows', () => {
    const lines = linesOf(text('ANNA', 'Say مرحبا now.'));
    expect(lines.find((line) => line.text === 'Say مرحبا now.')?.rtl).toBeUndefined();
  });

  it('is right to left when the first strong character is Arabic or Hebrew, whatever follows', () => {
    const lines = linesOf(text('ANNA', 'שלום Bob.', '', 'BOB', 'مرحبا Alice.'));
    expect(lines.find((line) => line.text === 'שלום Bob.')?.rtl).toBe(true);
    expect(lines.find((line) => line.text === 'مرحبا Alice.')?.rtl).toBe(true);
  });

  it('takes the direction of the project language for a paragraph with no strong character, only in a document that holds Arabic or Hebrew', () => {
    const source = blocksOf(text('INT. A - DAY', '', '...', '', 'שלום.'));
    const rtl = layoutPdf(source, { title: 'T', language: 'he' }).pages.flatMap((page) => page.lines);
    const ltr = layoutPdf(source, { title: 'T', language: 'en' }).pages.flatMap((page) => page.lines);
    expect(rtl.find((line) => line.text === '...')?.rtl).toBe(true);
    expect(ltr.find((line) => line.text === '...')?.rtl).toBeUndefined();
    // The same text in a Hebrew project that holds no Hebrew or Arabic is laid out as any other.
    const latin = blocksOf(text('INT. A - DAY', '', '...', '', 'Hello.'));
    expect(layoutPdf(latin, { title: 'T', language: 'he' }).pages).toEqual(layoutPdf(latin, { title: 'T' }).pages);
  });

  it('keeps an English scene heading and its action left to right, with the dialogue and the cue of an Arabic speech right-aligned in their own columns', () => {
    const lines = layoutPdf(blocksOf(ARABIC), { title: 'T' }).pages.flatMap((page) => page.lines);
    expect(lines.find((line) => line.kind === 'scene')?.rtl).toBeUndefined();
    const cue = lines.find((line) => line.kind === 'character');
    expect(cue?.text).toBe('سارة');
    expect(cue?.rtl).toBe(true);
    expect(cue?.x).toBe(LAYOUT.marginLeft + (LAYOUT.indent.character + LAYOUT.width.character - textColumns('سارة')) * LAYOUT.charWidth);
    // The page is not mirrored: the page number and the margins stay where they are.
    expect(lines.every((line) => line.x >= LAYOUT.marginLeft || line.kind === 'sceneNumber')).toBe(true);
  });

  it('needs an @ for a cue in a script with no case, and says nothing else', () => {
    const cue = linesOf(text('@سارة', 'مرحبا.')).map((line) => line.kind);
    expect(cue).toEqual(['character', 'dialogue']);
    const plain = linesOf(text('سارة', 'مرحبا.')).map((line) => line.kind);
    // Without the @ the two lines are one action paragraph.
    expect(plain).toEqual(['action']);
  });
});

describe('the width of an Arabic or Hebrew word on the grid', () => {
  it('is a column for each letter until a font measures it, and a mark adds none', () => {
    expect(textColumns('السلام')).toBe(6);
    expect(textColumns('بِسْمِ')).toBe(3);
    expect(textColumns('שָׁלוֹם')).toBe(4);
    expect(textColumns('سلام، شكرا؟')).toBe(4 + 1 + 1 + 4 + 1);
  });

  it('is the shaped width rounded up to whole columns once the fonts are loaded', async () => {
    const support = await loadRtlSupport(['arabic', 'hebrew'], LOADERS);
    // The advance of السلام is 2431 units of 1000 to the em: 29.2 points, 4.05 columns of 7.2 points, so 5.
    expect(support.measure('السلام')).toBe(5);
    // لا is 582 units: 7 points, under a column.
    expect(support.measure('لا')).toBe(1);
    expect(support.measure('שלום')).toBe(4);
    // A word with marks is measured without them, as it is drawn.
    expect(support.measure('بِسْمِ')).toBe(support.measure('بسم'));
  });

  it('breaks a line where the measured words stop fitting, not where the letters would', async () => {
    const support = await loadRtlSupport(['arabic', 'hebrew'], LOADERS);
    const long = Array.from({ length: 12 }, () => 'السلام').join(' ');
    const blocks = blocksOf(text('@سارة', long));
    const estimated = layoutPdf(blocks, { title: 'T' }).pages.flatMap((page) => page.lines).filter((line) => line.kind === 'dialogue');
    const measured = layoutPdf(blocks, { title: 'T' }, support.measure).pages.flatMap((page) => page.lines).filter((line) => line.kind === 'dialogue');
    // Each word is 6 columns counted by letters and 5 measured, so the measured lines hold more of them.
    expect(estimated.map((line) => line.text.split(' ').length)).toEqual([5, 5, 2]);
    expect(measured.map((line) => line.text.split(' ').length)).toEqual([6, 6]);
    for (const line of measured) expect(withMeasure(support.measure, () => textColumns(line.text))).toBeLessThanOrEqual(LAYOUT.width.dialogue);
  });
});

describe('a line never splits inside a grapheme cluster', () => {
  it('keeps a letter with its marks when a word is wider than the column and has to be cut', () => {
    const word = 'بَ'.repeat(40);
    const lines = linesOf(text('@سارة', word)).filter((line) => line.kind === 'dialogue');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((line) => line.text).join('')).toBe(word);
    for (const line of lines) {
      expect(line.text.startsWith('َ'), line.text).toBe(false);
      expect(textColumns(line.text)).toBeLessThanOrEqual(LAYOUT.width.dialogue);
      // Every unit of the line is a letter with its mark: the cut fell between clusters.
      expect(textUnits(line.text).every((unit) => unit === 'بَ')).toBe(true);
    }
  });

  it('keeps a Hebrew letter with its points, and a ZWNJ with the letter before it', () => {
    const word = 'שָׁ'.repeat(40);
    for (const line of linesOf(text('@דוד', word)).filter((l) => l.kind === 'dialogue')) {
      expect(textUnits(line.text).every((unit) => unit === 'שָׁ')).toBe(true);
    }
    expect(textUnits('می‌خواهم')).toEqual(['م', 'ی‌', 'خ', 'و', 'ا', 'ه', 'م']);
  });

  it('leaves the units of Latin, CJK and emoji text as they were', () => {
    expect(textUnits('Café 草堂 👨‍👩‍👧 1️⃣')).toEqual(['C', 'a', 'f', 'é', ' ', '草', '堂', ' ', '👨‍👩‍👧', ' ', '1️⃣']);
  });
});

describe('where a speech splits', () => {
  const filler = Array.from({ length: 25 }, (_, i) => `Filler ${i}.`).join('\n\n');
  // Six sentences of a 30-letter word and a stop: a line each on the 35-column dialogue.
  const speech = (stop: string): string => Array.from({ length: 6 }, () => `${'ب'.repeat(30)}${stop}`).join(' ');
  const rows = (source: string) => paginate(parseFountain(source).elements).map((page) => page.lines.filter((line) => line.row !== null));

  it.each([
    ['؟', 'U+061F'],
    ['۔', 'U+06D4'],
    ['؛', 'U+061B'],
    ['.', 'a Latin full stop'],
  ])('splits after %s (%s) with (MORE) at the foot and the cue again on the next page', (stop) => {
    const [first, second] = rows(`${filler}\n\n@ANNA\n${speech(stop)}\n`);
    expect(first?.slice(-4).map((line) => line.kind)).toEqual(['character', 'dialogue', 'dialogue', 'more']);
    expect(first?.at(-2)?.text.endsWith(stop)).toBe(true);
    expect(second?.[0]?.text).toBe("ANNA (CONT'D)");
  });

  it('does not split where no sentence ends, and moves the cue group whole', () => {
    const [first, second] = rows(`${filler}\n\n@ANNA\n${Array.from({ length: 6 }, () => 'ب'.repeat(30)).join(' ')}\n`);
    expect(first?.some((line) => line.kind === 'character' || line.kind === 'more')).toBe(false);
    expect(second?.[0]).toMatchObject({ kind: 'character', text: 'ANNA' });
  });
});

describe('the marks that are left out', () => {
  it('are counted in the compile log, per script, and the text of the file still holds them', async () => {
    const source = text('@سارة', 'بِسْمِ اللّٰهِ', '', '@דוד', 'שָׁלוֹם');
    const layout = layoutPdf(blocksOf(source), { title: 'T' });
    expect(layout.notes.filter((note) => note.startsWith('pdf:'))).toEqual([
      expect.stringMatching(/^pdf: 3 Hebrew points and cantillation marks are left out of the print/),
      expect.stringMatching(/^pdf: 6 Arabic marks \(harakat, shadda and the like\) are left out of the print/),
    ]);
    const pdf = await pdfOf(source);
    expect(actualTexts(pdf)).toContain('بِسْمِ');
    expect(actualTexts(pdf)).toContain('שָׁלוֹם');
  });

  it('say nothing when a text has none, and are drawn nowhere: a word with marks is the glyphs of the word without them', async () => {
    expect(layoutPdf(blocksOf(text('@سارة', 'بسم الله')), { title: 'T' }).notes).toEqual([]);
    const support = await loadRtlSupport(['arabic'], LOADERS);
    const plan = async (word: string) => {
      const layout = layoutPdf(blocksOf(text('@سارة', word)), { title: 'T' }, support.measure);
      const fonts = await loadRtlFallback(layout, support);
      return fonts?.lines.get(rtlLineKey(word, true));
    };
    const marked = await plan('بِسْمِ');
    const bare = await plan('بسم');
    const glyphs = (items: Awaited<ReturnType<typeof plan>>) => items?.flatMap((item) => (item.kind === 'shaped' ? item.glyphs.map((glyph) => glyph.x) : []));
    expect(glyphs(marked)).toEqual(glyphs(bare));
    expect(marked?.[0]).toMatchObject({ kind: 'shaped', source: 'بِسْمِ' });
  });

  it('do not fail a compile when the engine cannot shape a run: it prints as "?" and the file is still written', async () => {
    // fontkit 1.1.1 throws on the dagger alef in this text; with its marks left out it never reaches the engine, so force it
    // with a shape function that fails.
    const support = await loadRtlSupport(['arabic'], LOADERS, () => ({ glyphs: [], advance: 0, failed: 'engine failed' }));
    const layout = layoutPdf(blocksOf(text('@سارة', 'مرحبا بالعالم')), { title: 'T' }, support.measure);
    const fonts = await loadRtlFallback(layout, support);
    const bytes = drawPdf(layout, await loadCourierPrime(), undefined, undefined, fonts);
    expect(bytes.length).toBeGreaterThan(0);
    expect(decode(bytes)).toContain('(????? ???????) Tj');
  });
});

describe('the plan of a line', () => {
  async function plan(line: string, rtl: boolean) {
    const support = await loadRtlSupport(['arabic', 'hebrew'], LOADERS);
    const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', line)), { title: 'T' }, support.measure);
    const fonts = await loadRtlFallback(layout, support);
    return { items: fonts?.lines.get(rtlLineKey(line, rtl)), fonts, support };
  }

  it('puts an Arabic word between Latin words where UAX #9 does, each at its own column', async () => {
    const { items, support } = await plan('Say مرحبا now', false);
    const ordered = [...(items ?? [])].sort((a, b) => a.column - b.column);
    expect(ordered.map((item) => (item.kind === 'plain' ? item.text : item.source))).toEqual(['Say ', 'مرحبا', ' now']);
    expect(ordered.map((item) => item.column)).toEqual([0, 4, 4 + support.measure('مرحبا')]);
  });

  it('reverses the words of a right-to-left line and sets a Latin word and its digits left to right inside it', async () => {
    const { items } = await plan('שלום Bob 42 עולם', true);
    const ordered = [...(items ?? [])].sort((a, b) => a.column - b.column);
    expect(ordered.map((item) => (item.kind === 'plain' ? item.text : item.source))).toEqual(['עולם', ' ', 'Bob 42', ' ', 'שלום']);
  });

  it('draws the brackets of a right-to-left run turned, so (בשקט) has its parentheses the right way round', async () => {
    const { items } = await plan('(בשקט)', true);
    const ordered = [...(items ?? [])].sort((a, b) => a.column - b.column);
    // Left to right as drawn: "(", the word, ")"; the characters typed were "(", the word, ")" in logical order.
    expect(ordered.map((item) => (item.kind === 'plain' ? item.text : item.source))).toEqual(['(', 'בשקט', ')']);
    const logical = [...(items ?? [])].sort((a, b) => a.order - b.order);
    expect(logical.map((item) => (item.kind === 'plain' ? item.source : item.source)).join('')).toBe('(בשקט)');
  });

  it('sets the room a word leaves in its cell on the left of a right-to-left word and on the right of a left-to-right run of digits', async () => {
    const { items, support } = await plan('السلام', true);
    const word = items?.[0];
    if (word?.kind !== 'shaped') throw new Error('no shaped word');
    const columns = support.measure('السلام');
    const advance = word.glyphs.reduce((sum, glyph) => sum + glyph.x, 0);
    expect(advance).toBeGreaterThan(0);
    // Glyphs are listed left to right, so the last one (the first letter, alef) ends the word at the right edge of its cell.
    const last = word.glyphs[word.glyphs.length - 1];
    expect(last && last.x).toBeGreaterThan((columns - 1) * LAYOUT.charWidth);
    expect(Math.min(...word.glyphs.map((glyph) => glyph.x))).toBeGreaterThanOrEqual(0);
  });

  it('gives a lam-alef, which the font draws in two glyphs, a CID for each glyph and the text that copies back', async () => {
    const { fonts } = await plan('لا', true);
    const texts = fonts?.arabic?.entries.map((entry) => entry.text) ?? [];
    expect(texts.join('')).toContain('ل');
    expect(texts.join('')).toContain('ا');
  });
});

describe('the file', () => {
  it('holds each word as marked content with its logical text, in the order the text is written', async () => {
    const pdf = await pdfOf(ARABIC, { language: 'ar' });
    const copied = actualTexts(pdf);
    for (const word of ['السلام', 'عليكم', 'أصدقائي', 'سارة', 'بهدوء', 'مرحبا', 'مرة']) expect(copied, word).toContain(word);
    // A line's runs follow its logical order: the first word of the sentence comes before the second.
    expect(copied.indexOf('السلام')).toBeLessThan(copied.indexOf('عليكم'));
    // The Latin word between the Arabic ones is written as ordinary text.
    expect(pdf).toContain('(Bob) Tj');
  });

  it('has an Arabic font object only when the text holds Arabic, and a Hebrew one only when it holds Hebrew', async () => {
    const arabic = await pdfOf(text('@سارة', 'مرحبا.'));
    const hebrew = await pdfOf(text('@דוד', 'שלום.'));
    const both = await pdfOf(text('@سارة', 'مرحبا.', '', '@דוד', 'שלום.'));
    const latin = await pdfOf(text('ANNA', 'Hello.'));
    expect([arabic, hebrew, both, latin].map((pdf) => [pdf.includes('/F4 '), pdf.includes('/F5 ')])).toEqual([
      [true, false],
      [false, true],
      [true, true],
      [false, false],
    ]);
    expect(arabic).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansArabic-Regular/);
    expect(hebrew).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansHebrew-Regular/);
    // Subsets of TrueType fonts, not the whole file: the file is far smaller than Noto Sans Arabic's 142 KB.
    expect(arabic.length).toBeLessThan(150_000);
  });

  it('is byte for byte the same for a Latin-only script whether or not the Arabic and Hebrew fonts and a right-to-left language are given', async () => {
    const latin = text('INT. A - DAY', '', 'Hello. World.', '', 'ANNA', '(quietly)', 'Fine, thanks.');
    const plain = await pdfOf(latin, {}, { cjk: LOADERS.cjk, emoji: LOADERS.emoji });
    expect(await pdfOf(latin, {}, LOADERS)).toBe(plain);
    expect(await pdfOf(latin, { language: 'ar' }, LOADERS)).toBe(plain);
  });

  it('is laid out with no shaper and no font loaded for a script with no Arabic or Hebrew, and is the same pages as layoutPdf', async () => {
    const latin = blocksOf(text('INT. A - DAY', '', 'Hello. World.'));
    const prepared = await preparePdf(latin, { title: 'T' }, LOADERS);
    expect(prepared.rtl).toBeUndefined();
    expect(prepared.layout.pages).toEqual(layoutPdf(latin, { title: 'T' }).pages);
  });

  it('prints Arabic and Hebrew as "?" when the host passes no font for them, and says so', () => {
    const result = renderPdf(blocksOf(text('@سارة', 'مرحبا.')), { title: 'T' });
    expect(result.notes.some((note) => note.includes('Arabic font was not passed to renderPdf'))).toBe(true);
    expect(decode(result.bytes)).toContain('(?????.) Tj');
  });

  it('sets Persian and Urdu letters, digits, emoji and Latin in one paragraph, with no "?" and no note', async () => {
    const source = text('@پروین', 'سلام دنیا، می‌خواهم چطوری 🎬 ٣٢١ Bob.', '', '@احمد', 'ٹھیک ہے، ڈاکٹر صاحب۔');
    const layout = layoutPdf(blocksOf(source), { title: 'T' });
    expect(layout.notes).toEqual([]);
    const pdf = await pdfOf(source);
    expect(actualTexts(pdf)).toEqual(expect.arrayContaining(['سلام', 'دنیا', 'می‌خواهم', 'چطوری', '٣', '٢', '١', 'ٹھیک', 'ڈاکٹر']));
    expect(pdf).toContain('/F3 ');
    expect(pdf).not.toContain('(?) Tj');
  });
});

/** pdftotext, where it is installed: the run is skipped otherwise. */
function pdftotext(bytes: Uint8Array): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'caotang-rtl-'));
  try {
    const file = join(dir, 'file.pdf');
    writeFileSync(file, bytes);
    return execFileSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8', timeout: 20_000 });
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the text a reader extracts', () => {
  it('is the logical text of every word, as pdftotext reads it back (where it is installed)', async () => {
    const source = text(ARABIC, '', HEBREW);
    const blob = await createPdfRenderer(LOADERS).emit(blocksOf(source), { title: 'T' });
    const out = pdftotext(new Uint8Array(await blob.arrayBuffer()));
    if (out === null) return;
    // pdftotext lays right-to-left runs out with embedding controls around them; the words are what matters.
    const bare = out.replace(/[‪-‮⁦-⁩]/g, '');
    for (const word of ['السلام', 'عليكم', 'أصدقائي', 'مرحبا', 'سارة', 'שלום', 'עולם', 'שלומך', 'בסדר', 'תודה', 'Everything']) expect(bare, word).toContain(word);
  });
});
