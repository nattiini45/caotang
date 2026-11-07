import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from '../classic-pin.js';
import { waitForSaved } from '../support.js';

/**
 * The agent's companion window (M8, #309; modern-interface.md §15.4): open beside the page at 1,440 by 900 and as a sheet at 1,280 by
 * 800, light and dark, glass and reduced transparency. Like modern.spec.ts, these run only in the `visual` project in CI's pinned
 * image, with time fixed and masked, animations off (reduced motion) and the caret hidden.
 */

// A missing step fails in 15 s instead of holding the job until it is cancelled (#307's finisher).
test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

const NOW = new Date('2026-06-01T09:00:00Z');

type Scheme = 'light' | 'dark';

function masks(page: Page): Locator[] {
  return [page.locator('time'), page.getByTestId('save-state')];
}

/**
 * Opens the binder before the empty manuscript's **Create Chapter 1**. Once #307's sidebar is in, the binder sits in a sidebar that is
 * closed and inert until Manuscript in the tab bar opens it; before that it is on the page, and this does nothing.
 */
async function openBinder(page: Page): Promise<void> {
  // Keyed on #307's tab bar itself: a navigation named "Binder" exists before it too (the binder's own), without Manuscript.
  if ((await page.getByTestId('modern-binder-bar').count()) === 0) return;
  await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
}

/** Lets #307's sidebar close as the pointer leaves it, so the page and the window are not behind it. Nothing without the sidebar. */
async function leaveBinder(page: Page): Promise<void> {
  const binder = page.getByTestId('modern-binder');
  if ((await binder.count()) === 0) return;
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.mouse.move(size.width - 60, Math.round(size.height / 2));
  await expect(binder).toHaveAttribute('data-state', 'closed');
}

async function start(page: Page, scheme: Scheme, solid: boolean): Promise<void> {
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
  await openBinder(page);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
  const banner = page.getByTestId('storage-banner');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
  await leaveBinder(page);
  // The pointer off every control (it was left on New document), so no hover state is in the picture: the beside shots differed
  // between attempts by the binder buttons' hover border.
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.mouse.move(Math.round(size.width / 2), size.height - 8);
  // The window, opened with its chord, with the panel drawn.
  await page.keyboard.press('ControlOrMeta+j');
  const pane = page.getByRole('complementary', { name: 'Agent' });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
  // Nothing focused, so no ring is in the picture.
  await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?: () => void } | null } }).document.activeElement?.blur?.());
}

for (const [width, height, place] of [
  [1440, 900, 'beside'],
  [1280, 800, 'sheet'],
] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const solid of [false, true]) {
      const name = `modern-${scheme}-${solid ? 'solid' : 'glass'}-companion-${place}`;
      test(`Modern's agent window ${place} the page, ${scheme}, ${solid ? 'reduced transparency' : 'glass'}`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.setViewportSize({ width, height });
        await start(page, scheme, solid);
        await expect(page).toHaveScreenshot(`${name}.png`, { animations: 'disabled', caret: 'hide', mask: masks(page), maxDiffPixels: 0 });
      });
    }
  }
}
