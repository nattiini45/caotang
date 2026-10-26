import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint as pointAtFakeEndpoint } from './endpoint.js';
import { createProject, projectTrace, waitForSaved } from './support.js';

/**
 * A run a reload cut short (agent-harness §5.1, "Durable runs and resume"). The model is a fake endpoint (endpoint.ts). The run is
 * left waiting on its plan card, the page is reloaded, and the project is opened again: the panel offers the run as a card with
 * Resume and Discard log. Resume is the writer's click, the plan card comes back and needs its own Approve, and nothing is
 * applied twice. Discard log keeps what the run wrote and removes the card.
 */

const TWO_NOTES = {
  steps: [
    { tool: 'notes.append', params: { doc: 'Opening', text: 'First note.' }, expect: 'A first note is added' },
    { tool: 'notes.append', params: { doc: 'Opening', text: 'Second note.' }, expect: 'A second note is added' },
  ],
};

const INTENT = 'Add two notes to Opening.';

async function projectWithScene(page: Page, name: string): Promise<void> {
  await fakeEndpoint(page, planThenAnswer(TWO_NOTES, 'Both notes are in.'));
  await pointAtFakeEndpoint(page);
  await createProject(page, name);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Opening');
  await page.keyboard.press('Enter');
  await waitForSaved(page);
}

/** Opens the agent drawer when it is closed: a new project starts with it shut. */
async function openAgent(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Agent', exact: true });
  if ((await toggle.count()) > 0) await toggle.click();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  await openAgent(page);
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Reloads the page mid-plan and opens the project again. */
async function reloadAndReopen(page: Page, name: string): Promise<void> {
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('a run reloaded on its plan card is offered back, and resuming shows the card again for its own approval', async ({ page }) => {
  await projectWithScene(page, 'Resume Book');
  await sendIntent(page, INTENT);
  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();

  await reloadAndReopen(page, 'Resume Book');

  // The card is a region with real buttons, and says what happened in words.
  const interrupted = page.getByTestId('interrupted-run');
  await expect(interrupted).toBeVisible();
  await expect(interrupted.getByRole('heading', { name: 'An agent run was interrupted' })).toBeVisible();
  await expect(page.getByTestId('interrupted-progress')).toContainText(`“${INTENT}”: 0 of 2 steps applied`);
  await expect(interrupted).toContainText('The model call that was in flight when the page closed was lost, and its cost counts as spent.');
  // Nothing started by itself: no plan card, no write.
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  expect(await projectTrace(page)).not.toContain('notes.append');

  await interrupted.getByRole('button', { name: 'Resume' }).click();
  // The plan comes back needing its own Approve; the click on Resume did not apply it.
  await expect(card.getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve plan', exact: true })).toBeEnabled();
  expect(await projectTrace(page)).not.toContain('notes.append');

  await card.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  expect((await projectTrace(page)).filter((name) => name === 'notes.append')).toEqual(['notes.append', 'notes.append']);
  await waitForSaved(page);
  // The run is finished: the card is gone.
  await expect(page.getByTestId('interrupted-run')).toHaveCount(0);
});

test('Discard log removes the card and keeps the project as it is', async ({ page }) => {
  await projectWithScene(page, 'Discard Book');
  await sendIntent(page, INTENT);
  await expect(page.getByTestId('plan-card').getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();

  await reloadAndReopen(page, 'Discard Book');
  const interrupted = page.getByTestId('interrupted-run');
  await expect(interrupted).toBeVisible();
  await interrupted.getByRole('button', { name: 'Discard log' }).click();
  await expect(page.getByTestId('interrupted-run')).toHaveCount(0);
  await expect(page.getByTestId('agent-announcement')).toContainText('Run log discarded. What the agent wrote stays in the project.');
  expect(await projectTrace(page)).not.toContain('notes.append');

  // A reload finds nothing to offer.
  await reloadAndReopen(page, 'Discard Book');
  await expect(page.getByTestId('interrupted-run')).toHaveCount(0);
});
