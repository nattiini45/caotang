import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { binderTitle, createProject, waitForSaved } from './support.js';

/**
 * The last Modern homes no issue covered (#313; modern-interface.md §7.2, §8.8, §9.5):
 *
 * - Focus mode (§8.8): the ornaments, the binder tab bar, Scene info and the agent window fade away and stay mounted; the pointer near an
 *   edge or over one of them, keyboard focus in one of them, or a key pressed outside the text brings them back; typing never does. A
 *   **Leave focus mode** glass capsule (44 px) stays at the top. Ctrl+Shift+F, **⋯** › Focus mode and the palette still toggle it. Under
 *   reduced motion nothing fades.
 * - Scene info lists the scene's open findings, each with **Show in Findings**, which opens the sidebar's Findings tab on it (§7.2).
 * - The Codex's entry view and a Board card's own controls are 44 px targets (§9.5).
 */

// A step that cannot happen fails in 15 s instead of at the test timeout (#307's lesson).
test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

const stage = (page: Page): Locator => page.getByTestId('modern-stage');
const scene = (page: Page): Locator => page.getByRole('toolbar', { name: 'Scene' });
const views = (page: Page): Locator => page.getByRole('navigation', { name: 'Views and tools' });
const more = (page: Page): Locator => scene(page).getByRole('button', { name: 'More', exact: true });
const leave = (page: Page): Locator => page.getByTestId('modern-focus-leave').getByRole('button', { name: 'Leave focus mode' });
const binder = (page: Page): Locator => page.getByRole('navigation', { name: 'Binder' });

/** A Modern project with one scene whose words were typed, the sidebar closed, the storage notice dismissed. */
async function modernScene(page: Page, name: string): Promise<Locator> {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await createProject(page, name);
  await expect(stage(page)).toBeVisible();
  await binder(page).getByRole('button', { name: 'Binder', exact: true }).click();
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  for (const title of ['The ferry', 'The ticket']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(title);
    await page.keyboard.press('Enter');
  }
  const surface = page.getByRole('main', { name }).getByRole('textbox', { name: 'Document text' });
  await surface.click();
  await page.keyboard.type('Lin had the only ticket.');
  await waitForSaved(page);
  await page.mouse.move(700, 450);
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'closed');
  const banner = page.getByTestId('storage-banner');
  if (await banner.isVisible()) {
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toBeHidden();
  }
  return surface;
}

function opacity(target: Locator): Promise<string> {
  return target.evaluate((element) => getComputedStyle(element).opacity);
}

/** The ornaments, the tab bar and (when open) the agent window: all at `value` opacity. */
async function expectChrome(page: Page, value: '0' | '1', agent = false): Promise<void> {
  const parts = [page.getByTestId('modern-top-ornament'), page.getByTestId('modern-bottom-ornament'), page.getByTestId('modern-binder')];
  if (agent) parts.push(page.getByTestId('modern-companion'));
  for (const part of parts) await expect.poll(() => opacity(part)).toBe(value);
}

test('focus mode fades the ornaments, the tab bar and the agent window; the pointer at an edge brings them back; the capsule leaves', async ({ page }) => {
  test.setTimeout(90_000);
  const surface = await modernScene(page, 'Quiet Book');
  await page.locator('#modern-ask').click();
  await expect(page.getByTestId('modern-companion')).toBeVisible();
  await surface.click();
  await page.mouse.move(500, 450);
  await page.keyboard.press('ControlOrMeta+Shift+F');

  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');
  await expectChrome(page, '0', true);
  // They stay where they were, with their state: only faded. The windows let the pointer through to the page.
  await expect(page.getByTestId('modern-top-ornament')).toHaveCount(1);
  await expect(page.getByTestId('modern-companion')).toHaveCSS('pointer-events', 'none');
  await expect(page.getByTestId('modern-companion')).toHaveClass(/is-open/);

  // The capsule: glass, at the top, a 44 px target.
  await expect(leave(page)).toBeVisible();
  const box = await leave(page).boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.y ?? 900).toBeLessThan(80);
  await expect(page.getByTestId('modern-focus-leave')).toHaveClass(/mat-glass/);

  // Typing in the text never brings them back.
  await page.keyboard.type(' The ferry was late.');
  await page.waitForTimeout(400);
  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');

  // The pointer near the bottom edge does, and away from the edges they fade again.
  await page.mouse.move(700, 890);
  await expect(stage(page)).toHaveAttribute('data-focus', 'shown');
  await expectChrome(page, '1', true);
  await page.mouse.move(500, 450);
  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');
  await expectChrome(page, '0');
  // The inline-start edge, where the tab bar is, too.
  await page.mouse.move(10, 450);
  await expect(stage(page)).toHaveAttribute('data-focus', 'shown');
  await page.mouse.move(500, 450);
  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');

  // The capsule leaves focus mode: everything is back, the agent window still open.
  await leave(page).click();
  await expect(leave(page)).toHaveCount(0);
  await expect(stage(page)).not.toHaveAttribute('data-focus', /.*/);
  await expectChrome(page, '1', true);
  await expect(page.getByTestId('modern-companion')).toBeVisible();
});

test('keyboard focus in the faded ornaments holds them, a key outside the text shows them, and the chord, ⋯ and the palette toggle the mode', async ({ page }) => {
  test.setTimeout(90_000);
  const surface = await modernScene(page, 'Keyed Book');
  await surface.click();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');

  // Shift+Tab from the page reaches the tab bar where it is, and shows the chrome while focus stays there.
  await page.locator('#modern-page').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(binder(page).getByRole('button', { name: 'Agent', exact: true })).toBeFocused();
  await expect(stage(page)).toHaveAttribute('data-focus', 'shown');
  await page.waitForTimeout(1_000);
  await expect(stage(page)).toHaveAttribute('data-focus', 'shown');

  // A key outside a text field shows them too; the pointer back over the page and a click in the text hide them again.
  await page.locator('#modern-page').focus();
  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');
  await page.keyboard.press('KeyA');
  await expect(stage(page)).toHaveAttribute('data-focus', 'shown');
  await surface.click();
  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');

  // The chord leaves, as it always did.
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(leave(page)).toHaveCount(0);
  await expect(stage(page)).not.toHaveAttribute('data-focus', /.*/);

  // ⋯ › Focus mode; then ⋯, faded but where it was, › Leave focus mode.
  await more(page).click();
  await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Focus mode' }).click();
  await expect(leave(page)).toBeVisible();
  await page.mouse.move(500, 450);
  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');
  await more(page).click();
  await page.getByRole('menu', { name: 'More' }).getByRole('menuitem', { name: 'Leave focus mode' }).click();
  await expect(leave(page)).toHaveCount(0);

  // The palette's Focus mode.
  await surface.click();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await palette.getByRole('combobox', { name: 'Search scenes, codex and commands' }).fill('Focus mode');
  await expect(palette.getByRole('option', { selected: true })).toContainText('Focus mode');
  await page.keyboard.press('Enter');
  await expect(leave(page)).toBeVisible();
  await expect(stage(page)).toHaveAttribute('data-focus', /hidden|shown/);
});

test('under reduced motion focus mode hides the ornaments at once, without a fade', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const surface = await modernScene(page, 'Still Book');
  await surface.click();
  await page.mouse.move(500, 450);
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(stage(page)).toHaveAttribute('data-focus', 'hidden');
  const ornament = page.getByTestId('modern-top-ornament');
  expect(await ornament.evaluate((element) => getComputedStyle(element).transitionDuration)).toMatch(/^0s(, 0s)*$/);
  expect(await opacity(ornament)).toBe('0');
  expect(await ornament.evaluate((element) => element.getAnimations().length)).toBe(0);
});

test('Scene info lists the scene’s open findings, and Show in Findings opens the sidebar’s Findings tab on one', async ({ page }) => {
  test.setTimeout(120_000);
  // Built in Classic (the suite's pin), as findings.spec.ts does: two declared scenes whose days break their order, then a scan.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // A fresh profile starts in Modern (#313); Classic is chosen and the page reloaded, so the project is built in Classic.
  await page.evaluate(() => localStorage.setItem('caotang.interface', 'classic'));
  await page.reload();
  await createProject(page, 'Findings Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  for (const title of ['Scene A', 'Scene B']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(title);
    await page.keyboard.press('Enter');
  }
  const surface = page.getByRole('textbox', { name: 'Document text' });
  const declare = async (title: string, day: string): Promise<void> => {
    await binderTitle(page, title).click();
    const meta = page.getByTestId('scene-meta');
    if ((await meta.getAttribute('open')) === null) await meta.locator('summary').click();
    await page.getByRole('spinbutton', { name: 'Day offset' }).fill(day);
    await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');
  };
  await declare('Scene A', '5');
  await surface.click();
  await page.keyboard.type('The ferry was late, as always.');
  await waitForSaved(page);
  await declare('Scene B', '1');
  await page.getByRole('combobox', { name: 'Add a scene this follows' }).selectOption({ label: 'Scene A' });
  await expect(page.getByRole('list', { name: 'Follows these scenes' })).toContainText('Scene A');
  await surface.click();
  await page.keyboard.type('The lamp went out before the ferry came in.');
  await waitForSaved(page);
  await page.getByRole('tab', { name: /^Findings/ }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(page.getByTestId('findings-open')).toHaveText('2 open');

  // Modern, switched on live; the rail stays on Findings, so the sidebar's tab is already the current one, closed.
  await page.locator('.toolbar').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  await settings.getByRole('group', { name: 'Interface', exact: true }).getByRole('radio', { name: /^Modern/ }).check();
  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(stage(page)).toBeVisible();
  await page.mouse.move(700, 450);
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'closed');
  const banner = page.getByTestId('storage-banner');
  if (await banner.isVisible()) await banner.getByRole('button', { name: 'Dismiss' }).click();

  // Scene info, from the title capsule: the scene's open findings, each with Show in Findings, described by its finding.
  await scene(page).locator('.modern-title').click();
  const info = page.getByRole('dialog', { name: 'Scene info' });
  await expect(info).toBeVisible();
  const list = info.getByTestId('scene-info-findings');
  await expect(list.getByRole('heading', { name: 'Open findings in this scene' })).toBeVisible();
  const show = list.getByRole('button', { name: 'Show in Findings', exact: true });
  await expect(show.first()).toBeVisible();
  const count = await show.count();
  expect(count).toBeGreaterThanOrEqual(1);
  expect(count).toBeLessThanOrEqual(2);
  const described = await show.first().evaluate((element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent?.trim() ?? '');
  expect(described.length).toBeGreaterThan(0);
  // The layout size: Scene info may still be growing out of the title capsule, and a transform scales the bounding box.
  const size = await show.first().evaluate((element) => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight }));
  expect(size.height).toBeGreaterThanOrEqual(44);
  expect(size.width).toBeGreaterThanOrEqual(44);

  await show.first().click();
  // The popover closes; the sidebar opens on Findings, with the finding's group focused.
  await expect(info).toHaveCount(0);
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('modern-sidebar').getByRole('tab', { name: /^Findings/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('modern-sidebar').locator('.finding-group[data-group]:focus')).toHaveCount(1);
});

test('the Codex’s entry view and a Board card’s own controls are at least 44 px', async ({ page }) => {
  test.setTimeout(90_000);
  await modernScene(page, 'Target Book');

  // Board: the grip, the synopsis and, while renaming, the title field.
  await views(page).getByRole('radio', { name: 'Board' }).click();
  const card = page.locator('#modern-page article.card').first();
  await expect(card).toBeVisible();
  for (const control of [card.locator('.card-grip'), card.getByRole('textbox', { name: 'Synopsis' })]) {
    const size = await control.evaluate((element) => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight }));
    expect(size.height).toBeGreaterThanOrEqual(44);
    if ((await control.getAttribute('class'))?.includes('card-grip')) expect(size.width).toBeGreaterThanOrEqual(44);
  }
  await card.locator('.card-title').dblclick();
  const rename = card.locator('.card-rename');
  await expect(rename).toBeVisible();
  expect(await rename.evaluate((element) => (element as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Escape');

  // Codex: a new entry's view, with a keyword so its chip has a remove button.
  await views(page).getByRole('radio', { name: 'Codex' }).click();
  await page.getByRole('main').getByRole('button', { name: 'New entry' }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Zoë Hart');
  await name.press('Enter');
  const entry = page.locator('#modern-page .codex-entry');
  await expect(entry).toBeVisible();
  const keyword = entry.getByRole('textbox', { name: 'Add to Keywords' });
  await keyword.fill('harbour');
  await keyword.press('Enter');
  const targets: Locator[] = [
    entry.getByRole('button', { name: '← All entries' }),
    entry.getByLabel('Type', { exact: true }),
    ...(await entry.locator('.policy-option').all()),
    entry.locator('label.check').first(),
    entry.getByRole('button', { name: /^Remove .*harbour.* from Keywords$/ }),
    keyword,
  ];
  for (const target of targets) {
    const size = await target.evaluate((element) => ({ width: (element as HTMLElement).offsetWidth, height: (element as HTMLElement).offsetHeight, text: element.textContent ?? '' }));
    expect(size.height, size.text).toBeGreaterThanOrEqual(44);
    expect(size.width, size.text).toBeGreaterThanOrEqual(44);
  }
});
