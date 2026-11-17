import { expect, test, type Page } from '@playwright/test';

import { createProject, waitForSaved } from './support.js';

const INTENT = 'Keep the changed scenes as they are.';
const RESUME_GOAL = 'g_0000000001';
const DISCARD_GOAL = 'g_0000000002';
const UNREADABLE_GOAL = 'g_0000000003';

async function seedInterruptedGoal(page: Page, goalId: string, options: { readonly costUsd?: number; readonly unresolved?: boolean; readonly status?: 'running' | 'interrupted' } = {}): Promise<void> {
  await page.evaluate(async ({ intent, goalId, costUsd, unresolved, status }) => {
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
        const transaction = db.transaction(['goalRuns', 'agentSessions', 'runs', 'runEvents'], 'readwrite');
        const runId = `${goalId}-iteration`;
        const spend = { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0, costUsd };
        transaction.objectStore('agentSessions').put(conversation);
        transaction.objectStore('goalRuns').put({
          schema: 1,
          goalId,
          projectId,
          sessionId: conversation.sessionId,
          status,
          createdAt: 100,
          updatedAt: 200,
          iterationRunIds: unresolved ? [runId] : [],
          checkpoint: {
            goal: { id: goalId, intent,
              checks: unresolved ? [{ kind: 'status.all', status: 'final', scope: { mode: 'full' } }] : [{ kind: 'synopsis.filled', scope: { mode: 'changed' } }],
              limits: unresolved ? { maxModelCalls: 10, maxTokens: 1_000_000, maxCostUsd: 10, maxActiveMs: 1_000_000 } : { maxModelCalls: 1 },
            },
            iterations: [],
            results: [],
            nextIteration: unresolved ? 1 : 2,
            spend,
          },
        });
        if (unresolved) {
          transaction.objectStore('runs').put({ schema: 3, runId, projectId, kind: 'turn', intent, createdAt: 200, updatedAt: 201, status: 'interrupted' });
          transaction.objectStore('runEvents').put({ runId, t: 'turn.start', v: 3, turnId: 'unresolved-turn', intent, wire: 'planner', native: false, seq: 0, at: 200 });
          transaction.objectStore('runEvents').put({ runId, t: 'spend', turnId: 'unresolved-turn', spend, reservedCalls: 1, seq: 1, at: 201 });
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }, { intent: INTENT, goalId, costUsd: options.costUsd ?? 0, unresolved: options.unresolved ?? false, status: options.status ?? 'interrupted' });
}

async function reloadAndReopen(page: Page): Promise<void> {
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Goal Recovery Book' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' }).or(page.getByTestId('modern-binder-bar')).first()).toBeVisible();
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
});

test('an unreadable goal is discard-only and stays absent after reload', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/chat/completions', (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await createProject(page, 'Goal Recovery Book');
  await seedInterruptedGoal(page, UNREADABLE_GOAL, { costUsd: NaN });
  await reloadAndReopen(page);
  const cards = page.getByTestId('goal-recovery-card');
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

test('recovery explains unrecorded usage and treats its limits as spent without another turn', async ({ page }, testInfo) => {
  const requests: string[] = [];
  await page.route('**/chat/completions', (route) => { requests.push(route.request().url()); return route.abort(); });
  await createProject(page, 'Goal Recovery Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('A scene to finish');
  await page.keyboard.press('Enter');
  await waitForSaved(page);
  await seedInterruptedGoal(page, RESUME_GOAL, { unresolved: true });
  await reloadAndReopen(page);
  const card = page.getByTestId('goal-recovery-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('limits are treated as spent');
  await expect(page.locator('[data-testid="interrupted-runs"]:visible')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Resume the goal' })).toBeEnabled();
  const screenshot = testInfo.outputPath('unrecorded-usage.png');
  await page.getByTestId('goal-recovery').screenshot({ path: screenshot });
  await testInfo.attach('Unrecorded model usage', { path: screenshot, contentType: 'image/png' });
  await card.getByRole('button', { name: 'Resume the goal' }).focus();
  await page.keyboard.press('Enter');
  await expect(card).toHaveAttribute('data-status', 'settled');
  await expect(card).toContainText('budget:');
  await expect(page.locator('.agent-turn')).toHaveCount(0);
  expect(requests).toEqual([]);
});

for (const shell of ['classic', 'modern'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`without Web Locks recovery stays disabled but the project and Discard remain usable (${shell}, ${theme})`, async ({ page }, testInfo) => {
      await page.addInitScript(({ shell, theme }) => {
        localStorage.setItem('caotang.interface', shell);
        localStorage.setItem('caotang.theme', theme);
      }, { shell, theme });
      await createProject(page, 'Goal Recovery Book');
      await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
      await page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }));
      await seedInterruptedGoal(page, RESUME_GOAL, { status: 'running' });
      await reloadAndReopen(page);
      if (shell === 'modern') await page.keyboard.press('Control+j');
      const recovery = page.getByTestId('goal-recovery');
      const card = page.getByTestId('goal-recovery-card');
      await expect(card).toHaveCount(1);
      await expect.poll(async () => (await recovery.boundingBox())?.height ?? 0).toBeGreaterThan(100);
      await expect(card).toHaveAttribute('data-status', 'running');
      await expect(recovery).toContainText('Goal runs need Web Locks');
      const resume = card.getByRole('button', { name: 'Resume the goal' });
      await expect(resume).toBeDisabled();
      await resume.focus();
      await expect(resume).toBeFocused();
      await expect(resume).toHaveAccessibleDescription(/Web Locks/);
      await page.keyboard.press('Enter');
      await expect(card).toHaveAttribute('data-status', 'running');
      await expect(page.locator('.agent-turn')).toHaveCount(0);
      await page.keyboard.press('Space');
      await page.keyboard.press('Tab');
      await expect(card.getByRole('button', { name: 'Discard the goal record' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(resume).toBeFocused();
      await expect(resume).toHaveCSS('opacity', '1');
      await expect(resume).toHaveCSS('cursor', 'not-allowed');
      expect(await resume.evaluate((button) => {
        const enabled = document.createElement('button');
        enabled.className = 'button is-primary';
        button.parentElement!.append(enabled);
        const normal = getComputedStyle(enabled);
        const disabled = getComputedStyle(button);
        const distinct = { fill: disabled.backgroundColor !== normal.backgroundColor, ink: disabled.color !== normal.color };
        enabled.remove();
        return distinct;
      })).toEqual({ fill: true, ink: true });
      const background = await resume.evaluate((button) => getComputedStyle(button).backgroundColor);
      await resume.hover();
      await expect(resume).toHaveCSS('background-color', background);
      await expect(page.getByRole('alert').filter({ hasText: 'Web Locks' })).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 1100 });
      await expect(recovery.getByText('Goal runs need Web Locks', { exact: false })).toBeInViewport({ ratio: 1 });
      await expect(card.getByRole('heading')).toBeInViewport({ ratio: 1 });
      const screenshot = testInfo.outputPath(`web-locks-unavailable-${shell}-${theme}.png`);
      await recovery.screenshot({ path: screenshot });
      await testInfo.attach('Web Locks unavailable', { path: screenshot, contentType: 'image/png' });
      await card.getByRole('button', { name: 'Discard the goal record' }).click();
      await expect(card).toHaveCount(0);
      await reloadAndReopen(page);
      await expect(page.getByTestId('goal-recovery-card')).toHaveCount(0);
    });
  }
}
