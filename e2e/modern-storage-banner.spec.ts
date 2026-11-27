import { expect, test, type Page } from '@playwright/test';

import { chooseInterfaceLanguage } from './support.js';
import { test as tagged } from './test.js';

/**
 * The browser-storage warning over the page in Modern (#647 for the empty editor, #735 for every other view). The banner is not a
 * toast: it stays until the writer answers it and it carries buttons, so the stage gives it a row of its own, and a field the writer
 * scrolls to is never underneath it. Both widths are covered, because the reserved row takes its room from the desktop page in one
 * and from the narrow layout's bars and safe areas in the other.
 */

/** A German Modern project whose browser has not promised to keep this site's storage, with the banner still up. */
async function germanProjectWithBanner(page: Page, chooseGerman = true): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('caotang.interface', 'modern');
    const storage = Object.getPrototypeOf(navigator.storage) as Record<string, unknown>;
    storage['persisted'] = async () => false;
    storage['persist'] = async () => false;
  });
  await page.goto('/');
  if (chooseGerman) {
    await page.getByTestId('open-settings').click();
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="appearance"]').click();
    await chooseInterfaceLanguage(page, settings, 'de');
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('de');
  if (chooseGerman && await page.getByTestId('settings').isVisible()) await page.keyboard.press('Escape');
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
  // The empty state's own button comes from the catalogue, so in this German interface its words are German.
  await page.getByRole('main').getByRole('button', { name: 'Neuer Eintrag' }).click();
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

test.describe('German Modern studio at 150% display scaling', () => {
  test.use({ deviceScaleFactor: 1.5, locale: 'de-DE', reducedMotion: 'reduce' });

  for (const [width, height] of [[1280, 800], [1600, 900], [1920, 1080], [3840, 2160]] as const) {
    tagged(`keeps the banner, panel header and composer reachable at ${width}×${height}`, { tag: '@modern' }, async ({ page }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height });
      await germanProjectWithBanner(page, false);
      await page.getByTestId('modern-bottom-ornament').getByRole('radio', { name: 'Bilder', exact: true }).click();
      await page.getByTestId('modern-binder-bar').getByRole('button', { name: 'Binder', exact: true }).click();
      await page.getByTestId('modern-sidebar').locator('.modern-sidebar-pin').click();
      await page.keyboard.press('ControlOrMeta+j');
      const panel = page.locator('#modern-companion');
      await expect(panel.locator('.agent-foot')).toBeVisible();

      const bounds = await page.evaluate(() => {
        const box = (selector: string): DOMRect => {
          const element = document.querySelector(selector);
          if (element === null) throw new Error(`Missing ${selector}`);
          return element.getBoundingClientRect();
        };
        const agent = box('#modern-companion');
        const footer = box('.agent-foot');
        const form = box('.agent-foot .agent-intent');
        const nav = box('.modern-ornament.is-bottom');
        const navChildren = [...document.querySelectorAll('.modern-ornament.is-bottom .modern-capsule')];
        const title = document.querySelector('.modern-title-name');
        const banner = box('[data-testid="storage-banner"]');
        return {
          bannerClear: banner.left >= box('.modern-sidebar').right && (banner.right <= agent.left || banner.bottom <= agent.top),
          titleFits: title !== null && title.scrollWidth <= title.clientWidth + 1,
          footerInside: form.top >= footer.top && form.bottom <= footer.bottom && footer.bottom <= agent.bottom,
          noNavOverlap: (agent.left >= nav.right || agent.bottom <= nav.top)
            && navChildren.every((control) => control.getBoundingClientRect().right <= nav.right),
          chatWidth: agent.width,
          transcriptHeight: box('.agent-body').height,
          pageWidth: box('.modern-page').width,
        };
      });
      expect(bounds).toMatchObject({ bannerClear: true, titleFits: true, footerInside: true, noNavOverlap: true });
      expect(bounds.transcriptHeight).toBeGreaterThan(160);
      if (width === 3840) {
        expect(bounds.chatWidth).toBeGreaterThan(700);
        expect(bounds.pageWidth).toBeGreaterThan(1500);
      }

      const close = panel.getByTestId('agent-close');
      const headerPosition = await close.boundingBox();
      await panel.locator('.agent-body').evaluate((body) => { body.scrollTop = body.scrollHeight; });
      expect(await close.boundingBox()).toEqual(headerPosition);
      if (width === 1280) {
        await panel.getByRole('button', { name: 'Ziel', exact: true }).click();
        const back = panel.getByRole('button', { name: 'Zur Einzelrunde' });
        await expect(back).toBeInViewport();
        const backPosition = await back.boundingBox();
        await panel.locator('.goal-composer-fields').evaluate((fields) => { fields.scrollTop = fields.scrollHeight; });
        expect(await back.boundingBox()).toEqual(backPosition);
        await back.click();
        await expect(panel.locator('.agent-foot')).toBeVisible();
      }
      await close.click();
      await expect(panel).toBeHidden();
    });
  }
});
