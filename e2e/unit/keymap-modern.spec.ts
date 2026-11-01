import { expect, test } from '@playwright/test';

import { resolveKey, shortcutLabel, type KeyContext, type KeyFacts } from '../../apps/desktop/src/app/keymap.js';

/**
 * Modern's palette chord (modern-interface.md §8.11, D10, D11): Ctrl+K (Cmd+K) resolves to `palette` only with `shell: 'modern'`,
 * before the text-field rule so it works while typing, never while an input method composes or AltGr types a character, and on
 * any layout by the keymap's one layout rule. Classic gains nothing: the chord is `null` there, and every other chord resolves the
 * same in both shells.
 */

function keys(key: string, mods: Partial<Omit<KeyFacts, 'key'>> = {}): KeyFacts {
  return { key, code: '', altGraph: false, ctrl: false, meta: false, shift: false, alt: false, composing: false, ...mods };
}

const MODERN: KeyContext = { inTextField: false, inBinder: false, shell: 'modern' };
const MODERN_TYPING: KeyContext = { inTextField: true, inBinder: false, shell: 'modern' };

test('Ctrl+K and Cmd+K open the palette in Modern, typing or not', () => {
  expect(resolveKey(keys('k', { ctrl: true, code: 'KeyK' }), MODERN)).toBe('palette');
  expect(resolveKey(keys('k', { meta: true, code: 'KeyK' }), MODERN)).toBe('palette');
  expect(resolveKey(keys('K', { ctrl: true, code: 'KeyK' }), MODERN)).toBe('palette');
  expect(resolveKey(keys('k', { ctrl: true, code: 'KeyK' }), MODERN_TYPING)).toBe('palette');
  expect(resolveKey(keys('k', { ctrl: true }), { ...MODERN_TYPING, inAgent: true, inAgentIntent: true })).toBe('palette');
});

test('Classic has no palette chord (D11)', () => {
  expect(resolveKey(keys('k', { ctrl: true, code: 'KeyK' }), { inTextField: false, inBinder: false })).toBeNull();
  expect(resolveKey(keys('k', { ctrl: true, code: 'KeyK' }), { inTextField: false, inBinder: false, shell: 'classic' })).toBeNull();
  expect(resolveKey(keys('k', { meta: true, code: 'KeyK' }), { inTextField: true, inBinder: false, shell: 'classic' })).toBeNull();
});

test('a composing input method, AltGr, Shift, Alt or a bare K never opens it', () => {
  expect(resolveKey(keys('k', { ctrl: true, composing: true }), MODERN)).toBeNull();
  expect(resolveKey(keys('k', { ctrl: true, alt: true, altGraph: true }), MODERN)).toBeNull();
  expect(resolveKey(keys('K', { ctrl: true, shift: true }), MODERN)).toBeNull();
  expect(resolveKey(keys('k', { ctrl: true, alt: true }), MODERN)).toBeNull();
  expect(resolveKey(keys('k'), MODERN)).toBeNull();
  expect(resolveKey(keys('k'), MODERN_TYPING)).toBeNull();
});

test('the chord follows the layout rule: the printed K on Latin layouts, the physical key on others', () => {
  // Russian ЙЦУКЕН prints л on the K key; Greek prints κ.
  expect(resolveKey(keys('л', { ctrl: true, code: 'KeyK' }), MODERN)).toBe('palette');
  expect(resolveKey(keys('κ', { ctrl: true, code: 'KeyK' }), MODERN)).toBe('palette');
  // Dvorak prints t on the physical K key: Ctrl+T is not the palette, and the key printed K (physical V) is.
  expect(resolveKey(keys('t', { ctrl: true, code: 'KeyK' }), MODERN)).toBeNull();
  expect(resolveKey(keys('k', { ctrl: true, code: 'KeyV' }), MODERN)).toBe('palette');
});

test('every other chord resolves the same in both shells', () => {
  const contexts: KeyContext[] = [
    { inTextField: false, inBinder: false },
    { inTextField: true, inBinder: false },
    { inTextField: false, inBinder: true },
    { inTextField: false, inBinder: false, inCorkboard: true },
    { inTextField: true, inBinder: false, inAgent: true, inAgentIntent: true, agentIntentEmpty: true },
    { inTextField: false, inBinder: true, rtl: true },
  ];
  const presses: KeyFacts[] = [
    keys('n', { ctrl: true }),
    keys('z', { ctrl: true }),
    keys('Z', { ctrl: true, shift: true }),
    keys('F', { ctrl: true, shift: true }),
    keys('f', { ctrl: true, alt: true }),
    keys('Enter'),
    keys('Enter', { ctrl: true }),
    keys('Escape'),
    keys('F2'),
    keys('Delete'),
    keys(' '),
    keys('F10', { shift: true }),
    ...['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].flatMap((arrow) => [keys(arrow), keys(arrow, { alt: true })]),
  ];
  for (const context of contexts) {
    for (const press of presses) {
      const classic = resolveKey(press, context);
      expect(resolveKey(press, { ...context, shell: 'modern' }), `${JSON.stringify(press)} in ${JSON.stringify(context)}`).toBe(classic);
      expect(resolveKey(press, { ...context, shell: 'classic' })).toBe(classic);
    }
  }
});

test('the palette chord has its label', () => {
  expect(shortcutLabel('palette')).toBe('Ctrl+K');
});
