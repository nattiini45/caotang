import { expect, test } from '@playwright/test';

import { createProject, waitForSaved } from '../support.js';

for (const kind of ['screenplay', 'dialogue'] as const) {
  test(`Modern document modes: ${kind}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await page.clock.install({ time: new Date('2026-06-01T09:00:00Z') });
    await page.addInitScript(() => (globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }).localStorage.setItem('caotang.interface', 'modern'));
    await createProject(page, 'The Ferry');
    await page.getByTestId('new-menu').click();
    await page.getByTestId(`new-${kind}`).click();
    const bar = page.getByTestId('modern-top-ornament');
    const sourceMode = kind === 'screenplay' ? 'Source' : 'Ink';
    await bar.getByRole('radio', { name: sourceMode, exact: true }).click();
    await page.getByRole('textbox', { name: kind === 'screenplay' ? 'Fountain source' : 'Ink source' }).fill(
      kind === 'screenplay' ? 'INT. FERRY - DAY\n\nThe last passenger waits by the rail.' : '-> start\n=== start ===\nMara: Is this the last ferry?\n* [Stay] -> END\n',
    );
    await waitForSaved(page);
    await bar.getByRole('radio', { name: kind === 'screenplay' ? 'Script' : 'Graph', exact: true }).click();
    const banner = page.getByTestId('storage-banner');
    if (await banner.isVisible()) await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.mouse.move(1300, 450);
    await page.evaluate(() => (globalThis as unknown as { document: { activeElement: { blur?: () => void } | null } }).document.activeElement?.blur?.());
    await expect(page).toHaveScreenshot(`modern-light-glass-document-${kind}.png`, { animations: 'disabled', caret: 'hide', mask: [page.locator('time'), page.getByTestId('save-state')], maxDiffPixels: 0 });
    if (kind === 'screenplay') {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page).toHaveScreenshot('modern-light-glass-document-screenplay-narrow.png', { animations: 'disabled', caret: 'hide', mask: [page.locator('time'), page.getByTestId('save-state')], maxDiffPixels: 0 });
    }
  });
}
