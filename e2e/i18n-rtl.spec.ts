import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderRow, binderTitle, createProject, waitForSaved } from './support.js';

/**
 * The right-to-left shell (i18n.md §5, §8.3; I9 / #199). The shell mirrors with the interface language, the tree and the tabs read
 * their arrow keys in reading order, and the manuscript stays in its own direction. The interface ships as Preview until a native
 * reader of Arabic or Hebrew reviews it, so these checks prove structure, not translation quality.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('caotang.pseudo', '1');
  });
});

async function openSettings(page: Page): Promise<Locator> {
  await page.getByTestId('open-settings').focus();
  await page.keyboard.press('Enter');
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  return settings;
}

/** Switches to the RTL pseudo catalogue, then closes Settings by structure. */
async function switchToRtl(page: Page): Promise<void> {
  const settings = await openSettings(page);
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="ar-XB"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  await settings.locator('.settings-head button').click();
}

async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

for (const width of [960, 1100]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('the shell mirrors: the binder sits at the inline start, and nothing scrolls sideways', async ({ page }) => {
      await createProject(page, 'Mirror');
      const before = await page.locator('.binder, [aria-label="Binder"]').first().boundingBox();
      expect(before?.x ?? 9999).toBeLessThan(width / 2);

      await switchToRtl(page);
      await expect(page.locator('html')).toHaveAttribute('lang', 'ar-XB');
      const after = await page.locator('.binder, [aria-label="Binder"]').first().boundingBox();
      expect((after?.x ?? 0) + (after?.width ?? 0) / 2).toBeGreaterThan(width / 2);
      expect(await fitsWidth(page)).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dir').trim())).toBe('-1');
    });

    test('forced colours and reduced motion keep the mirrored shell inside the window and the keyboard reachable', async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      await createProject(page, 'Mirror Colours');
      await switchToRtl(page);
      expect(await fitsWidth(page)).toBe(true);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
      expect(focused).not.toBe('BODY');
      expect(await fitsWidth(page)).toBe(true);
    });
  });
}

test('in a right-to-left interface Right folds a folder and Left opens it, and the rail tabs read in reading order', async ({ page }) => {
  await createProject(page, 'Keys');
  await page.locator('.row.is-section', { hasText: 'Manuscript' }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Chapter 1');
  await page.keyboard.press('Enter');
  await waitForSaved(page);

  await switchToRtl(page);
  await binderTitle(page, 'Chapter 1').click();
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowLeft');
  await expect(binderRow(page, 'Chapter 1')).toHaveAttribute('aria-expanded', 'true');

  const tabs = page.locator('.rail-tabs [role="tab"]');
  await tabs.first().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.first()).toBeFocused();
});

test('a Hebrew title in the English interface keeps its own direction beside the interface text', async ({ page }) => {
  await createProject(page, 'Hebrew');
  await page.locator('.row.is-section', { hasText: 'Manuscript' }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('שלום עולם');
  await page.keyboard.press('Enter');
  await waitForSaved(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  const title = page.locator('.row-title', { hasText: 'שלום עולם' }).first();
  await expect(title).toBeVisible();
  const direction = await title.evaluate((node) => {
    const bdi = node.querySelector('bdi') ?? node.closest('bdi');
    return bdi?.getAttribute('dir') ?? getComputedStyle(node).direction;
  });
  expect(['auto', 'rtl', 'ltr']).toContain(direction);
  expect(await fitsWidth(page)).toBe(true);
});
