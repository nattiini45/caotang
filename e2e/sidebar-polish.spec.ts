import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { createProject } from './support.js';

test.use({ storageState: NO_PIN });

async function chooseShell(page: Page, shell: 'classic' | 'modern'): Promise<void> {
  await page.addInitScript((chosen) => localStorage.setItem('caotang.interface', chosen), shell);
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

async function edges(target: Locator, value: string): Promise<void> {
  await expect(target).toHaveAttribute('data-scroll-edges', value);
}

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: Settings fades follow vertical scroll, content changes and resizes`, async ({ page }) => {
    await chooseShell(page, shell);
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('settings');
    await expect(settings).toBeVisible();
    const body = settings.locator('.settings-body');
    await edges(body, 'bottom');
    await expect.poll(() => body.evaluate((element) => getComputedStyle(element, '::after').opacity)).toBe('1');
    await body.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
    await edges(body, 'top bottom');
    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await edges(body, 'top');
    await settings.locator('[data-section="writing"]').click();
    await page.setViewportSize({ width: 1280, height: 1600 });
    await edges(body, '');
    await page.setViewportSize({ width: 1280, height: 400 });
    await expect.poll(() => body.getAttribute('data-scroll-edges')).not.toBe('');
    await page.emulateMedia({ forcedColors: 'active' });
    await expect.poll(() => body.evaluate((element) => getComputedStyle(element, '::after').visibility)).toBe('hidden');
  });

  test(`${shell}: narrow Settings shows which way more sections remain`, async ({ page }) => {
    await chooseShell(page, shell);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav).toHaveAttribute('data-scroll-edges', /\bend\b/);
    await nav.evaluate((element) => { element.scrollLeft = 100; });
    await edges(nav, 'start end');
    await nav.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await edges(nav, 'start');
    await page.getByRole('button', { name: 'Data', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Data', exact: true })).toBeVisible();
  });
}

test('German sidebar labels remain whole at normal and enlarged type', async ({ page }) => {
  await chooseShell(page, 'modern');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Auf Kontinuitätsprobleme prüfen', exact: true }).click();
  await expect(page.getByTestId('modern-binder-findings-count')).toHaveText(/[1-9]/);
  await expect(page.locator('.agent-report-text')).toHaveCount(1);
  await page.locator('.modern-companion .agent-close').click();
  await page.getByRole('navigation', { name: 'Binder', exact: true }).getByRole('button', { name: 'Binder', exact: true }).click();
  const tabs = page.getByTestId('modern-sidebar').getByRole('tab');
  await expect(tabs).toHaveCount(4);
  for (const scale of [1, 1.5]) {
    if (scale > 1) await page.evaluate(() => document.styleSheets[0]?.insertRule('.modern-sidebar-tabs .rail-tab { font-size: 19.5px !important; }'));
    expect(await tabs.evaluateAll((elements) => elements.filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.textContent))).toEqual([]);
    for (const tab of await tabs.all()) await expect(tab).toBeVisible();
  }
});

test('the sidebar fades only while content remains, with an opaque accessibility fallback', async ({ page }) => {
  await chooseShell(page, 'modern');
  await page.setViewportSize({ width: 1280, height: 800 });
  await createProject(page, 'Scroll Book');
  await page.getByRole('navigation', { name: 'Binder', exact: true }).getByRole('button', { name: 'Binder', exact: true }).click();
  const panel = page.locator('.modern-sidebar-panel');
  await edges(panel, 'bottom');
  await panel.evaluate((element) => { element.scrollTop = 80; });
  await edges(panel, 'top bottom');
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await edges(panel, 'top');
  await page.evaluate(() => { document.documentElement.dataset['transparency'] = 'reduced'; });
  await expect.poll(() => panel.evaluate((element) => getComputedStyle(element, '::before').visibility)).toBe('hidden');
});

test('the 1280 px companion sheet stays between both ornaments', async ({ page }) => {
  await chooseShell(page, 'modern');
  await page.setViewportSize({ width: 1280, height: 800 });
  await createProject(page, 'Clearance Book');
  await page.keyboard.press('ControlOrMeta+j');
  const companion = page.getByRole('complementary', { name: 'Agent', exact: true });
  await expect(companion).toBeVisible();
  const [window, top, bottom] = await Promise.all([
    companion.boundingBox(), page.getByTestId('modern-top-ornament').boundingBox(), page.getByTestId('modern-bottom-ornament').boundingBox(),
  ]);
  expect(window).not.toBeNull();
  expect(top).not.toBeNull();
  expect(bottom).not.toBeNull();
  expect(window!.y).toBeGreaterThanOrEqual(top!.y + top!.height + 8);
  expect(window!.y + window!.height).toBeLessThanOrEqual(bottom!.y - 8);
});
