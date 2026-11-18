/**
 * The screenplay PDF's paper and Latin face (screenplay.md §5.3): US Letter or A4, and Courier Prime, the base-14 Courier or
 * Cousine. The text block sits at the same place on both papers, so a script breaks at the same lines and the pages hold the
 * same text. These tests hold that, the bytes of the default file, and the font figures.
 */
import { createHash } from 'node:crypto';
import * as fontkitModule from '@pdf-lib/fontkit';
import { describe, expect, it } from 'vitest';
import {
  COUSINE_METRICS,
  SCRIPT_FONTS,
  importFountainScript,
  isPrintable,
  layoutPdf,
  loadCourierPrime,
  loadCousine,
  loadScriptFont,
  preparePdf,
  renderPdf,
  sceneLengths,
  type FlatBlock,
} from '../src/index.js';
import { WIN_ANSI_EXTRA } from '../src/winansi.js';
import {
  SCENE_FILE,
  SCRIPT_NON_CANONICAL,
  SCRIPT_ONE_ACT,
  SCRIPT_RESIDUE,
  SCRIPT_SECTION_SYNOPSIS,
  SCRIPT_TWO_DEPTHS,
  SCRIPT_WITH_TITLE_PAGE,
} from './fixtures/corpus.js';

const fontkit = ((fontkitModule as unknown as { default?: typeof fontkitModule }).default ?? fontkitModule) as typeof fontkitModule;

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const CORPUS: readonly (readonly [string, string])[] = [
  ['SCENE_FILE', SCENE_FILE],
  ['SCRIPT_ONE_ACT', SCRIPT_ONE_ACT],
  ['SCRIPT_TWO_DEPTHS', SCRIPT_TWO_DEPTHS],
  ['SCRIPT_SECTION_SYNOPSIS', SCRIPT_SECTION_SYNOPSIS],
  ['SCRIPT_NON_CANONICAL', SCRIPT_NON_CANONICAL],
  ['SCRIPT_WITH_TITLE_PAGE', SCRIPT_WITH_TITLE_PAGE],
  ['SCRIPT_RESIDUE', SCRIPT_RESIDUE],
];

describe('the page size', () => {
  it('writes /MediaBox [0 0 595.28 841.89] for A4, and [0 0 612 792] for Letter or none', () => {
    const blocks = blocksOf(SCRIPT_ONE_ACT);
    const media = (opts: { pageSize?: 'A4' | 'Letter' }): string[] =>
      [...decode(renderPdf(blocks, { title: 'T', ...opts }).bytes).matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((m) => m[1] ?? '');
    const a4 = media({ pageSize: 'A4' });
    expect(a4.length).toBeGreaterThan(0);
    expect(new Set(a4)).toEqual(new Set(['0 0 595.28 841.89']));
    for (const opts of [{}, { pageSize: 'Letter' as const }]) expect(new Set(media(opts))).toEqual(new Set(['0 0 612 792']));
  });

  it('flips y from the A4 page’s own height', () => {
    const file = (pageSize: 'A4' | 'Letter'): string => decode(renderPdf(blocksOf(SCRIPT_ONE_ACT), { title: 'T', pageSize, titlePage: false }).bytes);
    // The first line sits at 72 + 10 points from the top.
    expect(file('Letter')).toContain(`1 0 0 1 108 ${792 - 82} Tm`);
    expect(file('A4')).toContain(`1 0 0 1 108 ${(841.89 - 82).toFixed(2)} Tm`);
  });

  it('keeps every xref offset exact on A4, with an embedded font', async () => {
    const { bytes } = renderPdf(blocksOf(SCRIPT_ONE_ACT), { title: 'T', pageSize: 'A4' }, await loadCousine());
    // The table's offsets count bytes, not decoded characters — slice the bytes, then decode.
    const xref = Number(/startxref\n(\d+)\n/.exec(decode(bytes))?.[1]);
    const lines = decode(bytes.slice(xref)).split('\n');
    const objects = Number(/^0 (\d+)$/m.exec(decode(bytes.slice(xref, xref + 40)))?.[1]) - 1;
    expect(objects).toBeGreaterThan(5);
    for (let object = 1; object <= objects; object++) {
      expect(decode(bytes.slice(Number(lines[2 + object]?.slice(0, 10)))).startsWith(`${object} 0 obj\n`), `object ${object}`).toBe(true);
    }
  });

  it.each(CORPUS)('lays %s out on A4 with the page count, line breaks and scene lengths of Letter', (_name, source) => {
    const blocks = blocksOf(source);
    for (const extra of [{}, { sceneNumbers: 'both' as const }]) {
      const letter = layoutPdf(blocks, { title: 'T', ...extra });
      const a4 = layoutPdf(blocks, { title: 'T', pageSize: 'A4', ...extra });
      expect(letter.pageSize).toBe('Letter');
      expect(a4.pageSize).toBe('A4');
      expect(letter.pages.length).toBeGreaterThan(0);
      expect(a4.scriptPageCount).toBe(letter.scriptPageCount);
      expect(a4.pages).toEqual(letter.pages);
      expect(sceneLengths(a4.pages)).toEqual(sceneLengths(letter.pages));
    }
  });

  it('shows the same text on A4 as on Letter, line for line', () => {
    const blocks = blocksOf(SCRIPT_ONE_ACT);
    const shown = (pdf: string): string[] => pdf.split('\n').filter((line) => line.endsWith(' Tj'));
    const letter = shown(decode(renderPdf(blocks, { title: 'T' }).bytes));
    expect(letter.length).toBeGreaterThan(10);
    expect(shown(decode(renderPdf(blocks, { title: 'T', pageSize: 'A4' }).bytes))).toEqual(letter);
  });
});

describe('the Latin face', () => {
  const blocks = blocksOf(SCRIPT_ONE_ACT);

  it('is Courier Prime when none is named', async () => {
    const named = renderPdf(blocks, { title: 'T', scriptFont: 'courier-prime' }, await loadScriptFont('courier-prime'));
    const absent = renderPdf(blocks, { title: 'T' }, await loadScriptFont());
    expect(sha256(absent.bytes)).toBe(sha256(named.bytes));
    expect(sha256(absent.bytes)).toBe(sha256(renderPdf(blocks, { title: 'T' }, await loadCourierPrime()).bytes));
    expect(decode(absent.bytes)).toContain('/BaseFont /CourierPrime');
  });

  it('writes a Latin-only Letter file byte for byte as it was written before the paper and the face were options', async () => {
    // The SHA-256 of what origin/main wrote for these scripts, with and without the embedded font,
    // re-based once for the binary comment line the header gained for PDF/A.
    const font = await loadCourierPrime();
    const titled = blocksOf(SCRIPT_WITH_TITLE_PAGE);
    const titledOptions = { title: 'T', author: 'A. Writer', sceneNumbers: 'both' as const };
    expect(sha256(renderPdf(blocks, { title: 'T' }, font).bytes)).toBe('739160e4390bf6f80e7354cbc37c5dbb5cda6c83504113250f6556d5918e9a13');
    expect(sha256(renderPdf(titled, titledOptions, font).bytes)).toBe('2c61e3c955e1753df94456a9f10907a320b7d417033b83f5fa6457c728ec7d16');
    expect(sha256(renderPdf(blocks, { title: 'T' }).bytes)).toBe('9724998dde7185a4b8cbef7ec17896a85f02484eab76512ef5fd0ffd6b555c00');
    expect(sha256(renderPdf(titled, titledOptions).bytes)).toBe('06b21880977ee27470fbbcb4966d11202a9c0d2855067b83c8fe32ede187f9a6');
  });

  it('names the base-14 Courier and embeds nothing for courier', async () => {
    expect(await loadScriptFont('courier')).toBeUndefined();
    const prepared = await preparePdf(blocks, { title: 'T', scriptFont: 'courier' });
    expect(prepared.font).toBeUndefined();
    const pdf = decode(renderPdf(blocks, { title: 'T', scriptFont: 'courier' }, prepared.font).bytes);
    expect(pdf).toContain('/BaseFont /Courier ');
    expect(pdf).not.toContain('FontFile2');
    expect(pdf).not.toContain('CourierPrime');
  });

  it('embeds Cousine whole, with its own name and the Courier advance, for cousine', async () => {
    const prepared = await preparePdf(blocks, { title: 'T', scriptFont: 'cousine' });
    expect(prepared.font?.metrics).toBe(COUSINE_METRICS);
    const pdf = decode(renderPdf(blocks, { title: 'T', scriptFont: 'cousine' }, prepared.font).bytes);
    expect(pdf).toContain('/Subtype /TrueType /BaseFont /Cousine-Regular /FirstChar 32 /LastChar 255');
    expect(pdf).toContain(`/FontName /Cousine-Regular /Flags ${COUSINE_METRICS.flags} /FontBBox [${COUSINE_METRICS.bbox.join(' ')}]`);
    expect(pdf).toContain(`/Ascent ${COUSINE_METRICS.ascent} /Descent ${COUSINE_METRICS.descent} /CapHeight ${COUSINE_METRICS.capHeight}`);
    expect(pdf).toContain(`/Length1 ${prepared.font?.bytes.length} /Filter /ASCIIHexDecode`);
    expect(pdf).not.toContain('CourierPrime');
    const widths = /\/Widths \[([^\]]+)\]/.exec(pdf)?.[1]?.split(' ') ?? [];
    expect(widths).toHaveLength(224);
    expect(new Set(widths)).toEqual(new Set(['600']));
  });

  it('breaks a script at the same lines in every face', () => {
    const base = layoutPdf(blocks, { title: 'T' }).pages;
    expect(base.length).toBeGreaterThan(0);
    for (const face of SCRIPT_FONTS) expect(layoutPdf(blocks, { title: 'T', scriptFont: face }).pages).toEqual(base);
  });
});

describe('WinAnsi coverage of the embedded faces', () => {
  const printable: string[] = [];
  for (let code = 0x20; code <= 0xff; code++) {
    const ch = String.fromCodePoint(code);
    if (isPrintable(ch)) printable.push(ch);
  }
  for (const ch of Object.keys(WIN_ANSI_EXTRA)) if (isPrintable(ch)) printable.push(ch);

  it.each([
    ['Courier Prime', loadCourierPrime],
    ['Cousine', loadCousine],
  ])('has a glyph in %s for every character isPrintable accepts', async (_name, load) => {
    const { bytes } = await load();
    const font = fontkit.create(bytes) as unknown as { glyphForCodePoint(code: number): { id: number } };
    // Control: the set is the whole Latin-1 range and the WinAnsi extras, not an empty loop.
    expect(printable.length).toBeGreaterThan(200);
    const missing = printable.filter((ch) => font.glyphForCodePoint(ch.codePointAt(0) ?? 0).id === 0);
    expect(missing).toEqual([]);
  });
});
