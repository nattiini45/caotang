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
    const [block] = parseProse('She *waited* in **silence** with `x`.').blocks;
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
    expect(parseProse('one\n\n***\n\ntwo').blocks.map((block) => block.kind)).toEqual(['paragraph', 'break', 'paragraph']);
  });

  it('reads headings, quotes, lists and code blocks', () => {
    const blocks = parseProse(['# Title', '', '> quoted', '', '- a', '- b', '', '1. first', '', '```', 'code()', '```'].join('\n')).blocks;
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'quote', 'list', 'list', 'code']);
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: false, items: [[{ kind: 'paragraph' }], [{ kind: 'paragraph' }]] });
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[4]).toEqual({ kind: 'code', text: 'code()' });
  });

  it('keeps raw HTML as literal text, so markup in a manuscript is shown and never run', () => {
    const [block] = parseProse('<script>alert(1)</script> and <em>this</em>').blocks;
    expect(block?.kind).toBe('paragraph');
    const text = block?.kind === 'paragraph' ? block.runs.map((run) => run.text).join('') : '';
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<em>this</em>');
  });

  it('keeps the target of a web or mail link and drops the target of anything else', () => {
    const [block] = parseProse('[a](https://example.com) [b](javascript:alert(1)) [c](chapter-2.md)').blocks;
    const links = block?.kind === 'paragraph' ? block.runs.filter((run) => run.text !== ' ') : [];
    expect(links.map((run) => [run.text, run.href])).toEqual([
      ['a', 'https://example.com'],
      ['b', undefined],
      ['c', undefined],
    ]);
  });

  it('reads a hard line break as a run with br set', () => {
    const [block] = parseProse('line one  \nline two').blocks;
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
    const blocks: readonly ProseBlock[] = parseProse('one *two*\n\n***\n\nthree').blocks;
    expect(plainProse(blocks, '* * *')).toBe('one two\n\n* * *\n\nthree');
  });

  it('writes list items with a marker that matches the list kind', () => {
    expect(plainProse(parseProse('- a\n- b').blocks, '* * *')).toBe('- a\n- b');
    expect(plainProse(parseProse('1. a\n2. b').blocks, '* * *')).toBe('1. a\n2. b');
  });
});

describe('footnotes (#271)', () => {
  it('keeps a referred marker as a note run and the note text in `notes`', () => {
    const parsed = parseProse('The ferry was late[^1].\n\n[^1]: The Marta.');
    const [block] = parsed.blocks;
    expect(block?.kind).toBe('paragraph');
    const marker = block?.kind === 'paragraph' ? block.runs.find((run) => run.noteId !== undefined) : undefined;
    expect(marker).toMatchObject({ noteId: '1' });
    expect(parsed.notes.get('1')?.[0]).toMatchObject({ kind: 'paragraph' });
    // Nothing the writer typed is dropped: the note text survives in `notes`, not the body.
    expect(plainProse(parsed.blocks, '* * *')).toBe('The ferry was late.');
    expect(plainProse(parsed.notes.get('1') ?? [], '* * *')).toBe('The Marta.');
  });

  it('a definition nothing refers to stays in the body as the text it is', () => {
    const parsed = parseProse('Plain body.\n\n[^loose]: A stray note.');
    expect(parsed.notes.size).toBe(0);
    expect(plainProse(parsed.blocks, '* * *')).toBe('Plain body.\n\n[^loose]: A stray note.');
  });

  it('a marker naming no note stays the marker text it is', () => {
    const parsed = parseProse('A gap[^nowhere].');
    expect(parsed.notes.size).toBe(0);
    expect(plainProse(parsed.blocks, '* * *')).toBe('A gap[^nowhere].');
  });

  it('a note cited only by a note nothing refers to stays literal with it', () => {
    const parsed = parseProse('Body.\n\n[^loose]: See [^child].\n\n[^child]: A child note.');
    // The child must not be lifted into `notes` — nothing that renders refers to it, so its text would be lost.
    expect(parsed.notes.size).toBe(0);
    expect(plainProse(parsed.blocks, '* * *')).toBe('Body.\n\n[^loose]: See [^child].\n\n[^child]: A child note.');
  });

  it('a note cited inside a note is collected and placed with the others', () => {
    const parsed = parseProse('Late[^a].\n\n[^a]: See [^b].\n\n[^b]: Nested.');
    expect(parsed.notes.get('a')).toBeDefined();
    expect(parsed.notes.get('b')).toBeDefined();
    expect(plainProse(parsed.notes.get('b') ?? [], '* * *')).toBe('Nested.');
  });

  it('the marker callback numbers the note run in plain text', () => {
    const parsed = parseProse('Late[^1] and later[^2].\n\n[^1]: One.\n\n[^2]: Two.');
    const text = plainProse(parsed.blocks, '* * *', 'placeholder', (noteId) => `[${noteId}]`);
    expect(text).toBe('Late[1] and later[2].');
  });
});
