import { expect, test } from '@playwright/test';

import { createProject, waitForSaved } from './support.js';
import { installSaveRefusals, makeFailingSettings, makeFailingTask, refuseSave } from './save-channel-fixture.js';

test.beforeEach(async ({ page }) => installSaveRefusals(page));

test('a refused task write cannot satisfy the saved-state helper', async ({ page }) => {
  await createProject(page, 'Tasks waiting to save');
  await makeFailingTask(page);
  const indicator = page.getByTestId('save-state');
  await expect(indicator).toContainText('Not saved: Tasks.');
  const waited = waitForSaved(page);
  await expect(indicator).not.toHaveAttribute('data-state', 'saved');
  await refuseSave(page, 'tasks', false);
  await page.getByRole('form', { name: 'New task' }).getByRole('button', { name: 'Save task' }).click();
  await waited;
  await expect(page.getByTestId('recurring-tasks')).toContainText('Read the opening');
});

test('a refused settings write names settings and clears after retry', async ({ page }) => {
  await createProject(page, 'Settings waiting to save');
  await makeFailingSettings(page);
  await expect(page.getByTestId('save-state')).toContainText('Not saved: Settings.');
  await refuseSave(page, 'settings', false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Writing', exact: true }).click();
  await settings.getByLabel('Daily target, in words (0 for none)').fill('2345');
  await settings.getByRole('button', { name: 'Save writing settings' }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await waitForSaved(page);
});
