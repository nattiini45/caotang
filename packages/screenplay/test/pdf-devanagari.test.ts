/**
 * Devanagari in the screenplay PDF (screenplay.md §5.3): the units a line is measured and broken in, the width of a shaped word
 * on the grid, the lines that never split inside a grapheme cluster, the danda as a sentence end, the language forms of Marathi
 * and Nepali, the plan of a mixed line, the text a reader extracts, and the Latin-only file that stays as it was.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FlatBlock } from '../src/index.js';
import {
  LAYOUT,
  createPdfRenderer,
  importFountainScript,
  layoutPdf,
  loadRtlFallback,
  paginate,
  parseFountain,
  preparePdf,
  renderPdf,
  textColumns,
  textUnits,
  unitColumns,
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

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function pdfOf(source: string, opts: { language?: string } = {}, loaders: Parameters<typeof createPdfRenderer>[0] = LOADERS): Promise<string> {
  const blob = await createPdfRenderer(loaders).emit(blocksOf(source), { title: 'T', ...(opts.language === undefined ? {} : { language: opts.language }) });
  return decode(new Uint8Array(await blob.arrayBuffer()));
}

/** The `/ActualText` strings of a file, in the order they are written. */
function actualTexts(pdf: string): string[] {
  return [...pdf.matchAll(/\/Span << \/ActualText <FEFF([0-9A-F]*)> >> BDC/g)].map((match) =>
    String.fromCharCode(...(match[1]?.match(/.{4}/g) ?? []).map((hex) => parseInt(hex, 16))),
  );
}

const dialogueLines = async (source: string, language = 'hi'): Promise<LayoutLine[]> => {
  const support = await loadRtlSupport(['devanagari'], LOADERS, undefined, { language });
  return layoutPdf(blocksOf(source), { title: 'T', language }, support.measure)
    .pages.flatMap((page) => page.lines)
    .filter((line) => line.kind === 'dialogue');
};

const HINDI = text(
  'INT. घर - DAY',
  '',
  'राम हिन्दी में क्षत्रिय श्रीमान् प्रेम कार्यक्रम स्त्री की बात करता है।',
  '',
  '@राम',
  '(धीरे से)',
  'मैं हिन्दी बोलता हूँ। क्या आप भी बोलते हैं? यह एक बहुत लंबा संवाद है जो कई पंक्तियों में फैलता है, पटकथा के लिए।',
);

describe('the units of Devanagari text', () => {
  it('are grapheme clusters with the conjuncts whole, never a bare code point', () => {
    expect(textUnits('हिन्दी')).toEqual(['हि', 'न्दी']);
    expect(textUnits('क्षत्रिय')).toEqual(['क्ष', 'त्रि', 'य']);
    expect(textUnits('क़ क़')).toEqual(['क़', ' ', 'क़']);
    expect(textUnits('श्री।')).toEqual(['श्री', '।']);
  });

  it('are what they were for Latin, CJK and emoji text, also beside Devanagari', () => {
    expect(textUnits('Café 草堂 👨‍👩‍👧 1️⃣')).toEqual(['C', 'a', 'f', 'é', ' ', '草', '堂', ' ', '👨‍👩‍👧', ' ', '1️⃣']);
    expect(textUnits('a草हि👨‍👩‍👧')).toEqual(['a', '草', 'हि', '👨‍👩‍👧']);
  });

  it('are a column each until a font measures the word, and a mark with no consonant takes none', () => {
    expect(textColumns('हिन्दी')).toBe(2);
    expect(textColumns('क्षत्रिय')).toBe(3);
    expect(unitColumns('कि')).toBe(1);
    expect(unitColumns('ि')).toBe(0);
    expect(unitColumns('ं')).toBe(0);
  });
});

describe('the width of a Devanagari word on the grid', () => {
  it('is the shaped width rounded up to whole columns once the font is loaded, never fewer than one', async () => {
    const support = await loadRtlSupport(['devanagari'], LOADERS);
    // हिन्दी: 259 + 531 + 309 + 531 + 259 = 1889 units of 1000 to the em, 22.7 points: 3.15 columns of 7.2 points, so 4.
    expect(support.measure('हिन्दी')).toBe(4);
    expect(support.measure('कि')).toBe(2);
    // The same word is the same width whatever the layout asked for before: the shaper has no history.
    expect(support.measure('हिन्दी')).toBe(4);
    expect(withMeasure(support.measure, () => textColumns('हिन्दी में'))).toBe(4 + 1 + support.measure('में'));
  });

  it('breaks a line where the measured words stop fitting, not where the clusters would', async () => {
    const support = await loadRtlSupport(['devanagari'], LOADERS);
    const long = Array.from({ length: 12 }, () => 'हिन्दी').join(' ');
    const blocks = blocksOf(text('@राम', long));
    const lines = (measure?: Parameters<typeof layoutPdf>[2]) =>
      layoutPdf(blocks, { title: 'T' }, measure).pages.flatMap((page) => page.lines).filter((line) => line.kind === 'dialogue');
    const estimated = lines();
    const measured = lines(support.measure);
    // Two columns by clusters, four measured: the column is 35 wide.
    expect(estimated.map((line) => line.text.split(' ').length)).toEqual([12]);
    expect(measured.map((line) => line.text.split(' ').length)).toEqual([7, 5]);
    for (const line of measured) expect(withMeasure(support.measure, () => textColumns(line.text))).toBeLessThanOrEqual(LAYOUT.width.dialogue);
  });
});

describe('a line never splits inside a grapheme cluster', () => {
  it('breaks Hindi dialogue at spaces', async () => {
    const lines = await dialogueLines(HINDI);
    expect(lines.length).toBeGreaterThan(1);
    const spoken = 'मैं हिन्दी बोलता हूँ। क्या आप भी बोलते हैं? यह एक बहुत लंबा संवाद है जो कई पंक्तियों में फैलता है, पटकथा के लिए।';
    expect(lines.map((line) => line.text).join(' ')).toBe(spoken);
  });

  it('cuts a word wider than the column between clusters, and never inside one', async () => {
    // A word with no space: 40 clusters, each of the short i and its consonant.
    const word = 'कि'.repeat(40);
    const lines = await dialogueLines(text('@राम', word));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((line) => line.text).join('')).toBe(word);
    const support = await loadRtlSupport(['devanagari'], LOADERS);
    for (const line of lines) {
      expect(line.text.startsWith('ि'), line.text).toBe(false);
      expect(withMeasure(support.measure, () => textColumns(line.text))).toBeLessThanOrEqual(LAYOUT.width.dialogue);
      expect(textUnits(line.text).every((unit) => unit === 'कि')).toBe(true);
    }
  });

  it('keeps a conjunct whole when the word is cut: क्ष is never split from its virama', async () => {
    const word = 'क्षत्रिय'.repeat(12);
    for (const line of await dialogueLines(text('@राम', word))) {
      expect(line.text.endsWith('्'), line.text).toBe(false);
      expect(line.text.startsWith('्'), line.text).toBe(false);
      expect(textUnits(line.text).every((unit) => ['क्ष', 'त्रि', 'य'].includes(unit))).toBe(true);
    }
  });

  it('breaks the same way whatever the shaper has shaped before', async () => {
    const first = await dialogueLines(HINDI);
    await dialogueLines(text('@राम', 'क्षत्रिय '.repeat(30)));
    expect((await dialogueLines(HINDI)).map((line) => line.text)).toEqual(first.map((line) => line.text));
  });
});

describe('where a speech splits', () => {
  const filler = Array.from({ length: 25 }, (_, i) => `Filler ${i}.`).join('\n\n');
  // Six sentences of a 30-cluster word and a stop: a line each on the 35-column dialogue (a column a cluster, with no font measuring).
  const speech = (stop: string): string => Array.from({ length: 6 }, () => `${'क'.repeat(30)}${stop}`).join(' ');
  const rows = (source: string) => paginate(parseFountain(source).elements).map((page) => page.lines.filter((line) => line.row !== null));

  it.each([
    ['।', 'the danda, U+0964'],
    ['॥', 'the double danda, U+0965'],
    ['.', 'a Latin full stop'],
  ])('splits after %s (%s) with (MORE) at the foot and the cue again on the next page', (stop) => {
    const [first, second] = rows(`${filler}\n\n@ANNA\n${speech(stop)}\n`);
    expect(first?.some((line) => line.kind === 'more')).toBe(true);
    const last = first?.filter((line) => line.kind === 'dialogue').at(-1);
    expect(last?.text.endsWith(stop)).toBe(true);
    expect(second?.[0]?.text).toBe("ANNA (CONT'D)");
  });

  it('does not split where no sentence ends', () => {
    const [first] = rows(`${filler}\n\n@ANNA\n${Array.from({ length: 6 }, () => 'क'.repeat(30)).join(' ')}\n`);
    expect(first?.some((line) => line.kind === 'more')).toBe(false);
  });
});

describe('the language forms', () => {
  it('are the font\'s Marathi and Nepali ones for a Marathi and a Nepali project, and the default ones otherwise', async () => {
    const subset = async (language: string | undefined, line: string) => {
      const support = await loadRtlSupport(['devanagari'], LOADERS, undefined, language === undefined ? {} : { language });
      const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', line)), { title: 'T' }, support.measure);
      const program = (await loadRtlFallback(layout, support))?.devanagari?.program ?? new Uint8Array();
      return Buffer.from(program).toString('base64');
    };
    // The Marathi la and sha, and the Nepali jha and digits, are other glyphs of the same font.
    expect(await subset('mr', 'शाळा')).not.toBe(await subset('hi', 'शाळा'));
    expect(await subset('ne', '२०८१ झ')).not.toBe(await subset('hi', '२०८१ झ'));
    expect(await subset(undefined, 'शाळा')).toBe(await subset('hi', 'शाळा'));
    expect(await subset('mr-IN', 'शाळा')).toBe(await subset('mr', 'शाळा'));
  });

  it('reach the file: the same text in a Marathi and in a Hindi project are two files', async () => {
    const source = text('@राम', 'शाळा');
    expect(await pdfOf(source, { language: 'mr' })).not.toBe(await pdfOf(source, { language: 'hi' }));
  });
});

describe('the plan of a line', () => {
  async function plan(line: string) {
    const support = await loadRtlSupport(['devanagari'], LOADERS);
    const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', line)), { title: 'T' }, support.measure);
    const fonts = await loadRtlFallback(layout, support);
    return { items: fonts?.lines.get(rtlLineKey(line, false)), fonts, support };
  }

  it('puts a Devanagari word between Latin words, each at its own column, left to right', async () => {
    const { items, support } = await plan('Say हिन्दी now');
    const ordered = [...(items ?? [])].sort((a, b) => a.column - b.column);
    expect(ordered.map((item) => (item.kind === 'plain' ? item.text : item.source))).toEqual(['Say ', 'हिन्दी', ' now']);
    expect(ordered.map((item) => item.column)).toEqual([0, 4, 4 + support.measure('हिन्दी')]);
    expect(items?.map((item) => item.order)).toEqual([0, 0, 0]);
  });

  it('draws the short i before its consonant and gives the first glyph of each cluster the cluster\'s text, so copying gives the typed word', async () => {
    const { items, fonts } = await plan('कि');
    const word = items?.[0];
    if (word?.kind !== 'shaped') throw new Error('no shaped word');
    expect(word.font).toBe('devanagari');
    expect(word.source).toBe('कि');
    expect(word.glyphs).toHaveLength(2);
    // The glyphs go left to right as drawn: the narrow i sign first, then ka. Both belong to the cluster कि.
    expect(word.glyphs[0]?.x).toBeLessThan(word.glyphs[1]?.x ?? 0);
    const texts = word.glyphs.map((glyph) => fonts?.devanagari?.entries[glyph.cid - 1]?.text);
    expect(texts).toEqual(['कि', '']);
  });

  it('draws reph over the consonant it belongs to, after it in the drawing order, with its own offset', async () => {
    const { items } = await plan('र्क');
    const word = items?.[0];
    if (word?.kind !== 'shaped') throw new Error('no shaped word');
    expect(word.glyphs).toHaveLength(2);
    // The reph glyph has no advance of its own: its offset puts it back over the consonant, inside the consonant's advance (768 units).
    expect(word.glyphs[1]?.x).toBeGreaterThan(word.glyphs[0]?.x ?? 0);
    expect(word.glyphs[1]?.x).toBeLessThan((word.glyphs[0]?.x ?? 0) + (768 * 12) / 1000);
  });

  it('gives a conjunct one glyph, and a CID for each distinct (glyph, text) pair', async () => {
    const { items, fonts } = await plan('द्ध द्ध');
    const words = (items ?? []).filter((item) => item.kind === 'shaped');
    expect(words.map((item) => item.glyphs.length)).toEqual([1, 1]);
    expect(fonts?.devanagari?.entries.map((entry) => entry.text)).toEqual(['द्ध']);
  });

  it('plans a mixed line of Devanagari and Arabic, each word in its own font', async () => {
    const support = await loadRtlSupport(['devanagari', 'arabic'], LOADERS);
    const line = 'हिन्दी مرحبا';
    const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', line)), { title: 'T' }, support.measure);
    const fonts = await loadRtlFallback(layout, support);
    const items = fonts?.lines.get(rtlLineKey(line, false)) ?? [];
    expect(items.filter((item) => item.kind === 'shaped').map((item) => item.font).sort()).toEqual(['arabic', 'devanagari']);
    expect(fonts?.devanagari).toBeDefined();
    expect(fonts?.arabic).toBeDefined();
  });

  it('leaves a line unplanned, to print as "?", when the Devanagari font is not loaded', async () => {
    const support = await loadRtlSupport(['devanagari'], {});
    const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', 'हिन्दी')), { title: 'T' }, support.measure);
    expect((await loadRtlFallback(layout, support))?.lines.size).toBe(0);
  });
});

describe('the file', () => {
  it('holds each word as marked content with its typed text, no "?", and a Devanagari font object', async () => {
    const pdf = await pdfOf(HINDI, { language: 'hi' });
    const copied = actualTexts(pdf);
    for (const word of ['हिन्दी', 'क्षत्रिय', 'श्रीमान्', 'प्रेम', 'कार्यक्रम', 'स्त्री', 'मैं', 'हूँ।', 'पंक्तियों', 'लिए।']) expect(copied, word).toContain(word);
    // A line's words follow its logical order.
    expect(copied.indexOf('हिन्दी')).toBeLessThan(copied.indexOf('क्षत्रिय'));
    expect(pdf).toContain('/F6 ');
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari-Regular/);
    // The one "?" in the file is the question mark the script types after बोलते हैं.
    expect(pdf.match(/\(\?+\) Tj/g)).toEqual(['(?) Tj']);
    // Subsets of TrueType fonts, hex-encoded: Courier Prime and the cut Devanagari glyphs, far under the whole 184 KB font on its own.
    expect(pdf.length).toBeLessThan(220_000);
  });

  it('says nothing about Devanagari in the compile log, and names a script that has no font', () => {
    expect(layoutPdf(blocksOf(HINDI), { title: 'T' }).notes).toEqual([]);
    const tamil = layoutPdf(blocksOf(text('@ராம', 'தமிழ்')), { title: 'T' }).notes;
    expect(tamil).toEqual([expect.stringMatching(/printed as "\?": .*த/)]);
    // Tamil and Hindi together: only the Tamil is named.
    const both = layoutPdf(blocksOf(text('@राम', 'हिन्दी தமிழ்')), { title: 'T' }).notes;
    expect(both).toHaveLength(1);
    expect(both[0]).not.toContain('ह');
  });

  it('prints Devanagari as "?" when the host passes no font for it, and says so', () => {
    const result = renderPdf(blocksOf(text('@राम', 'हिन्दी')), { title: 'T' });
    expect(result.notes.some((note) => note.includes('Devanagari font was not passed to renderPdf'))).toBe(true);
    expect(decode(result.bytes)).toContain('(??) Tj');
  });

  it('loads the font only for a document with Devanagari, and writes a Latin-only file as it was', async () => {
    const latin = text('INT. A - DAY', '', 'Hello. World.', '', 'ANNA', '(quietly)', 'Fine, thanks.');
    const devanagari = vi.fn(LOADERS.devanagari);
    const loaders = { cjk: LOADERS.cjk, emoji: LOADERS.emoji, arabic: LOADERS.arabic, hebrew: LOADERS.hebrew, devanagari };
    const plain = await pdfOf(latin, {}, { cjk: LOADERS.cjk, emoji: LOADERS.emoji });
    expect(await pdfOf(latin, {}, loaders)).toBe(plain);
    expect(await pdfOf(latin, { language: 'hi' }, loaders)).toBe(plain);
    expect(devanagari).not.toHaveBeenCalled();
    const prepared = await preparePdf(blocksOf(latin), { title: 'T' }, loaders);
    expect(prepared.rtl).toBeUndefined();
    await pdfOf(text('@राम', 'हिन्दी'), {}, loaders);
    expect(devanagari).toHaveBeenCalled();
  });

  it('is the same file for the same text, however many documents were shaped before it', async () => {
    const first = await pdfOf(HINDI, { language: 'hi' });
    await pdfOf(text('@राम', 'क्षत्रिय र्के क्े ' .repeat(10)), { language: 'hi' });
    expect(await pdfOf(HINDI, { language: 'hi' })).toBe(first);
  });

  it('sets Devanagari, Latin, digits and a keycap emoji in one paragraph with no "?"', async () => {
    const source = text('@राम', 'Hello हिन्दी 42 दुनिया 1️⃣ Bob।');
    const pdf = await pdfOf(source);
    expect(actualTexts(pdf)).toEqual(expect.arrayContaining(['हिन्दी', 'दुनिया']));
    expect(pdf).not.toContain('(?) Tj');
  });

  it('draws the precomposed nukta letter and the letter with its nukta alike', async () => {
    const support = await loadRtlSupport(['devanagari'], LOADERS);
    expect(support.measure('क़')).toBe(support.measure('क़'));
    const glyphs = async (word: string) => {
      const layout = layoutPdf(blocksOf(text('INT. A - DAY', '', word)), { title: 'T' }, support.measure);
      const items = (await loadRtlFallback(layout, support))?.lines.get(rtlLineKey(word, false));
      return JSON.stringify(items?.map((item) => (item.kind === 'shaped' ? item.glyphs.map((glyph) => [glyph.x, glyph.y]) : item.text)));
    };
    expect(await glyphs('क़')).toBe(await glyphs('क़'));
  });
});

/** pdftotext, where it is installed: the run is skipped otherwise. */
function pdftotext(bytes: Uint8Array): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'caotang-deva-'));
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
  it('is the typed text of every word, as pdftotext reads it back (where it is installed)', async () => {
    const blob = await createPdfRenderer(LOADERS).emit(blocksOf(HINDI), { title: 'T', language: 'hi' });
    const out = pdftotext(new Uint8Array(await blob.arrayBuffer()));
    if (out === null) return;
    const flat = out.replace(/\s+/g, ' ');
    for (const word of ['हिन्दी', 'क्षत्रिय', 'श्रीमान्', 'प्रेम', 'कार्यक्रम', 'स्त्री', 'बोलता', 'हूँ।', 'फैलता', 'पंक्तियों', 'पटकथा']) expect(flat, word).toContain(word);
  });
});
