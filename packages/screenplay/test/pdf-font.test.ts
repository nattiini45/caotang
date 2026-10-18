/**
 * The embedded font of the screenplay PDF (screenplay.md §5.3, A3): Courier Prime, carried in the app and written into
 * every file as a TrueType font program. These tests read the font's own tables to check the metrics the PDF states,
 * check that the program in the file is the font byte for byte, and hold the lazy-load line: only a dynamic import
 * reaches the module that carries the font.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FlatBlock } from '../src/index.js';
import { COURIER_PRIME_METRICS, LAYOUT, importFountainScript, loadCourierPrime, renderPdf } from '../src/index.js';
import { SCRIPT_ONE_ACT } from './fixtures/corpus.js';

function blocksOf(source: string): FlatBlock[] {
  return importFountainScript(source).nodes.map((node, i): FlatBlock => {
    if (node.kind === 'section') return { kind: 'chapter', title: node.title, level: node.depth, number: i + 1 };
    return { kind: 'scene', docId: `d${i}`, body: node.body, title: node.title, number: i + 1 };
  });
}

/** One table of a TrueType file, by its tag. */
function table(font: Uint8Array, tag: string): DataView {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + 16 * i;
    const name = String.fromCharCode(...font.slice(record, record + 4));
    if (name === tag) return new DataView(font.buffer, font.byteOffset + view.getUint32(record + 8), view.getUint32(record + 12));
  }
  throw new Error(`no ${tag} table`);
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('Courier Prime — the metrics the PDF states are the font’s own', () => {
  it('scales head, hhea and OS/2 to the 1000-unit glyph space', async () => {
    const { bytes } = await loadCourierPrime();
    const m = COURIER_PRIME_METRICS;
    const head = table(bytes, 'head');
    const upem = head.getUint16(18);
    expect(upem).toBe(m.unitsPerEm);
    const scale = (units: number): number => Math.round((units * 1000) / upem);
    expect([head.getInt16(36), head.getInt16(38), head.getInt16(40), head.getInt16(42)].map(scale)).toEqual([...m.bbox]);
    const hhea = table(bytes, 'hhea');
    expect(scale(hhea.getInt16(4))).toBe(m.ascent);
    expect(scale(hhea.getInt16(6))).toBe(m.descent);
    const os2 = table(bytes, 'OS/2');
    expect(scale(os2.getInt16(88))).toBe(m.capHeight);
    expect(scale(os2.getInt16(86))).toBe(m.xHeight);
    // fsType 0: the font may be embedded and installed (OFL), so a PDF may carry it whole.
    expect(os2.getUint16(8)).toBe(0);
  });

  it('is monospaced at Courier’s 600 units, so the layout’s 7.2 points a character holds', async () => {
    const { bytes } = await loadCourierPrime();
    const hhea = table(bytes, 'hhea');
    const hmtx = table(bytes, 'hmtx');
    const advances = new Set<number>();
    for (let i = 0; i < hhea.getUint16(34); i++) {
      const advance = hmtx.getUint16(4 * i);
      if (advance !== 0) advances.add(advance);
    }
    expect([...advances]).toEqual([COURIER_PRIME_METRICS.advanceUnits]);
    expect(Math.round((COURIER_PRIME_METRICS.advanceUnits * 1000) / COURIER_PRIME_METRICS.unitsPerEm)).toBe(COURIER_PRIME_METRICS.width);
    expect((COURIER_PRIME_METRICS.width * 12) / 1000).toBe(LAYOUT.charWidth);
  });

  it('names itself CourierPrime, the PostScript name the PDF gives it', async () => {
    const { bytes } = await loadCourierPrime();
    expect(decode(bytes).replace(/\0/g, '')).toContain(COURIER_PRIME_METRICS.postScriptName);
  });
});

describe('Courier Prime — the carrier holds the published font', () => {
  // The size and SHA-256 of CourierPrime-Regular.ttf as google/fonts publishes it, as the carrier and fonts/README.md state them.
  const SIZE = 71188;
  const SHA256 = '72f793376f8e2841656bf21d77a5de010f2929bd6956a22ee848ad0c7eb978af';

  it('decodes to the published file, byte for byte', async () => {
    const { bytes } = await loadCourierPrime();
    expect(bytes.length).toBe(SIZE);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SHA256);
  });

  it('is the file the carrier’s comment and fonts/README.md name', () => {
    const src = (file: string): string => readFileSync(resolve(__dirname, '../src/fonts', file), 'utf8');
    expect(src('courier-prime-regular.ts')).toContain(`${SIZE} bytes, SHA-256 ${SHA256}`);
    expect(src('README.md')).toContain(`(${SIZE} bytes) | \`${SHA256}\` (the TTF)`);
  });
});

describe('renderPdf — the embedded font program', () => {
  it('writes the whole font as FontFile2, in hexadecimal, byte for byte', async () => {
    const font = await loadCourierPrime();
    const pdf = decode(renderPdf(blocksOf(SCRIPT_ONE_ACT), { title: 'T' }, font).bytes);
    expect(pdf).toContain(`/Length1 ${font.bytes.length} /Filter /ASCIIHexDecode`);
    expect(pdf).toContain('/Subtype /TrueType /BaseFont /CourierPrime /FirstChar 32 /LastChar 255');
    expect(pdf).toContain('/Encoding /WinAnsiEncoding /FontDescriptor');
    const program = /\/ASCIIHexDecode >>\nstream\n([0-9A-F\n]+)>\nendstream/.exec(pdf)?.[1] ?? '';
    const digits = program.replace(/\n/g, '');
    expect(digits.length).toBe(font.bytes.length * 2);
    const back = new Uint8Array(digits.length / 2);
    for (let i = 0; i < back.length; i++) back[i] = parseInt(digits.slice(2 * i, 2 * i + 2), 16);
    expect(back).toEqual(font.bytes);
  });

  it('keeps every byte ASCII and every xref offset exact with the font in the file', async () => {
    const { bytes, pageCount } = renderPdf(blocksOf(SCRIPT_ONE_ACT), { title: 'T', author: 'A. Writer' }, await loadCourierPrime());
    expect(bytes.every((byte) => byte < 0x80)).toBe(true);
    const pdf = decode(bytes);
    expect(pdf).toContain('/Author (A. Writer)');
    const xref = Number(/startxref\n(\d+)\n/.exec(pdf)?.[1]);
    const lines = pdf.slice(xref).split('\n');
    const objects = Number(/^0 (\d+)$/m.exec(pdf.slice(xref, xref + 40))?.[1]) - 1;
    // Control: the catalogue, the page tree, the font and the info, two objects a page, the descriptor and the program.
    // A header the regexes miss gives NaN here, and the loop below would check nothing.
    expect(objects).toBe(4 + 2 * pageCount + 2);
    for (let object = 1; object <= objects; object++) {
      const offset = Number(lines[2 + object]?.slice(0, 10));
      expect(pdf.slice(offset).startsWith(`${object} 0 obj\n`), `object ${object}`).toBe(true);
    }
  });
});

describe('the font is loaded lazily', () => {
  it('is reached only by the dynamic import in render-pdf.ts', () => {
    const src = (file: string): string => readFileSync(resolve(__dirname, '../src', file), 'utf8');
    const renderer = src('render-pdf.ts');
    expect(renderer).toContain("await import('./fonts/courier-prime-regular.js')");
    expect(renderer).not.toMatch(/^import[^\n]*courier-prime-regular/m);
    for (const file of ['index.ts', 'pdf.ts', 'paginate.ts']) expect(src(file)).not.toContain('courier-prime-regular');
  });
});
