import { expect, test } from '@playwright/test';

import { localeFirstWeekday } from '../../packages/furniture/src/index.js';
import { resolveUiLocale } from '../../packages/i18n/src/index.js';
import { formatCount, wordsLabel } from '../../apps/desktop/src/app/counts.js';
import { SHIPPED_UI_LOCALES, formatterLocale, setUiLocaleTag, uiLocale } from '../../apps/desktop/src/i18n/format-locale.js';
import { projectCollator } from '../../apps/desktop/src/i18n/project-collator.js';

/**
 * The app's formatter-locale accessor (i18n.md §4.1, D3). The runtime sets the tag only after a
 * successful activation; these tests set it directly and inject the system languages, so their
 * expectations do not depend on the machine running them.
 */
test.describe('the app’s formatter locale (i18n.md §4.1, D3)', () => {
  test('the interface resolves to English while the English and German catalogues ship', () => {
    setUiLocaleTag('en');
    expect(SHIPPED_UI_LOCALES).toEqual(['en', 'de']);
    expect(uiLocale()).toBe('en');
  });

  test('an English system keeps its region, and another system gets the English default region', () => {
    setUiLocaleTag('en');
    expect(formatterLocale(['en-GB'])).toBe('en-GB');
    expect(formatterLocale(['en-AU'])).toBe('en-AU');
    expect(formatterLocale(['de-DE'])).toBe('en-US');
    expect(formatterLocale(['de-CH', 'en-GB'])).toBe('en-GB');
  });

  test('after a switch the formatter follows the activated catalogue, with the system region only when the languages match', () => {
    setUiLocaleTag('de');
    expect(formatterLocale(['de-DE'])).toBe('de-DE');
    expect(formatterLocale(['en-US'])).toBe('de-DE');
    setUiLocaleTag('en');
  });

  test('the result is a locale Intl accepts', () => {
    setUiLocaleTag('en');
    expect(() => new Intl.NumberFormat(formatterLocale(['en-GB']))).not.toThrow();
  });

  test('an empty shipped list answers English rather than an unshipped tag or a throw', () => {
    // A misconfigured build still renders: the source locale is the only honest answer when nothing is listed.
    expect(resolveUiLocale('system', ['de-DE'], [])).toBe('en');
  });
});

test.describe('the project’s sort language (i18n.md §4.3, D9)', () => {
  test('a name is sorted by the project language, and by the interface when the project names none', () => {
    expect(projectCollator('sv', 'en').compare('Åland', 'Zebra')).toBeGreaterThan(0);
    expect(projectCollator('en', 'sv').compare('Åland', 'Zebra')).toBeLessThan(0);
    expect(projectCollator(undefined, 'sv').compare('Åland', 'Zebra')).toBeGreaterThan(0);
    expect(projectCollator('   ', 'sv').compare('Åland', 'Zebra')).toBeGreaterThan(0);
  });

  test('a malformed stored tag does not throw, so a loaded project still lists its names', () => {
    expect(() => projectCollator('not a tag', 'en')).not.toThrow();
    expect(() => projectCollator('en_US', 'en')).not.toThrow();
  });
});

test.describe('the goal week start follows the formatter locale (i18n.md §4.2)', () => {
  test('a German system under the English interface starts on Sunday; a British one on Monday', () => {
    expect(localeFirstWeekday(formatterLocale(['de-DE']))).toBe(0);
    expect(localeFirstWeekday(formatterLocale(['en-GB']))).toBe(1);
  });
});

test.describe('the panel count formatter is the formatter locale’s (§4.2)', () => {
  test('grouping changes with the locale, while the sentence around it stays English', () => {
    expect(formatCount(1_234_567, 'en-US')).toBe('1,234,567');
    expect(formatCount(1_234_567, 'de-DE')).toBe('1.234.567');
    expect(wordsLabel(2_000, 'en-US')).toBe('2,000 words');
    expect(wordsLabel(2_000, 'de-DE')).toBe('2.000 words');
    expect(wordsLabel(1, 'de-DE')).toBe('1 word');
  });
});
