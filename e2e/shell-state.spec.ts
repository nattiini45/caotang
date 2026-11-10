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

test('a failed initial agent download settles instead of staying in starting', async ({ page }) => {
  await page.route('**/src/app/lazy-harness.ts*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: 'throw new Error("fixture harness is unavailable");',
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The turn stopped unexpectedly:' })).toContainText('fixture harness is unavailable');
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-state', 'idle');
});

test('an approval-waiting panel stays working until Stop settles the turn', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Draft the opening scene', exact: true }).click();
  const panel = page.getByTestId('agent-panel');
  await expect(page.getByTestId('plan-card')).toBeVisible();
  await expect(panel).toHaveAttribute('data-state', 'working');
  await panel.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(panel).toHaveAttribute('data-state', 'idle');
});
