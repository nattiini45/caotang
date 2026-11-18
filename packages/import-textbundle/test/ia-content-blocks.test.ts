/**
 * iA Writer's Content Blocks (#282): index order, pictures with their caption, CSV as paragraphs, and the lines the import cannot
 * resolve. Synthetic fixtures only.
 */
import { describe, expect, it } from 'vitest';

import { contentBlockRefs, csvCells, csvParagraphs, expandContentBlocks, kindOfBlock } from '../src/ia.js';

const filesOf = (files: Record<string, string>): Map<string, string> => new Map(Object.entries(files));

describe('what a Content Block line is', () => {
  it('reads a path on its own line, with an optional caption', () => {
    const refs = contentBlockRefs(['# Book', '', '/Chapter 1.md', '/images/lamp.png "The lamp"', '/data.csv', 'A prose line.'].join('\n'));
    expect(refs).toEqual([
      { path: 'Chapter 1.md', caption: '', kind: 'markdown' },
      { path: 'images/lamp.png', caption: 'The lamp', kind: 'image' },
      { path: 'data.csv', caption: '', kind: 'csv' },
    ]);
  });

  it('leaves prose, links and URLs alone', () => {
    const refs = contentBlockRefs(['See https://example.com/x.md', 'a / b', '[link](/x.md)', '  /indented.md', '/with spaces.md'].join('\n'));
    expect(refs.map((ref) => ref.path)).toEqual(['indented.md', 'with spaces.md']);
  });

  it('never reads a block inside a fenced code block', () => {
    const refs = contentBlockRefs(['```', '/Chapter 1.md', '```', '/Chapter 2.md'].join('\n'));
    expect(refs.map((ref) => ref.path)).toEqual(['Chapter 2.md']);
  });

  it('names the kind by extension', () => {
    expect([kindOfBlock('a.md'), kindOfBlock('a.txt'), kindOfBlock('a.PNG'), kindOfBlock('a.tsv'), kindOfBlock('a.pdf')]).toEqual([
      'markdown', 'markdown', 'image', 'csv', 'other',
    ]);
  });
});

describe('CSV as paragraphs', () => {
  it('keeps quoted commas and doubled quotes', () => {
    expect(csvCells('Ada,"Lamp, the","He said ""go"""')).toEqual(['Ada', 'Lamp, the', 'He said "go"']);
  });

  it('makes one paragraph per row, the header first, and reads tabs when there are no commas', () => {
    expect(csvParagraphs('Name,Place\nAda,The Rock\n\nBob,"Grey stone"\n')).toEqual(['Name, Place', 'Ada, The Rock', 'Bob, Grey stone']);
    expect(csvParagraphs('Name\tPlace\nAda\tRock')).toEqual(['Name, Place', 'Ada, Rock']);
  });
});

describe('expanding the blocks', () => {
  const FILES = filesOf({
    'Chapter 1.md': '# Chapter One\n\nThe ferry came.',
    'Chapter 2.md': '# Chapter Two\n\nThe letter arrived.',
    'data.csv': 'Name,Place\nAda,The Rock',
    'nested.md': '/Chapter 2.md',
  });

  it('takes the files in the order the index lists them, not in folder order', () => {
    const out = expandContentBlocks(['/Chapter 2.md', '', '/Chapter 1.md'].join('\n'), FILES);
    expect(out.included).toEqual(['Chapter 2.md', 'Chapter 1.md']);
    expect(out.body.indexOf('The letter arrived.')).toBeLessThan(out.body.indexOf('The ferry came.'));
  });

  it('follows a block inside an included file', () => {
    const out = expandContentBlocks('/nested.md', FILES);
    expect(out.included).toEqual(['nested.md', 'Chapter 2.md']);
    expect(out.body).toContain('The letter arrived.');
  });

  it('writes a picture as Markdown with its caption, so the bundle resolves its bytes', () => {
    const out = expandContentBlocks('/images/lamp.png "The lamp"', FILES);
    expect(out.images).toEqual([{ path: 'images/lamp.png', caption: 'The lamp' }]);
    expect(out.body).toBe('![The lamp](images/lamp.png)');
  });

  it('turns a CSV into paragraphs and names it', () => {
    const out = expandContentBlocks('/data.csv', FILES);
    expect(out.csv).toEqual(['data.csv']);
    expect(out.body).toBe('Name, Place\nAda, The Rock');
  });

  it('keeps a line it cannot resolve as text and names it', () => {
    const out = expandContentBlocks(['/gone.md', '/notes.pdf'].join('\n'), FILES);
    expect(out.missing).toEqual(['gone.md']);
    expect(out.unsupported).toEqual(['notes.pdf']);
    expect(out.body).toBe('/gone.md\n/notes.pdf');
  });

  it('a file that lists itself is kept out rather than looping', () => {
    const out = expandContentBlocks('/loop.md', filesOf({ 'loop.md': 'Before\n/loop.md\nAfter' }));
    expect(out.included).toEqual(['loop.md']);
    expect(out.missing).toEqual(['loop.md']);
    expect(out.body).toBe('Before\n/loop.md\nAfter');
  });

  it('a chain deeper than the cap stops and reports the rest', () => {
    const deep: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) deep[`n${i}.md`] = i === 11 ? 'The end.' : `/n${i + 1}.md`;
    const out = expandContentBlocks('/n0.md', filesOf(deep));
    expect(out.included).toHaveLength(8);
    expect(out.missing).toEqual(['n8.md']);
    expect(out.body).toContain('/n8.md');
    expect(out.body).not.toContain('The end.');
  });
});
