import { expect, test } from '@playwright/test';

/**
 * Settings › Agent (agent-harness §3): "Load every tool on every request" is off until the writer turns it on, and what they chose
 * is still chosen after a reload. It is an app setting, so it needs no project.
 */

test('the Agent section offers Load every tool on every request, off by default, and keeps it after a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();

  const toggle = settings.getByRole('checkbox', { name: 'Load every tool on every request' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(settings.getByText('Saved. It applies to the agent’s next request.')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings').getByRole('button', { name: 'Agent', exact: true }).click();
  const again = page.getByTestId('settings').getByRole('checkbox', { name: 'Load every tool on every request' });
  await expect(again).toBeChecked();

  await again.uncheck();
  await expect(page.getByTestId('settings').getByText('Saved. It applies to the agent’s next request.')).toBeVisible();
});
