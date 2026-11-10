import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { createProject, selectionOf, waitForSaved } from './support.js';

/**
 * Modern's ornaments, **⋯** and the view morph (M5, #306; modern-interface.md §6, §7.1, §7.3, §8.1–§8.3, §9.5): the top ornament is a
 * toolbar "Scene" with the title capsule and **⋯**; the bottom ornament is a nav "Views and tools" with Write, Board and Codex as one
 * radio group and its lens, then Ask and Search. **⋯** is a menu of every shell action with the other views and Appearance; Escape
 * and Tab close it and focus goes back to **⋯**. A view change keeps the editor mounted, with its caret and its undo history. Every
 * control is at least 44 px. Under reduced motion nothing moves.
 */

// A step that cannot happen fails in 15 s instead of at the test timeout (#307's lesson).
test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
});

/** A Modern project with one scene whose words were typed, so the editor has an undo history. */
async function modernScene(page: Page, name = 'Ferry Book'): Promise<Locator> {
  await page.goto('/');
  await createProject(page, name);
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  // The binder is in #307's sidebar, closed and inert until Manuscript in the tab bar opens it.
  await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Lin’s ticket');
  await page.keyboard.press('Enter');
  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();
  await page.keyboard.type('Alpha beta.');
  await waitForSaved(page);
  // Choosing the scene closed the unpinned sidebar on the editor; the pointer leaves it too, so nothing lies over the page.
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.mouse.move(size.width - 60, Math.round(size.height / 2));
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'closed');
  // The storage notice sits at the top centre, over the title capsule, until #311 places notices.
  const banner = page.getByTestId('storage-banner');
  if (await banner.isVisible()) {
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toBeHidden();
  }
  return surface;
}

const views = (page: Page): Locator => page.getByRole('navigation', { name: 'Views and tools' });
const scene = (page: Page): Locator => page.getByRole('toolbar', { name: 'Scene' });
const more = (page: Page): Locator => scene(page).getByRole('button', { name: 'More', exact: true });
const menu = (page: Page): Locator => page.getByRole('menu', { name: 'More' });

/** How far the lens is from lying exactly under a control: the larger of the gaps at its two edges, in px. */
async function lensGap(page: Page, control: Locator): Promise<number> {
  const lens = await page.getByTestId('modern-lens').boundingBox();
  const box = await control.boundingBox();
  if (lens === null || box === null) return Number.POSITIVE_INFINITY;
  return Math.max(Math.abs(lens.x - box.x), Math.abs(lens.x + lens.width - (box.x + box.width)));
}

test('Write, Board and Codex are one radio group with a lens; the keys choose, and the editor keeps its caret and undo history', async ({ page }) => {
  // Long walk: some 20 steps at 1–2 s each on a loaded WebKit runner outgrow the default 30 s.
  test.setTimeout(90_000);
  const surface = await modernScene(page);
  const main = page.getByRole('main', { name: 'Ferry Book' });
  // A selection inside the words (the hook reports a range, not a collapsed caret): the last word but its full stop.
  await surface.focus();
  await page.keyboard.press('End');
  await expect.poll(() => surface.evaluate(() => {
    const selection = window.getSelection();
    return [selection?.anchorOffset, selection?.focusOffset];
  })).toEqual([11, 11]);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => surface.evaluate(() => {
    const selection = window.getSelection();
    return [selection?.anchorOffset, selection?.focusOffset];
  })).toEqual([10, 10]);
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => {
    const selection = await selectionOf(page);
    return [selection?.from, selection?.to];
  }, { timeout: 5000 }).toEqual([6, 10]);
  const before = await selectionOf(page);

  const group = views(page).getByRole('radiogroup', { name: 'View' });
  await expect(group.getByRole('radio')).toHaveText(['Write', 'Board', 'Timeline', 'Codex', 'Pictures']);
  const write = group.getByRole('radio', { name: 'Write' });
  const board = group.getByRole('radio', { name: 'Board' });
  const codex = group.getByRole('radio', { name: 'Codex' });
  await expect(write).toHaveAttribute('aria-checked', 'true');
  await expect(write).toHaveAttribute('id', 'center-editor');
  await expect(board).toHaveAttribute('id', 'center-corkboard');
  await expect(main).toHaveAttribute('data-view', 'write');

  // The lens sits under the chosen view.
  await expect.poll(() => lensGap(page, write)).toBeLessThanOrEqual(1);

  // One tab stop: the chosen radio. The arrow keys choose and move, and wrap; Home and End go to the ends.
  await expect(board).toHaveAttribute('tabindex', '-1');
  await write.focus();
  await page.keyboard.press('ArrowRight');
  await expect(board).toBeFocused();
  await expect(board).toHaveAttribute('aria-checked', 'true');
  await expect(main).toHaveAttribute('data-view', 'board');
  await expect.poll(() => lensGap(page, board)).toBeLessThanOrEqual(1);

  // Board → Timeline → Codex (#475: every view is in the group, in the base order).
  const timeline = group.getByRole('radio', { name: 'Timeline' });
  const pictures = group.getByRole('radio', { name: 'Pictures' });
  await page.keyboard.press('ArrowRight');
  await expect(timeline).toBeFocused();
  await expect(main).toHaveAttribute('data-view', 'timeline');
  await page.keyboard.press('ArrowRight');
  await expect(codex).toBeFocused();
  await expect(main).toHaveAttribute('data-view', 'codex');
  // Codex is the codex on the page; the editor is still there, hidden.
  await expect(main.getByRole('searchbox', { name: 'Search the codex' })).toBeVisible();
  await expect(surface).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Document text', includeHidden: true })).toHaveCount(1);
  await expect(scene(page).getByTestId('modern-title-capsule')).toContainText('Codex');

  await page.keyboard.press('ArrowRight');
  await expect(pictures).toBeFocused();
  await expect(main).toHaveAttribute('data-view', 'pictures');
  await page.keyboard.press('ArrowRight');
  await expect(write).toBeFocused();
  await page.keyboard.press('End');
  await expect(pictures).toBeFocused();
  await page.keyboard.press('Home');
  await expect(write).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(pictures).toHaveAttribute('aria-checked', 'true');
  await board.click();
  await write.click();

  // Back in Write: the words, the caret where it was, and Ctrl+Z still takes back the typing.
  await expect(surface).toBeVisible();
  await expect(surface).toHaveText('Alpha beta.');
  await surface.focus();
  await expect.poll(() => selectionOf(page)).toEqual(before);
  await page.keyboard.press('End');
  await page.keyboard.press('Control+z');
  await expect(surface).toHaveText('');
});

test('⋯ is a menu of every shell action, the other views and Appearance; Escape, Tab and a click outside close it and focus returns', async ({ page }) => {
  // Long walk: some 20 steps at 1–2 s each on a loaded WebKit runner outgrow the default 30 s.
  test.setTimeout(90_000);
  await modernScene(page, 'Menu Book');
  const button = more(page);
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  await button.click();
  const list = menu(page);
  await expect(list).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const first = list.getByRole('menuitem', { name: 'Projects' });
  await expect(first).toBeFocused();

  // The eleven shell actions: ten as items, the theme as Appearance's Light and Dark.
  const folder = await page.evaluate(() => 'showDirectoryPicker' in window);
  const actions = ['Projects', 'Project details', 'Undo', 'Focus mode', 'Skills', 'Instructions', 'Compile…', 'Export bundle', ...(folder ? ['Save to folder'] : []), 'Settings'];
  for (const name of actions) await expect(list.getByRole('menuitem', { name, exact: true })).toHaveCount(1);
  await expect(list.getByRole('menuitem', { name: 'Undo', exact: true })).toBeEnabled();
  for (const name of ['Light', 'Dark']) await expect(list.getByRole('menuitemradio', { name, exact: true })).toHaveCount(1);
  // The views moved to the bottom bar (#475); for one release ⋯ only says so.
  await expect(list.getByRole('menuitem', { name: 'Views are in the bar below' })).toBeDisabled();
  await expect(list.getByRole('menuitemradio', { name: 'Timeline' })).toHaveCount(0);
  await expect(list.getByRole('group', { name: 'Appearance' })).toBeVisible();
  await expect(list.getByRole('menuitemcheckbox', { name: 'Reduce transparency' })).toHaveAttribute('aria-checked', 'false');
  await expect(list.getByRole('menuitem', { name: 'Use the Classic interface' })).toBeVisible();

  // Menu keys: Down, Up (wrapping), End, Home.
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('menuitem', { name: 'Project details' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(list.getByRole('menuitem', { name: 'Use the Classic interface' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(first).toBeFocused();
  await page.keyboard.press('End');
  await expect(list.getByRole('menuitem', { name: 'Use the Classic interface' })).toBeFocused();

  // Escape closes, focus returns to ⋯.
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  // Enter opens it from the keyboard; Tab closes it and focus returns.
  await page.keyboard.press('Enter');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(list).toHaveCount(0);
  await expect(button).toBeFocused();

  // ArrowDown on ⋯ opens it too; a click outside closes it.
  await page.keyboard.press('ArrowDown');
  await expect(first).toBeFocused();
  await page.mouse.click(5, 450);
  await expect(list).toHaveCount(0);

  // Appearance: Dark, then Reduce transparency.
  await button.click();
  await menu(page).getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(button).toBeFocused();
  // ⋯ pressed while the closing menu still shrinks opens a fresh one.
  await button.click();
  await expect(menu(page).getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  await menu(page).getByRole('menuitemcheckbox', { name: 'Reduce transparency' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-transparency', 'reduced');
  await expect(menu(page)).toHaveCount(0);

  // Every view is in the bottom bar (#475): the timeline is one click, checked and the group's tab stop.
  await views(page).getByRole('radio', { name: 'Timeline' }).click();
  await expect(page.locator('#modern-page')).toHaveAttribute('data-view', 'timeline');
  await expect(views(page).getByRole('radio', { checked: true })).toHaveAccessibleName('Timeline');
  await expect(views(page).getByRole('radio', { name: 'Timeline' })).toHaveAttribute('tabindex', '0');
  await expect(views(page).getByRole('radio', { name: 'Write' })).toHaveAttribute('tabindex', '-1');
  await expect(menu(page)).toHaveCount(0);

  // An action runs its own handler: Settings opens Settings.
  await button.click();
  await menu(page).getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('settings').getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('settings')).toBeHidden();

  // And the way back to Classic.
  await button.click();
  await menu(page).getByRole('menuitem', { name: 'Use the Classic interface' }).click();
  await expect(page.locator('.workspace')).toBeVisible();
  await expect(page.getByTestId('modern-stage')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('caotang.interface'))).toBe('classic');
});

test('the top ornament is one toolbar stop: the arrow keys move between the title capsule and ⋯, and the title opens Scene info', async ({ page }) => {
  await modernScene(page, 'Toolbar Book');
  const title = scene(page).getByTestId('modern-title-capsule');
  await expect(title).toContainText('Toolbar Book');
  await expect(title).toHaveAttribute('tabindex', '0');
  await expect(more(page)).toHaveAttribute('tabindex', '-1');

  await title.focus();
  await page.keyboard.press('End');
  await expect(more(page)).toBeFocused();
  await expect(title).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(title).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(more(page)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(title).toBeFocused();

  // Tab leaves the toolbar; Shift+Tab comes back to the control last used.
  await page.keyboard.press('Tab');
  await expect(scene(page).locator(':focus')).toHaveCount(0);
  await page.keyboard.press('Shift+Tab');
  await expect(title).toBeFocused();

  // The title capsule is Scene info's opener (#308): it says so, opens it, and Escape gives focus back to it.
  await expect(title).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await title.click();
  const info = page.getByRole('dialog', { name: 'Scene info' });
  await expect(info).toBeVisible();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await expect(title).toHaveAttribute('aria-controls', 'modern-scene-info');
  await page.keyboard.press('Escape');
  await expect(info).toHaveCount(0);
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
});

test('Ask opens and closes the agent’s window and shows when the agent works; Search opens the palette', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await modernScene(page, 'Ask Book');
  const ask = views(page).getByRole('button', { name: 'Ask' });
  await expect(ask).toHaveAttribute('id', 'modern-ask');
  await expect(ask).toHaveAttribute('aria-controls', 'modern-companion');
  await expect(ask).toHaveAttribute('aria-expanded', 'false');
  await expect(ask).toHaveAttribute('data-activity', 'idle');
  await expect(page.getByTestId('modern-ask-activity')).toHaveCount(0);

  await ask.click();
  const agent = page.getByRole('complementary', { name: 'Agent' });
  await expect(agent).toBeVisible();
  await expect(ask).toHaveAttribute('aria-expanded', 'true');
  // Ask again closes it; focus stays on Ask.
  await ask.click();
  await expect(agent).toBeHidden();
  await expect(ask).toHaveAttribute('aria-expanded', 'false');
  await expect(ask).toBeFocused();
  // Opened by Ask and closed by Escape, focus comes back to Ask.
  await ask.click();
  await expect(agent).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(agent).toBeHidden();
  await expect(ask).toBeFocused();

  // Search is the palette's opener: it opens the palette, and Escape gives focus back to it.
  const search = views(page).getByRole('button', { name: 'Search' });
  await search.click();
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(search).toBeFocused();
});

test('a docked Scene info and the agent window stack at the inline-end edge, and the page moves over for both', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await modernScene(page, 'Stack Book');
  const area = page.locator('.modern-page-area');
  const info = page.getByRole('dialog', { name: 'Scene info' });
  const agent = page.getByRole('complementary', { name: 'Agent' });
  const keep = info.getByRole('button', { name: 'Keep open' });

  await scene(page).getByTestId('modern-title-capsule').click();
  await keep.click();
  await expect(info).toHaveClass(/is-docked/);
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).insetInlineEnd)).toBe('412px');

  await views(page).getByRole('button', { name: 'Ask' }).click();
  await expect(agent).toBeVisible();
  // The page's room is both windows and their gutters (modernLayout), never the later one alone.
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).insetInlineEnd)).toBe('844px');
  const settledBox = async (locator: Locator) => {
    await locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    return locator.boundingBox();
  };
  const agentBox = await settledBox(agent);
  const infoBox = await settledBox(info);
  const pageBox = await page.locator('#modern-page').boundingBox();
  expect(agentBox).not.toBeNull();
  expect(infoBox).not.toBeNull();
  // The agent window at the edge, Scene info beside it, the page before both: nothing over anything.
  expect((agentBox?.x ?? 0) + (agentBox?.width ?? 0)).toBeGreaterThan(1920 - 40);
  expect((infoBox?.x ?? 0) + (infoBox?.width ?? 0)).toBeLessThanOrEqual(agentBox?.x ?? 0);
  expect((pageBox?.x ?? 0) + (pageBox?.width ?? 0)).toBeLessThanOrEqual(infoBox?.x ?? 0);

  // Closing the agent window gives its room back, and Scene info returns to the edge.
  await views(page).getByRole('button', { name: 'Ask' }).click();
  await expect(agent).toBeHidden();
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).insetInlineEnd)).toBe('412px');
  await keep.click();
  await expect(info).toHaveClass(/is-popover/);
});

test('the ornaments show ten controls, each at least 44 by 44 px, and every ⋯ item is 44 px tall', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await modernScene(page, 'Target Book');
  const controls = page.locator('[data-testid="modern-top-ornament"] button, [data-testid="modern-bottom-ornament"] button');
  // Top: the title capsule, + New and ⋯; bottom: the five views (#475), Ask and Search.
  await expect(controls).toHaveCount(10);
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(box?.width ?? 0, await control.innerText()).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0, await control.innerText()).toBeGreaterThanOrEqual(44);
  }
  await more(page).click();
  for (const item of await menu(page).locator('[role^="menuitem"]').all()) {
    // The layout size: the popover may still be growing out of ⋯, and a transform scales the bounding box.
    expect(await item.evaluate((element) => (element as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
  }
});

test('the page takes each view’s width from the layout, and morphs on a view change', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await modernScene(page, 'Width Book');
  const main = page.locator('#modern-page');
  await expect.poll(async () => (await main.boundingBox())?.width).toBe(780);
  await views(page).getByRole('radio', { name: 'Board' }).click();
  // The view change runs the page's morph (Web Animations).
  expect(await main.evaluate((element) => element.getAnimations().length)).toBeGreaterThan(0);
  await expect.poll(async () => (await main.boundingBox())?.width).toBe(1120);
  await views(page).getByRole('radio', { name: 'Codex' }).click();
  await expect.poll(async () => (await main.boundingBox())?.width).toBe(1000);
  expect(await page.getByTestId('modern-stage').evaluate((element) => (element as HTMLElement).style.getPropertyValue('--page-w'))).toBe('1000px');
});

test('under reduced motion a view changes at once and ⋯ only fades in', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await modernScene(page, 'Still Book');
  const main = page.locator('#modern-page');
  await views(page).getByRole('radio', { name: 'Board' }).click();
  await expect(main).toHaveAttribute('data-view', 'board');
  expect(await main.evaluate((element) => element.getAnimations().length)).toBe(0);
  expect(await main.evaluate((element) => getComputedStyle(element).transitionDuration.split(',').every((part) => Number.parseFloat(part) === 0 || part.trim() === '0.12s'))).toBe(true);
  expect(await page.getByTestId('modern-lens').evaluate((element) => getComputedStyle(element).transitionDuration)).toMatch(/^0s(, 0s)*$/);

  await more(page).click();
  const motion = await page.getByTestId('modern-more-popover').evaluate((element) =>
    element.getAnimations().map((animation) => {
      const effect = animation.effect as KeyframeEffect;
      return { duration: effect.getTiming().duration, moves: effect.getKeyframes().some((frame) => frame['transform'] !== undefined) };
    }),
  );
  for (const run of motion) expect(run).toEqual({ duration: 120, moves: false });
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page)).toBeFocused();
});
