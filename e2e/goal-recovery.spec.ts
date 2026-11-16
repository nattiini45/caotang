import { expect, test, type Page } from '@playwright/test';

import { createProject } from './support.js';

const INTENT = 'Keep the changed scenes as they are.';
const RESUME_GOAL = 'g_0000000001';
const DISCARD_GOAL = 'g_0000000002';
const UNREADABLE_GOAL = 'g_0000000003';

async function seedInterruptedGoal(page: Page, goalId: string, costUsd = 0): Promise<void> {
  await page.evaluate(async ({ intent, goalId, costUsd }) => {
    const projectId = (window as unknown as { __caotang: { projectId(): string | null } }).__caotang.projectId();
    if (projectId === null) throw new Error('The project must be open before seeding goal recovery.');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('caotang');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const sessions = await new Promise<{ projectId: string; sessionId: string }[]>((resolve, reject) => {
        const request = db.transaction('agentSessions', 'readonly').objectStore('agentSessions').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const conversation = sessions.find((session) => session.projectId === projectId) ?? {
        projectId, sessionId: 'goal-conversation', formatVersion: 1, title: 'Goal recovery', createdAt: 100, updatedAt: 200, active: true, turns: [],
      };
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['goalRuns', 'agentSessions'], 'readwrite');
        transaction.objectStore('agentSessions').put(conversation);
        transaction.objectStore('goalRuns').put({
          schema: 1,
          goalId,
          projectId,
          sessionId: conversation.sessionId,
          status: 'interrupted',
          createdAt: 100,
          updatedAt: 200,
          iterationRunIds: [],
          checkpoint: {
            goal: { id: goalId, intent, checks: [{ kind: 'synopsis.filled', scope: { mode: 'changed' } }], limits: { maxModelCalls: 1 } },
            iterations: [],
            results: [],
            nextIteration: 2,
            spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0, costUsd },
          },
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }, { intent: INTENT, goalId, costUsd });
}

async function reloadAndReopen(page: Page): Promise<void> {
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Goal Recovery Book' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('a goal a reload left interrupted is offered, never resumes by itself, and can be resumed or discarded', async ({ page }, testInfo) => {
  const requests: string[] = [];
  await page.route('**/chat/completions', (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await createProject(page, 'Goal Recovery Book');
  await seedInterruptedGoal(page, RESUME_GOAL);
  await reloadAndReopen(page);

  const cards = page.getByTestId('goal-recovery-card');
  const resumeCard = page.locator(`[data-testid="goal-recovery-card"][data-goal-id="${RESUME_GOAL}"]`);
  const discardCard = page.locator(`[data-testid="goal-recovery-card"][data-goal-id="${DISCARD_GOAL}"]`);
  await expect(cards).toHaveCount(1);
  await expect(resumeCard).toHaveCount(1);
  await expect(discardCard).toHaveCount(0);
  await expect(resumeCard.getByRole('heading', { name: 'A goal run was interrupted' })).toBeVisible();
  await expect(resumeCard).toContainText(INTENT);
  await expect(resumeCard).toContainText('iteration 2');
  await expect(resumeCard).toHaveAttribute('data-status', 'interrupted');
  await expect(resumeCard.getByRole('button', { name: 'Resume the goal' })).toBeEnabled();
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await expect(page.locator('.agent-turn')).toHaveCount(0);
  expect(requests).toEqual([]);
  const screenshot = testInfo.outputPath('goal-recovery.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('Interrupted goal', { path: screenshot, contentType: 'image/png' });

  await resumeCard.getByRole('button', { name: 'Resume the goal' }).focus();
  await page.keyboard.press('Enter');
  await expect(resumeCard).toHaveAttribute('data-status', 'settled');
  await expect(resumeCard).toContainText('passed:');
  await expect(resumeCard.getByRole('button', { name: 'Resume the goal' })).toHaveCount(0);
  expect(requests).toEqual([]);
  await reloadAndReopen(page);
  await expect(cards).toHaveCount(1);
  await expect(resumeCard).toHaveAttribute('data-status', 'settled');
  await resumeCard.getByRole('button', { name: 'Discard the goal record' }).click();
  await expect(cards).toHaveCount(0);

  await seedInterruptedGoal(page, DISCARD_GOAL);
  await reloadAndReopen(page);
  await expect(cards).toHaveCount(1);
  await expect(discardCard).toHaveCount(1);
  await expect(discardCard).toHaveAttribute('data-status', 'interrupted');
  await expect(resumeCard).toHaveCount(0);

  await discardCard.getByRole('button', { name: 'Discard the goal record' }).focus();
  await page.keyboard.press('Space');
  await expect(discardCard).toHaveCount(0);
  await reloadAndReopen(page);
  await expect(discardCard).toHaveCount(0);
  await expect(cards).toHaveCount(0);
  expect(requests).toEqual([]);

  await seedInterruptedGoal(page, UNREADABLE_GOAL, NaN);
  await reloadAndReopen(page);
  const unreadableCard = page.locator(`[data-testid="goal-recovery-card"][data-goal-id="${UNREADABLE_GOAL}"]`);
  await expect(cards).toHaveCount(1);
  await expect(unreadableCard).toHaveCount(1);
  await expect(unreadableCard).toContainText('saved progress cannot be read by this version');
  await expect(unreadableCard.getByRole('button', { name: 'Resume the goal' })).toHaveCount(0);
  await unreadableCard.getByRole('button', { name: 'Discard the goal record' }).focus();
  await page.keyboard.press('Enter');
  await expect(cards).toHaveCount(0);
  await reloadAndReopen(page);
  await expect(cards).toHaveCount(0);
  await expect(page.locator('.agent-turn')).toHaveCount(0);
  expect(requests).toEqual([]);
});
