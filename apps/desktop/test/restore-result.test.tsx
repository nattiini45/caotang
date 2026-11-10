import { afterEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { RestoreResult } from '../src/components/RestoreResult.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';

afterEach(activateEnglish);

for (const locale of ['en', 'de'] as const) {
  for (const summary of ['Applied: set 2 synopses.', 'Applied: set 2 synopses']) {
    for (const restoration of [undefined, 'whole', 'partial'] as const) {
      it(`${locale} keeps the original summary and separates ${restoration ?? 'confirmation'} copy from its punctuation: ${summary}`, async () => {
        if (locale === 'en') activateEnglish();
        else await activateCatalogue(locale);
        const html = renderToStaticMarkup(<I18nProvider i18n={i18n}><RestoreResult summary={summary} restoration={restoration} /></I18nProvider>);
        expect(html).toContain(`${locale === 'de' ? 'Ursprüngliches Ergebnis' : 'Original result'}: <bdi dir="auto">${summary}</bdi>`);
        expect(html.endsWith('</bdi>')).toBe(true);
        expect(html).not.toContain('..');
        if (restoration === 'whole') expect(html).toContain(locale === 'de' ? 'Die Projektänderungen dieses Durchlaufs wurden zurückgenommen.' : 'This turn’s project changes were taken back.');
        if (restoration === 'partial') expect(html).toContain(locale === 'de' ? 'Einige Projektänderungen dieses Durchlaufs wurden zurückgenommen.' : 'Some of this turn’s project changes were taken back.');
      });
    }
  }
}
