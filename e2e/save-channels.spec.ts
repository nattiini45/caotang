import { expect, test } from '@playwright/test';

import { createProject, waitForSaved } from './support.js';
import { installSaveRefusals, makeFailingDocument, makeFailingSettings, makeFailingTask, openSaveSettings, refuseSave } from './save-channel-fixture.js';

test.beforeEach(async ({ page }) => installSaveRefusals(page));

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: a failed save capsule survives modal ownership`, async ({ page }) => {
    await page.addInitScript((chosen) => localStorage.setItem('caotang.interface', chosen), shell);
    await createProject(page, 'A save under a modal');
    await makeFailingSettings(page);
    const indicator = page.getByTestId('save-state');
    await openSaveSettings(page);
    await expect(page.getByTestId('settings')).toHaveAttribute('data-modal-state', 'top');
    await expect(indicator).toHaveAttribute('data-state', 'failed');
    await expect(indicator).toContainText('Not saved: Settings');
    if (shell === 'modern') {
      await expect(page.getByTestId('modern-notices')).toHaveAttribute('data-state', 'covered');
      await expect(page.getByTestId('modern-notices')).toHaveAttribute('inert', '');
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('modal-stack')).toHaveAttribute('data-state', 'empty');
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveAttribute('data-state', 'failed');
    await expect(indicator).toContainText('Not saved: Settings');
    if (shell === 'modern') await expect(page.getByTestId('modern-notices')).toHaveAttribute('data-state', 'visible');
  });

  test(`${shell}: a document conflict stays named after an unchanged flush and clears after recovery`, async ({ page }) => {
    await page.addInitScript((chosen) => localStorage.setItem('caotang.interface', chosen), shell);
    await createProject(page, 'Documents waiting to save');
    await makeFailingDocument(page);
    const indicator = page.getByTestId('save-state');
    await expect(indicator).toContainText('Not saved: Documents');
    if (shell === 'modern') await expect(indicator).toHaveAccessibleName(/Copy your unsaved text somewhere safe before reloading\./);
    else await expect(indicator).toContainText('Copy your unsaved text somewhere safe before reloading.');
    await expect(indicator.getByRole('button', { name: 'Export a backup' })).toHaveCount(0);
    await expect(page.getByTestId('stale-tab-notice')).toHaveCount(0);
    const editor = page.getByRole('textbox', { name: 'Document text' });
    await editor.fill('Original saved words.');
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      documentConflictStatus(): { dirty: boolean };
    }).documentConflictStatus().dirty)).toBe(false);
    await expect(indicator).toHaveAttribute('data-state', 'failed');
    await expect(indicator).toContainText('Not saved: Documents');
    await page.evaluate(() => (window as unknown as { releaseDocumentConflict(): void }).releaseDocumentConflict());
    await editor.fill('The resolved words.');
    await waitForSaved(page);
  });
}

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
