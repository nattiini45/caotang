import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { i18n } from '@lingui/core';
import { expect, test } from '@playwright/test';

import {
  createKeyboardLayoutStore,
  printedKeyLabel,
  resolveKey,
  shortcutLabel,
  type KeyboardLayoutMap,
  type KeyboardSource,
} from '../../apps/desktop/src/app/keymap.js';

/** A layout as `navigator.keyboard.getLayoutMap()` reports it: the unshifted character of each physical key. */
function layout(entries: Record<string, string>): KeyboardLayoutMap {
  return new Map(Object.entries(entries));
}

const QWERTZ = layout({ KeyZ: 'y', KeyY: 'z', KeyN: 'n', KeyF: 'f', Digit1: '1' });
const AZERTY = layout({ KeyW: 'z', KeyZ: 'w', KeyN: 'n', KeyF: 'f', Digit1: '&' });
const RUSSIAN = layout({ KeyZ: 'я', KeyN: 'т', KeyF: 'а', Digit1: '1' });
const GREEK = layout({ KeyZ: 'ζ', KeyN: 'ν', KeyF: 'φ' });
const HEBREW = layout({ KeyZ: 'ז', KeyN: 'מ', KeyF: 'כ' });
const ARABIC = layout({ KeyZ: 'ئ', KeyN: 'ى', KeyF: 'ب' });

test.describe('shortcut labels', () => {
  test('without a layout map the label is the English one callers already get', () => {
    expect(shortcutLabel('new-document')).toBe('Ctrl+N');
    expect(shortcutLabel('undo', null)).toBe('Ctrl+Z');
    expect(shortcutLabel('focus-filter', undefined)).toBe('Ctrl+Alt+F');
    expect(shortcutLabel('focus-mode')).toBe('Ctrl+Shift+F');
    expect(shortcutLabel('open-in-editor')).toBe('Ctrl+Enter');
    expect(shortcutLabel('agent-stop')).toBe('Esc');
    expect(shortcutLabel('delete')).toBe('Delete');
    expect(shortcutLabel('reorder-up')).toBe('Alt+Up');
    expect(shortcutLabel('rename')).toBe('F2');
    expect(shortcutLabel('open-menu')).toBe('Shift+F10');
  });

  test('a Latin layout keeps the letter the writer sees, wherever the key sits', () => {
    expect(shortcutLabel('undo', QWERTZ)).toBe('Ctrl+Z');
    expect(shortcutLabel('undo', AZERTY)).toBe('Ctrl+Z');
    expect(shortcutLabel('new-document', AZERTY)).toBe('Ctrl+N');
    expect(printedKeyLabel('1', QWERTZ)).toBe('1');
  });

  test('a layout that prints another script labels the key the shortcut is actually on', () => {
    expect(shortcutLabel('undo', RUSSIAN)).toBe('Ctrl+Я');
    expect(shortcutLabel('new-document', RUSSIAN)).toBe('Ctrl+Т');
    expect(shortcutLabel('focus-mode', GREEK)).toBe('Ctrl+Shift+Φ');
    expect(shortcutLabel('focus-filter', HEBREW)).toBe('Ctrl+Alt+כ');
    expect(shortcutLabel('undo', ARABIC)).toBe('Ctrl+ئ');
  });

  test('the label names the same physical key the resolver reads', () => {
    const facts = { ctrl: true, meta: false, shift: false, alt: false, altGraph: false, composing: false };
    const context = { inTextField: false, inBinder: false };
    expect(resolveKey({ key: 'я', code: 'KeyZ', ...facts }, context)).toBe('undo');
    expect(printedKeyLabel('z', RUSSIAN)).toBe('Я');
  });

  test('a layout that cannot print the key, or a digit with no printed form, falls back to the Latin character', () => {
    expect(printedKeyLabel('z', layout({}))).toBe('Z');
    expect(printedKeyLabel('z', layout({ KeyZ: '' }))).toBe('Z');
    expect(printedKeyLabel('z', layout({ KeyZ: 'dead' }))).toBe('Z');
    expect(printedKeyLabel('z', layout({ KeyZ: ' ' }))).toBe('Z');
    expect(printedKeyLabel('z', layout({ KeyZ: 'q' }))).toBe('Z');
  });

  test('a digit follows the digit row, not the letter row', () => {
    // AZERTY prints & unshifted on Digit1, and the resolver reads that key through its code, so the cap is the label.
    expect(printedKeyLabel('1', AZERTY)).toBe('&');
    expect(printedKeyLabel('1', layout({ Digit1: '١' }))).toBe('١');
    expect(printedKeyLabel('1', layout({ Digit1: '1' }))).toBe('1');
  });

  test.describe('in German', () => {
    test.beforeAll(async () => {
      const url = pathToFileURL(
        resolve('apps/desktop/node_modules/@lingui/message-utils/dist/generateMessageId.node.mjs'),
      ).href;
      const { generateMessageId } = (await import(url)) as { generateMessageId: (message: string, context?: string) => string };
      const names: Record<string, string> = {
        Ctrl: 'Strg',
        Shift: 'Umschalt',
        Enter: 'Eingabe',
        Delete: 'Entf',
        Up: 'Hoch',
      };
      const messages: Record<string, string> = {};
      for (const [source, translation] of Object.entries(names)) {
        messages[generateMessageId(source, 'keyboard key')] = translation;
      }
      i18n.load('de', messages);
    });

    test.beforeEach(() => i18n.activate('de'));
    test.afterEach(() => i18n.activate('en'));

    test('modifier and key names come from the catalogue, and an untranslated one keeps its English name', () => {
      expect(shortcutLabel('new-document')).toBe('Strg+N');
      expect(shortcutLabel('focus-mode')).toBe('Strg+Umschalt+F');
      expect(shortcutLabel('open-in-editor')).toBe('Strg+Eingabe');
      expect(shortcutLabel('delete')).toBe('Entf');
      expect(shortcutLabel('reorder-up')).toBe('Alt+Hoch');
      expect(shortcutLabel('agent-stop')).toBe('Esc');
    });

    test('the German key names and the layout printed key combine', () => {
      expect(shortcutLabel('undo', QWERTZ)).toBe('Strg+Z');
      expect(shortcutLabel('undo', RUSSIAN)).toBe('Strg+Я');
    });
  });
});

test.describe('the keyboard layout store', () => {
  interface FakeKeyboard extends KeyboardSource {
    readonly reads: number;
    readonly listening: boolean;
    resolve(map: KeyboardLayoutMap): Promise<void>;
  }

  function fake(initial: KeyboardLayoutMap | 'throws' | 'rejects'): FakeKeyboard {
    let next: KeyboardLayoutMap | 'throws' | 'rejects' = initial;
    let reads = 0;
    let layoutchange: (() => void) | undefined;
    return {
      get reads() {
        return reads;
      },
      get listening() {
        return layoutchange !== undefined;
      },
      getLayoutMap() {
        reads += 1;
        if (next === 'throws') throw new Error('SecurityError');
        return next === 'rejects' ? Promise.reject(new Error('SecurityError')) : Promise.resolve(next);
      },
      addEventListener(_type, listener) {
        layoutchange = listener;
      },
      removeEventListener() {
        layoutchange = undefined;
      },
      async resolve(map) {
        next = map;
        layoutchange?.();
        await Promise.resolve();
      },
    };
  }

  const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

  test('reads nothing until a component subscribes, then publishes the layout and follows layoutchange', async () => {
    const keyboard = fake(RUSSIAN);
    const store = createKeyboardLayoutStore(() => keyboard);
    expect(keyboard.reads).toBe(0);
    expect(store.snapshot()).toBeNull();

    let notified = 0;
    const unsubscribe = store.subscribe(() => (notified += 1));
    await settle();
    expect(store.snapshot()).toBe(RUSSIAN);
    expect(notified).toBe(1);
    expect(keyboard.listening).toBe(true);

    await keyboard.resolve(QWERTZ);
    await settle();
    expect(store.snapshot()).toBe(QWERTZ);
    expect(notified).toBe(2);

    unsubscribe();
    expect(keyboard.listening).toBe(false);
  });

  test('a read that settles after the last unsubscribe is dropped', async () => {
    const keyboard = fake(RUSSIAN);
    const store = createKeyboardLayoutStore(() => keyboard);
    let notified = 0;
    store.subscribe(() => (notified += 1))();
    await settle();
    expect(notified).toBe(0);
    expect(store.snapshot()).toBeNull();
  });

  test('a second subscriber gets the layout already read', async () => {
    const keyboard = fake(RUSSIAN);
    const store = createKeyboardLayoutStore(() => keyboard);
    store.subscribe(() => undefined);
    await settle();
    let late = 0;
    store.subscribe(() => (late += 1));
    await settle();
    expect(late).toBe(1);
    expect(keyboard.reads).toBe(1);
  });

  test('no keyboard API, a throwing call and a rejected call all leave the snapshot empty', async () => {
    for (const source of [() => undefined, () => ({}), () => fake('throws'), () => fake('rejects')]) {
      const store = createKeyboardLayoutStore(source);
      let notified = 0;
      const unsubscribe = store.subscribe(() => (notified += 1));
      await settle();
      expect(store.snapshot()).toBeNull();
      expect(notified).toBe(0);
      unsubscribe();
    }
  });
});
