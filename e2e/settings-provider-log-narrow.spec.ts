import { expect } from '@playwright/test';

import { endpointRoute, planThenAnswer } from './endpoint.js';
import { addCustomEndpoint } from './provider-setup-support.js';
import { chooseInterfaceLanguage } from './support.js';
import { test } from './test.js';

/**
 * The provider request log on a phone's Settings pane (#726). Its eight columns are wider than the pane, so German headers and
 * the long address pushed the whole Settings body sideways. The narrow layout answers with one labelled record per request
 * instead of a table (ui-modules §0.6), so every value keeps its own label and nothing scrolls sideways.
 *
 * The log is filled by a real gateway request to the fake endpoint Playwright answers, as settings-provider-setup.spec.ts does.
 */

const PANE = /Einstellungsbereiche/;

for (const shell of ['classic', 'modern'] as const) {
  test.describe(`${shell} Settings › Providers on a phone`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('caotang.interface', value), shell);
    });

    test('the request log reads as labelled records, and the pane does not scroll sideways in German', { tag: shell === 'modern' ? '@modern' : [] }, async ({ page }) => {
      await endpointRoute(page, 'https://127.0.0.1:5999', planThenAnswer({ reply: 'unused' }));
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-shell', shell);

      // A provider whose listing request fills the log, added in English and then read in German.
      await page.getByTestId('open-settings').click();
      const settings = page.getByTestId('settings');
      await expect(settings).toBeVisible();
      await settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Providers', exact: true }).click();
      await addCustomEndpoint(settings);
      await settings.locator('[data-section="appearance"]').click();
      await chooseInterfaceLanguage(page, settings, 'de');
      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('de');
      if (!(await settings.isVisible())) await page.getByTestId('open-settings').click();
      await expect(settings).toBeVisible();
      await settings.getByRole('navigation', { name: PANE }).getByRole('button', { name: 'Provider', exact: true }).click();

      const log = settings.getByTestId('request-log');
      await expect(log).toBeVisible();
      // Each request is a record of its own, not a row of a table that cannot fit.
      await expect(log).toHaveJSProperty('tagName', 'UL');
      const record = log.locator('li').first();
      await expect(record.locator('h5')).toHaveText(/^\d{2}:\d{2}:\d{2} · \S+$/);
      // Every column the table shows keeps a label of its own beside its value.
      for (const [label, value] of [['Profil', 'OpenAI-compatible endpoint'], ['Versuch', '0'], ['Ergebnis', 'ok'], ['Status', '200'], ['Adresse', '127.0.0.1:5999/v1']] as const) {
        const pair = record.locator('dl > div', { has: page.locator(`dt:text-is("${label}")`) });
        await expect(pair.locator('dt')).toHaveText(label);
        await expect(pair.locator('dd')).toContainText(value);
      }

      // The pane scrolls down only: no record, label or address runs past its right edge.
      const geometry = await settings.evaluate((element) => {
        const body = element.querySelector('.settings-body') as HTMLElement;
        const right = body.getBoundingClientRect().right;
        const past = [...element.querySelectorAll<HTMLElement>('[data-testid="request-log"] *')]
          .filter((node) => node.getClientRects().length > 0 && node.getBoundingClientRect().right > right + 1)
          .map((node) => `${node.tagName}:${(node.textContent ?? '').trim().slice(0, 60)}`);
        return { width: body.clientWidth, scroll: body.scrollWidth, past };
      });
      expect(geometry.past).toEqual([]);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    });
  });
}
