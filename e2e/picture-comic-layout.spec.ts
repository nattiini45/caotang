import { expect, test } from '@playwright/test';

import { emptyComic, germanComic, pictureScene } from './picture-comic-support.js';

test.use({ viewport: { width: 1440, height: 900 } });

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: Insert picture shares the manuscript start edge in both directions`, async ({ page }) => {
    await pictureScene(page, shell);
    for (const direction of ['ltr', 'rtl']) {
      await page.locator('html').evaluate((root, dir) => root.setAttribute('dir', dir), direction);
      const offset = await page.getByRole('button', { name: 'Insert picture', exact: true }).evaluate((button, dir) => {
        const range = document.createRange();
        range.selectNodeContents(button);
        const label = range.getBoundingClientRect();
        const column = button.closest('.editor-column')!.getBoundingClientRect();
        return dir === 'rtl' ? label.right - column.right : label.left - column.left;
      }, direction);
      expect(Math.abs(offset)).toBeLessThanOrEqual(1);
    }
    if (shell === 'modern') {
      const box = await page.getByRole('button', { name: 'Insert picture', exact: true }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
  });
}

for (const locale of ['en', 'de'] as const) {
  test(`Modern: empty comic panels explain how to add art in ${locale} without clipping`, async ({ page }) => {
    test.setTimeout(90_000);
    await emptyComic(page, 'modern');
    if (locale === 'de') await germanComic(page);
    const notes = page.locator('.comic-panel-empty');
    await expect(notes).toHaveCount(6);
    await expect(notes.first()).toHaveText(locale === 'de'
      ? 'Dieses Panel ist leer. Ziehen Sie ein Bild hinein, fügen Sie eines ein oder wählen Sie eines aus.'
      : 'This panel is empty. Drop, paste or choose a picture to add art.');
    for (const template of ['grid-6', 'grid-9']) {
      await page.locator('.comic-tools select').first().selectOption(template);
      await expect(notes).toHaveCount(template === 'grid-6' ? 6 : 9);
      expect(await notes.evaluateAll((elements) => elements.every((element) =>
        element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 &&
        getComputedStyle(element).visibility === 'visible' &&
        element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1,
      ))).toBe(true);
    }
    await page.locator('.comic-panel-g').first().click();
    await expect(page.getByRole('region', { name: 'Panel 1', exact: true })).toBeVisible();
  });
}
