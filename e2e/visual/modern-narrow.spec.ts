import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from '../classic-pin.js';
import { waitForSaved } from '../support.js';

/**
 * Modern's narrow layout (M11, #312; modern-interface.md §13, §15.4) at 390 by 844: the bare page between the compact capsule and the
 * tab bar, light and dark, glass and reduced transparency; and, on glass, the binder drawer, Scene info's bottom sheet and the agent's
 * full-height sheet. Like modern.spec.ts, these run only in the `visual` project in CI's pinned image, with time fixed and masked,
 * animations off (reduced motion) and the caret hidden.
 */

// A missing step fails in 15 s instead of holding the job until it is cancelled.
test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

const NOW = new Date(Date.UTC(2026, 5, 1, 9, 0, 0));
const PHONE = { width: 390, height: 844 };

type Scheme = 'light' | 'dark';

function masks(page: Page): Locator[] {
  return [page.locator('time'), page.getByTestId('save-state')];
}

/** Nothing focused, so no ring is in the picture. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?: () => void } | null } }).document.activeElement?.blur?.());
}

async function start(page: Page, scheme: Scheme, solid: boolean): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ([chosen, reduce]) => {
      const store = (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage;
      store.setItem('caotang.interface', 'modern');
      store.setItem('caotang.theme', chosen);
      if (reduce) store.setItem('caotang.modern.transparency', 'reduced');
    },
    [scheme, solid] as const,
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill('The Lighthouse Keeper');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  // The binder is in the drawer: its button opens it for the empty manuscript's Create Chapter 1.
  await page.getByTestId('modern-narrow-binder').click();
  await expect(page.getByTestId('modern-drawer')).toHaveAttribute('data-state', 'open');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  // Choosing the scene closes the drawer on the editor.
  await page.getByRole('tree', { name: 'Binder' }).locator('.row-title', { hasText: 'The Landing' }).click();
  await expect(page.getByTestId('modern-drawer')).toHaveAttribute('data-state', 'closed');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
  const banner = page.getByTestId('storage-banner');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
  // The pointer off every control, so no hover state is in the picture.
  await page.mouse.move(Math.round(PHONE.width / 2), Math.round(PHONE.height / 2));
  await blur(page);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const solid of [false, true]) {
    test(`Modern's narrow page at 390 by 844, ${scheme}, ${solid ? 'reduced transparency' : 'glass'}`, async ({ page }) => {
      test.setTimeout(90_000);
      await start(page, scheme, solid);
      await expect(page).toHaveScreenshot(`modern-${scheme}-${solid ? 'solid' : 'glass'}-narrow.png`, {
        animations: 'disabled',
        caret: 'hide',
        mask: masks(page),
        maxDiffPixels: 0,
      });
    });
  }
}

// The narrow layout's three panels, on glass.
for (const scheme of ['light', 'dark'] as const) {
  for (const surface of ['narrow-drawer', 'narrow-scene-info', 'narrow-agent'] as const) {
    test(`Modern's ${surface.replace('narrow-', '').replace('-', ' ')} at 390 by 844, ${scheme}`, async ({ page }) => {
      test.setTimeout(90_000);
      await start(page, scheme, false);
      if (surface === 'narrow-drawer') {
        await page.getByTestId('modern-narrow-binder').click();
        await expect(page.getByTestId('modern-drawer')).toHaveAttribute('data-state', 'open');
      }
      if (surface === 'narrow-scene-info') {
        await page.getByTestId('modern-title-capsule').click();
        await expect(page.getByRole('dialog', { name: 'Scene info' })).toBeVisible();
      }
      if (surface === 'narrow-agent') {
        await page.locator('#modern-ask').click();
        const pane = page.getByRole('complementary', { name: 'Agent' });
        await expect(pane).toBeVisible();
        await expect(pane.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
      }
      await page.mouse.move(2, Math.round(PHONE.height / 2));
      await blur(page);
      await expect(page).toHaveScreenshot(`modern-${scheme}-glass-${surface}.png`, {
        animations: 'disabled',
        caret: 'hide',
        mask: masks(page),
        maxDiffPixels: 0,
      });
    });
  }
}
