import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';

/**
 * Restoring the project to before one step of a turn (agent-harness §5, command-bus §5). A plan sets three statuses; the second
 * step's menu takes back that step and the third and keeps the first. The endpoint is a fake (endpoint.ts); the card, the menu, the
 * dialog and the undo are the app's own.
 */

const INTENT = 'Set three statuses.';

const PLAN = {
  steps: [
    { tool: 'meta.set', params: { targets: ['The Landing'], status: 'draft' }, expect: 'The Landing is a draft' },
    { tool: 'meta.set', params: { targets: ['The Storm'], status: 'revised' }, expect: 'The Storm is revised' },
    { tool: 'meta.set', params: { targets: ['The Friend'], status: 'final' }, expect: 'The Friend is final' },
  ],
};

test.beforeEach(async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer(PLAN, 'Three statuses are set.'));
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
});

async function runTurn(page: Page): Promise<void> {
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(INTENT);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByTestId('plan-card').getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(page.locator('.agent-turn', { hasText: INTENT }).getByTestId('checkpoint')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /The Friend/ })).toContainText(/final/i);
}

const turn = (page: Page) => page.locator('.agent-turn', { hasText: INTENT });

/** The step menus of the turn, once its folded list of calls is open. */
async function stepMenus(page: Page) {
  const folded = turn(page).locator('.status-group > summary');
  if (await folded.count() > 0) await folded.click();
  return turn(page).getByTestId('step-menu');
}

test('restoring to before step 2 keeps step 1 and takes back steps 2 and 3', async ({ page }) => {
  await runTurn(page);
  const menus = await stepMenus(page);
  await expect(menus).toHaveCount(3);

  await menus.nth(1).getByRole('button', { name: /^Rewind options for step/ }).click();
  await page.getByRole('button', { name: /^Restore project to before this step/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore to before this step?' });
  await expect(dialog).toContainText('The steps before it stay.');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Restored to before that step.' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /The Landing/ })).toContainText(/draft/i);
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).not.toContainText(/revised/i);
  await expect(page.getByRole('treeitem', { name: /The Friend/ })).not.toContainText(/final/i);
  await expect(turn(page).getByTestId('partial-restore')).toContainText('Restored from step 2');
  // The turn's checkpoint still stands for step 1, and only that step can be restored now.
  await expect(turn(page).getByTestId('checkpoint').getByRole('button', { name: 'Restore to before this turn' })).toBeVisible();
  await expect(turn(page).getByTestId('step-menu')).toHaveCount(1);
});

test('the whole turn can still be restored after a step restore, and the first step goes too', async ({ page }) => {
  await runTurn(page);
  const menus = await stepMenus(page);
  await menus.nth(2).getByRole('button', { name: /^Rewind options for step/ }).click();
  await page.getByRole('button', { name: /^Restore project to before this step/ }).click();
  await page.getByRole('dialog', { name: 'Restore to before this step?' }).getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: /The Friend/ })).not.toContainText(/final/i);
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).toContainText(/revised/i);

  await turn(page).getByTestId('checkpoint').getByRole('button', { name: 'Restore to before this turn' }).click();
  await page.getByRole('dialog', { name: 'Restore to before this turn?' }).getByRole('button', { name: 'Restore', exact: true }).click();

  await expect(page.getByRole('treeitem', { name: /The Landing/ })).not.toContainText(/draft/i);
  await expect(page.getByRole('treeitem', { name: /The Storm/ })).not.toContainText(/revised/i);
  await expect(turn(page).getByTestId('checkpoint')).toContainText('Taken back');
});
