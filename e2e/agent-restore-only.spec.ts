import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { bodyOf, idOf, waitForSaved } from './support.js';

/**
 * Restoring an older step and keeping the writer's later edits (command-bus §5, "Independence rule"). A plan changes the status of
 * two scenes and appends a note to one of them; the writer then types into a different scene. The dialog offers "Restore only this
 * step (keep your later edits)" because the typing is elsewhere, and does not when it is in a scene the step touched.
 */

const INTENT = 'Mark two scenes and note one.';

const PLAN = {
  steps: [
    { tool: 'meta.set', params: { targets: ['The Landing'], status: 'draft' }, expect: 'The Landing is a draft' },
    { tool: 'meta.set', params: { targets: ['The Storm'], status: 'revised' }, expect: 'The Storm is revised' },
    { tool: 'notes.append', params: { doc: 'The Storm', text: 'Check the lamp.' }, expect: 'A note is added to The Storm' },
  ],
};

test.beforeEach(async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer(PLAN, 'The scenes are marked.'));
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(INTENT);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByTestId('plan-card').getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(page.locator('.agent-turn', { hasText: INTENT }).getByTestId('checkpoint')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).toContainText(/revised/i);
});

const turn = (page: Page) => page.locator('.agent-turn', { hasText: INTENT });

/** Types at the end of a scene, once it is open, and waits for the typing to be saved. */
async function typeInto(page: Page, title: string, text: string): Promise<void> {
  await page.getByRole('treeitem', { name: new RegExp(title) }).locator('.row-title').click();
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await waitForSaved(page);
}

/** Opens the restore dialog for the second step of the turn. */
async function openStepDialog(page: Page): Promise<void> {
  const folded = turn(page).locator('.status-group > summary');
  if ((await folded.count()) > 0) await folded.click();
  await turn(page).getByTestId('step-menu').nth(1).getByRole('button', { name: /^Rewind options for step/ }).click();
  await page.getByRole('button', { name: /^Restore project to before this step/ }).click();
}

test('restoring an older step keeps the writer’s later typing in another scene', async ({ page }) => {
  await typeInto(page, 'The Friend', ' Typed after the turn.');
  const friend = await idOf(page, 'The Friend');
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toContain('Typed after the turn.');

  await openStepDialog(page);
  const dialog = page.getByRole('dialog', { name: 'Restore to before this step?' });
  await expect(dialog.getByTestId('restore-exact')).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore only this step (keep your later edits)' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Restored to before that step. Your 1 later change was kept.' })).toBeVisible();
  // Step 1 stays, step 2 and 3 are gone, and the typing is still in its scene.
  await expect(page.getByRole('treeitem', { name: /The Landing/ })).toContainText(/draft/i);
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).not.toContainText(/revised/i);
  expect((await bodyOf(page, friend)) ?? '').toContain('Typed after the turn.');
  await expect(turn(page).getByTestId('partial-restore')).toContainText('Restored from step 2');
});

test('typing in a scene the step changed gives the full restore only, and lists the typing it would take back', async ({ page }) => {
  await typeInto(page, 'The Storm', ' Typed into the storm.');
  const storm = await idOf(page, 'The Storm');
  await expect.poll(async () => (await bodyOf(page, storm)) ?? '').toContain('Typed into the storm.');

  await openStepDialog(page);
  const dialog = page.getByRole('dialog', { name: 'Restore to before this step?' });
  await expect(dialog.getByRole('list', { name: 'Later changes' })).toBeVisible();
  // The planner has had its say once the list is read again; the keep-your-edits action never shows.
  await page.waitForTimeout(300);
  await expect(dialog.getByTestId('confirm-alternate')).toHaveCount(0);
  await expect(dialog.getByTestId('restore-exact')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restored to before that step. 1 later change was taken back with it.' })).toBeVisible();
  expect((await bodyOf(page, storm)) ?? '').not.toContain('Typed into the storm.');
});
