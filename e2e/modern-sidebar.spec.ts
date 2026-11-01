import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { waitForSaved } from './support.js';

/**
 * Modern's binder tab bar and sidebar (M6, #307; modern-interface.md §7.2, §8.5, §9.5, §9.6): the glass tab bar with Manuscript, Panels
 * and the minimap grows into the sidebar with Binder, Findings, Activity and Trace. A hover held for 140 ms opens it without moving focus,
 * and it closes 420 ms after the pointer leaves; a click, Enter or Space opens it with focus on the current row; Escape closes it and
 * returns focus; Ctrl+Alt+F opens it on the filter; Keep open pins it, the page moves over and the pin survives a reload; a scene chosen
 * in an unpinned sidebar closes it on the editor; a tap opens it; under reduced motion nothing moves; every control is at least 44 px.
 * These specs run Modern, so they start without the suite's Classic pin.
 */

test.use({ storageState: NO_PIN });

async function watchCsp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as Window & { __cspViolations?: string[] }).__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as Window & { __cspViolations?: string[] }).__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

function cspViolations(page: Page): Promise<string[] | undefined> {
  return page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations);
}

const binder = (page: Page): Locator => page.getByRole('navigation', { name: 'Binder' });
const sidebar = (page: Page): Locator => page.getByTestId('modern-sidebar');
const manuscript = (page: Page): Locator => binder(page).getByRole('button', { name: 'Manuscript' });
const panels = (page: Page): Locator => binder(page).getByRole('button', { name: 'Panels' });
const keepOpen = (page: Page): Locator => sidebar(page).getByRole('button', { name: 'Keep open' });
const editorText = (page: Page): Locator => page.getByRole('main').getByRole('textbox', { name: 'Document text' });

async function expectClosed(page: Page): Promise<void> {
  await expect(binder(page)).toHaveAttribute('data-state', 'closed');
  await expect(sidebar(page)).toBeHidden();
}

async function expectOpen(page: Page): Promise<void> {
  await expect(binder(page)).toHaveAttribute('data-state', 'open');
  await expect(sidebar(page)).toBeVisible();
}

/** A Modern project with two scenes, the second open in the editor, the sidebar closed and the pointer off it. */
async function modernProject(page: Page, pinned = false): Promise<void> {
  await page.addInitScript((pin) => {
    localStorage.setItem('caotang.interface', 'modern');
    if (pin) localStorage.setItem('caotang.modern.binderPinned', 'true');
  }, pinned);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Harbour Book');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  if (!pinned) await manuscript(page).click();
  await expectOpen(page);
  for (const title of ['The ferry', 'The ticket']) {
    await sidebar(page).getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await sidebar(page).getByRole('textbox', { name: 'Rename Untitled' }).fill(title);
    await page.keyboard.press('Enter');
  }
  await editorText(page).fill('Lin had the only ticket.');
  await waitForSaved(page);
  if (!pinned) {
    await page.mouse.move(1300, 450);
    await expectClosed(page);
  }
}

test('the tab bar shows Manuscript, Panels and a decorative minimap; closed, the sidebar is inert and Tab never reaches it', async ({ page }) => {
  await watchCsp(page);
  await modernProject(page);
  await expect(page.getByTestId('modern-binder-bar')).toBeVisible();
  await expect(manuscript(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(manuscript(page)).toHaveAttribute('aria-controls', 'modern-sidebar');
  await expect(panels(page)).toHaveAttribute('aria-expanded', 'false');
  const minimap = page.getByTestId('modern-minimap');
  await expect(minimap).toHaveAttribute('aria-hidden', 'true');
  await expect(minimap.locator('.modern-minimap-dot')).toHaveCount(2);
  await expect(minimap.locator('.modern-minimap-dot.is-current')).toHaveCount(1);
  await expect(sidebar(page)).toHaveAttribute('inert', '');

  // Tab from Manuscript goes to Panels and then leaves the binder: no hidden row or tab takes a stop.
  await manuscript(page).focus();
  await page.keyboard.press('Tab');
  await expect(panels(page)).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.getElementById('modern-sidebar')?.contains(document.activeElement) ?? false)).toBe(false);
  expect(await cspViolations(page)).toEqual([]);
});

test('a hover held for 140 ms opens the sidebar without moving focus, and it closes 420 ms after the pointer leaves', async ({ page }) => {
  await modernProject(page);
  await editorText(page).focus();
  // Time the hover and the state change in the page, so a slow machine cannot make the delays look shorter than they are.
  await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="modern-binder"]');
    const bar = document.querySelector('[data-testid="modern-binder-bar"]');
    const marks = ((window as unknown as { __marks: Record<string, number> }).__marks = {} as Record<string, number>);
    bar?.addEventListener('pointerenter', () => (marks['enter'] ??= performance.now()));
    nav?.addEventListener('pointerleave', () => (marks['leave'] = performance.now()));
    new MutationObserver(() => {
      marks[nav?.getAttribute('data-state') === 'open' ? 'open' : 'closed'] = performance.now();
    }).observe(nav as Element, { attributes: true, attributeFilter: ['data-state'] });
  });
  await manuscript(page).hover();
  await expectOpen(page);
  await expect(editorText(page)).toBeFocused();
  await expect(manuscript(page)).toHaveAttribute('aria-expanded', 'true');

  // Moving from the bar into the sidebar keeps it open.
  await sidebar(page).hover({ position: { x: 40, y: 200 } });
  await page.waitForTimeout(600);
  await expectOpen(page);

  await page.mouse.move(1300, 450);
  await expectClosed(page);
  await expect(editorText(page)).toBeFocused();
  const marks = await page.evaluate(() => (window as unknown as { __marks: Record<string, number> }).__marks);
  expect((marks['open'] ?? 0) - (marks['enter'] ?? 0)).toBeGreaterThanOrEqual(130);
  expect((marks['closed'] ?? 0) - (marks['leave'] ?? 0)).toBeGreaterThanOrEqual(400);
});

test('a click, Enter or Space opens it with focus on the current row; Escape closes it and returns focus to the button', async ({ page }) => {
  await modernProject(page);
  const current = sidebar(page).getByRole('treeitem', { name: 'The ticket' });

  await manuscript(page).click();
  await expectOpen(page);
  await expect(current).toBeFocused();
  await page.keyboard.press('Escape');
  await expectClosed(page);
  await expect(manuscript(page)).toBeFocused();

  await page.keyboard.press('Enter');
  await expectOpen(page);
  await expect(current).toBeFocused();
  await page.keyboard.press('Escape');
  await expectClosed(page);
  await expect(manuscript(page)).toBeFocused();

  await page.keyboard.press(' ');
  await expectOpen(page);
  await expect(current).toBeFocused();

  // Focus inside keeps it open after the pointer has gone.
  await page.mouse.move(1300, 450);
  await page.waitForTimeout(700);
  await expectOpen(page);
  await page.keyboard.press('Escape');
  await expectClosed(page);

  // Panels opens on Findings the first time, with focus on that tab; pressed again it closes.
  await panels(page).click();
  await expectOpen(page);
  const findings = sidebar(page).getByRole('tab', { name: /^Findings/ });
  await expect(findings).toHaveAttribute('aria-selected', 'true');
  await expect(findings).toBeFocused();
  await expect(panels(page)).toHaveAttribute('aria-expanded', 'true');
  await panels(page).click();
  await expectClosed(page);
});

test('the sidebar’s tabs are a tablist with Classic’s keys and ids, and Panels comes back to the last other tab', async ({ page }) => {
  await modernProject(page);
  await manuscript(page).click();
  const tablist = sidebar(page).getByRole('tablist', { name: 'Panels' });
  await expect(tablist.getByRole('tab')).toHaveText([/^Binder/, /^Findings/, /^Activity/, /^Trace/]);
  const tab = (name: string): Locator => tablist.getByRole('tab', { name: new RegExp(`^${name}`) });
  const panel = sidebar(page).getByRole('tabpanel');

  await tab('Binder').focus();
  await expect(tab('Binder')).toHaveAttribute('id', 'rail-tab-binder');
  await expect(panel).toHaveAttribute('aria-labelledby', 'rail-tab-binder');
  await page.keyboard.press('ArrowRight');
  await expect(tab('Findings')).toBeFocused();
  await expect(tab('Findings')).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toHaveAttribute('aria-labelledby', 'rail-tab-findings');
  await page.keyboard.press('End');
  await expect(tab('Trace')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab('Binder')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tab('Trace')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tab('Activity')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Activity')).toHaveAttribute('tabindex', '0');
  await expect(tab('Binder')).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('Escape');
  await expectClosed(page);
  await manuscript(page).click();
  await expect(tab('Binder')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await panels(page).click();
  await expect(tab('Activity')).toHaveAttribute('aria-selected', 'true');
});

test('the Binder tab holds the import actions, the filter bar, the tree and the footer under Goals and sprint', async ({ page }) => {
  await modernProject(page);
  await manuscript(page).click();
  const side = sidebar(page);
  await expect(side.getByRole('toolbar', { name: 'Binder actions' })).toBeVisible();
  await expect(side.locator('#binder-filter-text')).toBeVisible();
  await expect(side.getByRole('tree', { name: 'Binder' })).toBeVisible();
  const goals = side.getByRole('button', { name: 'Goals and sprint' });
  await expect(goals).toHaveAttribute('aria-expanded', 'false');
  await expect(side.getByTestId('binder-footer')).toBeHidden();
  await goals.click();
  await expect(goals).toHaveAttribute('aria-expanded', 'true');
  await expect(side.getByTestId('binder-footer')).toBeVisible();
  await expect(side.getByTestId('binder-totals')).toBeVisible();
});

test('Ctrl+Alt+F opens the sidebar on the filter, from the editor', async ({ page }) => {
  await modernProject(page);
  await editorText(page).focus();
  await page.keyboard.press('Control+Alt+KeyF');
  await expectOpen(page);
  await expect(page.locator('#binder-filter-text')).toBeFocused();
  await page.keyboard.press('Escape');
  await expectClosed(page);
  await expect(manuscript(page)).toBeFocused();
});

test('choosing a scene in an unpinned sidebar closes it on the editor', async ({ page }) => {
  await modernProject(page);
  await manuscript(page).click();
  await sidebar(page).locator('.row-title', { hasText: 'The ferry' }).click();
  await expectClosed(page);
  await expect(editorText(page)).toBeFocused();
  await expect(page.locator('.modern-minimap-dot').first()).toHaveClass(/is-current/);
});

test('Keep open pins the sidebar, the page moves over, a scene chosen keeps it, and the pin survives a reload', async ({ page }) => {
  await modernProject(page);
  const page0 = await page.locator('#modern-page').boundingBox();
  await manuscript(page).click();
  await expect(keepOpen(page)).toHaveAttribute('aria-pressed', 'false');
  await keepOpen(page).click();
  await expect(keepOpen(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('caotang.modern.binderPinned'))).toBe('true');
  await expect(binder(page)).toHaveClass(/is-pinned/);

  // The page moves clear of the sidebar.
  await expect
    .poll(async () => {
      const side = await sidebar(page).boundingBox();
      const sheet = await page.locator('#modern-page').boundingBox();
      return side !== null && sheet !== null && sheet.x >= side.x + side.width;
    })
    .toBe(true);
  expect(page0).not.toBeNull();

  // Neither the pointer leaving, nor focus leaving, nor Escape, nor a scene chosen closes a pinned sidebar.
  await sidebar(page).locator('.row-title', { hasText: 'The ferry' }).click();
  await page.mouse.move(1300, 450);
  await editorText(page).click();
  await page.waitForTimeout(700);
  await expectOpen(page);

  await page.reload();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await expectOpen(page);
  await expect(keepOpen(page)).toHaveAttribute('aria-pressed', 'true');

  await keepOpen(page).click();
  await expect(keepOpen(page)).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('caotang.modern.binderPinned'))).toBeNull();
  // Unpinned with focus inside, it waits for focus to leave.
  await expectOpen(page);
  await page.mouse.move(1300, 450);
  await editorText(page).click();
  await expectClosed(page);
});

test('every control of the tab bar and the sidebar, and every tree row, is at least 44 by 44 px', async ({ page }) => {
  await modernProject(page);
  await manuscript(page).click();
  await sidebar(page).getByRole('button', { name: 'Goals and sprint' }).click();
  const targets = [
    manuscript(page),
    panels(page),
    ...['Binder', 'Findings', 'Activity', 'Trace'].map((name) => sidebar(page).getByRole('tab', { name: new RegExp(`^${name}`) })),
    keepOpen(page),
    sidebar(page).getByRole('button', { name: 'Goals and sprint' }),
  ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(box, await target.textContent()).not.toBeNull();
    expect(box?.width ?? 0, await target.textContent()).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0, await target.textContent()).toBeGreaterThanOrEqual(44);
  }
  const rows = sidebar(page).getByRole('treeitem');
  expect(await rows.count()).toBeGreaterThan(2);
  for (const row of await rows.all()) {
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test('under reduced motion the sidebar does not move: it appears with the 120 ms fade only', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await modernProject(page);
  await manuscript(page).click();
  await expectOpen(page);
  const timing = await sidebar(page).evaluate((element) => {
    const style = getComputedStyle(element);
    const properties = style.transitionProperty.split(',').map((part) => part.trim());
    const durations = style.transitionDuration.split(',').map((part) => part.trim());
    return Object.fromEntries(properties.map((property, at) => [property, durations[at] ?? durations[0]]));
  });
  expect(timing['transform']).toBe('0s');
  expect(timing['opacity']).toBe('0.12s');
  expect(await sidebar(page).evaluate((element) => getComputedStyle(element).transform)).toBe('none');
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('a tap on Manuscript opens the sidebar, and a tap on the page closes it', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox has no touch emulation in Playwright');
    await modernProject(page);
    await manuscript(page).tap();
    await expectOpen(page);
    await expect(sidebar(page).getByRole('treeitem', { name: 'The ticket' })).toBeFocused();
    await page.locator('#modern-page').tap({ position: { x: 600, y: 300 } });
    await expectClosed(page);
  });
});
