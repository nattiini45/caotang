import { expect, test, type Page } from '@playwright/test';

import { createProject } from './support.js';

const INTENT = 'Keep the changed scenes as they are.';
const RESUME_GOAL = 'g_0000000001';
const DISCARD_GOAL = 'g_0000000002';

async function seedInterruptedGoals(page: Page): Promise<void> {
  await page.evaluate(async ({ intent, ids }) => {
    const projectId = (window as unknown as { __caotang: { projectId(): string | null } }).__caotang.projectId();
    if (projectId === null) throw new Error('The project must be open before seeding goal recovery.');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('caotang');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('goalRuns', 'readwrite');
        for (const goalId of ids) transaction.objectStore('goalRuns').put({
          schema: 1,
          goalId,
          projectId,
          sessionId: 'conversation',
          status: 'interrupted',
          createdAt: 100,
          updatedAt: 200,
          iterationRunIds: [],
          checkpoint: {
            goal: { id: goalId, intent, checks: [{ kind: 'synopsis.filled', scope: { mode: 'changed' } }], limits: { maxModelCalls: 1 } },
            iterations: [],
            results: [],
            nextIteration: 2,
            spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 },
          },
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }, { intent: INTENT, ids: [RESUME_GOAL, DISCARD_GOAL] });
}

async function reloadAndReopen(page: Page): Promise<void> {
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Goal Recovery Book' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('a goal a reload left interrupted is offered, never resumes by itself, and can be resumed or discarded', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/chat/completions', (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await createProject(page, 'Goal Recovery Book');
  await seedInterruptedGoals(page);
  await reloadAndReopen(page);

  const cards = page.getByTestId('goal-recovery-card');
  const resumeCard = page.locator(`[data-testid="goal-recovery-card"][data-goal-id="${RESUME_GOAL}"]`);
  const discardCard = page.locator(`[data-testid="goal-recovery-card"][data-goal-id="${DISCARD_GOAL}"]`);
  await expect(cards).toHaveCount(2);
  for (const card of [resumeCard, discardCard]) {
    await expect(card.getByRole('heading', { name: 'A goal run was interrupted' })).toBeVisible();
    await expect(card).toContainText(INTENT);
    await expect(card).toContainText('iteration 2');
    await expect(card).toHaveAttribute('data-status', 'interrupted');
    await expect(card.getByRole('button', { name: 'Resume the goal' })).toBeEnabled();
  }
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await expect(page.locator('.agent-turn')).toHaveCount(0);
  expect(requests).toEqual([]);

  await resumeCard.getByRole('button', { name: 'Resume the goal' }).click();
  await expect(resumeCard).toHaveAttribute('data-status', 'settled');
  await expect(resumeCard).toContainText('passed:');
  await expect(resumeCard.getByRole('button', { name: 'Resume the goal' })).toHaveCount(0);
  await expect(discardCard).toHaveAttribute('data-status', 'interrupted');
  expect(requests).toEqual([]);

  await discardCard.getByRole('button', { name: 'Discard the goal record' }).click();
  await expect(discardCard).toHaveCount(0);
  await reloadAndReopen(page);
  await expect(discardCard).toHaveCount(0);
  await expect(resumeCard).toHaveAttribute('data-status', 'settled');
  await resumeCard.getByRole('button', { name: 'Discard the goal record' }).click();
  await expect(cards).toHaveCount(0);
  expect(requests).toEqual([]);
});
