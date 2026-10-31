/**
 * Input-method composition (i18n §7.3, issue #188).
 *
 * A writer typing Chinese, Japanese or Korean confirms a candidate with Enter, and that Enter arrives as a `keydown` while the
 * composition is still active. A handler that acts on it commits half-typed text, saves or blurs a field, or sends a message
 * before the writer has chosen the characters. Every Enter handler in the app asks this guard first and leaves the key to the
 * input method when it answers true.
 *
 * `isComposing` is the standard fact, but MDN marks it "limited availability", and Safari reports the Enter that ends a
 * composition with `isComposing` already false; both report `keyCode` 229 for a key the input method processes, so that is
 * the belt. A React event carries the DOM fact on `nativeEvent` (React's own event has no `isComposing`), so both are read.
 *
 * Pure on purpose, like the keymap: it reads plain facts, so it is tested without a browser.
 */

/** The parts of a key event the guard reads. A DOM `KeyboardEvent` and a React `KeyboardEvent` both have them. */
export interface CompositionFacts {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly nativeEvent?: { readonly isComposing?: boolean; readonly keyCode?: number };
}

/** The `keyCode` browsers give a key the input method processed. */
export const IME_KEY_CODE = 229;

/**
 * True when the key belongs to an input method's composition, so an Enter handler must not act on it:
 * `event.isComposing || event.keyCode === 229`, on the event or on a React event's `nativeEvent`.
 */
export function isImeEnter(event: CompositionFacts): boolean {
  const native = event.nativeEvent;
  return (
    event.isComposing === true ||
    native?.isComposing === true ||
    event.keyCode === IME_KEY_CODE ||
    native?.keyCode === IME_KEY_CODE
  );
}
