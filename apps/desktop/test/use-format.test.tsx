/**
 * The formatter binding (i18n.md §3.2, §4.1; I5): a mounted line re-reads its formatters when a
 * catalogue activates, so a language switch re-formats it without navigation or a remount.
 *
 * The test mirrors the two halves `useFormat` uses — the language store's subscription and
 * `formatAt(formatterLocale())` — because the component itself needs a DOM renderer this suite does
 * not carry. The mounted switch is also exercised by `e2e/i18n-switch.spec.ts` and
 * `e2e/i18n-surfaces.spec.ts`.
 */
import { describe, expect, it } from 'vitest';

import { formatterLocale } from '../src/i18n/format-locale.js';
import { languageRevision, subscribeLanguage, switchInterfaceLanguage } from '../src/i18n/language.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { formatAt } from '../src/i18n/use-format.js';

const DAY = new Date(2026, 9, 26);
const settings = { update: async (): Promise<null> => null };

describe('the formatter binding', () => {
  it('re-reads the formatters when a catalogue activates, so a mounted line formats in the new language', async () => {
    activateEnglish();
    // A line as a status or footer model renders it: the locale is read on every render, not captured.
    const line = (): string => formatAt(formatterLocale()).date(DAY, { day: 'numeric', month: 'short' });
    const before = line();
    const reads: string[] = [];
    const revisionBefore = languageRevision();
    // What a mounted `useFormat` does: subscribe, and render again when the revision changes.
    const unsubscribe = subscribeLanguage(() => reads.push(line()));
    try {
      const result = await switchInterfaceLanguage('ar-XB', settings);
      expect(result.status).toBe('switched');
      // The store announced the switch; a mounted component therefore re-renders.
      expect(languageRevision()).toBeGreaterThan(revisionBefore);
      expect(reads).toHaveLength(1);
      // The re-render reads the new locale, so the line differs without a navigation or a rebuild.
      expect(line()).not.toBe(before);
      expect(reads[0]).toBe(line());
    } finally {
      unsubscribe();
      // Leave the shared controller in the source locale for the rest of the suite.
      await switchInterfaceLanguage('en', settings);
    }
  });

  it('formats a USD price and a number in the locale it is given', () => {
    expect(formatAt('en-US').currency(0.0015)).toBe('$0.0015');
    expect(formatAt('en-GB').currency(0.0015)).toContain('US$0.0015');
    expect(formatAt('en-US').number(1234)).toBe('1,234');
    expect(formatAt('de-DE').number(1234)).toBe('1.234');
  });
});
