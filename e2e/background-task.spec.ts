import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { binderTitle, createProject, idOf, projectTrace, waitForSaved } from './support.js';

/**
 * A big plan sent to the background (agent-harness §2, "Background runs"), as a writer meets it: the offer before anything is
 * drafted, the Background tasks section, the writer going on typing while the task drafts, and the review that applies it. The model
 * is a fake endpoint (endpoint.ts); the queue, the offer and the review are the app's own.
 */

const SCENES = ['Scene one', 'Scene two', 'Scene three', 'Scene four', 'Scene five'];
const INTENT = 'Write the synopses of all five scenes.';

async function nameIt(page: Page, title: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Rename Untitled' });
  await expect(field).toBeFocused();
  await field.fill(title);
  await page.keyboard.press('Enter');
}

/** A chapter, from the binder's own New folder button. */
async function newChapter(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder' }).click();
  await nameIt(page, title);
  await expect(binderTitle(page, title)).toBeVisible();
}

/** A scene in the selected chapter, from the binder's New document button; its text is typed in the editor. */
async function newScene(page: Page, title: string, text: string): Promise<void> {
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await nameIt(page, title);
  await page.getByRole('textbox', { name: 'Document text' }).fill(text);
  await waitForSaved(page);
}

async function openAgent(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Intent' })).toBeEnabled();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Intent' }).fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('a five-call plan goes to the background while the writer keeps typing, and the ready task is reviewed and applied', async ({ page }) => {
  const plan = { steps: [{ tool: 'synopsis.fill', params: { docs: SCENES, source: 'text', max_words: 20 }, expect: 'Every scene has a synopsis' }] };
  await fakeEndpoint(page, planThenAnswer(plan, 'Done.', 'A synopsis drafted in the background.'));
  await useFakeEndpoint(page);
  await createProject(page, 'Background Book');
  await newChapter(page, 'Act one');
  for (const title of SCENES) await newScene(page, title, `${title} has some text.`);
  await openAgent(page);

  await sendIntent(page, INTENT);

  // The offer comes before any draft: it names the calls, and offers the three answers.
  const offer = page.getByTestId('plan-offer');
  await expect(offer).toContainText('This plan needs 5 model calls');
  await expect(offer.getByRole('button', { name: 'Run now' })).toBeVisible();
  await expect(offer.getByRole('button', { name: 'Cancel' })).toBeVisible();
  expect(await projectTrace(page)).not.toContain('binder.setSynopsis');
  await offer.getByRole('button', { name: 'Run in background' }).click();

  // The turn is over at once, and the Intent box is free for the next message.
  await expect(page.getByText('Queued in the background: 5 model calls. Results appear in Tasks when ready.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Intent' })).toBeEnabled();
  await expect(page.getByTestId('agent-stop')).toHaveCount(0);

  // The writer keeps typing while the task drafts, and the task does not touch the project.
  await binderTitle(page, 'Scene one').click();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Scene one has new text, typed while the task ran.');
  const tasks = page.getByTestId('background-tasks');
  await expect(tasks.getByTestId('task-status')).toContainText('Ready to review');
  expect(await projectTrace(page)).not.toContain('binder.setSynopsis');

  // Scene one changed after it was drafted, so the row says one draft is out of date.
  await expect(tasks.getByTestId('task-status')).toContainText('1 out of date');
  await expect(tasks).toContainText('5 / 5 drafted');
  await expect(tasks).toContainText('5 of 5 model calls');

  // Review opens the usual card; the changed scene's step cannot be approved, so the writer retries the draft against the current text.
  await tasks.getByRole('button', { name: /^Review/ }).click();
  const planCard = page.getByTestId('plan-card');
  await expect(planCard).toBeVisible();
  await expect(planCard.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  await planCard.getByRole('button', { name: 'Retry draft' }).click();
  await expect(planCard.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await planCard.getByRole('button', { name: 'Approve', exact: true }).click();

  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await expect(tasks.getByTestId('task-status')).toHaveText('Applied');
  const trace = await projectTrace(page);
  expect(trace.filter((name) => name === 'binder.setSynopsis')).toHaveLength(5);
  const id = await idOf(page, 'Scene two');
  expect(id).toMatch(/^n_/);
});

test('Run now on the offer drafts in the turn as before, and Cancel drafts nothing', async ({ page }) => {
  const plan = { steps: [{ tool: 'synopsis.fill', params: { docs: SCENES, source: 'text', max_words: 20 }, expect: 'Every scene has a synopsis' }] };
  await fakeEndpoint(page, planThenAnswer(plan, 'Done.', 'A synopsis drafted now.'));
  await useFakeEndpoint(page);
  await createProject(page, 'Offer Book');
  await newChapter(page, 'Act one');
  for (const title of SCENES) await newScene(page, title, `${title} has some text.`);
  await openAgent(page);

  await sendIntent(page, INTENT);
  await page.getByTestId('plan-offer').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('plan-offer')).toHaveCount(0);
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  expect(await projectTrace(page)).not.toContain('binder.setSynopsis');

  await sendIntent(page, INTENT);
  await page.getByTestId('plan-offer').getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByTestId('plan-card')).toBeVisible();
  // Run now stages in the turn, which is held to its own limit of eight model calls: the five are within it.
  await expect(page.getByTestId('plan-card').getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  await expect(page.getByTestId('background-tasks')).toHaveCount(0);
});
