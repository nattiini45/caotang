/**
 * The pace line's words (goals-progress §2.2): the singular for one word, the plural for any other count.
 */
import { describe, expect, it } from 'vitest';

import { paceWords } from '../src/index.js';

describe('the pace line words (goals-progress §2.2)', () => {
  it('writes one word in the singular, so the line reads "≈ 1 word/day"', () => {
    expect(paceWords(1)).toBe('1 word');
  });

  it('writes every other count in the plural, grouped by thousands', () => {
    expect(paceWords(0)).toBe('0 words');
    expect(paceWords(2)).toBe('2 words');
    expect(paceWords(850)).toBe('850 words');
    expect(paceWords(1200)).toBe('1,200 words');
  });
});

describe('the pace count follows the locale it is given (D3, i18n.md §4.1)', () => {
  it('groups in the formatter locale the app passes, and en-US with none', () => {
    expect(paceWords(1200, 'en-GB')).toBe('1,200 words');
    expect(paceWords(1200, 'de-DE')).toBe('1.200 words');
    expect(paceWords(1200)).toBe('1,200 words');
  });
});
