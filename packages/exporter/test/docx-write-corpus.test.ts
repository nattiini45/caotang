/**
 * The DOCX write corpus: the contents-field cases of issue #26, written through the exporter's own renderer to the
 * directory CAOTANG_DOCX_OUT names, with expected.json beside them (per file: whether a contents field is expected and the
 * entry titles, in order). It writes nothing without the variable, so `pnpm verify` is unchanged. The files are for opening
 * by hand in Word, Pages and Google Docs (docs/testing/office-interop.md); nothing here checks them in an application.
 *
 * The cases that need no directory run always: each file is unzipped and its structure checked, so expected.json cannot
 * describe a field the file does not hold.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate/browser';
import { renderDocx } from '../src/render-docx.js';
import type { RenderInput } from '../src/render-input.js';
import { DEFAULT_TEMPLATE } from '../src/template.js';
import type { FlatBlock } from '../src/types.js';

const OUT = process.env['CAOTANG_DOCX_OUT'] ?? '';

interface DocxCase {
  readonly file: string;
  readonly toc: boolean;
  /** The chapter titles, as the binder holds them. */
  readonly chapters: readonly string[];
}

interface ExpectedDocx {
  readonly file: string;
  /** Whether the file holds a contents field, and so `updateFields` in its settings. */
  readonly contents: boolean;
  /** The cached entry titles, in order, as Word shows them before any update. */
  readonly entries: readonly string[];
}

const CASES: readonly DocxCase[] = [
  { file: 'toc-3-chapters.docx', toc: true, chapters: ['The Landing', 'The Storm', 'Morning'] },
  {
    file: 'toc-unicode.docx',
    toc: true,
    chapters: ['Café à la crème', '第一章 川を渡る', 'Storm \u{1F30A} & Calm', '<Beacon> "lit" \'twice\''],
  },
  { file: 'toc-one-chapter.docx', toc: true, chapters: ['The Only Chapter'] },
  { file: 'toc-off.docx', toc: false, chapters: ['The Landing', 'The Storm'] },
  { file: 'toc-long.docx', toc: true, chapters: Array.from({ length: 40 }, (_, i) => `Chapter title number ${i + 1}`) },
];

function inputOf(entry: DocxCase): RenderInput {
  const blocks: FlatBlock[] = [{ kind: 'frontmatter', fmKind: 'titlepage' }];
  entry.chapters.forEach((title, index) => {
    blocks.push({ kind: 'chapter', title, level: 1, number: index + 1 });
    blocks.push({ kind: 'scene', docId: `n_SCENE${index}`, title, body: `Text of ${title}.`, number: 1 });
  });
  return { blocks, title: 'Contents field corpus', author: 'M. Ortega', date: '2026-10-08', template: DEFAULT_TEMPLATE, toc: entry.toc };
}

function expectedOf(entry: DocxCase): ExpectedDocx {
  const contents = entry.toc && entry.chapters.length > 0;
  return { file: entry.file, contents, entries: contents ? entry.chapters.map((title, index) => `${index + 1}. ${title}`) : [] };
}

/** XML text back to characters: `&amp;` last, so `&amp;lt;` reads as the text `&lt;`. */
const unescapeXml = (text: string): string =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');

/** The text of each paragraph inside the contents control, in order. */
function cachedEntries(documentXml: string): string[] {
  const start = documentXml.indexOf('<w:sdt>');
  const end = documentXml.indexOf('</w:sdt>');
  if (start < 0 || end < 0) return [];
  const field = documentXml.slice(start, end);
  const out: string[] = [];
  for (const paragraph of field.split('</w:p>')) {
    let text = '';
    let at = 0;
    for (;;) {
      // `<w:t` alone would also match `<w:tab` and `<w:tabs`.
      const spaced = paragraph.indexOf('<w:t ', at);
      const bare = paragraph.indexOf('<w:t>', at);
      const open = spaced < 0 ? bare : bare < 0 ? spaced : Math.min(spaced, bare);
      if (open < 0) break;
      const tagEnd = paragraph.indexOf('>', open);
      const close = paragraph.indexOf('</w:t>', tagEnd);
      if (tagEnd < 0 || close < 0) break;
      text += unescapeXml(paragraph.slice(tagEnd + 1, close));
      at = close + 6;
    }
    if (text !== '') out.push(text);
  }
  return out;
}

describe('the DOCX write corpus — structure', () => {
  it.each(CASES.map((entry) => [entry.file, entry] as const))('%s holds the contents field expected.json says', async (_name, entry) => {
    const expected = expectedOf(entry);
    const parts = unzipSync(await renderDocx(inputOf(entry)));
    const body = strFromU8(parts['word/document.xml'] ?? new Uint8Array());
    const settings = strFromU8(parts['word/settings.xml'] ?? new Uint8Array());

    expect(body.includes('<w:sdt>')).toBe(expected.contents);
    expect(settings.includes('<w:updateFields/>')).toBe(expected.contents);
    expect(cachedEntries(body)).toEqual(expected.entries);
    if (expected.contents) {
      for (const type of ['begin', 'separate', 'end']) expect(body).toContain(`<w:fldChar w:fldCharType="${type}"`);
      expect(body).not.toContain('<w:hyperlink');
      expect(body).not.toContain('_Toc');
    }
  });
});

describe.skipIf(OUT === '')('the DOCX write corpus — files', () => {
  it.each(CASES.map((entry) => [entry.file, entry] as const))('writes %s through the exporter', async (_name, entry) => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, entry.file), await renderDocx(inputOf(entry)));
  });

  it('writes expected.json for the files above', () => {
    writeFileSync(resolve(OUT, 'expected.json'), `${JSON.stringify({ files: CASES.map(expectedOf) }, null, 2)}\n`);
  });
});
