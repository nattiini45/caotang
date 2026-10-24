/**
 * Which locale is the interface's, which locale formats its numbers and dates, and which way it reads
 * — [i18n.md §3.1, §4.1, §5](docs/architecture/i18n.md), decisions D3 and D8.
 */
import { describe, expect, it } from 'vitest';

import { directionOf, formatLocale, resolveUiLocale } from '../src/index.js';

describe('resolveUiLocale: a shipped catalogue, or the system when it is shipped', () => {
  it('returns a shipped tag as itself', () => {
    expect(resolveUiLocale('de', ['en-US'], ['en', 'de'])).toBe('de');
    expect(resolveUiLocale('en', ['de-DE'], ['en', 'de'])).toBe('en');
  });

  it('matches the system by language, so a regional system language picks its language catalogue', () => {
    expect(resolveUiLocale('system', ['en-GB', 'de'], ['en', 'de'])).toBe('en');
    expect(resolveUiLocale('system', ['de-AT', 'en-US'], ['en', 'de'])).toBe('de');
  });

  it('skips a system entry no catalogue ships and takes a later one that matches', () => {
    expect(resolveUiLocale('system', ['fr-FR', 'de-AT'], ['en', 'de'])).toBe('de');
    expect(resolveUiLocale('system', ['ja-JP', 'pt-BR', 'en-GB'], ['en', 'de'])).toBe('en');
  });

  it('falls back to English when no system language is shipped, and with no system languages at all', () => {
    expect(resolveUiLocale('system', ['fr-FR'], ['en', 'de'])).toBe('en');
    expect(resolveUiLocale('system', [], ['en', 'de'])).toBe('en');
  });

  it('never returns a tag that is not shipped, whatever the stored setting or the system says', () => {
    const shipped = ['en', 'de'];
    for (const setting of ['system', 'fr', 'de-CH', 'EN', '']) {
      for (const system of [[], ['fr'], ['ja-JP'], ['de-CH'], ['en-GB'], ['DE-at']]) {
        const resolved = resolveUiLocale(setting, system, shipped);
        expect(shipped, `${setting} / ${system.join(',')} → ${resolved}`).toContain(resolved);
      }
    }
  });

  it('resolves a stored tag that is no longer shipped through the system rather than returning it', () => {
    // A stored `fr` that is now below the release gate resolves like `system`; the picker's own
    // thresholds are L4/L11's concern, and this function is handed the already-shipped list (§3.2).
    expect(resolveUiLocale('fr', ['de-CH'], ['en', 'de'])).toBe('de');
    expect(resolveUiLocale('fr', ['en-GB'], ['en', 'de'])).toBe('en');
  });

  it('matches a shipped tag case-insensitively and returns its canonical spelling', () => {
    expect(resolveUiLocale('DE', ['en-US'], ['en', 'de'])).toBe('de');
    expect(resolveUiLocale('system', ['EN-gb'], ['en'])).toBe('en');
  });
});

describe('formatLocale: the UI language, and the system region only when the languages match', () => {
  it('keeps the system region of the same language', () => {
    expect(formatLocale('en', ['en-GB'])).toBe('en-GB');
    expect(formatLocale('de', ['de-AT'])).toBe('de-AT');
    expect(formatLocale('en', ['en'])).toBe('en');
  });

  it('uses the language default region when the system speaks another language', () => {
    expect(formatLocale('de', ['en-US'])).toBe('de-DE');
    expect(formatLocale('en', ['de-DE'])).toBe('en-US');
    expect(formatLocale('en', ['fr-FR'])).toBe('en-US');
  });

  it('is never the first system tag by accident: the first matching language wins, not the first tag', () => {
    expect(formatLocale('en', ['de-DE', 'en-GB'])).toBe('en-GB');
    expect(formatLocale('en', ['en-GB', 'en-US'])).toBe('en-GB');
  });

  it('uses the language default region when there are no system languages', () => {
    expect(formatLocale('en', [])).toBe('en-US');
    expect(formatLocale('de', [])).toBe('de-DE');
  });

  it('keeps a script a tag carries', () => {
    expect(formatLocale('zh-Hant', ['en-US'])).toBe('zh-Hant-TW');
  });
});

describe('directionOf: the UI language, not the project language', () => {
  it('reads English left to right and Hebrew right to left', () => {
    expect(directionOf('he-IL')).toBe('rtl');
    expect(directionOf('en-US')).toBe('ltr');
  });

  it('names every language the spec lists, with or without the engine’s own text info', () => {
    for (const tag of ['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'ar-EG', 'fa-IR']) {
      expect(directionOf(tag), tag).toBe('rtl');
    }
    for (const tag of ['en', 'de-DE', 'ja-JP', 'zh-Hant']) {
      expect(directionOf(tag), tag).toBe('ltr');
    }
  });

  it('does not throw on a tag that is not a language tag, and calls it left to right', () => {
    // Message ids are opaque and never reach Intl (§3.2); a caller that passes one by mistake gets a
    // direction, not an exception.
    expect(directionOf('coherence.timeline.orderDrift')).toBe('ltr');
    expect(directionOf('')).toBe('ltr');
  });
});
