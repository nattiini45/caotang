import { expect, test, type Page } from '@playwright/test';

import { createProject } from './support.js';
import { installSaveRefusals, makeFailingDocument, makeFailingSettings, makeFailingTask } from './save-channel-fixture.js';

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('caotang.interface', 'modern');
    localStorage.setItem('caotang.pseudo', '1');
  });
  await installSaveRefusals(page);
});

async function fits(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  const bar = page.getByTestId('modern-top-ornament');
  const controls = [page.getByTestId('modern-title-capsule'), page.getByTestId('save-state'), bar.locator('.modern-new'), page.getByTestId('modern-more')];
  await expect.poll(async () => {
    const bounds = await bar.boundingBox();
    const boxes = await Promise.all(controls.map((control) => control.evaluate((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    })));
    if (bounds === null) return false;
    return boxes.every((box) => box.width >= 44 && box.height >= 44
      && box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1
      && box.y >= bounds.y - 1 && box.y + box.height <= bounds.y + bounds.height + 1)
      && boxes.every((box, i) => boxes.slice(i + 1).every((other) =>
        box.x + box.width <= other.x + 1 || other.x + other.width <= box.x + 1
          || box.y + box.height <= other.y + 1 || other.y + other.height <= box.y + 1));
  }).toBe(true);
  expect((await page.locator('.modern-title-name').boundingBox())?.width).toBeGreaterThanOrEqual(80);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (width < 960) {
    await expect.poll(async () => {
      const bounds = await bar.boundingBox();
      const area = await page.locator('.modern-page-area').boundingBox();
      return bounds === null || area === null ? -1 : area.y - bounds.y - bounds.height;
    }).toBeGreaterThanOrEqual(0);
  }
}

for (const locale of ['en', 'de', 'en-XA'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${locale}, ${scheme}: compact failure preserves navigation and full recovery at desktop and touch widths`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('caotang.theme', value), scheme);
      await createProject(page, 'The Lighthouse Keeper and the Long Journey Home');
      await expect(page.getByTestId('modern-stage')).toBeVisible();
      await makeFailingSettings(page);
      await page.evaluate(async (tag) => {
        const path = '/src/i18n/language.ts';
        const { initializeInterfaceLanguage } = await import(path);
        await initializeInterfaceLanguage(tag);
      }, locale);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const indicator = page.getByTestId('save-state');
      await expect(indicator).toHaveAttribute('data-state', 'failed');
      const full = await indicator.getAttribute('title');
      expect(full).toBeTruthy();
      await expect(indicator).toHaveAccessibleName(full!);
      expect((await indicator.innerText()).length).toBeLessThan(full!.length);
      if (locale === 'de') await expect(indicator).toHaveText('Nicht gespeichert: Einstellungen');
      if (locale === 'en') await expect(indicator).toHaveText('Not saved: Settings');
      const live = page.getByTestId('modern-top-ornament').getByRole('status');
      await expect(live).toHaveCount(1);
      await expect(live).toHaveText(full!);
      for (const width of [1440, 1366, 1280, 390]) await fits(page, width);
      await indicator.tap();
      await expect(page.getByTestId('scene-info-progress')).toBeFocused();
      await expect(page.getByTestId('scene-info-save-state')).toHaveText(full!);
      await expect(page.getByTestId('scene-info-save-state')).toBeInViewport({ ratio: 1 });
      await expect(page.getByTestId('scene-info-save-state').getByRole('button')).toHaveCount(0);
      await expect(live).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(indicator).toBeFocused();
      await page.getByTestId('modern-title-capsule').focus();
      await page.keyboard.press('ArrowRight');
      await expect(indicator).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('scene-info-progress')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(indicator).toBeFocused();
    });
  }
}

for (const channel of ['documents', 'tasks'] as const) {
  test(`${channel}: disclosure preserves the appropriate recovery and backup action`, async ({ page }) => {
    await createProject(page, 'A recognizable project title');
    await expect(page.getByTestId('modern-stage')).toBeVisible();
    if (channel === 'documents') await makeFailingDocument(page);
    else {
      await makeFailingTask(page);
      await page.keyboard.press('Control+j');
    }
    const indicator = page.getByTestId('save-state');
    await expect(indicator).toHaveText(`Not saved: ${channel === 'documents' ? 'Documents' : 'Tasks'}`);
    for (const width of [1440, 1366, 1280, 390]) await fits(page, width);
    await indicator.click();
    await expect(page.getByTestId('scene-info-progress')).toBeFocused();
    const recovery = page.getByTestId('scene-info-save-state');
    if (channel === 'documents') {
      await expect(recovery).toContainText('Copy your unsaved text somewhere safe before reloading.');
      await expect(recovery.getByRole('button')).toHaveCount(0);
    } else {
      await expect(recovery).toContainText('Try the change again.');
      await expect(recovery.getByRole('button', { name: 'Export a backup' })).toBeVisible();
    }
  });
}

test('multiple failed channels leave the Board zoom and navigation usable', async ({ page }) => {
  await createProject(page, 'A recognizable project title');
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await makeFailingTask(page);
  await page.keyboard.press('Control+j');
  await makeFailingSettings(page);
  await expect(page.getByTestId('save-state')).toHaveText('Not saved: Tasks and Settings');
  await page.getByRole('radio', { name: 'Board', exact: true }).click();
  for (const width of [1440, 1366, 1280]) await fits(page, width);
  await expect(page.getByTestId('modern-top-ornament').getByRole('radio', { name: 'M: Medium cards, title and synopsis', exact: true })).toBeVisible();
});

test('the narrow failure row clears document-mode controls and the page', async ({ page }) => {
  await createProject(page, 'A recognizable project title');
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await page.locator('.modern-new').click();
  await page.getByTestId('new-screenplay').click();
  await expect(page.locator('.document-mode-outlet .segmented')).toBeVisible();
  await makeFailingSettings(page);
  for (const width of [1440, 1366, 1280, 390, 320]) await fits(page, width);
  await page.getByTestId('save-state').tap();
  await expect(page.getByTestId('scene-info-progress')).toBeFocused();
  await expect(page.getByTestId('scene-info-save-state')).toBeInViewport({ ratio: 1 });
});

test('document modes fit while the narrow chunk is still loading', async ({ page }) => {
  await createProject(page, 'A recognizable project title');
  await page.locator('.modern-new').click();
  await page.getByTestId('new-screenplay').click();
  const modes = page.locator('.document-mode-outlet .segmented');
  await expect(modes).toBeVisible();
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route('**/narrow-panels.tsx*', async (route) => {
    held = true;
    await released;
    await route.continue();
  });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => held).toBe(true);
    await expect.poll(async () => {
      const box = await modes.boundingBox();
      return box !== null && box.x >= 0 && box.x + box.width <= 390;
    }).toBe(true);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
