/**
 * The PDF validation gate (tools/pdf-validate/check.mjs) on a one-page PDF written here by hand: what it accepts, and each way it
 * fails. The corpus the gate runs on in CI is written by packages/exporter/test/pdf-write-corpus.test.ts; the last describe ties
 * the tools the gate runs to the ones the pdf-validate job in ci.yml installs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_TOOLS,
  checkStructure,
  checkWithPdfjs,
  compareFonts,
  fontsOf,
  mutoolComplaints,
  parsePdffonts,
  unsubset,
  withoutNoText,
  type ExpectedFile,
} from '../tools/pdf-validate/check.mjs';

/** A classic-xref PDF with the text "Hello PDF" in Helvetica on a 200 x 100 page. `shift` moves one xref offset off its object. */
function pdf(options: { shift?: number; eof?: boolean } = {}): Uint8Array {
  const stream = 'BT /F1 12 Tf 20 50 Td (Hello PDF) Tj ET';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = bodies.map((body, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset, i) => {
    out += `${String(offset + (i === 2 ? (options.shift ?? 0) : 0)).padStart(10, '0')} 00000 n \n`;
  });
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n`;
  if (options.eof !== false) out += '%%EOF\n';
  return new TextEncoder().encode(out);
}

const HELVETICA = { name: 'Helvetica', embedded: false, toUnicode: false };

const EXPECTED: ExpectedFile = {
  file: 'hello.pdf',
  format: 'pdf',
  pages: [['Hello PDF']],
  size: [200, 100],
  fonts: [HELVETICA],
};

describe('checkStructure', () => {
  it('accepts a file whose xref entries point at their objects', () => {
    expect(checkStructure(pdf())).toEqual([]);
  });

  it('names the xref entry that points off its object', () => {
    const problems = checkStructure(pdf({ shift: 1 }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^xref entry 3 points at byte \d+, which is not "3 0 obj"$/);
  });

  it('fails a file that is not closed with %%EOF', () => {
    expect(checkStructure(pdf({ eof: false }))).toEqual(['the file does not end with %%EOF']);
  });

  it('fails bytes that are not a PDF', () => {
    expect(checkStructure(new TextEncoder().encode('hello'))).toContain('the file does not start with %PDF-');
  });
});

describe('fonts', () => {
  it('reads the fonts a file names, and whether each is embedded and has a ToUnicode map', async () => {
    expect(await fontsOf(pdf())).toEqual([HELVETICA]);
  });

  it('removes a subset tag from a name', () => {
    expect(unsubset('ABCDEF+NotoEmoji-Regular')).toBe('NotoEmoji-Regular');
    expect(unsubset('Helvetica-Bold')).toBe('Helvetica-Bold');
    expect(unsubset('abcdef+Name')).toBe('abcdef+Name');
  });

  it('fails a missing font, an unexpected one, an embedding that differs, and a missing ToUnicode map', () => {
    const cjk = { name: 'NotoSansMonoCJKsc-Regular', embedded: true, toUnicode: true };
    expect(compareFonts([HELVETICA, cjk], [HELVETICA])).toEqual(['no font named NotoSansMonoCJKsc-Regular']);
    expect(compareFonts([HELVETICA], [HELVETICA, cjk])).toEqual(['unexpected font NotoSansMonoCJKsc-Regular']);
    expect(compareFonts([cjk], [{ ...cjk, embedded: false }])).toEqual(['NotoSansMonoCJKsc-Regular is not embedded, expected embedded']);
    expect(compareFonts([cjk], [{ ...cjk, toUnicode: false }])).toEqual(['NotoSansMonoCJKsc-Regular has no ToUnicode map']);
  });

  it('reads a pdffonts table, whose type column has spaces', () => {
    const table = [
      'name                                 type              encoding         emb sub uni object ID',
      '------------------------------------ ----------------- ---------------- --- --- --- ---------',
      'CourierPrime                         TrueType          WinAnsi          yes no  no       9  0',
      'ABCDEF+NotoSansMonoCJKsc-Regular     CID Type 0C (OT)  Identity-H        yes yes yes     14  0',
      '',
    ].join('\n');
    expect(parsePdffonts(table)).toEqual([
      { name: 'CourierPrime', embedded: true, toUnicode: false },
      { name: 'NotoSansMonoCJKsc-Regular', embedded: true, toUnicode: true },
    ]);
  });
});

describe('withoutNoText', () => {
  it('drops the zero-width space the writers map a glyph with no text to, and nothing else', () => {
    expect(withoutNoText('الف​يلم​')).toBe('الفيلم');
    expect(withoutNoText('Hello ​World')).toBe('Hello World');
  });

  it('keeps every other character, so a word with a control character, a space or a stray letter in it still fails the gate', () => {
    for (const junk of ['\u0013', '\u0011', ' ', 'A', '7', '‌', '‍', ' ', '﻿']) {
      expect(withoutNoText(`الف${junk}يلم`), JSON.stringify(junk)).toBe(`الف${junk}يلم`);
    }
  });

  it('leaves reversed text reversed, so the gate still fails it: the letters stay in the order the reader gave them', () => {
    expect(withoutNoText('ةراس')).toBe('ةراس');
    expect(withoutNoText('םולש')).not.toContain('שלום');
  });
});

describe('checkWithPdfjs', () => {
  it('accepts the file when its page count, size and text are the expected ones', async () => {
    expect(await checkWithPdfjs(pdf(), EXPECTED)).toEqual([]);
  });

  it('fails text the page does not give back, and a page that is not the size expected.json says', async () => {
    const wrong: ExpectedFile = { ...EXPECTED, pages: [['Goodbye']], size: [595.28, 841.89] };
    const problems = await checkWithPdfjs(pdf(), wrong);
    expect(problems).toContain('page 1 is 200 x 100, expected 595.28 x 841.89');
    expect(problems).toContain('page 1: pdf.js text does not hold "Goodbye"');
  });

  it('fails a page count that is not the expected one', async () => {
    const problems = await checkWithPdfjs(pdf(), { ...EXPECTED, pages: [['Hello PDF'], ['More']] });
    expect(problems).toContain('pdf.js counts 1 pages, expected 2');
  });

  it('fails a file whose xref entry is off, which pdf.js has to repair or refuse', async () => {
    expect(await checkWithPdfjs(pdf({ shift: 1 }), EXPECTED)).not.toEqual([]);
  });
});

describe('the pdf-validate job in ci.yml', () => {
  const ci = readFileSync(resolve(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const start = ci.indexOf('\n  pdf-validate:');
  const job = start < 0 ? '' : ci.slice(start);

  it('exists, and installs the package of every external tool the gate runs', () => {
    expect(job).not.toBe('');
    const packages: Record<string, string> = {
      qpdf: 'qpdf',
      pdffonts: 'poppler-utils',
      pdftotext: 'poppler-utils',
      pdftoppm: 'poppler-utils',
      gs: 'ghostscript',
      mutool: 'mupdf-tools',
    };
    expect([...EXTERNAL_TOOLS].sort()).toEqual(Object.keys(packages).sort());
    const install = job.split('\n').find((line) => line.includes('apt-get install')) ?? '';
    for (const tool of EXTERNAL_TOOLS) expect(install, tool).toContain(packages[tool]);
  });

  it('writes the corpus, runs the gate with every external tool, and uploads the corpus and logs on failure', () => {
    expect(job).toContain('CAOTANG_PDF_OUT');
    expect(job).toContain('packages/exporter/test/pdf-write-corpus.test.ts');
    expect(job).toContain('node tools/pdf-validate/check.mjs');
    expect(job).toContain('--external');
    expect(job).toContain('if: failure()');
  });

  it('sets the corpus folder with a context a job-level env allows (runner exists only inside steps)', () => {
    const env = job.slice(job.indexOf('\n    env:'), job.indexOf('\n    steps:'));
    expect(env).toContain('CAOTANG_PDF_OUT');
    expect(env).not.toContain('runner.');
    expect(job).not.toContain('runner.temp');
  });

  it('keeps the workflow-wide read-only token', () => {
    expect(ci).toContain('permissions:\n  contents: read');
    expect(job).not.toContain('permissions:');
  });
});

describe('mutoolComplaints', () => {
  it('ignores the line a MuPDF build without LittleCMS prints on every draw, and keeps every warning about the file', () => {
    expect(mutoolComplaints('warning: ICC support is not available\n')).toEqual([]);
    expect(mutoolComplaints('warning: ICC support is not available\nwarning: unknown cmap\nerror: syntax error in content stream\n')).toEqual([
      'warning: unknown cmap',
      'error: syntax error in content stream',
    ]);
    expect(mutoolComplaints('warning: ICC support is not available for this page\n')).toEqual(['warning: ICC support is not available for this page']);
    expect(mutoolComplaints('page 1 drawn\n')).toEqual([]);
  });
});
