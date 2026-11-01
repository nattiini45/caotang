import { expect, test, type Page } from '@playwright/test';

import { createProject, waitForSaved } from './support.js';

/**
 * The shell, home and settings surfaces under a padded pseudo catalogue (i18n.md §8.1, §8.3; I5 / #196).
 *
 * Pseudo text is 40 % longer than the English source, so a layout that fits English can still clip a
 * label, push a control out of the window or overlap a neighbour. Both widths the plan names are
 * checked: 960 px, where the shell is at its narrowest supported desktop size, and 1100 px.
 *
 * The source strings stay exact in English before a switch, so the catalogue conversion did not
 * change what a writer reads in the source language. Pseudo runs are enabled through the local flag,
 * as in `i18n-switch.spec.ts`; no provider or model is involved.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('caotang.pseudo', '1');
  });
});

/** Opens Settings from the surface's stable test id, and waits for the lazy chunk. */
async function openSettings(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.getByTestId('open-settings').focus();
  await page.keyboard.press('Enter');
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  return settings;
}

/** Switches the interface to the padded LTR pseudo catalogue and returns the Settings dialog. */
async function switchToPseudo(page: Page, settings: ReturnType<Page['getByTestId']>): Promise<void> {
  await settings.locator('[data-section="appearance"]').click();
  // Async radios need `click`, not `check`: the input's change is handled by the switcher.
  await settings.locator('input[name="interface-language"][value="en-XA"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en-XA');
}

/** Closes Settings by structure: after the switch its buttons are pseudo text, not English. */
async function closeSettings(settings: ReturnType<Page['getByTestId']>): Promise<void> {
  await settings.locator('.settings-head button').click();
}

/** The page does not scroll sideways: padded labels fit the window at this width. */
async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

for (const width of [960, 1100]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('home keeps its English source, then renders padded pseudo text and fits the width', async ({ page }) => {
      await page.goto('/');
      // The source language before any switch: these are the exact words the English catalogue ships.
      await expect(page.locator('h1')).toHaveText('Caotang');
      await expect(page.locator('.lede')).toHaveText('A writing studio that keeps your work on this device.');
      await expect(page.getByLabel('Project name')).toBeVisible();
      await expect(page.locator('.new-project button[type="submit"]')).toHaveText('Create project');
      expect(await fitsWidth(page)).toBe(true);

      const settings = await openSettings(page);
      await expect(settings.locator('h2')).toHaveText('Settings');
      await switchToPseudo(page, settings);
      // The dialog fits too, with the longer padded section names.
      const box = await settings.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.width ?? width + 1) <= width + 1).toBe(true);
      await closeSettings(settings);

      // Focus returned to the control that opened the dialog.
      await expect(page.getByTestId('open-settings')).toBeFocused();
      // The same controls now read padded pseudo text, and no longer read their English source.
      await expect(page.locator('h1')).toContainText('⟦');
      await expect(page.locator('.new-project label span')).toContainText('⟦');
      await expect(page.locator('.new-project button[type="submit"]')).toContainText('⟦');
      await expect(page.locator('.new-project button[type="submit"]')).not.toHaveText('Create project');
      // The form still works by keyboard: the name field, then the submit button.
      await page.locator('.new-project input').focus();
      await page.keyboard.press('Tab');
      await expect(page.locator('.new-project button[type="submit"]')).toBeFocused();
      expect(await fitsWidth(page)).toBe(true);
    });

    test('the shell toolbar, rail, centre and footer render padded pseudo text and keep keyboard focus', async ({ page }) => {
      await createProject(page, 'Pseudo Shell');
      // The English source, preserved by the conversion.
      await expect(page.locator('.toolbar-start button').first()).toHaveText('Projects');
      await expect(page.getByTestId('binder-totals')).toContainText('in the project');
      await expect(page.getByTestId('save-state')).toHaveText('All changes saved in this browser');
      await waitForSaved(page);
      expect(await fitsWidth(page)).toBe(true);

      const settings = await openSettings(page);
      await switchToPseudo(page, settings);
      await closeSettings(settings);

      await expect(page.locator('.toolbar-start button').first()).toContainText('⟦');
      await expect(page.getByTestId('binder-totals')).toContainText('⟦');
      await expect(page.getByTestId('save-state')).toContainText('⟦');
      // The rail's tabs are named from the catalogue, and the badge's accessible count is too.
      const tabs = page.locator('.rail-tabs [role="tab"]');
      await expect(tabs.first()).toContainText('⟦');
      // Roving tabindex: focus the first tab, then the arrow key selects and focuses the next.
      await tabs.first().focus();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.nth(1)).toBeFocused();
      await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('ArrowLeft');
      await expect(tabs.first()).toBeFocused();
      // The centre's radio group follows the same arrow-key model.
      const views = page.locator('.center-switch [role="radio"]');
      await views.first().focus();
      await page.keyboard.press('ArrowRight');
      await expect(views.nth(1)).toBeFocused();
      // The footer's own labels are catalogue messages, not English left behind.
      await expect(page.locator('.binder-footer')).toContainText('⟦');
      expect(await fitsWidth(page)).toBe(true);
    });
  });
}
