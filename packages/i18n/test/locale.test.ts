import { describe, expect, it } from 'vitest';

import { PACKAGE_TEXT_LOCALE, SHIPPED_UI_LOCALES, SOURCE_LOCALE, directionOf, formatLocale, resolveUiLocale } from '../src/index.js';

describe('resolveUiLocale (i18n.md §3.1)', () => {
  it('ships English only today, and English is the source', () => {
    expect(SOURCE_LOCALE).toBe('en');
    expect(SHIPPED_UI_LOCALES).toEqual(['en']);
    expect(PACKAGE_TEXT_LOCALE).toBe('en-US');
  });

  it('follows the system to English on every system while only English ships', () => {
    expect(resolveUiLocale('system', ['en-US'])).toBe('en');
    expect(resolveUiLocale('system', ['en-GB', 'de-DE'])).toBe('en');
    expect(resolveUiLocale('system', ['de-DE', 'ja'])).toBe('en');
    expect(resolveUiLocale('system', [])).toBe('en');
  });

  it("takes the first system language a shipped locale matches, by tag, then language and script, then language", () => {
    const shipped = ['en', 'de', 'zh-Hant', 'pt-BR'];
    expect(resolveUiLocale('system', ['fr-FR', 'de-AT', 'en-US'], shipped)).toBe('de');
    expect(resolveUiLocale('system', ['zh-TW'], shipped)).toBe('zh-Hant');
    expect(resolveUiLocale('system', ['pt-br'], shipped)).toBe('pt-BR');
    expect(resolveUiLocale('system', ['pt-PT'], shipped)).toBe('en');
    expect(resolveUiLocale('system', ['not a tag', 'de'], shipped)).toBe('de');
  });

  it('lets a pinned setting win when it is shipped, and otherwise falls back to the system', () => {
    expect(resolveUiLocale('de', ['en-US'], ['en', 'de'])).toBe('de');
    expect(resolveUiLocale('DE-ch', ['en-US'], ['en', 'de'])).toBe('de');
    expect(resolveUiLocale('fr', ['de-DE'], ['en', 'de'])).toBe('de');
  });

  it('falls back to the first shipped locale when a build ships no source', () => {
    expect(resolveUiLocale('system', ['fr'], ['de', 'ja'])).toBe('de');
  });
});

describe('formatLocale (D3, i18n.md §4.1)', () => {
  it('is the interface language plus the system region when the languages match', () => {
    expect(formatLocale('en', ['en-GB'])).toBe('en-GB');
    expect(formatLocale('en', ['en-US'])).toBe('en-US');
    expect(formatLocale('en', ['de-DE', 'en-AU'])).toBe('en-AU');
  });

  it("is the language's own default region when no system language matches", () => {
    expect(formatLocale('de', ['en-US'])).toBe('de-DE');
    expect(formatLocale('en', ['de-DE'])).toBe('en-US');
    expect(formatLocale('en', [])).toBe('en-US');
    expect(formatLocale('en', ['en'])).toBe('en-US');
  });

  it('keeps the interface script, and a region the interface tag already has', () => {
    expect(formatLocale('zh-Hant', ['zh-HK'])).toBe('zh-Hant-HK');
    expect(formatLocale('zh-Hant', ['en-US'])).toBe('zh-Hant-TW');
    expect(formatLocale('pt-BR', ['pt-PT'])).toBe('pt-BR');
  });

  it('reads en-US for a tag it cannot parse', () => {
    expect(formatLocale('', ['en-GB'])).toBe('en-US');
    expect(formatLocale('not a tag', ['en-GB'])).toBe('en-US');
  });
});

describe('directionOf (i18n.md §3.2)', () => {
  it('is right to left for Arabic, Hebrew, Persian, Urdu and the rest of the list', () => {
    for (const tag of ['ar', 'ar-EG', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']) expect(directionOf(tag), tag).toBe('rtl');
  });

  it('is left to right for other languages and for a tag it cannot read', () => {
    for (const tag of ['en', 'de-DE', 'ja', 'zh-Hant', 'hi', 'ru', '', 'not a tag']) expect(directionOf(tag), tag).toBe('ltr');
  });
});
