/**
 * The pace line's words (goals-progress §2.2): the singular for one word, the plural for any other count, grouped the way the
 * formatter locale groups numbers (i18n.md §4.2). The locale is supplied by the caller: this package is below the app and
 * does not read a system locale of its own.
 */
import { describe, expect, it } from 'vitest';

import { paceWords } from '../src/index.js';

describe('the pace line words (goals-progress §2.2)', () => {
  it('writes one word in the singular, so the line reads "≈ 1 word/day"', () => {
    expect(paceWords(1, 'en-US')).toBe('1 word');
  });

  it('writes every other count in the plural, grouped by thousands', () => {
    expect(paceWords(0, 'en-US')).toBe('0 words');
    expect(paceWords(2, 'en-US')).toBe('2 words');
    expect(paceWords(850, 'en-US')).toBe('850 words');
    expect(paceWords(1200, 'en-US')).toBe('1,200 words');
  });

  it('groups the count the way the supplied locale does, and keeps the English noun (the wording is L6’s)', () => {
    expect(paceWords(1200, 'de-DE')).toBe('1.200 words');
    expect(paceWords(1200, 'en-GB')).toBe('1,200 words');
    expect(paceWords(1, 'de-DE')).toBe('1 word');
  });
});
