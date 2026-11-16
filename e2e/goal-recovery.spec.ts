import { expect, test, type Page } from '@playwright/test';

import { createProject } from './support.js';

/**
 * A goal a reload left behind (agent-harness §7.2). A goal record is seeded as interrupted in the runtime database — the app has no
 * goal-start surface yet (H5i), so the record is the only way to reach the card — and the project is opened again. The card must
 * show, nothing may run by itself, Resume may only act on the click, and Discard must remove the record for good.
 */

const INTENT = 'Make the opening scene name the harbour.';

const GOAL = 'gol_0000000001';

/**
 * Seeds one interrupted goal row for the project the app currently has open, reading the project and session ids from the runtime
 * database the app itself just wrote.
 */
async function seedInterruptedGoal(page: Page): Promise<void> {
  const seeded = await page.evaluate(async (goalId: string) => {
    const open = (): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('caotang');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await open();
    const readAll = <T,>(store: string): Promise<T[]> =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      });
    const sessions = await readAll<{ projectId: string; sessionId?: string; id?: string }>('agentSessions');
    const last = sessions.at(-1);
    if (last === undefined) return null;
    const projectId = last.projectId;
    const sessionId = last.sessionId ?? last.id ?? '';
    if (projectId === '' || sessionId === '') return null;
    const now = Date.now();
    const row = {
      schema: 1,
      goalId,
      projectId,
      sessionId,
      status: 'interrupted',
      createdAt: now,
      updatedAt: now,
      iterationRunIds: [],
      checkpoint: {
        goal: { id: goalId, intent: 'Make the opening scene name the harbour.', checks: [] },
        iterations: [],
        results: [],
        nextIteration: 2,
        spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 },
      },
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('goalRuns', 'readwrite');
      transaction.objectStore('goalRuns').put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    return projectId;
  }, GOAL);
  expect(seeded, 'the agent panel saved a session for this project').not.toBeNull();
}

/** Opens the agent drawer when it is closed: a new project starts with it shut. */
async function openAgent(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Agent', exact: true });
  if ((await toggle.count()) > 0) await toggle.click();
}

async function reloadAndReopen(page: Page, name: string): Promise<void> {
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('a goal a reload left interrupted is offered, never resumes by itself, and can be resumed or discarded', async ({ page }) => {
  await createProject(page, 'Goal Recovery Book');
  await openAgent(page);
  await expect(page.getByRole('combobox', { name: 'Intent' })).toBeVisible();
  await seedInterruptedGoal(page);

  await reloadAndReopen(page, 'Goal Recovery Book');

  const card = page.getByTestId('goal-recovery-card');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'A goal run was interrupted' })).toBeVisible();
  await expect(card).toContainText(INTENT);
  await expect(card).toHaveAttribute('data-status', 'interrupted');
  // It did not continue on its own: no plan card, no turn, and the card still says it waits.
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Resume the goal' })).toBeEnabled();

  // Resume is the writer's click and nothing else; whatever the run then does, the card leaves the untouched interrupted state.
  await card.getByRole('button', { name: 'Resume the goal' }).click();
  await expect(page.getByTestId('agent-announcement')).not.toBeEmpty();
  await expect(page.getByTestId('goal-recovery-card')).not.toHaveAttribute('data-status', 'interrupted');

  // Discard removes the record, and a reload finds nothing left to offer.
  const after = page.getByTestId('goal-recovery-card');
  if ((await after.count()) > 0) await after.getByRole('button', { name: 'Discard the goal record' }).click();
  await expect(page.getByTestId('goal-recovery-card')).toHaveCount(0);
  await reloadAndReopen(page, 'Goal Recovery Book');
  await expect(page.getByTestId('goal-recovery-card')).toHaveCount(0);
  await expect(page.getByTestId('interrupted-run')).toHaveCount(0);
});