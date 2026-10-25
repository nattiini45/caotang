/**
 * G2: the *loader* wires the per-message English fallback, not only the `withEnglishFallback` helper.
 *
 * `test/i18n-build.test.ts` proves the helper and the activation primitive. Here the compiled pseudo
 * catalogues cover every id, so a "missing translation" cannot be shown with them. This file mocks the
 * two `.po` modules: the English module keeps the real compiled catalogue (via `importOriginal`) and
 * adds one test-only id, while the pseudo-LOCALE module is a partial catalogue that translates that
 * one id and omits the real `Settings` id. `loadMessages`/`activateCatalogue` then have one missing id
 * (must render English) and one translated id (must win) in the same catalogue.
 */
import { i18n } from '@lingui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { witnessMessage } from './fixtures/i18n-macro.js';

const TRANSLATED_ID = 'fallback-wiring-translated';

vi.mock('../apps/desktop/src/i18n/locales/en/messages.po', async (importOriginal) => {
  const original = await importOriginal<{ messages: Record<string, unknown> }>();
  return { messages: { ...original.messages, [TRANSLATED_ID]: ['English translated'] } };
});

vi.mock('../apps/desktop/src/i18n/locales/pseudo-LOCALE/messages.po', () => ({
  messages: { [TRANSLATED_ID]: ['Traduction'] },
}));

const { activateCatalogue, loadMessages } = await import('../apps/desktop/src/i18n/runtime.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the loader applies the English fallback to a partial catalogue', () => {
  it('loadMessages contains the English message for the missing id and the translation for the translated one', async () => {
    const messages = await loadMessages('en-XA');

    expect(Object.prototype.hasOwnProperty.call(messages, witnessMessage.id)).toBe(true);
    expect(messages[witnessMessage.id]).toEqual(['Settings']);
    expect(messages[TRANSLATED_ID]).toEqual(['Traduction']);
  });

  it('activateCatalogue renders English for the missing id and the translation for the translated id', async () => {
    await activateCatalogue('en-XA');

    expect(i18n._(witnessMessage.id)).toBe('Settings');
    expect(i18n._(TRANSLATED_ID)).toBe('Traduction');
  });
});
