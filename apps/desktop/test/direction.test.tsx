/**
 * The interface direction for keyboard code (i18n.md §5.5): Left and Right swap only in a right-to-left interface, and no other key
 * ever does.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { inlineKey, uiIsRtl } from '../src/i18n/direction.js';
import { setUiLocaleTag } from '../src/i18n/format-locale.js';

afterEach(() => setUiLocaleTag('en'));

const OTHER_KEYS = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'a', ' '];

describe('inlineKey', () => {
  it('returns every key unchanged in a left-to-right interface', () => {
    setUiLocaleTag('en');
    expect(uiIsRtl()).toBe(false);
    for (const key of ['ArrowLeft', 'ArrowRight', ...OTHER_KEYS]) expect(inlineKey(key)).toBe(key);
  });

  it('swaps Left and Right in a right-to-left interface, so Right is still the next item in reading order', () => {
    setUiLocaleTag('ar');
    expect(uiIsRtl()).toBe(true);
    expect(inlineKey('ArrowLeft')).toBe('ArrowRight');
    expect(inlineKey('ArrowRight')).toBe('ArrowLeft');
    for (const key of OTHER_KEYS) expect(inlineKey(key)).toBe(key);
  });
});
