import { describe, expect, it } from 'vitest';

import { escapeInline, escapeLineStarts, isSafeLinkTarget, NO_MARKS, renderRuns, type Marks, type Run } from '../src/markdown.js';

const t = (text: string, marks: Partial<Marks> = {}): Run => ({ kind: 'text', text, marks: { ...NO_MARKS, ...marks } });

describe('renderRuns', () => {
  it('opens and closes only the marks that change, so emphasis nests', () => {
    expect(renderRuns([t('a', { b: true }), t('b', { b: true, i: true }), t('c', { b: true })])).toBe('**a*b*c**');
    expect(renderRuns([t('x', { s: true, b: true }), t('y', { b: true })])).toBe('~~**x**~~**y**');
  });

  it('keeps whitespace outside the delimiters', () => {
    expect(renderRuns([t('say '), t(' loud ', { b: true }), t('now')])).toBe('say  **loud** now');
  });

  it('writes links and raw Markdown as given', () => {
    expect(renderRuns([t('see '), { kind: 'link', href: 'https://a.b/c d', runs: [t('here', { i: true })] }, { kind: 'raw', md: '[^1]', text: '', marks: NO_MARKS }])).toBe(
      'see [*here*](<https://a.b/c d>)[^1]',
    );
  });
});

describe('escaping', () => {
  it('escapes inline syntax and leaves ordinary punctuation alone', () => {
    expect(escapeInline('a*b_c d_ [x] `y` ~~z~~ ~ <i> < 3 & &amp; Kara_thal')).toBe('a\\*b_c d\\_ \\[x\\] \\`y\\` \\~\\~z\\~\\~ ~ \\<i> < 3 & \\&amp; Kara_thal');
  });

  it('escapes what would start a block', () => {
    expect(escapeLineStarts('# h\n> q\n- l\n+ l\n2. n\n3) n\n===\n---\n#hashtag\n-dash\n2.5 km')).toBe(
      '\\# h\n\\> q\n\\- l\n\\+ l\n2\\. n\n3\\) n\n\\===\n\\---\n#hashtag\n-dash\n2.5 km',
    );
  });
});

describe('isSafeLinkTarget (the paste rule)', () => {
  it('admits web, mail and scheme-less targets only', () => {
    expect(['https://a', 'http://a', 'mailto:a@b', '#x', 'page.html'].map(isSafeLinkTarget)).toEqual([true, true, true, true, true]);
    expect(['javascript:alert(1)', ' JaVaScRiPt:x', 'data:text/html,x', 'file:///etc', 'java\nscript:x', 'scrivcmt://A'].map(isSafeLinkTarget)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
