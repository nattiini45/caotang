/**
 * editor-engine.md §9's word rule: whitespace tokens, with a token in an unspaced script (Han, kana, Thai, Lao, Khmer, Myanmar) counted by
 * `Intl.Segmenter` and every other token counted 1. The spaced-script cases are the old whitespace split, pinned.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WORD_RULE_VERSION, countBody, wordRuleInUse } from '../src/index.js';

const oldRule = (body: string): number => {
  const trimmed = body.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

const wordLike = (text: string): number => {
  let n = 0;
  for (const part of new Intl.Segmenter('und', { granularity: 'word' }).segment(text)) if (part.isWordLike) n++;
  return n;
};

const realSegmenter = Intl.Segmenter;
afterEach(() => {
  (Intl as { Segmenter: unknown }).Segmenter = realSegmenter;
});

describe('countBody — unspaced scripts', () => {
  it.each([
    ['Chinese', '我喜欢在海边的灯塔里写作'],
    ['Japanese', '私は海辺の灯台で小説を書いています'],
    ['Thai', 'ฉันชอบเขียนหนังสือที่ประภาคาร'],
  ])('counts %s by word segmentation, not as one token', (_name, text) => {
    const { words } = countBody(text);
    expect(words).toBeGreaterThan(1);
    expect(words).toBe(wordLike(text));
  });

  it('is 0 for whitespace and separators only, and for punctuation alone in an unspaced script', () => {
    expect(countBody('').words).toBe(0);
    expect(countBody(' \n\t  ').words).toBe(0);
    expect(countBody('\u3000\u3000').words).toBe(0);
    expect(countBody('。').words).toBe(0);
  });

  it('counts a mixed Latin and CJK line token by token', () => {
    expect(countBody('Chapter 1 我喜欢写作 end').words).toBe(3 + wordLike('我喜欢写作'));
    expect(countBody('see 灯塔lighthouse now').words).toBe(2 + wordLike('灯塔lighthouse'));
  });

  it('leaves chars as the body length', () => {
    expect(countBody('我喜欢写作').chars).toBe(5);
  });
});

describe('countBody — spaced scripts keep the whitespace split', () => {
  it.each([
    'The ferry was late, as always.',
    'a well-known fact',
    "don't stop",
    '> quote',
    'Tôi thích viết văn bên ngọn hải đăng',
    '나는 등대에서 글을 쓰는 것을 좋아한다',
    'Мне нравится писать у маяка',
    'Μου αρέσει να γράφω στο φάρο',
    '  leading and trailing  ',
  ])('%s', (body) => {
    expect(countBody(body).words).toBe(oldRule(body));
  });

  it('pins the hyphen compound, the apostrophe and the blockquote marker', () => {
    expect(countBody('well-known').words).toBe(1);
    expect(countBody("don't").words).toBe(1);
    expect(countBody('> quote').words).toBe(2);
  });
});

describe('countBody — no Intl.Segmenter', () => {
  it('counts each unspaced character as a word and each run of the rest as one, and the rule in use is 1', () => {
    (Intl as { Segmenter: unknown }).Segmenter = undefined;
    expect(wordRuleInUse()).toBe(1);
    expect(countBody('我喜欢写作').words).toBe(5);
    expect(countBody('see 灯塔lighthouse now').words).toBe(2 + 3);
    expect(countBody('plain latin text').words).toBe(3);
  });

  it('is never fewer than the whitespace split', () => {
    (Intl as { Segmenter: unknown }).Segmenter = undefined;
    for (const body of ['a b c', '我 你', 'ฉันชอบ ครับ', '']) {
      expect(countBody(body).words).toBeGreaterThanOrEqual(oldRule(body));
    }
  });

});

describe('the rule version and the segmenter', () => {
  it('reports rule 2 where Intl.Segmenter exists', () => {
    expect(WORD_RULE_VERSION).toBe(2);
    expect(wordRuleInUse()).toBe(2);
  });

  it('constructs the segmenter once, with the fixed locale', () => {
    const calls: unknown[][] = [];
    class Counting extends realSegmenter {
      constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
        super(...args);
        calls.push(args);
      }
    }
    (Intl as { Segmenter: unknown }).Segmenter = Counting;
    for (let i = 0; i < 5; i++) countBody('我喜欢写作');
    wordRuleInUse();
    expect(calls).toEqual([['und', { granularity: 'word' }]]);
  });

  it('does not build a segmenter for a body with no unspaced script', () => {
    let constructed = 0;
    class Counting extends realSegmenter {
      constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
        super(...args);
        constructed++;
      }
    }
    (Intl as { Segmenter: unknown }).Segmenter = Counting;
    countBody('only latin words here, and 한국어 and Кириллица');
    expect(constructed).toBe(0);
  });
});

describe('countBody — cost', () => {
  it('counts a 200k-character CJK body and a long run of combining marks promptly', () => {
    const big = '我喜欢在海边的灯塔里写作。'.repeat(16000);
    expect(big.length).toBeGreaterThan(200_000);
    const start = performance.now();
    expect(countBody(big).words).toBeGreaterThan(16000);
    const marks = 'a' + '\u0301'.repeat(100_000) + ' 我' + '\u0301'.repeat(100_000);
    expect(countBody(marks).words).toBeGreaterThanOrEqual(2);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
