/**
 * The shared body model — the mdast stage every non-Markdown renderer reads.
 *
 * Two rules here are about what a book may carry, not about how Markdown parses:
 * raw HTML is text, and only web and mail links keep a target. Both are asserted
 * against the inputs that would break them.
 */

import { describe, expect, it } from 'vitest';
import { parseProse, plainProse, safeHref, type ProseBlock } from '../src/prose.js';

describe('parseProse', () => {
  it('reads paragraphs with emphasis, strong and inline code as runs', () => {
    const [block] = parseProse('She *waited* in **silence** with `x`.');
    expect(block).toEqual({
      kind: 'paragraph',
      runs: [
        { text: 'She ' },
        { text: 'waited', em: true },
        { text: ' in ' },
        { text: 'silence', strong: true },
        { text: ' with ' },
        { text: 'x', code: true },
        { text: '.' },
      ],
    });
  });

  it('reads a thematic break, the *** separator, as a break block', () => {
    expect(parseProse('one\n\n***\n\ntwo').map((block) => block.kind)).toEqual(['paragraph', 'break', 'paragraph']);
  });

  it('reads headings, quotes, lists and code blocks', () => {
    const blocks = parseProse(['# Title', '', '> quoted', '', '- a', '- b', '', '1. first', '', '```', 'code()', '```'].join('\n'));
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'quote', 'list', 'list', 'code']);
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: false, items: [[{ kind: 'paragraph' }], [{ kind: 'paragraph' }]] });
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[4]).toEqual({ kind: 'code', text: 'code()' });
  });

  it('keeps raw HTML as literal text, so markup in a manuscript is shown and never run', () => {
    const [block] = parseProse('<script>alert(1)</script> and <em>this</em>');
    expect(block?.kind).toBe('paragraph');
    const text = block?.kind === 'paragraph' ? block.runs.map((run) => run.text).join('') : '';
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<em>this</em>');
  });

  it('keeps the target of a web or mail link and drops the target of anything else', () => {
    const [block] = parseProse('[a](https://example.com) [b](javascript:alert(1)) [c](chapter-2.md)');
    const links = block?.kind === 'paragraph' ? block.runs.filter((run) => run.text !== ' ') : [];
    expect(links.map((run) => [run.text, run.href])).toEqual([
      ['a', 'https://example.com'],
      ['b', undefined],
      ['c', undefined],
    ]);
  });

  it('reads a hard line break as a run with br set', () => {
    const [block] = parseProse('line one  \nline two');
    expect(block?.kind === 'paragraph' && block.runs.some((run) => run.br === true)).toBe(true);
  });
});

describe('safeHref', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['http://example.com', 'http://example.com'],
    ['mailto:a@example.com', 'mailto:a@example.com'],
    ['javascript:alert(1)', undefined],
    ['JAVASCRIPT:alert(1)', undefined],
    ['data:text/html,x', undefined],
    ['file:///etc/passwd', undefined],
    ['chapter-2.md', undefined],
    ['#anchor', undefined],
  ])('%s -> %s', (url, expected) => {
    expect(safeHref(url)).toBe(expected);
  });
});

describe('plainProse', () => {
  it('joins paragraphs with a blank line and writes a break as the separator', () => {
    const blocks: ProseBlock[] = parseProse('one *two*\n\n***\n\nthree');
    expect(plainProse(blocks, '* * *')).toBe('one two\n\n* * *\n\nthree');
  });

  it('writes list items with a marker that matches the list kind', () => {
    expect(plainProse(parseProse('- a\n- b'), '* * *')).toBe('- a\n- b');
    expect(plainProse(parseProse('1. a\n2. b'), '* * *')).toBe('1. a\n2. b');
  });
});

describe('footnotes, until the exporter renders them (#271)', () => {
  it('a body with GFM footnotes exports every marker and every note as the text it is', () => {
    // The editor keeps footnotes as `[^n]` markers and notes since #270 (editor-engine §3.4). The
    // exporter's parse has no footnote extension, so it reads both as text: nothing a writer typed
    // is dropped, and the marker shows where the note belongs.
    const body = 'The ferry was late[^1], on the second bell[^note].\n\n[^1]: The Marta.\n\n[^note]: Named.\n\n    Second paragraph.\n';
    const text = plainProse(parseProse(body), '* * *');
    for (const piece of ['late[^1]', 'bell[^note]', '[^1]: The Marta.', '[^note]: Named.', 'Second paragraph.']) {
      expect(text).toContain(piece);
    }
  });
});
