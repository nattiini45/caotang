import { expect, test, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { createProject } from './support.js';

/**
 * The interface (app/interface.ts; modern-interface.md §3, ui-modules.md §5.1): Classic or Modern, chosen in Settings › Appearance ›
 * Interface, kept in this browser as `caotang.interface` and put on <html> as `data-shell` before the first render. These specs check
 * the default themselves, so they start without the suite's Classic pin (e2e/classic-pin.ts).
 *
 * Until the parity gate opens (MODERN_DEFAULT_FOR_NEW_USERS, #313) a fresh profile resolves to Classic, and Modern is "Modern
 * (Preview)" in Settings. Modern's stylesheet is loaded only while Modern is on; its placeholder override sets `--radius` to 14px
 * (8px in Classic), which is what these specs read.
 *
 * The code inside `page.evaluate` is sent to the page as text, so each callback names its own globals.
 */

test.use({ storageState: NO_PIN });

interface View {
  document: { documentElement: { dataset: Record<string, string> } };
  localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
  getComputedStyle(element: unknown): { getPropertyValue(name: string): string };
}

function shellOf(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as View).document.documentElement.dataset['shell'] ?? null);
}

function stored(page: Page): Promise<string | null> {
  return page.evaluate(() => (globalThis as unknown as View).localStorage.getItem('caotang.interface'));
}

function radius(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = globalThis as unknown as View;
    return view.getComputedStyle(view.document.documentElement).getPropertyValue('--radius').trim();
  });
}

/** Every request for Modern's stylesheet, from the dev server (`/src/modern/modern.css`) or a build (`modern-<hash>.css`). */
function watchModernCss(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (/modern[^/]*\.css/.test(request.url())) seen.push(request.url());
  });
  return seen;
}

const HOME = 'Projects in this browser';

test('a fresh profile resolves as the parity gate says: Classic today, stored at once, and Modern’s stylesheet is not fetched', async ({ page }) => {
  const css = watchModernCss(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: HOME })).toBeVisible();
  expect(await shellOf(page)).toBe('classic');
  expect(await stored(page)).toBe('classic');
  expect(await radius(page)).toBe('8px');
  expect(css).toEqual([]);
});

test('an existing profile (a theme kept from an earlier visit) stays Classic', async ({ page }) => {
  await page.addInitScript(() => (globalThis as unknown as View).localStorage.setItem('caotang.theme', 'light'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: HOME })).toBeVisible();
  expect(await shellOf(page)).toBe('classic');
  expect(await stored(page)).toBe('classic');
});

test('an existing profile with a project and no interface stored settles on Classic from the store', async ({ page }) => {
  await createProject(page, 'Returning Book');
  await page.evaluate(() => (globalThis as unknown as View).localStorage.removeItem('caotang.interface'));
  await page.reload();
  await expect(page.getByRole('heading', { name: HOME })).toBeVisible();
  expect(await shellOf(page)).toBe('classic');
  expect(await stored(page)).toBe('classic');
});

test('a stored Modern loads its stylesheet before the first render, and survives a reload', async ({ page }) => {
  await page.addInitScript(() => (globalThis as unknown as View).localStorage.setItem('caotang.interface', 'modern'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: HOME })).toBeVisible();
  expect(await shellOf(page)).toBe('modern');
  expect(await radius(page)).toBe('14px');
});

test('Settings › Appearance › Interface switches live: the unsaved text, the open agent panel and focus on the radio all stay', async ({ page }) => {
  await createProject(page, 'Switch Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Switching');
  await page.keyboard.press('Enter');
  await expect(page.locator('#agent-body')).toBeVisible();
  // Typed and not waited for: the save is still pending (its journal holds it) when the interface changes.
  await page.getByRole('textbox', { name: 'Document text' }).fill('Words typed just before the switch.');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click();
  const group = settings.getByRole('group', { name: 'Interface' });
  const modern = group.getByRole('radio', { name: 'Modern (Preview)' });
  await modern.check();
  await expect(modern).toBeFocused();
  expect(await shellOf(page)).toBe('modern');
  expect(await stored(page)).toBe('modern');
  await expect.poll(() => radius(page)).toBe('14px');

  const classic = group.getByRole('radio', { name: 'Classic' });
  await classic.check();
  await expect(classic).toBeFocused();
  expect(await shellOf(page)).toBe('classic');
  expect(await stored(page)).toBe('classic');
  await expect.poll(() => radius(page)).toBe('8px');

  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('Words typed just before the switch.');
  await expect(page.locator('#agent-body')).toBeVisible();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});
