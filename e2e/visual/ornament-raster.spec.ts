import { expect, test, type Page } from '@playwright/test';

import { NO_PIN } from '../classic-pin.js';

/**
 * The ornaments sit on the pixel grid, so their text rasterizes the same whichever layer it is painted in (#644).
 *
 * The ornaments are glass, so `backdrop-filter` makes each one a render surface of its own. A text run inside one that sits on a
 * fraction of a pixel has two legal rasters — its exact sub-pixel phase, and the integer-snapped one Chromium paints when the run
 * ends up in a compositing layer of its own — and which of the two a frame commits depends on how that frame's layer tree came
 * out, never on the layout. The German sidebar count snapshot flaked on exactly that: the two rasters are 836 pixels apart in the
 * title alone while the layout is identical, and each run of the job committed one or the other.
 *
 * Two things say it is gone: the ornament and the title's own run start on whole pixels, and the same ornament photographed with
 * the title forced into a layer of its own is the same bytes. The second compares the app with itself, so the guard needs no
 * baseline that a layout change would have to regenerate alongside it.
 */
test.use({ storageState: NO_PIN, actionTimeout: 15_000 });

test('the ornament rasterizes the same with and without its own compositing layer', async ({ page }) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
  await page.addInitScript(() => {
    localStorage.setItem('caotang.interface', 'modern');
    localStorage.setItem('caotang.theme', 'dark');
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('The Lighthouse Keeper');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  const banner = page.getByTestId('storage-banner');
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toBeHidden();
  await page.mouse.move(1300, 450);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
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

  const options: Parameters<Page['screenshot']>[0] = {
    animations: 'disabled',
    caret: 'hide',
    mask: [page.getByTestId('save-state'), page.locator('time')],
  };
  const shot = async (): Promise<Buffer> => {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    return page.screenshot(options);
  };
  // `translateZ(0)` is Chromium's own switch for "paint this in a layer of its own"; it moves nothing.
  const paintInOwnLayer = (on: boolean): Promise<void> =>
    page.evaluate((separately) => {
      const run = document.querySelector<HTMLElement>('.modern-title-name');
      run?.style.removeProperty('transform');
      if (separately) run?.style.setProperty('transform', 'translateZ(0)', 'important');
    }, on);

  for (const selector of ['.modern-ornament.is-top', '.modern-title-name']) {
    const x = await page.locator(selector).evaluate((element) => element.getBoundingClientRect().x);
    expect(Number.isInteger(x), `${selector} starts on whole pixel ${x}`).toBe(true);
  }

  const plain = await shot();
  await paintInOwnLayer(true);
  const composited = await shot();
  await paintInOwnLayer(false);
  expect(composited.equals(plain), 'the title painted in a compositing layer of its own').toBe(true);
});
