import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, useFakeEndpoint, type FakeReply } from './endpoint.js';
import { binderTitle, createProject, waitForSaved } from './support.js';

/**
 * Recurring tasks as a writer meets them (agent-harness.md §12): a task made in the agent drawer, a scan that starts by itself when
 * the project opens and makes no model request, a task that is due offered with Run now and Skip even with the drawer closed, and
 * a model task that is only ever offered. The model is a fake endpoint (endpoint.ts), counted; the tasks, the offers and the history
 * are the app's own.
 */

/** The wait for what a project does as it opens, on a machine that is also building the app for other specs. */
const LOADED = 20_000;

async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry was late, as always.');
  await waitForSaved(page);
}

async function openAgent(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByTestId('recurring-tasks')).toBeVisible();
}

async function reopen(page: Page, name: string): Promise<void> {
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

interface NewTask {
  readonly name: string;
  readonly does: 'Ask the agent' | 'Scan for continuity problems';
  readonly ask?: string;
  readonly when: 'Only when I run it' | 'Each time the project opens' | 'Every day' | 'Every week';
  readonly due: 'Offer it to me' | 'Start it by itself';
  readonly from?: string;
  readonly calls?: string;
}

async function makeTask(page: Page, task: NewTask): Promise<void> {
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task name').fill(task.name);
  await form.getByLabel('What it does').selectOption({ label: task.does });
  if (task.ask !== undefined) await form.getByLabel('What to ask').fill(task.ask);
  await form.getByLabel('When', { exact: true }).selectOption({ label: task.when });
  if (task.from !== undefined) await form.getByLabel('From').fill(task.from);
  await form.getByLabel('When it is due').selectOption({ label: task.due });
  if (task.calls !== undefined) await form.getByLabel('Most model calls in a run').fill(task.calls);
  await form.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: task.name })).toBeVisible();
}

/** A fake model that counts the chat requests it is asked for and answers with a plain reply. */
function countingReply(counter: { calls: number }): FakeReply {
  return (request) => {
    counter.calls += 1;
    return request.tools !== undefined ? { text: 'Looked it over.' } : JSON.stringify({ reply: 'Looked it over.' });
  };
}

test('a scan set to start when the project opens runs by itself the next time, and makes no model request', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await createProject(page, 'Scan Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await makeTask(page, { name: 'Open scan', does: 'Scan for continuity problems', when: 'Each time the project opens', due: 'Start it by itself' });

  const row = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Open scan' });
  await expect(row).toContainText('Each time the project opens');
  await expect(row).toContainText('Calls no model');
  // Made this visit, it has not been due: the open that made it is behind it.
  await expect(row.getByText(/Runs on this machine/)).toHaveCount(0);

  await reopen(page, 'Scan Book');
  await openAgent(page);
  const again = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Open scan' });
  // No click started it, and nothing is offered for it.
  await expect(again.getByText('Runs on this machine (1)')).toBeVisible({ timeout: LOADED });
  await expect(page.getByTestId('task-offers').getByRole('group')).toHaveCount(0);
  await again.getByText('Runs on this machine (1)').click();
  await expect(again.getByRole('list', { name: 'Runs of Open scan' })).toContainText('Done');
  await expect(again.getByRole('list', { name: 'Runs of Open scan' })).toContainText('Scan complete');
  await expect(again.getByRole('list', { name: 'Runs of Open scan' })).toContainText('no model calls');
  expect(counter.calls).toBe(0);
});

test('a task that is due is offered with the drawer closed, announced, and Skip keeps it from coming back', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await createProject(page, 'Offer Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await makeTask(page, { name: 'Daily read', does: 'Ask the agent', ask: 'Look over the newest scene.', when: 'Every day', from: '00:00', due: 'Offer it to me' });

  await reopen(page, 'Offer Book');
  // The drawer is closed, and the writer is still offered the task.
  const offers = page.getByTestId('task-offers');
  const offer = offers.getByRole('group', { name: 'Task due: Daily read' });
  await expect(offer).toBeVisible({ timeout: LOADED });
  await expect(offer).toContainText('It uses the model');
  await expect(page.getByTestId('task-announcement')).toHaveText('Task due: Daily read. Run now or Skip.');
  expect(counter.calls).toBe(0);

  // Skip is a button the keyboard reaches.
  await offer.getByRole('button', { name: 'Skip' }).focus();
  await page.keyboard.press('Enter');
  await expect(offer).toHaveCount(0);
  expect(counter.calls).toBe(0);

  await reopen(page, 'Offer Book');
  await expect(page.getByTestId('task-offers').getByRole('group')).toHaveCount(0);
  await openAgent(page);
  const row = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Daily read' });
  await row.getByText('Runs on this machine (1)').click();
  await expect(row.getByRole('list', { name: 'Runs of Daily read' })).toContainText('Skipped');
});

test('Run now on an offered model task is an agent turn in the Background role, recorded with what it used', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await createProject(page, 'Run Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await makeTask(page, { name: 'Daily read', does: 'Ask the agent', ask: 'Look over the newest scene.', when: 'Every day', from: '00:00', due: 'Offer it to me', calls: '3' });
  await expect(page.getByTestId('recurring-tasks')).toContainText('at most 3 model calls');

  await reopen(page, 'Run Book');
  await expect(page.getByTestId('task-offers').getByRole('button', { name: 'Run now' })).toBeVisible({ timeout: LOADED });
  await page.getByTestId('task-offers').getByRole('button', { name: 'Run now' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => counter.calls).toBeGreaterThan(0);

  await openAgent(page);
  const row = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Daily read' });
  await row.getByText('Runs on this machine (1)').click();
  const runs = row.getByRole('list', { name: 'Runs of Daily read' });
  await expect(runs).toContainText('Done');
  await expect(runs).toContainText('model call');
  await expect(page.getByTestId('task-offers').getByRole('group')).toHaveCount(0);
  // The turn is in the drawer like any other.
  await expect(page.getByRole('list', { name: 'Turns' })).toContainText('Look over the newest scene.');
});

test('a model task saved to start by itself is offered instead, and says so', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await createProject(page, 'Consent Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task name').fill('Self-start read');
  await form.getByLabel('What to ask').fill('Look over the newest scene.');
  await form.getByLabel('When', { exact: true }).selectOption({ label: 'Each time the project opens' });
  await form.getByLabel('When it is due').selectOption({ label: 'Start it by itself' });
  await expect(form).toContainText('Starting by itself is not built for tasks that use the model yet');
  // A model task that starts by itself needs its limit on model calls.
  await form.getByRole('button', { name: 'Save task' }).click();
  await expect(form.getByRole('alert')).toContainText('limit on its model calls');
  await form.getByLabel('Most model calls in a run').fill('2');
  await form.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByTestId('recurring-tasks')).toContainText('Starting by itself is not built for tasks that use the model yet');

  await reopen(page, 'Consent Book');
  await expect(page.getByTestId('task-offers').getByRole('group', { name: 'Task due: Self-start read' })).toBeVisible({ timeout: LOADED });
  expect(counter.calls).toBe(0);
});

test('tasks are the writer’s: they are kept in the project, switched off and deleted from the drawer', async ({ page }) => {
  await createProject(page, 'Keep Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await makeTask(page, { name: 'Weekly scan', does: 'Scan for continuity problems', when: 'Only when I run it', due: 'Offer it to me' });
  await reopen(page, 'Keep Book');
  await binderTitle(page, 'Opening').click();
  await openAgent(page);
  const row = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Weekly scan' });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: /^Turn off/ }).click();
  await expect(row).toContainText('(off)');
  await row.getByRole('button', { name: /^Run now/ }).click();
  await expect(row.getByText('Runs on this machine (1)')).toBeVisible();

  await row.getByRole('button', { name: /^Delete/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('recurring-tasks').locator('[data-task]')).toHaveCount(0);
  await expect(page.getByTestId('recurring-tasks')).toContainText('No tasks yet.');
});
