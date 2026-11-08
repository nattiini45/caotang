import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

async function modern(page: Page): Promise<void> {
  await page.locator('.toolbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('group', { name: 'Interface', exact: true }).getByRole('radio', { name: 'Modern', exact: true }).check();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  const banner = page.getByTestId('storage-banner');
  if (await banner.isVisible()) await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
}

async function media(page: Page, item: string): Promise<void> {
  await createProject(page, 'Navigation book');
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await page.keyboard.press('Escape');
}

async function go(page: Page, query: string, option: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await palette.getByRole('combobox').fill(query);
  await palette.getByRole('option', { name: option, exact: true }).click();
  await expect(palette).toHaveCount(0);
}

for (const shell of ['Classic', 'Modern'] as const) {
  test(`${shell}: screenplay modes edit one body in their own container`, async ({ page }) => {
    test.setTimeout(90_000);
    await media(page, 'New screenplay scene here');
    if (shell === 'Modern') await modern(page);
    const container = shell === 'Modern' ? page.getByTestId('modern-top-ornament') : page.getByRole('region', { name: 'Screenplay: Untitled scene' });
    const modes = container.getByRole('radiogroup', { name: 'View of the scene' });
    await expect(modes.getByRole('radio')).toHaveText(['Script', 'Source', 'Pages']);
    await modes.getByRole('radio', { name: 'Script', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(modes.getByRole('radio', { name: 'Source', exact: true })).toBeFocused();
    const source = page.getByRole('textbox', { name: 'Fountain source' });
    await source.fill('INT. FERRY - DAY\n\nThe ferry leaves.');
    await waitForSaved(page);
    await modes.getByRole('radio', { name: 'Script', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Formatted script' })).toContainText('The ferry leaves.');
    await modes.getByRole('radio', { name: 'Pages', exact: true }).click();
    await expect(modes.getByRole('radio', { name: 'Pages', exact: true })).toHaveAttribute('aria-checked', 'true');
    await modes.getByRole('radio', { name: 'Source', exact: true }).click();
    await expect(source).toHaveValue('INT. FERRY - DAY\n\nThe ferry leaves.');
    if (shell === 'Classic') return;
    await expect(container.locator('[data-document-kind="screenplay"] svg')).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('radiogroup', { name: 'View of the scene' })).toHaveCount(0);
    await expect.poll(() => container.locator('button[tabindex="0"]').count()).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(modes).toBeVisible();
    await expect.poll(async () => {
      const bar = await container.boundingBox();
      const main = await page.getByRole('main').boundingBox();
      return bar !== null && main !== null && bar.x >= 0 && bar.x + bar.width <= 390 && main.y >= bar.y + bar.height;
    }).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await go(page, 'New scene', 'Scene A prose scene');
    await expect(container.getByRole('radiogroup', { name: 'View of the scene' })).toHaveCount(0);
    await expect(container.locator('[data-document-kind="scene"] svg')).toHaveCount(1);
  });

  test(`${shell}: dialogue keeps its Ink body when changing the presentation`, async ({ page }) => {
    test.setTimeout(90_000);
    await media(page, 'New dialogue here');
    const source = page.getByRole('textbox', { name: 'Ink source' });
    const ink = '-> start\n=== start ===\nMara: Hello.\n-> END\n';
    await source.fill(ink);
    await waitForSaved(page);
    if (shell === 'Classic') {
      await expect(page.locator('.dlg-canvas-wrap')).toBeVisible();
      await expect(source).toBeVisible();
      await expect(page.getByRole('radiogroup', { name: 'View of the dialogue' })).toHaveCount(0);
      return;
    }
    await modern(page);
    const bar = page.getByTestId('modern-top-ornament');
    const modes = bar.getByRole('radiogroup', { name: 'View of the dialogue' });
    await expect(modes.getByRole('radio')).toHaveText(['Graph', 'Ink']);
    await expect(source).toBeHidden();
    await expect(bar.locator('[data-document-kind="dialogue"] svg')).toHaveCount(1);
    await page.getByRole('button', { name: /^start:/ }).click();
    await expect(modes.getByRole('radio', { name: 'Ink', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(source).toBeFocused();
    await expect(source).toHaveValue(ink);
    await expect(page.locator('.dlg-canvas-wrap')).toBeHidden();
    await source.fill(ink.replace('Hello.', 'Hello again.'));
    await modes.getByRole('radio', { name: 'Graph', exact: true }).click();
    await expect(page.locator('.dlg-canvas-wrap')).toBeVisible();
    await modes.getByRole('radio', { name: 'Graph', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(modes.getByRole('radio', { name: 'Ink', exact: true })).toBeFocused();
    await expect(source).toHaveValue(ink.replace('Hello.', 'Hello again.'));
    await waitForSaved(page);
  });
}

test('the palette reaches every view and reopens Binder, Findings and the last Agent log', async ({ page }) => {
  test.setTimeout(90_000);
  await createProject(page, 'Navigation book');
  await modern(page);
  for (const [label, value] of [['Board', 'board'], ['Timeline', 'timeline'], ['Codex', 'codex'], ['Pictures', 'pictures'], ['Write', 'write']] as const) {
    await go(page, label, `${label} View`);
    await expect(page.getByRole('main')).toHaveAttribute('data-view', value);
  }
  await go(page, 'sidebar Binder', 'Binder Sidebar');
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  await page.keyboard.press('Escape');
  await go(page, 'sidebar Binder', 'Binder Sidebar');
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  await go(page, 'sidebar Findings', 'Findings Sidebar');
  await expect(page.getByRole('tab', { name: 'Findings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await go(page, 'sidebar Agent', 'Agent Sidebar');
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  await go(page, 'sidebar Binder', 'Binder Sidebar');
  await go(page, 'sidebar Agent', 'Agent Sidebar');
  await expect(page.getByRole('tab', { name: 'Trace', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, 'sidebar Binder', 'Binder Sidebar');
  await expect(page.getByTestId('modern-drawer')).toHaveAttribute('data-state', 'open');
});

test('the last Agent log survives resizing in both directions', async ({ page }) => {
  test.setTimeout(90_000);
  await createProject(page, 'Navigation book');
  await modern(page);
  await go(page, 'sidebar Agent', 'Agent Sidebar');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  await go(page, 'sidebar Binder', 'Binder Sidebar');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('modern-narrow-binder')).toBeVisible();
  await go(page, 'sidebar Agent', 'Agent Sidebar');
  await expect(page.getByRole('tab', { name: 'Trace', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await go(page, 'sidebar Binder', 'Binder Sidebar');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#modern-binder-agent')).toBeVisible();
  await go(page, 'sidebar Agent', 'Agent Sidebar');
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('German document modes fit the narrow ornament and translate dialogue controls', async ({ page }) => {
  test.setTimeout(90_000);
  await media(page, 'New screenplay scene here');
  await page.locator('.toolbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('group', { name: 'Interface', exact: true }).getByRole('radio', { name: 'Modern', exact: true }).check();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await settings.getByRole('button', { name: 'Schließen', exact: true }).click();
  const banner = page.getByTestId('storage-banner');
  if (await banner.isVisible()) await banner.getByRole('button', { name: 'Zurückweisen', exact: true }).click();
  const bar = page.getByTestId('modern-top-ornament');
  const sceneModes = bar.getByRole('radiogroup', { name: 'Ansicht der Szene' });
  await expect(sceneModes.getByRole('radio')).toHaveText(['Skript', 'Quelle', 'Seiten']);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const control of await sceneModes.getByRole('radio').all()) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 390) + (box?.width ?? 1)).toBeLessThanOrEqual(390);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('new-menu').click();
  await page.getByTestId('new-dialogue').click();
  const modes = bar.getByRole('radiogroup', { name: 'Ansicht des Dialogs' });
  await expect(modes.getByRole('radio')).toHaveText(['Graph', 'Ink']);
  await modes.getByRole('radio', { name: 'Ink', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Ink-Quelltext' })).toBeVisible();
});
