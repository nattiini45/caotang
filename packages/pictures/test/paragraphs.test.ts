import { describe, expect, it } from 'vitest';

import { PARAGRAPH_CONTEXT, PARAGRAPH_EXACT_MAX, blockHashOf, captureParagraphAnchor, checkParagraphAnchor, fnv1a64Hex, normalizeBlockText, paragraphBlocks } from '../src/paragraphs.js';
import { validateAssetLink } from '../src/validate.js';

const BODY = 'First paragraph, short.\n\nSecond paragraph has more words in it.\n\n\n\nThird one.\n';

function anchorAt(body: string, needle: string, revision = 3) {
  const anchor = captureParagraphAnchor(body, body.indexOf(needle), revision);
  if (anchor === undefined) throw new Error('no anchor');
  return anchor;
}

describe('paragraphBlocks', () => {
  it('splits on blank lines and numbers the non-blank blocks', () => {
    const blocks = paragraphBlocks(BODY);
    expect(blocks.map((b) => [b.ordinal, b.text])).toEqual([
      [0, 'First paragraph, short.'],
      [1, 'Second paragraph has more words in it.'],
      [2, 'Third one.'],
    ]);
    for (const b of blocks) expect(BODY.slice(b.start, b.end)).toBe(b.text);
  });

  it('keeps hard-wrapped lines in one block, and treats whitespace-only lines as blank', () => {
    const body = 'one\ntwo\n  \t \nthree';
    expect(paragraphBlocks(body).map((b) => b.text)).toEqual(['one\ntwo', 'three']);
  });

  it('handles CRLF, lone CR, leading blanks and an empty body', () => {
    expect(paragraphBlocks('\r\n\r\na\r\nb\r\n\r\nc').map((b) => b.text)).toEqual(['a\r\nb', 'c']);
    expect(paragraphBlocks('a\r\rb').map((b) => b.text)).toEqual(['a', 'b']);
    expect(paragraphBlocks('')).toEqual([]);
    expect(paragraphBlocks('  \n\n \n')).toEqual([]);
  });
});

describe('captureParagraphAnchor', () => {
  it('captures the quote, the context, the revision and both tie-breakers', () => {
    const anchor = anchorAt(BODY, 'Second', 7);
    expect(anchor).toMatchObject({ exact: 'Second paragraph has more words in it.', capturedRevision: 7, ordinal: 1 });
    expect(anchor.prefix).toBe('First paragraph, short.\n\n'.slice(-PARAGRAPH_CONTEXT));
    expect(anchor.suffix).toBe(BODY.slice(anchor.to, anchor.to + PARAGRAPH_CONTEXT));
    expect(anchor.blockHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the quote\'s range matching its text, at UTF-16 offsets', () => {
    const body = 'Intro\n\n\u{1F30A} wave and 𝒳 math, then text.\n\nEnd';
    const anchor = anchorAt(body, 'wave');
    expect(body.slice(anchor.from, anchor.to)).toBe(anchor.exact);
    expect(anchor.from).toBe(body.indexOf('\u{1F30A}'));
  });

  it('cuts the quote at 200 characters and hashes the whole block', () => {
    const long = 'word '.repeat(100).trim();
    const body = `${long}\n\nnext`;
    const anchor = captureParagraphAnchor(body, 0, 1);
    expect(PARAGRAPH_EXACT_MAX).toBe(200);
    expect(anchor?.exact).toHaveLength(200);
    expect(anchor?.to).toBe(200);
    expect(anchor?.blockHash).toBe(blockHashOf(long));
  });

  it('separates the whole-block hash from the short quote: an edit past 200 characters changes only the hash', () => {
    const head = 'a'.repeat(210);
    const before = captureParagraphAnchor(`${head} ending one\n\nz`, 0, 1);
    const after = captureParagraphAnchor(`${head} ending two\n\nz`, 0, 1);
    expect(before?.exact).toBe(after?.exact);
    expect(before?.blockHash).not.toBe(after?.blockHash);
  });

  it('never splits a surrogate pair at the quote or context boundary', () => {
    const emojiAt199 = `${'x'.repeat(199)}\u{1F30A}${'y'.repeat(50)}`;
    const a = captureParagraphAnchor(emojiAt199, 0, 1);
    expect(a?.to).toBe(199);
    expect(a?.exact.endsWith('x')).toBe(true);
    const body = `${'p'.repeat(31)}\u{1F30A}\n\nQuote here.\n\n\u{1F30A}${'s'.repeat(40)}`;
    const b = anchorAt(body, 'Quote');
    expect(b.prefix.codePointAt(0)).not.toBe(0xdc00);
    for (const piece of [a?.exact, b.prefix, b.suffix]) expect(piece === undefined || !/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(piece)).toBe(true);
  });

  it('snaps a position in blank space to the next paragraph, and past the end to the last', () => {
    const gap = BODY.indexOf('\n\n\n\n') + 2;
    expect(captureParagraphAnchor(BODY, gap, 1)?.exact).toBe('Third one.');
    expect(captureParagraphAnchor(BODY, 9999, 1)?.exact).toBe('Third one.');
    expect(captureParagraphAnchor(BODY, { from: 0 }, 1)?.ordinal).toBe(0);
  });

  it('has nothing to anchor in an empty body', () => {
    expect(captureParagraphAnchor('', 0, 1)).toBeUndefined();
    expect(captureParagraphAnchor('  \n\n', 1, 1)).toBeUndefined();
  });

  it('produces an anchor a paragraph link accepts', () => {
    const anchor = anchorAt(BODY, 'Third');
    const link = { id: 'l_0000000001', assetId: 'a_AAAAAAAAA1', target: { kind: 'paragraph', nodeId: 'n_1', anchor }, role: 'reference', order: 10 };
    expect(validateAssetLink(link).ok).toBe(true);
  });
});

describe('block identity', () => {
  it('hashes the normalised block: reflowed whitespace matches, a changed word does not', () => {
    expect(blockHashOf('one   two\nthree')).toBe(blockHashOf('one two three'));
    expect(blockHashOf('one two three')).not.toBe(blockHashOf('one two threeX'));
    expect(blockHashOf('Case')).not.toBe(blockHashOf('case'));
    expect(normalizeBlockText('  e\u0301  x ')).toBe('\u00e9 x');
  });

  it('is FNV-1a over UTF-8 (published vectors)', () => {
    expect(fnv1a64Hex('')).toBe('cbf29ce484222325');
    expect(fnv1a64Hex('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64Hex('foobar')).toBe('85944171f73967e8');
  });

  it('tells parallel lookalike paragraphs apart by hash and ordinal', () => {
    const body = 'The door was red and old.\n\nThe door was red and new.\n\nThe door was red and old.';
    const first = captureParagraphAnchor(body, 0, 1);
    const third = captureParagraphAnchor(body, body.lastIndexOf('The door'), 1);
    expect(first?.exact).toBe(third?.exact);
    expect(first?.blockHash).toBe(third?.blockHash);
    expect([first?.ordinal, third?.ordinal]).toEqual([0, 2]);
    expect(captureParagraphAnchor(body, body.indexOf('new'), 1)?.blockHash).not.toBe(first?.blockHash);
  });

  it('checks an anchor against a body without searching', () => {
    const anchor = anchorAt(BODY, 'Second');
    expect(checkParagraphAnchor(BODY, anchor)).toEqual({ quote: true, block: true, ordinal: true });

    const tailEdited = BODY.replace('in it.', 'in it, edited.');
    expect(checkParagraphAnchor(tailEdited, anchor)).toEqual({ quote: false, block: false, ordinal: true });

    const firstRemoved = BODY.slice(BODY.indexOf('Second'));
    expect(checkParagraphAnchor(firstRemoved, anchor).ordinal).toBe(false);
  });

  it('keeps the quote valid when only text past it changes', () => {
    const head = 'b'.repeat(205);
    const body = `${head} one\n\nz`;
    const anchor = captureParagraphAnchor(body, 0, 1);
    if (anchor === undefined) throw new Error('no anchor');
    expect(checkParagraphAnchor(`${head} two\n\nz`, anchor)).toEqual({ quote: true, block: false, ordinal: true });
  });

  it('does not throw for an anchor outside the body', () => {
    const anchor = anchorAt(BODY, 'Third');
    expect(() => checkParagraphAnchor('', anchor)).not.toThrow();
    expect(checkParagraphAnchor('', anchor)).toEqual({ quote: false, block: false, ordinal: false });
  });
});
