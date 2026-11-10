import { expect, test } from '@playwright/test';

import { createProject } from '../support.js';
import { installSaveRefusals, makeFailingSettings, makeFailingTask } from '../save-channel-fixture.js';

for (const shell of ['classic', 'modern'] as const) {
 for (const channel of ['tasks', 'settings'] as const) {
  test(`${shell} names a failed ${channel} save`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await page.addInitScript((chosen) => localStorage.setItem('caotang.interface', chosen), shell);
    await installSaveRefusals(page);
    await createProject(page, 'The Lighthouse Keeper');
    if (channel === 'tasks') await makeFailingTask(page);
    else await makeFailingSettings(page);
    const indicator = page.getByTestId('save-state');
    await expect(indicator).toHaveScreenshot(`save-${channel}-${shell}.png`, { animations: 'disabled', maxDiffPixels: 0 });
  });
 }
}
