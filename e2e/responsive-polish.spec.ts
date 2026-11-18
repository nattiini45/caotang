import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './test.js';
import { chooseInterfaceLanguage, createProject } from './support.js';

async function selectLanguage(page: Page, settings: Locator, language: string): Promise<void> {
  await settings.locator('[data-section="appearance"]').click();
  await chooseInterfaceLanguage(page, settings, language);
  await expect(page.locator('html')).toHaveAttribute('lang', language);
}

for (const language of ['en', 'de']) {
  test(`the screenplay runtime is readable on a phone in ${language}`, { tag: '@modern' }, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
    await createProject(page, 'Harbour Screenplay');
    if (language === 'de') {
      await page.getByTestId('modern-more').click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const settings = page.getByTestId('settings');
      await selectLanguage(page, settings, language);
      await settings.getByRole('button', { name: 'Schließen', exact: true }).click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const banner = page.getByTestId('storage-banner');
    if (await banner.isVisible()) await banner.getByRole('button').last().click();
    await page.getByTestId('new-menu').click();
    await page.getByTestId('new-screenplay').click();
    const pill = page.locator('.sp-readout-chip');
    await expect(pill).toHaveText(language === 'de' ? '0 Seiten · etwa 0 min' : '0 pages · about 0 min');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      expect(await page.evaluate((scheme) => matchMedia(`(prefers-color-scheme: ${scheme})`).matches, colorScheme)).toBe(true);
      const bounds = await pill.evaluate((element) => {
        const card = element.closest('.sp-view')!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        return { card: [card.left, card.right], pill: [box.left, box.right], text: [text.left, text.right] };
      });
      expect(bounds.pill[0]!).toBeGreaterThanOrEqual(bounds.card[0]!);
      expect(bounds.pill[1]!).toBeLessThanOrEqual(bounds.card[1]!);
      expect(bounds.text[0]!).toBeGreaterThanOrEqual(bounds.pill[0]!);
      expect(bounds.text[1]!).toBeLessThanOrEqual(bounds.pill[1]!);
    }
  });
}
