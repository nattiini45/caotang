import { expect, test, type Page } from '@playwright/test';

import { createProject } from './support.js';

/**
 * The interface shell (app/shell.ts, ui-modules.md §5.1): Classic or Modern, chosen in Settings › Appearance › Interface, kept in
 * this browser and put on <html> as `data-shell` before the first paint. With nothing stored, a new writer gets Modern and a
 * returning one Classic. Modern's stylesheet is loaded only when Modern is on; until the Modern spec lands it only overrides a few
 * semantic tokens, and `--radius-md` (8px in Classic, 14px in Modern) is the one these specs read.
 *
 * The code inside `page.evaluate` is sent to the page as text, so each callback names its own globals (this package's tsconfig has
 * no DOM library for the page's side).
 */

interface View {
  document: { documentElement: { dataset: Record<string, string> } };
  localStorage: { getItem(key: string): string | null; removeItem(key: string): void };
  getComputedStyle(element: unknown): { getPropertyValue(name: string): string };
}

function shellOf(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as View).document.documentElement.dataset['shell'] ?? null);
}

function storedShell(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as View).localStorage.getItem('caotang.shell'));
}

function radius(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = globalThis as unknown as View;
    return view.getComputedStyle(view.document.documentElement).getPropertyValue('--radius-md').trim();
  });
}

const HOME = 'Projects in this browser';

test('a first visit with nothing kept opens in Modern, loads its stylesheet, and remembers the default', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: HOME })).toBeVisible();
  expect(await shellOf(page)).toBe('modern');
  expect(await storedShell(page)).toBe('modern');
  await expect.poll(() => radius(page)).toBe('14px');
});

test('a browser that kept something from an earlier visit opens in Classic, and Modern’s stylesheet is not loaded', async ({ page }) => {
  await page.addInitScript(() => {
    const view = globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } };
    view.localStorage.setItem('caotang.theme', 'light');
  });
  const css: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'stylesheet' || request.url().includes('modern')) css.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: HOME })).toBeVisible();
  expect(await shellOf(page)).toBe('classic');
  expect(await storedShell(page)).toBe('classic');
  expect(await radius(page)).toBe('8px');
  expect(css.filter((url) => url.includes('modern'))).toEqual([]);
});

test('a project kept from an earlier visit settles a missing choice on Classic', async ({ page }) => {
  await createProject(page, 'Returning Book');
  // The stored default is lost (site data partly cleared): the project in the browser's store now says this writer is returning.
  await page.evaluate(() => (globalThis as unknown as View).localStorage.removeItem('caotang.shell'));
  await page.reload();
  await expect(page.getByRole('heading', { name: HOME })).toBeVisible();
  expect(await shellOf(page)).toBe('classic');
  expect(await storedShell(page)).toBe('classic');
});

test('Settings › Appearance › Interface switches the shell at once, and the choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  const group = settings.getByRole('group', { name: 'Interface' });

  await group.getByRole('radio', { name: 'Classic' }).check();
  expect(await shellOf(page)).toBe('classic');
  expect(await storedShell(page)).toBe('classic');
  await expect.poll(() => radius(page)).toBe('8px');

  await group.getByRole('radio', { name: 'Modern' }).check();
  expect(await shellOf(page)).toBe('modern');
  expect(await storedShell(page)).toBe('modern');
  await expect.poll(() => radius(page)).toBe('14px');

  await page.reload();
  await expect(page.getByRole('heading', { name: HOME })).toBeVisible();
  expect(await shellOf(page)).toBe('modern');
  expect(await radius(page)).toBe('14px');
});
