import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { waitForSaved } from './support.js';

/**
 * Modern's narrow layout (modern-interface.md §13, §9.2, §9.5, §9.7; M11, #312), below 960 px: the page full-bleed with a small margin,
 * the compact top capsule (title, ⋯) beside the binder's button, the bottom tab bar (Write, Board, Codex, Ask, Search) above the safe
 * area, the binder as the inline-start drawer, Scene info as the bottom sheet (at most 80% of the height) and the agent as a full-height
 * sheet, one at a time over a scrim with the rest inert. Close, a tap on the scrim, or Escape closes each, and focus returns to its
 * button. Every target is at least 44 px, and touch works.
 *
 * The file name holds "mobile-shell.spec.ts", so the `mobile` and `mobile-iphone-size` projects run it (Chromium with touch, emulation
 * only; playwright.config.ts) beside Classic's e2e/mobile-shell.spec.ts, and the desktop projects leave it out. Each test sets the size
 * it is about: a phone (390 by 844), a tablet (768 by 1024), and a 1,440 by 900 window at 200% zoom (720 by 450 CSS px).
 */

test.use({ storageState: NO_PIN });
// Each test makes a project and walks a panel three ways; a loaded runner needs more than the default 30 s for that.
test.describe.configure({ timeout: 90_000 });

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
const ZOOMED = { width: 720, height: 450 };
const GUTTER = 8;

const binderButton = (page: Page): Locator => page.getByTestId('modern-narrow-binder');
const drawer = (page: Page): Locator => page.getByTestId('modern-drawer');
const tree = (page: Page): Locator => page.getByRole('tree', { name: 'Binder' });
const scrim = (page: Page): Locator => page.getByTestId('modern-narrow-scrim');
const capsule = (page: Page): Locator => page.getByTestId('modern-title-capsule');
const sceneInfo = (page: Page): Locator => page.getByRole('dialog', { name: 'Scene info' });
const agent = (page: Page): Locator => page.getByRole('complementary', { name: 'Agent' });
const ask = (page: Page): Locator => page.locator('#modern-ask');
const tabBar = (page: Page): Locator => page.getByRole('navigation', { name: 'Views and tools' });
const pageMain = (page: Page): Locator => page.locator('#modern-page');

/** Modern, chosen before the app starts, as a writer who picked it in Settings would have it. */
async function modern(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
}

/** A project made from the projects screen, with the narrow Modern shell showing and the storage notice out of the way. */
async function newProject(page: Page, size: { width: number; height: number } = PHONE, name = 'Phone Book'): Promise<void> {
  await modern(page, size);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await expect(binderButton(page)).toBeVisible();
  await waitForSaved(page);
  const banner = page.getByTestId('storage-banner');
  if (await banner.isVisible()) {
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toBeHidden();
  }
}

/** Taps where touch is emulated, clicks where it is not (a local run in a desktop browser); at `position` when given. */
async function press(page: Page, target: Locator, position?: { x: number; y: number }): Promise<void> {
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (touch) await target.tap(position === undefined ? undefined : { position });
  else await target.click(position === undefined ? undefined : { position });
}

async function openDrawer(page: Page): Promise<void> {
  await press(page, binderButton(page));
  await expect(drawer(page)).toHaveAttribute('data-state', 'open');
  await expect(tree(page)).toBeVisible();
}

/** A chapter and a scene made in the drawer, then the drawer closed by choosing the scene. */
async function sceneInDrawer(page: Page, title: string): Promise<void> {
  await openDrawer(page);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: `Rename Untitled` }).fill(title);
  await page.keyboard.press('Enter');
  await press(page, tree(page).locator('.row-title', { hasText: title }));
  await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
}

/** Waits until every animation under an element has run out, so a measure reads where it rests and not a frame of a slide or morph. */
async function settled(element: Locator): Promise<void> {
  await element.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))));
  // The drawer's slide is a CSS transition, which getAnimations lists too; one more frame for the layout to settle.
  await element.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/** Whether the page scrolls sideways. */
function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Whether an element sits inside something inert. */
function isInert(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.closest('[inert]') !== null);
}

/** The controls on screen smaller than 44 by 44 px (as e2e/mobile-shell.spec.ts measures them), one line each. */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const selector =
      'button, [role=tab], [role=radio], [role=menuitem], [role=menuitemradio], [role=treeitem], select, summary, textarea, input:not([type=hidden]):not([type=file])';
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (element.closest('[inert]') !== null || element.classList.contains('visually-hidden')) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const inSentence = [element.previousSibling, element.nextSibling].some((side) => side?.nodeType === Node.TEXT_NODE && (side.textContent ?? '').trim() !== '');
      if (inSentence) continue;
      const label = element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio') ? element.closest('label') : null;
      const box = (label ?? element).getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right < 0 || box.left > window.innerWidth || box.bottom < 0 || box.top > window.innerHeight) continue;
      if (box.width < 43.5 || box.height < 43.5) {
        const name = element.getAttribute('aria-label') ?? element.textContent ?? '';
        found.push(`${element.tagName.toLowerCase()}.${element.className} "${name.trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    return found;
  });
}

/** Everything a box needs to be fully on screen. */
async function onScreen(page: Page, locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox();
  const size = page.viewportSize();
  if (box === null || size === null) return false;
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 0.5 && box.y + box.height <= size.height + 0.5;
}

test.describe('the Modern narrow layout at 390 and 768 px', () => {
  for (const size of [PHONE, TABLET]) {
    test(`at ${size.width} px the page is full-bleed between the compact capsule and the tab bar, with no sideways scroll`, async ({ page }) => {
      await newProject(page, size);
      await sceneInDrawer(page, 'Opening');
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);

      // The page: the window's width less the small margin on each side.
      const paper = await pageMain(page).boundingBox();
      expect(paper).not.toBeNull();
      expect(Math.round(paper?.x ?? 0)).toBe(GUTTER);
      expect(Math.round(paper?.width ?? 0)).toBe(size.width - 2 * GUTTER);

      // The compact capsule: the title and ⋯, above the page; the save state and the view's crumb are left to Scene info.
      const top = page.getByRole('toolbar', { name: 'Scene', exact: true });
      await expect(capsule(page)).toBeVisible();
      await expect(top.getByRole('button', { name: 'More', exact: true })).toBeVisible();
      await expect(top.locator('.modern-ornament-state')).toBeHidden();
      const topBox = await top.boundingBox();
      expect((topBox?.y ?? 0) + (topBox?.height ?? 0)).toBeLessThanOrEqual(paper?.y ?? 0);
      // The binder's button shares the top bar and never meets the capsule.
      const button = await binderButton(page).boundingBox();
      expect((button?.x ?? 0) + (button?.width ?? 0)).toBeLessThanOrEqual(topBox?.x ?? 0);

      // The tab bar: five tabs in a row, below the page, the page's width, above the bottom edge.
      const bar = await tabBar(page).boundingBox();
      expect(bar?.y ?? 0).toBeGreaterThanOrEqual((paper?.y ?? 0) + (paper?.height ?? 0));
      expect(Math.round((bar?.y ?? 0) + (bar?.height ?? 0))).toBe(size.height - GUTTER);
      expect(Math.round(bar?.width ?? 0)).toBe(size.width - 2 * GUTTER);
      const tabs = tabBar(page).locator('button');
      await expect(tabs).toHaveCount(5);
      await expect(tabs).toHaveText([/Write/, /Board/, /Codex/, /Ask/, /Search/]);
      const tops = await tabs.evaluateAll((buttons) => buttons.map((element) => Math.round(element.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);

      // 44 px: every control on screen, with nothing open.
      expect(await smallTargets(page)).toEqual([]);
    });
  }

  test('at 200% zoom a 1,440 px window (720 CSS px) gets the narrow layout with nothing clipped', async ({ page }) => {
    await newProject(page, ZOOMED);
    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
    for (const control of [binderButton(page), capsule(page), tabBar(page), pageMain(page)]) expect(await onScreen(page, control)).toBe(true);
    for (const name of ['Write', 'Board', 'Codex']) await expect(tabBar(page).getByRole('radio', { name })).toBeVisible();
    expect(await smallTargets(page)).toEqual([]);
  });

  test('960 px is the wide Modern layout again: no binder button, and the bottom ornament no longer spans the window', async ({ page }) => {
    await newProject(page, PHONE);
    await page.setViewportSize({ width: 960, height: 800 });
    await expect(binderButton(page)).toHaveCount(0);
    const bar = await tabBar(page).boundingBox();
    expect(bar?.width ?? 0).toBeLessThan(960 - 2 * GUTTER);
    await page.setViewportSize(PHONE);
    await expect(binderButton(page)).toBeVisible();
  });
});

test.describe('the Modern binder drawer', () => {
  for (const size of [PHONE, TABLET]) {
    test(`at ${size.width} px it opens from the inline-start edge with the rest inert, and closes by Close, the scrim and Escape`, async ({ page }) => {
      await newProject(page, size);
      await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
      expect(await isInert(drawer(page))).toBe(true);
      await expect(binderButton(page)).toHaveAttribute('aria-expanded', 'false');

      // Opened: focus on the current tab, the page, the capsule and the tab bar inert behind the scrim.
      await press(page, binderButton(page));
      await expect(drawer(page)).toHaveAttribute('data-state', 'open');
      await expect(binderButton(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('tab', { name: 'Binder' })).toBeFocused();
      await expect(scrim(page)).toHaveClass(/is-open/);
      for (const behind of [pageMain(page), capsule(page), tabBar(page), binderButton(page)]) expect(await isInert(behind)).toBe(true);
      await settled(drawer(page));
      const box = await drawer(page).boundingBox();
      expect(Math.round(box?.x ?? -1)).toBe(GUTTER);
      expect(Math.round(box?.width ?? 0)).toBe(Math.min(360, size.width - 56));
      expect(Math.round(box?.height ?? 0)).toBe(size.height - 2 * GUTTER);
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0);
      expect(await smallTargets(page)).toEqual([]);

      // Close.
      await press(page, page.getByTestId('modern-drawer-close'));
      await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
      await expect(binderButton(page)).toBeFocused();
      expect(await isInert(pageMain(page))).toBe(false);
      await expect(scrim(page)).not.toHaveClass(/is-open/);

      // The scrim, tapped beside the drawer.
      await openDrawer(page);
      await press(page, scrim(page), { x: size.width - 12, y: Math.round(size.height / 2) });
      await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
      await expect(binderButton(page)).toBeFocused();

      // Escape, from the keyboard.
      await binderButton(page).focus();
      await page.keyboard.press('Enter');
      await expect(drawer(page)).toHaveAttribute('data-state', 'open');
      await expect(page.getByRole('tab', { name: 'Binder' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
      await expect(binderButton(page)).toBeFocused();
    });
  }

  test('its four tabs are the sidebar’s, walked by the arrow keys, and choosing a scene closes it on the editor', async ({ page }) => {
    await newProject(page);
    await openDrawer(page);
    await expect(drawer(page).getByRole('tab')).toHaveText([/Binder/, /Findings/, /Activity/, /Trace/]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Trace' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Trace' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'Binder' })).toBeFocused();
    await page.keyboard.press('Escape');
    await sceneInDrawer(page, 'Landing');
    await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
  });

  test('its Binder tab is #307’s: the import actions, the filter, the tree, and the footer under Goals and sprint, tapped open', async ({ page }) => {
    await newProject(page, TABLET);
    await openDrawer(page);
    const side = drawer(page);
    await expect(side.getByRole('toolbar', { name: 'Binder actions' })).toBeVisible();
    await expect(side.locator('#binder-filter-text')).toBeVisible();
    const goals = side.getByRole('button', { name: 'Goals and sprint' });
    await expect(goals).toHaveAttribute('aria-expanded', 'false');
    await expect(side.getByTestId('binder-footer')).toBeHidden();
    await press(page, goals);
    await expect(goals).toHaveAttribute('aria-expanded', 'true');
    await expect(side.getByTestId('binder-footer')).toBeVisible();
    await expect(drawer(page)).toHaveAttribute('data-state', 'open');
    const box = await goals.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.99);
    expect(await smallTargets(page)).toEqual([]);
  });

  test('the keyboard reaches it from the top bar: Tab from the title capsule goes on to the binder’s button, in reading order', async ({ page }) => {
    await newProject(page);
    await capsule(page).focus();
    await page.keyboard.press('Tab');
    await expect(binderButton(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(drawer(page)).toHaveAttribute('data-state', 'open');
    // Tab stays inside: the rest is inert.
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.getElementById('narrow-rail')?.contains(document.activeElement) === true)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(binderButton(page)).toBeFocused();
  });
});

test.describe('Scene info, the bottom sheet', () => {
  for (const size of [PHONE, TABLET]) {
    test(`at ${size.width} px it rises from the bottom, at most 80% of the height, and closes by Close, the scrim and Escape`, async ({ page }) => {
      await newProject(page, size);
      await sceneInDrawer(page, 'Opening');

      await press(page, capsule(page));
      await expect(sceneInfo(page)).toBeVisible();
      await expect(sceneInfo(page)).toHaveClass(/is-sheet/);
      await expect(capsule(page)).toHaveAttribute('aria-expanded', 'true');
      // Keep open docks beside a page; there is none to dock beside here.
      await expect(sceneInfo(page).getByRole('button', { name: 'Keep open' })).toHaveCount(0);
      // Focus is in the sheet, on its first field; the rest is inert behind the scrim.
      expect(await sceneInfo(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
      for (const behind of [pageMain(page), tabBar(page), binderButton(page), capsule(page)]) expect(await isInert(behind)).toBe(true);
      await settled(sceneInfo(page));
      const box = await sceneInfo(page).boundingBox();
      // It rises from just above the tab bar, at the overlay band's foot, so the tab bar stays in sight behind the scrim (#358).
      const bar = await tabBar(page).boundingBox();
      const foot = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--overlay-bottom')));
      expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(Math.round(size.height - foot));
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(bar?.y ?? 0);
      expect(box?.height ?? 0).toBeLessThanOrEqual(Math.round(size.height * 0.8) + 1);
      expect(Math.round(box?.width ?? 0)).toBe(size.width - 2 * GUTTER);
      expect(await smallTargets(page)).toEqual([]);

      // Close.
      await press(page, sceneInfo(page).getByRole('button', { name: 'Close', exact: true }));
      await expect(sceneInfo(page)).toBeHidden();
      await expect(capsule(page)).toBeFocused();
      expect(await isInert(pageMain(page))).toBe(false);

      // The scrim, tapped above the sheet.
      await press(page, capsule(page));
      await expect(sceneInfo(page)).toBeVisible();
      await press(page, scrim(page), { x: Math.round(size.width / 2), y: 12 });
      await expect(sceneInfo(page)).toBeHidden();
      await expect(capsule(page)).toBeFocused();

      // Escape.
      await capsule(page).focus();
      await page.keyboard.press('Enter');
      await expect(sceneInfo(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sceneInfo(page)).toBeHidden();
      await expect(capsule(page)).toBeFocused();
    });
  }
});

test.describe('the agent, a full-height sheet', () => {
  for (const size of [PHONE, TABLET]) {
    test(`at ${size.width} px Ask opens it over the scrim, and Close, the scrim and Escape give focus back to Ask`, async ({ page }) => {
      await newProject(page, size);

      await press(page, ask(page));
      await expect(agent(page)).toBeVisible();
      await expect(ask(page)).toHaveAttribute('aria-expanded', 'true');
      await expect.poll(() => agent(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
      for (const behind of [pageMain(page), tabBar(page), binderButton(page), capsule(page)]) expect(await isInert(behind)).toBe(true);
      await settled(agent(page));
      const box = await agent(page).boundingBox();
      expect(Math.round(box?.y ?? 0)).toBe(GUTTER);
      expect(Math.round(box?.height ?? 0)).toBe(size.height - 2 * GUTTER);
      expect(Math.round(box?.width ?? 0)).toBe(size.width - 2 * GUTTER);
      // One scrim, the narrow layout's: the window's own gives way to it.
      await expect(page.getByTestId('modern-companion-scrim')).toBeHidden();
      await expect(scrim(page)).toHaveAttribute('data-panel', 'agent');
      expect(await smallTargets(page)).toEqual([]);

      // Close.
      await press(page, page.getByTestId('agent-close'));
      await expect(agent(page)).toBeHidden();
      await expect(ask(page)).toBeFocused();
      expect(await isInert(pageMain(page))).toBe(false);

      // The scrim, in the margin beside the sheet.
      await press(page, ask(page));
      await expect(agent(page)).toBeVisible();
      await press(page, scrim(page), { x: 3, y: Math.round(size.height / 2) });
      await expect(agent(page)).toBeHidden();
      await expect(ask(page)).toBeFocused();

      // Escape (the Intent box empty, no turn running).
      await ask(page).focus();
      await page.keyboard.press('Enter');
      await expect(agent(page)).toBeVisible();
      await expect.poll(() => agent(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(agent(page)).toBeHidden();
      await expect(ask(page)).toBeFocused();
    });
  }

  test('at most one panel is open: the agent replaces Scene info or the drawer, and Ctrl+J closes it again', async ({ page }) => {
    await newProject(page);
    await sceneInDrawer(page, 'Opening');

    await press(page, capsule(page));
    await expect(sceneInfo(page)).toBeVisible();
    await page.keyboard.press('Control+j');
    await expect(agent(page)).toBeVisible();
    await expect(sceneInfo(page)).toBeHidden();
    await expect(scrim(page)).toHaveAttribute('data-panel', 'agent');

    await page.keyboard.press('Control+j');
    await expect(agent(page)).toBeHidden();
    await expect(ask(page)).toBeFocused();
    await expect(scrim(page)).toHaveAttribute('data-panel', 'none');

    await openDrawer(page);
    await page.keyboard.press('Control+j');
    await expect(agent(page)).toBeVisible();
    await expect(drawer(page)).toHaveAttribute('data-state', 'closed');
    await page.keyboard.press('Escape');
    await expect(agent(page)).toBeHidden();
    expect(await isInert(pageMain(page))).toBe(false);
  });
});

test.describe('the tab bar', () => {
  test('Board on a prose chapter says "Open on desktop: the corkboard", and Write comes back', async ({ page }) => {
    await newProject(page);
    await sceneInDrawer(page, 'Opening');
    await press(page, tabBar(page).getByRole('radio', { name: 'Board' }));
    await expect(page.getByTestId('open-on-desktop')).toHaveAttribute('data-feature', 'corkboard');
    await expect(page.getByRole('heading', { name: 'Open on desktop: the corkboard' })).toBeVisible();
    await press(page, tabBar(page).getByRole('radio', { name: 'Write' }));
    await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
    await press(page, tabBar(page).getByRole('radio', { name: 'Codex' }));
    await expect(pageMain(page)).toHaveAttribute('data-view', 'codex');
    // The Codex is the page's view, not a panel: nothing opened over it.
    await expect(scrim(page)).toHaveAttribute('data-panel', 'none');
  });

  test('Search opens the palette, and Escape gives focus back to Search', async ({ page }) => {
    await newProject(page);
    await press(page, page.getByTestId('modern-search'));
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(page.getByTestId('modern-search')).toBeFocused();
  });
});

test.describe('reduced motion', () => {
  test('the drawer and the scrim appear at once, and Scene info and the agent fade in place', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await newProject(page);
    await sceneInDrawer(page, 'Opening');

    await openDrawer(page);
    const durations = await drawer(page).evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(durations.split(',').every((value) => parseFloat(value) === 0)).toBe(true);
    expect(await scrim(page).evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration))).toBe(0);
    await page.keyboard.press('Escape');

    await press(page, capsule(page));
    await expect(sceneInfo(page)).toHaveAttribute('data-entrance', 'fade');
    await page.keyboard.press('Escape');

    await press(page, ask(page));
    await expect(agent(page)).toBeVisible();
    await expect(page.locator('#modern-companion')).toHaveAttribute('data-morph', 'fade');
  });

  test('without it, Scene info rises from the bottom edge', async ({ page }) => {
    await newProject(page);
    await sceneInDrawer(page, 'Opening');
    await press(page, capsule(page));
    await expect(sceneInfo(page)).toHaveAttribute('data-entrance', 'rise');
  });
});
