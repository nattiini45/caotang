/**
 * The Markdown and plain-text renderers — exporter.md §2 (render), §3 (MD, TXT).
 *
 * The expected output is written out in full, because the renderers are string
 * assembly: a test that checked only "contains a heading" would pass on a file
 * with the wrong order, the wrong separator and a missing contents list.
 */

import { describe, expect, it } from 'vitest';
import { flatten } from '../src/flatten.js';
import { renderMarkdown, renderText } from '../src/render-text.js';
import type { RenderInput } from '../src/render-input.js';
import { DEFAULT_TEMPLATE, anchorOf, fileStem } from '../src/template.js';
import { makeProject, PROJECT_NAME } from './fixture.js';

const DATE = '2026-10-08';

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  const blocks = flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: true }).blocks;
  return {
    blocks,
    title: PROJECT_NAME,
    author: '',
    date: DATE,
    template: DEFAULT_TEMPLATE,
    toc: true,
    ...overrides,
  };
}

describe('renderMarkdown', () => {
  it('writes the title page, the contents list, chapters as ## and the separator as ***', () => {
    expect(renderMarkdown(input())).toBe(
      [
        '# The Lighthouse Keeper',
        '',
        '2026-10-08',
        '',
        '**Contents**',
        '',
        '- [1. Chapter One](#1-chapter-one)',
        '- [2. Chapter Two](#2-chapter-two)',
        '',
        'The keeper had been alone on the rock for nine years.',
        '',
        '## 1. Chapter One',
        '',
        'The ferry was late, as always.',
        '',
        'Elena *stepped* onto the **quay** and [waved](https://example.com/wave).',
        '',
        '***',
        '',
        'He counted the ships, and the ships counted him.',
        '',
        '***',
        '',
        'The glass fell all night.',
        '',
        '## 2. Chapter Two',
        '',
        'Light, at last.',
        '',
      ].join('\n'),
    );
  });

  it('keeps the author on the title page when one is given', () => {
    const out = renderMarkdown(input({ author: 'M. Ortega' }));
    expect(out.split('\n').slice(0, 6)).toEqual(['# The Lighthouse Keeper', '', 'M. Ortega', '', '2026-10-08', '']);
  });

  it('puts the contents list at the top when there is no title page', () => {
    const out = renderMarkdown(input({ blocks: input().blocks.filter((block) => block.kind !== 'frontmatter') }));
    expect(out.startsWith('**Contents**\n\n- [1. Chapter One](#1-chapter-one)')).toBe(true);
  });

  it('writes no contents list when the recipe turns it off', () => {
    const out = renderMarkdown(input({ toc: false }));
    expect(out).not.toContain('Contents');
    expect(out).toContain('## 1. Chapter One');
  });

  it('gives every contents link an anchor that a heading in the file actually has', () => {
    const out = renderMarkdown(input());
    const links = [...out.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]);
    expect(links).toEqual(['1-chapter-one', '2-chapter-two']);
    for (const anchor of links) {
      const heading = out.split('\n').find((line) => line.startsWith('## ') && anchorOf(line.slice(3)) === anchor);
      expect(heading, `no heading for #${anchor}`).toBeDefined();
    }
  });

  it('keeps an underscore in an anchor, so a chapter title with _ links to the heading a reader generates', () => {
    // GitHub's slug rule keeps `_`, so the anchor for `Draft_2` is `1-draft_2`, not `1-draft2`. The expectation is
    // written out rather than computed with anchorOf, so the two cannot drift together and hide the bug.
    expect(anchorOf('1. Draft_2')).toBe('1-draft_2');
    expect(anchorOf('Draft_2')).toBe('draft_2');
  });

  it('keeps the indentation of a body that opens with an indented code block', () => {
    const blocks = input().blocks.map((block) =>
      block.kind === 'scene' && block.docId === 'n_MORNING01' ? { ...block, body: '    const x = 1;\n' } : block,
    );
    const out = renderMarkdown(input({ blocks }));
    // `.trim()` would drop the four spaces and turn the code block into a paragraph.
    expect(out).toContain('    const x = 1;');
    expect(out).not.toMatch(/^const x = 1;/m);
  });
});

describe('renderText', () => {
  it('writes uppercase chapter lines and the * * * separator, with the words and no markup', () => {
    expect(renderText(input())).toBe(
      [
        'The Lighthouse Keeper',
        '',
        '2026-10-08',
        '',
        'The keeper had been alone on the rock for nine years.',
        '',
        'CHAPTER 1. CHAPTER ONE',
        '',
        'The ferry was late, as always.',
        '',
        'Elena stepped onto the quay and waved.',
        '',
        '* * *',
        '',
        'He counted the ships, and the ships counted him.',
        '',
        '* * *',
        '',
        'The glass fell all night.',
        '',
        'CHAPTER 2. CHAPTER TWO',
        '',
        'Light, at last.',
        '',
      ].join('\n'),
    );
  });

  it('has no contents list, whatever the recipe asks for', () => {
    const out = renderText(input({ toc: true }));
    expect(out).not.toMatch(/contents/i);
    expect(out).not.toContain('](');
  });

  it('does not turn a leading # heading into a chapter line of its own', () => {
    const blocks = input().blocks.map((block) =>
      block.kind === 'scene' && block.docId === 'n_MORNING01' ? { ...block, body: '# A heading the author typed' } : block,
    );
    expect(renderText(input({ blocks }))).toContain('A heading the author typed');
    expect(renderText(input({ blocks }))).not.toContain('# A heading');
  });
});

describe('fileStem', () => {
  it('drops trailing dots and spaces, and keeps the rest', () => {
    expect(fileStem('Book')).toBe('Book');
    expect(fileStem('Book. . .')).toBe('Book');
    expect(fileStem('Book...   ')).toBe('Book');
    expect(fileStem('. Book .')).toBe('. Book');
    expect(fileStem('A.B. C.')).toBe('A.B. C');
  });

  it('is Untitled when nothing is left, and prefixes a Windows device name', () => {
    expect(fileStem('')).toBe('Untitled');
    expect(fileStem('   \t\n ')).toBe('Untitled');
    expect(fileStem('. . . .')).toBe('Untitled');
    expect(fileStem('CON.')).toBe('_CON');
  });

  it('turns reserved, control and line-ending characters into one space, and keeps unicode', () => {
    expect(fileStem('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j');
    expect(fileStem('Line\r\nBreak\u0007Bell')).toBe('Line Break Bell');
    expect(fileStem('Café \u{1F4D6} Ünïcode. ')).toBe('Café \u{1F4D6} Ünïcode');
  });

  it('caps the stem at 120 characters and drops the space the cut leaves', () => {
    expect(fileStem(`${'a'.repeat(119)} bcd`)).toBe('a'.repeat(119));
  });

  it('takes linear time on a long run of alternating dots and spaces', () => {
    const pathological = `${'. '.repeat(25_000)}x`;
    const started = performance.now();
    expect(fileStem(pathological)).toBe(('. '.repeat(60)).trim());
    expect(performance.now() - started).toBeLessThan(500);
  });
});
