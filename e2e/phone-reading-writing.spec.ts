import { expect, test, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { waitForSaved } from './support.js';

test.use({ viewport: { width: 390, height: 844 }, storageState: NO_PIN });

async function create(page: Page, shell: string, name = 'The Harbour'): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('caotang.interface', value);
    const storage = Object.getPrototypeOf(navigator.storage) as Record<string, unknown>;
    storage['persisted'] = async () => false;
    storage['persist'] = async () => false;
  }, shell);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('.new-project input').fill(name);
  await page.locator('.new-project button[type="submit"]').click();
  await expect(page.locator(shell === 'modern' ? '.modern-stage' : '.workspace')).toBeVisible();
  await waitForSaved(page);
  const banner = page.getByTestId('storage-banner');
  await expect(banner).toBeVisible();
  await banner.getByRole('button').last().click();
}

for (const shell of ['classic', 'modern']) {
  test(`${shell} Home reading and tab order match the phone layout without losing forms on resize`, async ({ page }) => {
    await create(page, shell);
    await page.reload();
    const projects = page.locator('[aria-labelledby="home-projects"]');
    await expect(projects.locator('.project-list')).toBeVisible();
    await expect(page.locator('.home > :first-child')).toHaveClass('home-head');
    await expect(page.locator('.home > :nth-child(2)')).toHaveAttribute('aria-labelledby', 'home-projects');
    const snapshot = await page.locator('.home').ariaSnapshot();
    expect(snapshot.indexOf('Caotang')).toBeLessThan(snapshot.indexOf('Projects in this browser'));
    expect(snapshot.indexOf('Projects in this browser')).toBeLessThan(snapshot.indexOf('Try the agent with no key'));
    expect(snapshot.indexOf('Projects in this browser')).toBeLessThan(snapshot.indexOf('New project'));
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('open-settings')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(projects.getByRole('button', { name: 'Open', exact: true })).toBeFocused();
    await projects.getByRole('button', { name: 'Rename The Harbour', exact: true }).click();
    const rename = projects.getByRole('textbox', { name: 'New name', exact: true });
    await rename.fill('An unfinished rename');
    const name = page.getByRole('textbox', { name: 'Project name', exact: true });
    await name.fill('An unfinished new project');
    await name.evaluate((element) => element.setAttribute('data-original', 'true'));
    for (const width of [599, 600, 1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator('.home > :first-child')).toHaveClass('home-head');
      if (width < 600) await expect(page.locator('.home > :nth-child(2)')).toHaveAttribute('aria-labelledby', 'home-projects');
      await expect(name).toHaveValue('An unfinished new project');
      await expect(name).toHaveAttribute('data-original', 'true');
      await expect(rename).toHaveValue('An unfinished rename');
    }
  });

  test(`${shell} screenplay Source keeps its writing minimum with touch input`, async ({ browser, baseURL }, testInfo) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, locale: 'en-US', storageState: NO_PIN });
    try {
      const page = await context.newPage();
      await create(page, shell);
      if (shell === 'modern') {
        await page.getByTestId('new-menu').click();
        await page.getByTestId('new-screenplay').click();
      } else {
        await page.getByRole('button', { name: 'Binder', exact: true }).click();
        await page.getByRole('button', { name: 'Create Chapter 1', exact: true }).click();
        await page.getByRole('treeitem').filter({ hasText: 'Chapter 1' }).getByRole('button', { name: /Actions for/ }).click();
        await page.getByRole('menuitem', { name: 'New screenplay scene here', exact: true }).click();
        await page.getByRole('button', { name: 'Close panels', exact: true }).click();
      }
      await page.getByRole('radio', { name: 'Source', exact: true }).click();
      const source = page.getByRole('textbox', { name: 'Fountain source', exact: true });
      await source.fill('INT. HARBOUR OFFICE - DAY\n\nA lamp burns.\n\nADA\nWe leave at dawn.');
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        expect(await source.evaluate((element) => parseFloat(getComputedStyle(element).minHeight))).toBeGreaterThanOrEqual(506);
        expect((await source.boundingBox())!.height).toBeGreaterThanOrEqual(506);
        const metrics = await page.locator('.src-field').evaluate((field) => [...field.children].map((element) => {
          const style = getComputedStyle(element);
          return [style.font, style.padding, style.lineHeight, element.getBoundingClientRect().height];
        }));
        expect(metrics[0]).toEqual(metrics[1]);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await source.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`${shell}-phone-source.png`) });
    } finally {
      await context.close();
    }
  });
}

for (const locale of ['en-US', 'de-DE']) {
  for (const shell of ['classic', 'modern']) {
    test(`${shell} empty Write gives phone steps in ${locale} and retains the desktop shortcut`, async ({ browser, baseURL }) => {
      const context = await browser.newContext({ baseURL, locale, viewport: { width: 390, height: 844 }, storageState: NO_PIN });
      try {
        const page = await context.newPage();
        await create(page, shell);
        const empty = page.locator('.editor-pane.is-empty');
        const steps = locale === 'de-DE'
          ? 'Öffnen Sie den Binder und wählen Sie ein Dokument. Hier schreiben Sie Szenen.'
          : 'Open the binder and choose a document. Scenes are written here.';
        await expect(empty).toContainText(steps);
        await expect(empty).not.toContainText(/Ctrl|Strg/);
        const chapter = empty.getByRole('button', { name: locale === 'de-DE' ? 'Neues Kapitel' : 'New chapter', exact: true });
        await expect(chapter).toBeVisible();
        await page.setViewportSize({ width: 1280, height: 844 });
        await expect(empty).toContainText(/Ctrl|Strg/);
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(empty).toContainText(steps);
        await chapter.click();
        await expect(empty.locator('.empty-text')).toHaveText(steps);
        await expect(empty).not.toContainText(/Ctrl|Strg/);
      } finally {
        await context.close();
      }
    });
  }
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`Modern long phone titles reserve New and More in ${locale}, ${colorScheme}`, async ({ browser, baseURL }, testInfo) => {
      const context = await browser.newContext({ baseURL, locale, colorScheme, viewport: { width: 390, height: 844 }, storageState: NO_PIN });
      try {
        const page = await context.newPage();
        const name = 'The Harbour and the Long Journey Home Across the Northern Sea';
        await create(page, 'modern', name);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.slice(0, 2));
        for (const title of [name, 'A'.repeat(200)]) {
          if (title !== name) {
            await page.reload();
            await page.locator('.project-actions button').filter({ hasText: locale === 'de-DE' ? 'Umbenennen' : 'Rename' }).click();
            await page.locator('.project-rename input').fill(title);
            await page.locator('.project-rename button[type="submit"]').click();
            await expect(page.locator('.project-name')).toHaveText(title);
            await page.locator('.project-actions button.is-primary').click();
          }
          const capsule = page.getByTestId('modern-title-capsule');
          await expect(capsule).toHaveAccessibleName(new RegExp(title));
          for (const id of ['modern-title-capsule', 'new-menu', 'modern-more']) {
            const control = page.getByTestId(id);
            const box = (await control.boundingBox())!;
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(390);
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
            await expect(control).toBeInViewport({ ratio: 1 });
          }
          await page.getByTestId('new-menu').click();
          await expect(page.getByTestId('new-scene')).toBeVisible();
          await page.keyboard.press('Escape');
          await page.getByTestId('modern-more').click();
          await expect(page.getByTestId('modern-more-popover')).toBeVisible();
          await page.keyboard.press('Escape');
        }
        await page.screenshot({ path: testInfo.outputPath(`long-title-${locale}-${colorScheme}.png`) });
      } finally {
        await context.close();
      }
    });
  }
}

for (const view of ['board', 'timeline', 'codex', 'pictures']) {
  test(`keyboard returns from narrow ${view} to Write`, async ({ page }) => {
    await create(page, 'modern');
    const views = page.getByTestId('modern-narrow-views');
    await views.focus();
    await page.keyboard.press('Enter');
    const item = page.getByTestId(`modern-views-${view}`);
    for (let index = 0; index < 4 && !(await item.evaluate((element) => element === document.activeElement)); index++) await page.keyboard.press('ArrowDown');
    await expect(item).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#modern-page')).toHaveAttribute('data-view', view);
    await expect(views).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('modern-narrow-binder')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const write = page.getByRole('radio', { name: 'Write', exact: true });
    await expect(write).toBeFocused();
    await expect(write).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Space');
    await expect(write).toBeFocused();
    await expect(write).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#modern-page')).toHaveAttribute('data-view', 'write');
  });
}

test('a refused first-run dismissal stays visible with a recoverable error', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('first-run')).toBeVisible();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: { key?: string; value?: { firstRun?: { dismissed?: boolean } } }, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      if (value.key === 'settings' && value.value?.firstRun?.dismissed) {
        IDBObjectStore.prototype.put = put;
        throw new DOMException('The disk is full.', 'QuotaExceededError');
      }
      return put.call(this, value, key);
    };
  });
  const dismiss = page.getByRole('button', { name: 'Got it', exact: true });
  await dismiss.click();
  await expect(page.getByTestId('first-run').getByRole('alert')).toContainText('The settings could not be saved in this browser');
  await expect(dismiss).toBeEnabled();
  await dismiss.click();
  await expect(page.getByTestId('first-run')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.home')).toBeVisible();
  await expect(page.getByTestId('first-run')).toHaveCount(0);
});
