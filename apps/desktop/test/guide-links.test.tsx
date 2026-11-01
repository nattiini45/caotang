import { describe, expect, it } from 'vitest';

import { guideHref } from '../src/i18n/guide-links';
import guideStatus from '../src/i18n/guide-status.json';

describe('the localized guide link', () => {
  it('uses the translated anchor only for a current German section', () => {
    expect(guideStatus.locales.de?.sections.settings?.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(guideHref('de', 'settings')).toBe(
      'https://github.com/nattiini45/caotang/blob/main/docs/i18n/de/USER-GUIDE.md#einstellungen',
    );
  });

  it('falls back to English for English, pseudo, missing and unknown sections', () => {
    const root = 'https://github.com/nattiini45/caotang/blob/main/docs/USER-GUIDE.md';
    expect(guideHref('en', 'settings')).toBe(`${root}#settings`);
    expect(guideHref('ar-XB', 'settings')).toBe(`${root}#settings`);
    expect(guideHref('fr', 'settings')).toBe(`${root}#settings`);
    expect(guideHref('de', 'not-a-section')).toBe(`${root}#not-a-section`);
  });
});
