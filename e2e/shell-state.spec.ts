import { expect, test } from '@playwright/test';

import { switchToModern } from './modern-walk.js';
import { createProject, waitForShell } from './support.js';

test('the committed shell waits for Modern’s code before Settings closes and shortcuts run', async ({ page }) => {
  await createProject(page, 'Shell state');
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route('**/src/components/shell/modern/modern-shell.tsx*', async (route) => {
    requested = true;
    await held;
    await route.continue();
  });

  const switched = switchToModern(page);
  try {
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'modern');
    await waitForShell(page, 'classic');
    await expect(page.getByTestId('settings')).toBeVisible();
  } finally {
    release();
  }
  await switched;
  await waitForShell(page, 'modern');
  await expect(page.getByTestId('settings')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Search and commands' })).toBeVisible();
});
