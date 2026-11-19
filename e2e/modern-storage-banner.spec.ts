import { expect, test, type Page } from '@playwright/test';

import { chooseInterfaceLanguage } from './support.js';
import { test as tagged } from './test.js';

/**
 * The browser-storage warning over the page in Modern (#647 for the empty editor, #735 for every other view). The banner is not a
 * toast: it stays until the writer answers it and it carries buttons, so the stage gives it a row of its own, and a field the writer
 * scrolls to is never underneath it. Both widths are covered, because the reserved row takes its padding from the desktop page in
 * one and from the narrow layout's bars and safe areas in the other.
 */

/** A German Modern project whose browser has not promised to keep this site's storage, with the banner still up. */
async function germanProjectWithBanner(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('caotang.interface', 'modern');
    const storage = Object.getPrototypeOf(navigator.storage) as Record<string, unknown>;
    storage['persisted'] = async () => false;
    storage['persist'] = async () => false;
  });
  await page.goto('/');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await chooseInterfaceLanguage(page, settings, 'de');
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('de');
  if (await settings.isVisible()) await page.keyboard.press('Escape');
  await page.getByLabel('Projektname', { exact: true }).fill('Kodex Notizen');
  await page.getByRole('button', { name: 'Projekt erstellen', exact: true }).click();
  await expect(page.getByTestId('storage-banner')).toBeVisible();
}

/** The Codex view, on a wide window from the bottom bar's radio group and on a phone from its Views sheet. */
async function openCodex(page: Page, width: number): Promise<void> {
  const ornament = page.getByTestId('modern-bottom-ornament');
  if (width >= 960) {
    await ornament.getByRole('radio', { name: 'Kodex', exact: true }).click();
  } else {
    await ornament.getByRole('button', { name: 'Ansichten' }).click();
    await page.getByTestId('modern-views-codex').click();
  }
  // The empty state's own button is bare text, not a catalogue message, so its words are English in a German interface.
  await page.getByRole('main').getByRole('button', { name: 'New entry' }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Elena');
  await name.press('Enter');
}

/** How the banner and the exclusion-phrases field stand to each other, with the codex scrolled so the field is at the page's top. */
async function geometry(page: Page): Promise<{ overlap: boolean; receives: boolean; hit: string }> {
  return page.evaluate(() => {
    const heading = [...document.querySelectorAll('h3')].find((node) => (node.textContent ?? '').trim() === 'Ausschlussbegriffe');
    const input = heading?.closest('section')?.querySelector('input') as HTMLElement | null | undefined;
    if (input === null || input === undefined) throw new Error('no exclusion-phrases field');
    let scroller: HTMLElement | null = input;
    while (scroller !== null) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    if (scroller !== null) {
      const box = input.getBoundingClientRect();
      scroller.scrollTop += box.top - scroller.getBoundingClientRect().top - 6;
    }
    const banner = document.querySelector('[data-testid="storage-banner"]') as HTMLElement;
    const field = input.getBoundingClientRect();
    const bannerBox = banner.getBoundingClientRect();
    const hit = document.elementFromPoint((field.left + field.right) / 2, (field.top + field.bottom) / 2);
    return {
      overlap: bannerBox.bottom > field.top && bannerBox.top < field.bottom,
      receives: hit !== null && (hit === input || input.contains(hit)),
      hit: hit === null ? 'null' : `${hit.tagName}.${String(hit.className)}`,
    };
  });
}

for (const width of [1280, 390]) {
  tagged(`${width >= 960 ? 'Modern' : 'Modern on a phone'}: the storage warning leaves room for a scrolled Codex field`, { tag: '@modern' }, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width >= 960 ? 900 : 844 });
    await germanProjectWithBanner(page);
    await openCodex(page, width);
    const before = await geometry(page);
    // The banner is still open, and the field it would have covered takes the writer's input.
    await expect(page.getByTestId('storage-banner')).toBeVisible();
    expect(before.overlap, JSON.stringify(before)).toBe(false);
    expect(before.receives, JSON.stringify(before)).toBe(true);
    const field = page.getByRole('main').getByLabel('Zu Ausschlussbegriffe hinzufügen');
    await field.click();
    await field.fill('harbour');
    await field.press('Enter');
    await expect(page.getByRole('main').getByRole('list', { name: 'Ausschlussbegriffe' }).getByRole('listitem')).toHaveCount(1);
    // The warning's own recovery action is still reachable beside it.
    await expect(page.getByTestId('storage-banner').getByRole('button', { name: 'Ein Backup exportieren' })).toBeInViewport();
  });
}
