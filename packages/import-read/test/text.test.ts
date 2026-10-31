import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { splitImport, type ImportBlock, type ProposedNode } from '@caotang/import-core';
import { describe, expect, it } from 'vitest';

import {
  decodePlainText,
  detectParagraphMode,
  escapePlainMarkdown,
  MAX_TEXT_BYTES,
  normalisePlainText,
  plainTextBlocks,
  readPlainText,
} from '../src/text.js';

/**
 * The plain-text reader (#283): the fixtures in `fixtures/text/` are a manuscript in UTF-8 and in Windows-1252 (CRLF), which the
 * test also writes as UTF-16 LE (CRLF) and BE with byte-order marks; a Word "Save as text" file (one line per paragraph, no blank lines, a no-break
 * space); and a Shift JIS file the reader must ask about rather than guess.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/text/', import.meta.url));
const UTF8_MANUSCRIPT = readFileSync(FIXTURES + 'manuscript-utf8.txt', 'utf8');

/** UTF-16 with its byte-order mark, built from the UTF-8 fixture: the zero bytes would make a checked-in copy a control-byte file. */
function utf16(text: string, order: 'le' | 'be'): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out.set(order === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out[2 + i * 2 + (order === 'le' ? 0 : 1)] = unit & 0xff;
    out[2 + i * 2 + (order === 'le' ? 1 : 0)] = unit >> 8;
  }
  return out;
}

/** The fixtures, plus the manuscript as UTF-16 LE with Windows line ends and as UTF-16 BE. */
function bytesOf(name: string): Uint8Array {
  if (name === 'manuscript-utf16le.txt') return utf16(UTF8_MANUSCRIPT.replace(/\n/g, '\r\n'), 'le');
  if (name === 'manuscript-utf16be.txt') return utf16(UTF8_MANUSCRIPT, 'be');
  return new Uint8Array(readFileSync(FIXTURES + name));
}

/** The proposed tree as indented `role: title` lines. */
function outline(nodes: ProposedNode[], depth = 0): string[] {
  return nodes.flatMap((node) => {
    const line = `${'  '.repeat(depth)}${node.role}: ${node.title}`;
    return node.kind === 'folder' ? [line, ...outline(node.children, depth + 1)] : [line];
  });
}

function read(name: string, options?: Parameters<typeof readPlainText>[1]) {
  const result = readPlainText(bytesOf(name), options);
  if (result.status !== 'read') throw new Error(`${name}: ${result.status}`);
  return result;
}

const paraTexts = (blocks: ImportBlock[]): string[] => blocks.flatMap((b) => (b.kind === 'para' ? [b.text] : []));

describe('decodePlainText reads every common encoding through the store detection', () => {
  it.each([
    ['manuscript-utf8.txt', 'utf-8', false],
    ['manuscript-utf16le.txt', 'utf-16le', false],
    ['manuscript-utf16be.txt', 'utf-16be', false],
    ['manuscript-cp1252.txt', 'windows-1252', true],
  ] as const)('%s decodes as %s', (name, encoding, guessed) => {
    const decoded = decodePlainText(bytesOf(name));
    expect(decoded.status).toBe('decoded');
    if (decoded.status !== 'decoded') return;
    expect(decoded.encoding).toBe(encoding);
    expect(decoded.guessed).toBe(guessed);
    const text = normalisePlainText(decoded.text).text;
    expect(text).toBe(UTF8_MANUSCRIPT);
    // The Windows-1252 block 0x80–0x9F: curly quotes and the em dash, not C1 controls.
    expect(text).toContain('“Late again,” she said\nto nobody — the gulls didn’t care.');
    expect(text).toContain('café');
  });

  it('a UTF-8 byte-order mark is consumed, not imported', () => {
    const decoded = decodePlainText(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Chapter 1')]));
    expect(decoded).toMatchObject({ status: 'decoded', encoding: 'utf-8', guessed: false, text: 'Chapter 1' });
  });

  it('asks when the best reading is not one it may guess (Shift JIS), preselecting that reading', () => {
    const decoded = decodePlainText(bytesOf('shift-jis.txt'));
    expect(decoded.status).toBe('ask');
    if (decoded.status !== 'ask') return;
    expect(decoded.detection.candidates.length).toBeGreaterThan(1);
    expect(decoded.suggested).toBe(decoded.detection.candidates[0]?.encoding);
  });

  it('asks when no candidate reads as text (binary bytes)', () => {
    const binary = Uint8Array.from({ length: 256 }, (_, i) => (i * 37) % 256);
    expect(decodePlainText(binary).status).toBe('ask');
  });

  it('decodes as the writer’s pick once asked, and marks it as a choice rather than a certainty', () => {
    const decoded = decodePlainText(bytesOf('shift-jis.txt'), { encoding: 'shift_jis' });
    expect(decoded).toMatchObject({ status: 'decoded', encoding: 'shift_jis', guessed: true });
    if (decoded.status !== 'decoded') return;
    expect(decoded.text).toContain('第一章');
    expect(decoded.text).toContain('灯台守の娘');
    const read = readPlainText(bytesOf('shift-jis.txt'), { encoding: 'shift_jis' });
    expect(read.status).toBe('read');
  });

  it('refuses a file past the size cap without decoding it', () => {
    const big = new Uint8Array(MAX_TEXT_BYTES + 1);
    expect(decodePlainText(big)).toEqual({ status: 'too-large', bytes: MAX_TEXT_BYTES + 1, limit: MAX_TEXT_BYTES });
  });
});

describe('normalisePlainText', () => {
  it('turns CRLF, CR and Unicode line separators into LF and no-break spaces into spaces, counting them', () => {
    const { text, noBreakSpaces, controls } = normalisePlainText('\uFEFFa\r\nb\rc\u2028d\u00a0e\u202Ff\u0007g');
    expect(text).toBe('a\nb\nc\nd e fg');
    expect(noBreakSpaces).toBe(2);
    expect(controls).toBe(1);
  });

  it('keeps tabs and the form feed', () => {
    expect(normalisePlainText('a\tb\fc').text).toBe('a\tb\fc');
  });
});

describe('detectParagraphMode', () => {
  it('reads Word’s "Save as text" (many lines, no blank lines) as one line per paragraph', () => {
    expect(detectParagraphMode(normalisePlainText(new TextDecoder().decode(bytesOf('word-save-as-text.txt'))).text)).toBe('line');
  });

  it('reads a blank-separated, hard-wrapped file as blank-line paragraphs', () => {
    expect(detectParagraphMode(UTF8_MANUSCRIPT)).toBe('blank');
  });

  it('keeps a short file without blank lines as one paragraph per blank-separated block', () => {
    expect(detectParagraphMode('one line\nand another\n')).toBe('blank');
  });
});

describe('escapePlainMarkdown keeps prose from being read as Markdown', () => {
  it.each([
    ['# Not a heading', '\\# Not a heading'],
    ['> Not a quote', '\\> Not a quote'],
    ['- a dash', '\\- a dash'],
    ['+ a plus', '\\+ a plus'],
    ['* a star', '\\* a star'],
    ['1. a number', '1\\. a number'],
    ['12) a number', '12\\) a number'],
    ['===', '\\==='],
    ['*not emphasis* and _not either_', '\\*not emphasis\\* and \\_not either\\_'],
    ['a [link](x) and <b>tag</b> and `code` and ~~strike~~ and a\\b', 'a \\[link\\](x) and \\<b>tag\\</b> and \\`code\\` and \\~\\~strike\\~\\~ and a\\\\b'],
    ['Tom &amp; Jerry & co', 'Tom &amp;amp; Jerry & co'],
    ['a footnote[^1]', 'a footnote\\[^1\\]'],
    ['#hashtag stays', '#hashtag stays'],
    ['-5 degrees', '-5 degrees'],
    ['1984 was a year.', '1984 was a year.'],
  ])('%s', (input, md) => {
    expect(escapePlainMarkdown(input)).toBe(md);
  });
});

describe('plainTextBlocks', () => {
  it('builds blank-separated paragraphs, joins hard-wrapped lines and keeps chapter lines and breaks apart', () => {
    const { doc, paragraphs, detectedParagraphs } = read('manuscript-utf8.txt');
    expect(paragraphs).toBe('blank');
    expect(detectedParagraphs).toBe('blank');
    const kinds = doc.blocks.map((b) => (b.kind === 'para' ? b.text.slice(0, 24) : b.kind === 'break' ? `break ${b.marker}` : b.kind));
    expect(kinds).toEqual([
      "THE KEEPER'S DAUGHTER",
      'by A. N. Author',
      'CHAPTER ONE',
      'The ferry came at noon, ',
      'Her father was asleep be',
      'break * * *',
      'By evening the wind had ',
      'CHAPTER TWO',
      'The letter arrived on a ',
      '# Not a heading, just a ',
      '- a line that starts wit',
      'break * * *',
      'She burned it in the sto',
      'CHAPTER THREE',
      'Spring came late to the ',
    ]);
    const ferry = doc.blocks[3];
    expect(ferry).toMatchObject({
      kind: 'para',
      text: 'The ferry came at noon, as it always did, and Mara watched it cross the grey water from the lamp room. “Late again,” she said to nobody — the gulls didn’t care.',
    });
    // Signals: capitals, and the extra blank line before a chapter (one blank line is only the paragraph separator).
    expect(doc.blocks[2]).toMatchObject({ kind: 'para', text: 'CHAPTER ONE', src: { allCaps: true, emptyBefore: 1 } });
    expect(doc.blocks[1]).toMatchObject({ src: { emptyAfter: 1 } });
    // The list line and the numbered line were one hard-wrapped paragraph; only its start is escaped.
    expect(doc.blocks[10]).toMatchObject({ md: '\\- a line that starts with a dash 1. and one that starts with a number' });
    expect(doc.blocks[9]).toMatchObject({ md: '\\# Not a heading, just a hash. > Not a quote either.' });
    expect(doc.losses).toBeUndefined();
  });

  it('every encoding of the manuscript gives the same blocks', () => {
    const utf8 = read('manuscript-utf8.txt').doc;
    for (const name of ['manuscript-utf16le.txt', 'manuscript-utf16be.txt', 'manuscript-cp1252.txt']) expect(read(name).doc, name).toEqual(utf8);
  });

  it('a chapter line directly above its text (no blank line) still stands alone, and so does a setext underline heading', () => {
    const { doc } = plainTextBlocks('Chapter 1\nThe ferry came at noon\nand left at one.\n\nThe Landing\n===========\nShe walked up the hill.\n');
    expect(paraTexts(doc.blocks)).toEqual(['Chapter 1', 'The ferry came at noon and left at one.', 'The Landing', 'She walked up the hill.']);
  });

  it('a form feed is a page break, and leading indentation is dropped and reported', () => {
    const { doc } = plainTextBlocks('    Indented first line.\n\n\fChapter 2\n\nText.\n');
    expect(doc.blocks.map((b) => b.kind)).toEqual(['para', 'pagebreak', 'para', 'para']);
    expect(doc.blocks[0]).toMatchObject({ md: 'Indented first line.' });
    expect(doc.losses).toEqual([{ code: 'formatting', count: 1, message: 'Leading indentation was dropped from lines that had it.' }]);
  });

  it('reports normalised no-break spaces, removed controls and undecodable bytes', () => {
    const { doc } = plainTextBlocks('a\u00a0b\u0001c \uFFFD\n');
    expect(doc.losses?.map((l) => [l.code, l.count])).toEqual([
      ['formatting', 1],
      ['unsupported', 1],
      ['unsupported', 1],
    ]);
  });

  it('keeps the file name as the title', () => {
    expect(plainTextBlocks('Text.', { fileName: 'C:\\Books\\The Keeper (final).TXT' }).doc.metadata).toEqual({ title: 'The Keeper (final)' });
    expect(plainTextBlocks('Text.').doc.metadata).toBeUndefined();
  });

  it('reads Word’s "Save as text" one line per paragraph, and the toggle switches it back', () => {
    const auto = read('word-save-as-text.txt', { fileName: 'keeper.txt' });
    expect(auto.paragraphs).toBe('line');
    expect(auto.detectedParagraphs).toBe('line');
    expect(paraTexts(auto.doc.blocks)).toHaveLength(13);
    expect(auto.doc.blocks.filter((b) => b.kind === 'break')).toHaveLength(1);
    expect(paraTexts(auto.doc.blocks)[2]).toBe('“Late again,” she said to nobody — the gulls didn’t care.');
    expect(auto.doc.losses).toEqual([{ code: 'formatting', count: 1, message: 'No-break spaces were read as ordinary spaces.' }]);

    const blank = read('word-save-as-text.txt', { paragraphs: 'blank' });
    expect(blank.paragraphs).toBe('blank');
    expect(blank.detectedParagraphs).toBe('line');
    // Without blank lines, the chapter lines still stand alone, but each chapter's text is one paragraph.
    expect(paraTexts(blank.doc.blocks).length).toBeLessThan(paraTexts(auto.doc.blocks).length);
  });

  it('forcing one line per paragraph on a hard-wrapped file makes every line a paragraph', () => {
    const lines = read('manuscript-utf8.txt', { paragraphs: 'line' });
    expect(paraTexts(lines.doc.blocks)).toContain('cross the grey water from the lamp room. “Late again,” she said');
  });

  it('is pure: the same text gives the same blocks', () => {
    const text = UTF8_MANUSCRIPT;
    expect(plainTextBlocks(text)).toEqual(plainTextBlocks(text));
  });
});

describe('the shared splitter turns a text manuscript into chapters and scenes', () => {
  it('"CHAPTER ONE" lines split chapters and * * * lines split scenes', () => {
    const result = splitImport(read('manuscript-utf8.txt', { fileName: 'keeper.txt' }).doc);
    expect(outline(result.tree)).toEqual([
      'chapter: CHAPTER ONE',
      '  scene: CHAPTER ONE · 1',
      '  scene: CHAPTER ONE · 2',
      'chapter: CHAPTER TWO',
      '  scene: CHAPTER TWO · 1',
      '  scene: CHAPTER TWO · 2',
      'chapter: CHAPTER THREE',
      '  scene: CHAPTER THREE · 1',
    ]);
    expect(result.stats).toMatchObject({ chapters: 3, scenes: 5 });
    // The title page is front matter, kept (Research by default), never dropped.
    expect(result.frontMatter).toMatchObject({ startBlock: 0, endBlock: 1, destination: 'research' });
    expect(result.frontMatter?.body).toContain('by A. N. Author');
  });

  it('a Word "Save as text" manuscript splits at its "Chapter N" lines and its *** break', () => {
    const result = splitImport(read('word-save-as-text.txt').doc);
    expect(outline(result.tree)).toEqual([
      'chapter: Chapter 1',
      '  scene: Chapter 1 · 1',
      '  scene: Chapter 1 · 2',
      'chapter: Chapter 2',
      '  scene: Chapter 2 · 1',
      'chapter: Chapter 3',
      '  scene: Chapter 3 · 1',
    ]);
  });

  it('a Windows-1252 manuscript splits the same as its UTF-8 original', () => {
    expect(outline(splitImport(read('manuscript-cp1252.txt').doc).tree)).toEqual(outline(splitImport(read('manuscript-utf8.txt').doc).tree));
  });

  it('a 200k-word file reads in well under a second', () => {
    const para = 'The ferry came at noon and the keeper watched it cross the grey water while gulls wheeled over the rocks.';
    const chapters: string[] = [];
    for (let c = 1; c <= 40; c++) chapters.push(`CHAPTER ${c}\n\n${Array.from({ length: 250 }, () => para).join('\n\n')}`);
    const bytes = new TextEncoder().encode(chapters.join('\n\n\n'));
    const start = performance.now();
    const result = readPlainText(bytes);
    const elapsed = performance.now() - start;
    expect(result.status).toBe('read');
    if (result.status !== 'read') return;
    expect(result.doc.blocks).toHaveLength(40 * 251);
    expect(elapsed).toBeLessThan(1000);
  });
});
