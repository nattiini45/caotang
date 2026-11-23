import { chooseInterfaceLanguage } from '../support.js';
import { expect, test } from '@playwright/test';

import { NO_PIN } from '../classic-pin.js';

test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

for (const shell of ['classic', 'modern'] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${shell} ${scheme}: narrow Settings directional scroll cues`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
      await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
      await page.addInitScript(([chosen, theme]) => {
        localStorage.setItem('caotang.interface', chosen);
        localStorage.setItem('caotang.theme', theme);
      }, [shell, scheme] as const);
      await page.goto('/');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByTestId('settings');
      const body = settings.locator('.settings-body');
      await expect.poll(() => body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(2);
      await body.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
      await expect(body).toHaveAttribute('data-scroll-edges', 'top bottom');
      await page.mouse.move(2, 2);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(page).toHaveScreenshot(`${shell}-${scheme}-settings-scroll-cues.png`, { animations: 'disabled', caret: 'hide', maxDiffPixels: 0 });
    });
  }
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Modern ${scheme}: German sidebar labels and empty manuscript`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
    await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
    await page.addInitScript((theme) => {
      localStorage.setItem('caotang.interface', 'modern');
      localStorage.setItem('caotang.theme', theme);
    }, scheme);
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="appearance"]').click();
    await chooseInterfaceLanguage(page, settings, 'de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await page.keyboard.press('Escape');
    await page.getByLabel('Projektname', { exact: true }).fill('Der Leuchtturmwärter');
    await page.getByRole('button', { name: 'Projekt erstellen', exact: true }).click();
    await page.getByTestId('storage-banner').getByRole('button', { name: 'Zurückweisen', exact: true }).click();
    await page.getByRole('navigation', { name: 'Binder', exact: true }).getByRole('button', { name: 'Binder', exact: true }).click();
    const panel = page.locator('.modern-sidebar-panel');
    await panel.getByRole('heading', { name: 'Das Manuskript ist leer', exact: true }).scrollIntoViewIfNeeded();
    await expect(panel).toHaveAttribute('data-scroll-edges', /top/);
    await page.mouse.move(118, 400);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page).toHaveScreenshot(`modern-${scheme}-german-sidebar-empty.png`, { animations: 'disabled', caret: 'hide', mask: [page.getByTestId('save-state'), page.locator('time')], maxDiffPixels: 0 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Auf Kontinuitätsprobleme prüfen', exact: true }).click();
    // The demo scan on the fixed sample manuscript reports exactly one finding; asserting the digit makes a
    // count change a test failure instead of a screenshot diff (#644).
    await expect(page.getByTestId('modern-binder-findings-count')).toHaveText('1');
    await expect(page.locator('.agent-report-text')).toHaveCount(1);
    await page.locator('.modern-companion .agent-close').click();
    await page.getByRole('navigation', { name: 'Binder', exact: true }).getByRole('button', { name: 'Binder', exact: true }).click();
    await expect(page.getByTestId('modern-sidebar').getByRole('tab')).toHaveCount(4);
    await expect(page.getByTestId('modern-title-dot')).toBeVisible();
    await page.mouse.move(118, 400);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // #644: the title's glyph raster is baked inside the ornament's composited glass layer, and a raster committed at a different
    // subpixel phase sticks. Wait until no animation under the stage is running, the fonts are settled and two more frames are
    // committed before reading the pixels. A forced repaint is deliberately avoided — repainting the glass ornament bakes a
    // different glyph phase.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector('.modern-stage')
              ?.getAnimations({ subtree: true })
              .filter((animation) => animation.playState === 'running').length ?? 0,
        ),
      )
      .toBe(0);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    // The settled phase still follows the display server, not the test: the same tree renders this title at one phase on a
    // development machine and at another in CI, and each phase fails against the other's baseline. So this shot alone compares
    // with a small tolerance — enough for a one-subpixel glyph run inside the glass (836 pixels, 0.08% of 1280×800), far too
    // little to hide a moved control, a different label or a shifted layout, which the geometry probes above already refuse.
    await expect(page).toHaveScreenshot(`modern-${scheme}-german-sidebar-count.png`, { animations: 'disabled', caret: 'hide', mask: [page.getByTestId('save-state'), page.locator('time')], maxDiffPixels: 1_400 });
  });
}
