import { devices, expect, test, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { waitForSaved } from './support.js';

test.use({ storageState: NO_PIN });

async function start(page: Page, width = 390): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
  await page.goto('/');
  await page.getByLabel('Project name').fill('Phone Book');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await waitForSaved(page);
  const banner = page.getByTestId('storage-banner');
  if (await banner.isVisible()) await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
}

for (const width of [390, 1280]) {
  test(`Import stays on the binder action row at ${width} px`, async ({ page }) => {
    await start(page, width);
    if (width === 390) await page.getByTestId('modern-narrow-binder').click();
    else await page.getByTestId('modern-binder').getByRole('button', { name: 'Binder', exact: true }).click();
    const panel = page.getByTestId(width === 390 ? 'modern-drawer' : 'modern-sidebar');
    const create = panel.getByRole('button', { name: 'New document', exact: true });
    const summary = panel.locator('.binder-import > summary');
    const first = await create.boundingBox();
    const last = await summary.boundingBox();
    const bounds = await panel.locator('.binder').boundingBox();
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    expect(Math.abs(first!.y - last!.y)).toBeLessThanOrEqual(1);
    expect(last!.x + last!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    await summary.click();
    await expect(panel.locator('.binder-import')).toHaveAttribute('open', '');
    await expect(panel.getByRole('button', { name: 'Import script', exact: true })).toBeVisible();
  });
}

test('Timeline has clearance in the phone tab bar and no radio track behind it', async ({ page }) => {
  await start(page);
  const bar = page.getByTestId('modern-bottom-ornament');
  await expect(bar.getByRole('radio')).toHaveCount(1);
  await page.getByTestId('modern-narrow-views').click();
  await page.getByTestId('modern-views-timeline').click();
  await expect(page.locator('#modern-page')).toHaveAttribute('data-view', 'timeline');
  await expect(page.getByTestId('modern-lens')).toBeHidden();
  const tab = page.getByTestId('modern-narrow-views');
  await expect(tab).toHaveText('Timeline');
  const clearance = await tab.evaluate((element) => {
    const label = element.querySelector('.modern-label')!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return Math.min(label.left - box.left, box.right - label.right);
  });
  expect(clearance).toBeGreaterThanOrEqual(4);
  expect(await bar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

test('WebKit hides the phone tab bar when only the visual viewport shrinks for typing', async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== 'webkit', 'The visual-only keyboard resize is the iOS Safari path.');
  const context = await browser.newContext({ ...devices['iPhone 14'], baseURL, locale: 'en-US', storageState: NO_PIN });
  try {
    const page = await context.newPage();
    await start(page);
    await page.getByTestId('new-menu').click();
    await page.getByTestId('new-scene').click();
    const text = page.getByRole('textbox', { name: 'Document text' });
    await expect(text).toBeVisible();
    const bar = page.getByTestId('modern-bottom-ornament');
    const height = await page.evaluate(() => window.innerHeight);
    const viewport = async (visible: number, scale = 1): Promise<void> => {
      await page.evaluate(({ visible, scale }) => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: visible });
        Object.defineProperty(window.visualViewport, 'scale', { configurable: true, value: scale });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      }, { visible, scale });
    };
    await text.focus();
    await viewport(height - 60);
    await expect(bar).toBeVisible();
    await viewport(500, 1.5);
    await expect(bar).toBeVisible();
    await viewport(500);
    await expect(bar).toBeHidden();
    expect(await page.evaluate(() => window.innerHeight)).toBe(height);
    const paper = await page.locator('.modern-page-area').boundingBox();
    expect(Math.round(paper!.y + paper!.height)).toBe(height - 8);
    await viewport(height);
    await expect(text).toBeFocused();
    await expect(bar).toBeVisible();
    await viewport(500);
    await expect(bar).toBeHidden();
    await text.evaluate((element) => (element as HTMLElement).blur());
    await expect(bar).toBeVisible();
    await viewport(height);
    await page.getByTestId('modern-narrow-binder').click();
    const filter = page.getByRole('searchbox', { name: 'Filter the binder by text' });
    await filter.focus();
    await viewport(500);
    await expect(bar).toBeHidden();
    await viewport(height);
    await expect(bar).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('modern-stage')).not.toHaveAttribute('data-visual-keyboard');
  } finally {
    await context.close();
  }
});
