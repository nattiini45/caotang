/**
 * Where a finding sits in the stored file: the front matter's lines added back, none for Ink, and CRLF counted as one break.
 */

import { parseDocumentFile, serializeDocumentFile, type DocumentFrontMatter } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { bodyStartOf, placeFinding } from '../src/index.js';

const FRONT: DocumentFrontMatter = { id: 'n_7K2QX9M4A1', title: 'The Harbour', status: null, label: null, keywords: [], synopsis: '' };
const BODY = 'Gulls only.\nThe tide came in.\n\nElena watched the sea.';
const MD = 'docs/n_7K2QX9M4A1.md';

/** The line of an index in the text, counted another way: the line breaks before it, with CRLF read as one. */
function referenceLine(text: string, index: number): number {
  return text.slice(0, index).replaceAll('\r\n', '\n').split('\n').length;
}

function span(body: string, quote: string): { from: number; to: number } {
  const from = body.indexOf(quote);
  expect(from).toBeGreaterThanOrEqual(0);
  return { from, to: from + quote.length };
}

describe('bodyStartOf', () => {
  it.each([['\n' as const], ['\r\n' as const]])('finds the first character of the body the loader reads, for a %j file', (newline) => {
    const stored = serializeDocumentFile(FRONT, BODY, { newline });
    const start = bodyStartOf(stored, MD);
    expect(stored.slice(start).startsWith(parseDocumentFile(stored).body)).toBe(true);
    expect(stored.slice(start, start + 5)).toBe('Gulls');
  });

  it('keeps an author-intended leading blank line in the body', () => {
    const stored = serializeDocumentFile(FRONT, '\nSecond line first.');
    expect(parseDocumentFile(stored).body).toBe('\nSecond line first.');
    expect(stored.slice(bodyStartOf(stored, MD))).toBe('\nSecond line first.\n');
  });

  it('is 0 for a file with no front matter, which the loader keeps whole as the body', () => {
    expect(bodyStartOf('Gulls only.\nThe tide came in.\n', MD)).toBe(0);
    expect(bodyStartOf('---\nnot: a mapping: at all\n---\n\nbody\n', MD)).toBe(0);
  });

  it('is 0 for an Ink file, whose `---` block would be story', () => {
    expect(bodyStartOf('---\nid: n_AQ5T03R7D4\ntitle: x\n---\n\n=== start ===\n', 'docs/n_AQ5T03R7D4.ink')).toBe(0);
  });

  it('is the end of the file for a front matter block with nothing after it', () => {
    const stored = serializeDocumentFile(FRONT, '');
    expect(bodyStartOf(stored, MD)).toBe(stored.length);
  });
});

describe('placeFinding', () => {
  it('adds the front matter lines back for a Markdown document', () => {
    const stored = serializeDocumentFile(FRONT, BODY);
    const start = bodyStartOf(stored, MD);
    // Eight lines of front matter and the blank line after it.
    expect(stored.slice(0, start).split('\n').length - 1).toBe(9);
    expect(placeFinding(span(BODY, 'Gulls only.'), stored, start)).toEqual({ line: 10, endLine: 10 });
    expect(placeFinding(span(BODY, 'The tide came in.'), stored, start)).toEqual({ line: 11, endLine: 11 });
    expect(placeFinding(span(BODY, 'Elena watched'), stored, start)).toEqual({ line: 13, endLine: 13 });
  });

  it('gives the body lines as they are for a file with no front matter', () => {
    const start = bodyStartOf(BODY, MD);
    expect(placeFinding(span(BODY, 'Elena watched'), BODY, start)).toEqual({ line: 4, endLine: 4 });
  });

  it('places a Fountain document after its front matter too', () => {
    const body = 'INT. LAMP ROOM - NIGHT\n\nELENA\nThe lamp turns.';
    const stored = serializeDocumentFile({ ...FRONT, id: 'n_9P4SZ2Q6C3', title: 'The Script' }, body);
    const start = bodyStartOf(stored, 'docs/n_9P4SZ2Q6C3.fountain');
    expect(placeFinding(span(body, 'ELENA'), stored, start)).toEqual({ line: 12, endLine: 12 });
  });

  it('places an Ink container from the first line of the file', () => {
    const ink = '=== start ===\nHello.\n* [Leave] -> END\n';
    const start = bodyStartOf(ink, 'docs/n_AQ5T03R7D4.ink');
    expect(start).toBe(0);
    expect(placeFinding(span(ink, '* [Leave]'), ink, start)).toEqual({ line: 3, endLine: 3 });
  });

  it.each([['\n' as const], ['\r\n' as const]])('counts a line break once in a %j file', (newline) => {
    const body = BODY.replaceAll('\n', newline);
    const stored = serializeDocumentFile(FRONT, body, { newline });
    const start = bodyStartOf(stored, MD);
    expect(placeFinding(span(body, 'Elena watched'), stored, start)).toEqual({ line: 13, endLine: 13 });
    expect(placeFinding(span(body, 'The tide came in.'), stored, start)).toEqual({ line: 11, endLine: 11 });
  });

  it('gives the lines a quote spans, and keeps a quote that ends at a line break on its own line', () => {
    const stored = serializeDocumentFile(FRONT, BODY);
    const start = bodyStartOf(stored, MD);
    expect(placeFinding(span(BODY, 'Gulls only.\nThe tide came in.'), stored, start)).toEqual({ line: 10, endLine: 11 });
    expect(placeFinding(span(BODY, 'Gulls only.\n'), stored, start)).toEqual({ line: 10, endLine: 10 });
  });

  it('agrees with a second count of the lines for every offset of a CRLF file', () => {
    const body = 'one\r\ntwo\r\n\r\nthree four\r\nfive';
    const stored = serializeDocumentFile(FRONT, body, { newline: '\r\n' });
    const start = bodyStartOf(stored, MD);
    for (let from = 0; from < body.length; from += 1) {
      expect(placeFinding({ from, to: from + 1 }, stored, start).line).toBe(referenceLine(stored, start + from));
    }
  });

  it.each([
    ['a negative offset', { from: -1, to: 3 }, 0],
    ['a reversed span', { from: 5, to: 2 }, 0],
    ['an offset that is not a whole number', { from: 1.5, to: 3 }, 0],
    ['an offset that is not a number', { from: Number.NaN, to: Number.NaN }, 0],
    ['an offset past the end of the file', { from: 4000, to: 4010 }, 0],
    ['a body offset that is not in the file', { from: 0, to: 3 }, -1],
  ])('falls back to line 1 for %s', (_name, evidence, bodyOffset) => {
    expect(placeFinding(evidence, BODY, bodyOffset)).toEqual({ line: 1, endLine: 1 });
  });

  it('ends a span that runs past the end of the file at the last line', () => {
    expect(placeFinding({ from: 0, to: 9999 }, BODY, 0)).toEqual({ line: 1, endLine: 4 });
  });
});
