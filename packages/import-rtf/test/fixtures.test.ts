import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { attr, descendants, readXml, textOf } from '@caotang/import-read/xml';

import { fixture, lossMessages, mdOf, PIXEL_PNG, read } from './helpers.js';

/**
 * Whole files. `textedit-cocoa.rtf`, `word-styles.rtf`, `cjk-fonts.rtf`, `ansicpg936.rtf` and `mac-roman.rtf` are written by hand in
 * the shapes TextEdit (Cocoa RTF) and Word write; `draft-bench/` holds real Scrivener 3 for Windows files with Scrivener's own text
 * extraction beside them (see its README).
 */

describe('TextEdit (Cocoa RTF, \\uc0)', () => {
  const imported = read(fixture('textedit-cocoa.rtf'));

  it('reads the text, the emoji, the lists and the link, and skips the Cocoa noise', () => {
    expect(mdOf(imported)).toEqual([
      '**Chapter One**',
      '“Café,” she said — “naïve” and 😀 done.',
      '',
      '- First point',
      '- Second point',
      '1. Numbered one',
      '2. Numbered two',
      '[*Caotang*](https://caotang.app/) and *underlined* text with *italic* ***bold-italic*** **bold**.',
    ]);
    expect(imported.document.blocks[0]).toMatchObject({ src: { align: 'center', allBold: true, fontSizeRel: 1.5 } });
  });

  it('counts what it does not keep', () => {
    expect(lossMessages(imported)).toEqual([
      'formatting: Centred and right-aligned paragraphs are kept as ordinary paragraphs.',
      'formatting: Underlined text is set in italics, since a scene has no underline. ×2',
      'formatting: Fonts are not kept; scenes use the project font. ×3',
      'formatting: Text colours are not kept.',
    ]);
  });
});

describe('Word (styles, footnotes, comments, tables, pictures, \\uc1)', () => {
  const imported = read(fixture('word-styles.rtf'));

  it('reads headings as style and outline signals, the text, the table rows and the pictures', () => {
    expect(mdOf(imported)).toEqual([
      '**Part One**',
      '***The Landing***',
      'The keeper wrote in the log[^1] every night. Chinese: 中文. Emoji: 😀. new words',
      '12',
      'click me and see above',
      '<page>',
      'Name | Role',
      'Ada | Keeper',
      'After the table.',
      '<image rtf-image-1.png>',
      '',
      '![](rtf-image-2.jpg) A caption beside it.',
    ]);
    expect(imported.document.blocks.slice(0, 2).map((b) => (b.kind === 'para' ? b.src : undefined))).toEqual([
      { styleName: 'heading 1', outlineLevel: 1, allBold: true, fontSizeRel: 1.33 },
      { styleName: 'heading 2', outlineLevel: 2, allBold: true, fontSizeRel: 1.17 },
    ]);
  });

  it('keeps the footnote, the comment and the metadata', () => {
    expect(imported.document.footnotes).toEqual([{ blockIndex: 2, label: '1', md: 'The log is kept in the lamp room.\n\nSecond paragraph of the note.' }]);
    expect(imported.document.comments).toEqual([{ blockIndex: 2, md: 'Check this date.', author: 'Jane Writer' }]);
    expect(imported.document.metadata).toEqual({ title: 'The Lighthouse', author: 'Jane Writer' });
    expect(imported.document.assets?.map((a) => a.mime)).toEqual(['image/png', 'image/jpeg']);
    expect([...imported.assetData.get('rtf-image-1.png')!]).toEqual([...PIXEL_PNG]);
  });

  it('names every loss, the hidden text and deleted words among them', () => {
    expect(lossMessages(imported)).toEqual([
      'unsupported: Page headers and footers are not imported.',
      'field: PAGE fields are kept as the text they showed.',
      'formatting: Centred and right-aligned paragraphs are kept as ordinary paragraphs.',
      'field: Links to targets other than web and mail addresses are kept as their text.',
      'field: Links to a place inside the document are kept as their text.',
      'image-unreadable: Pictures saved as Windows enhanced metafiles (EMF) are not imported.',
      'formatting: Hidden text is not imported; it is listed for the scan. ×23',
      'tracked-change: Text marked as deleted in tracked changes is not imported; inserted text is kept. ×8',
      'table: Tables are kept as one paragraph per row, with the cells separated by " | ".',
      'formatting: Fonts are not kept; scenes use the project font. ×2',
    ]);
    expect(imported.scanExtra.map((s) => s.where)).toEqual(['field PAGE', 'field HYPERLINK', 'field HYPERLINK', 'hidden text', 'deleted text']);
  });
});

describe('code pages', () => {
  it('reads GBK, Shift-JIS, Big5 and Cyrillic fonts in one file', () => {
    expect(mdOf(read(fixture('cjk-fonts.rtf')))).toEqual(['GBK: 中文草堂', 'Shift-JIS: 日本語', 'Big5: 臺灣', 'Cyrillic: Привет']);
  });

  it('reads a GBK document (\\ansicpg936) and a Mac Roman one', () => {
    expect(mdOf(read(fixture('ansicpg936.rtf')))).toEqual(['中文草堂 and ASCII.']);
    expect(mdOf(read(fixture('mac-roman.rtf')))).toEqual(['Café über alles']);
  });
});

describe('Scrivener 3 for Windows, against Scrivener’s own text (draft-bench)', () => {
  const base = new URL('./fixtures/draft-bench/', import.meta.url);
  const index = readXml(readFileSync(new URL('search.indexes', base)));
  if (!index.ok) throw index.error;
  const scrivener = new Map<string, string>();
  for (const document of descendants(index.document.root, 'Document')) {
    const text = [...descendants(document, 'Text')][0];
    if (text !== undefined) scrivener.set(attr(document, 'ID') ?? '', textOf(text));
  }
  const files = readdirSync(new URL('content/', base)).filter((f) => f.endsWith('.rtf'));
  const words = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;
  const normal = (text: string): string => text.replace(/\s+/g, ' ').trim();

  it('has the eighteen documents', () => {
    expect(files).toHaveLength(18);
  });

  for (const file of files) {
    const id = file.replace(/\.rtf$/, '');
    it(`${id}: the same text and word count as Scrivener`, () => {
      const imported = read(new Uint8Array(readFileSync(new URL(`content/${file}`, base))));
      // Scrivener's own style markers (<$Scr_Ps::0>) are the Scrivener pass's to remove (#277), and a table row's " | " is ours.
      const ours = imported.document.blocks
        .map((b) => (b.kind === 'para' ? b.text : b.kind === 'other' ? b.md.replaceAll(' | ', ' ') : ''))
        .join('\n')
        .replace(/<!?\$Scr_[A-Za-z]+::\d+>/g, ' ');
      const theirs = scrivener.get(id) ?? '';
      expect(normal(ours)).toBe(normal(theirs));
      const count = words(theirs);
      expect(Math.abs(words(ours) - count)).toBeLessThanOrEqual(Math.ceil(count * 0.01));
    });
  }

  it('lists the linked comment for the Scrivener pass and reads the template guide’s lists', () => {
    const comment = read(new Uint8Array(readFileSync(new URL('content/A9C97B44-46C8-4CA8-8F28-B8C0606A58EF.rtf', base))));
    expect(comment.links).toEqual([{ blockIndex: 3, target: 'scrivcmt://C22DA3B1-5EA9-4FFD-84D8-DDB36384E416', text: 'dictum.' }]);
    const guide = mdOf(read(new Uint8Array(readFileSync(new URL('content/F8F9FDEF-FD9F-4A8C-B33D-3434A1220ADC.rtf', base)))));
    expect(guide.filter((line) => /^\s*(-|\d+\.) /.test(line)).length).toBeGreaterThan(20);
  });
});
