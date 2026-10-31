import { expect, test } from '@playwright/test';

import { IME_KEY_CODE, isImeEnter } from '../../apps/desktop/src/app/ime.js';

/**
 * i18n §7.3, issue #188: the guard every Enter handler asks first. The Enter that confirms a Chinese, Japanese or Korean
 * candidate is the input method's, reported by `isComposing` or, where that is missing or already false (Safari), by `keyCode` 229.
 */
test.describe('the input-method guard', () => {
  test('a DOM key event is composing when isComposing is true or keyCode is 229', () => {
    expect(isImeEnter({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeEnter({ isComposing: false, keyCode: IME_KEY_CODE })).toBe(true);
    expect(isImeEnter({ keyCode: 229 })).toBe(true);
    expect(isImeEnter({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeEnter({})).toBe(false);
  });

  test('a React key event is read through its nativeEvent, which carries isComposing', () => {
    expect(isImeEnter({ keyCode: 13, nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
    expect(isImeEnter({ keyCode: 13, nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
    expect(isImeEnter({ keyCode: 229, nativeEvent: { isComposing: false } })).toBe(true);
    expect(isImeEnter({ keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
  });
});
