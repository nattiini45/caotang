import { expect, test, type Page } from '@playwright/test';

import { FAKE_ENDPOINT, endpointRoute, fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { idOf, projectTrace } from './support.js';

/**
 * What a plan card shows before the writer approves it (agent-harness §2, §3): the synopses a batch writes, the codex entry a
 * write creates, and the tree a restructure changes. Each is checked in the rendered card, before Approve is clicked, and the
 * project is checked to be untouched at that point. The sample project is opened by the first-run card's read-only demo; the
 * demo synopsis runs on the built-in demo profile, and the codex and restructure plans come from the fake endpoint.
 */

const FRIEND_PROSE = 'The ferry came in on the evening tide, low in the water and slow to answer the rope.';

/** The sample project, opened by the first-run card's read-only demo. */
async function openSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

/** An intent sent from the agent panel, to the active provider. */
async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('the synopsis the demo batch will write is in the plan card before Approve is clicked, and nothing is written yet', async ({ page }) => {
  // The first-run card offers the demo intents, and a choice opens the sample and runs it. The agent panel's own choices are gone
  // once a turn has run, so the run starts from the first-run card.
  await page.goto('/');
  await page.getByRole('button', { name: 'Fill in the synopses', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();

  const card = page.getByTestId('plan-card');
  const synopses = card.getByRole('figure', { name: 'Synopses this step writes' });
  await expect(synopses).toBeVisible();
  // The row names its document and carries the text the batch will write, so the writer reads it before approving.
  const row = synopses.locator('li').first();
  await expect(row).toContainText(/\S/);
  await expect(row.locator('strong')).not.toHaveText('');
  // The demo may hold one step or several, so the approve control is the card's primary button, whatever its label.
  await expect(card.locator('button.is-primary')).toBeEnabled();
  // The batch has not written: no synopsis has been set, and there is no checkpoint yet.
  expect((await projectTrace(page)).filter((name) => name === 'binder.setSynopsis')).toEqual([]);
  await expect(page.getByTestId('checkpoint')).toHaveCount(0);
});

test('a codex entry a plan creates shows its description in the card before Approve is clicked', async ({ page }) => {
  const description = 'The bird that circles the lighthouse at dusk.';
  const plan = {
    steps: [
      {
        tool: 'codex.write',
        params: { entries: [{ action: 'create', name: 'Kestrel', type: 'other', description }] },
        expect: 'Kestrel is an entry in the codex',
      },
    ],
  };
  // The endpoint is set up before the sample opens, as agent.spec.ts does: useFakeEndpoint loads the app and makes the endpoint active.
  await fakeEndpoint(page, planThenAnswer(plan, 'Added.', FRIEND_PROSE));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Add Kestrel to the codex.');

  const card = page.getByTestId('plan-card');
  const entries = card.getByRole('figure', { name: 'Codex entries this step writes' });
  await expect(entries).toContainText('New entry: Kestrel');
  // The new entry's description is the text the write adds, and it is shown as the writer reads it: no raw JSON, no quotes.
  await expect(entries).toContainText(`Description: ${description}`);
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  expect((await projectTrace(page)).filter((name) => name === 'codex.upsert')).toEqual([]);
});

test('a restructure’s new item shows where it lands in the card before Approve is clicked', async ({ page }) => {
  // The op names its parent by id, which exists only once the sample is open. The endpoint serialises the plan when the intent
  // is sent, so the id is filled in after the sample opens and before that send.
  const op = { action: 'create', parent: '', type: 'document', title: 'Interlude' };
  const plan = { steps: [{ tool: 'binder.restructure', params: { ops: [op] }, expect: 'An Interlude sits in Chapter 1' }] };
  await fakeEndpoint(page, planThenAnswer(plan, 'Added.', FRIEND_PROSE));
  await useFakeEndpoint(page);
  await openSample(page);
  op.parent = await idOf(page, 'Chapter 1');
  await sendIntent(page, 'Add an interlude to Chapter 1.');

  const card = page.getByTestId('plan-card');
  const tree = card.getByRole('figure', { name: 'Tree this step changes' });
  await expect(tree).toContainText('Interlude');
  await expect(tree).toContainText('Chapter 1');
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  expect((await projectTrace(page)).filter((name) => name === 'binder.restructure' || name === 'binder.create')).toEqual([]);
});

/** Adds a priced profile on the fake endpoint and makes it active: 1 per 1,000 prompt tokens and 2 per 1,000 reply tokens. */
async function usePricedEndpoint(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  // Labels are scoped to the provider form, which the generic preset fills out for the fake endpoint.
  const form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('generic');
  await form.getByLabel('Name').fill('Priced endpoint');
  await form.getByLabel('Endpoint (the base URL, ending in /v1)').fill(FAKE_ENDPOINT);
  await form.getByLabel('Model', { exact: true }).fill('test-model');
  await form.getByLabel('Prompt', { exact: true }).fill('1');
  await form.getByLabel('Reply', { exact: true }).fill('2');
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText('Saved “Priced endpoint”.')).toBeVisible();
  await settings.locator('[data-profile="Priced endpoint"]').getByRole('button', { name: 'Use this profile' }).click();
  await expect(settings.getByText('is now the active profile')).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();
}

test('a scene draft’s card warns when the prompt is over the model’s window and shows the whole plan’s cost (issue #69)', async ({ page }) => {
  const plan = {
    steps: [{ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'The friend arrives by boat.', mode: 'draft' }, expect: 'The Friend holds a drafted opening scene' }],
  };
  // The listing reports a window far smaller than a scene draft's prompt, so the step's preview is over it.
  await endpointRoute(page, new URL(FAKE_ENDPOINT).origin, planThenAnswer(plan, 'Drafted.', FRIEND_PROSE), [{ id: 'test-model', context_length: 300 }]);
  await usePricedEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Draft the opening of The Friend.');

  const card = page.getByTestId('plan-card');
  await expect(card).toContainText('scene.draft');
  // The model's limits reach the app's prompts: the window check and the price are the step's own (context-assembly §5).
  await expect(card.locator('.plan-notice.is-warn').filter({ hasText: 'model window 300' })).toBeVisible();
  await expect(card.locator('.plan-cost')).toContainText('About $');
});

test('a coherence review’s card shows what the review is estimated to cost, at the profile’s price, before Approve is clicked', async ({ page }) => {
  // The review is staged as a card: the planner's one step, and no model call until the writer approves it. The card is what this
  // test reads, so the endpoint answers the planner only.
  const plan = { steps: [{ tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'the manuscript is reviewed for contradictions' }] };
  await fakeEndpoint(page, planThenAnswer(plan, 'Reviewed.'));
  await usePricedEndpoint(page);

  await openSample(page);
  await sendIntent(page, 'Review the manuscript for contradictions.');

  const card = page.getByTestId('plan-card');
  await expect(card).toContainText('coherence.review');
  // The review's own estimate, in dollars, on the step and for the whole plan (coherence.md §5.3).
  await expect(card.locator('.context-cost')).toContainText('About $');
  await expect(card.locator('.plan-cost')).toContainText('About $');
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
});

test('a notes rewrite shows the new notes as added words in the card before Approve is clicked, and writes them once approved', async ({ page }) => {
  const notes = 'Check the ferry timetable.\n\nKeeper’s log goes here.';
  const plan = { steps: [{ tool: 'notes.replace', params: { doc: 'The Storm', notes }, expect: 'The Storm has new notes' }] };
  await fakeEndpoint(page, planThenAnswer(plan, 'Rewritten.', FRIEND_PROSE));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Rewrite the notes of The Storm.');

  const card = page.getByTestId('plan-card');
  const diff = card.getByRole('figure', { name: 'Notes this step writes' });
  await expect(diff).toContainText('The notes of “The Storm”');
  // The sample's notes are empty, so every word is an added one, set in an underlined run that does not rest on colour alone.
  await expect(diff.locator('ins')).toContainText('Check the ferry timetable.');
  await expect(diff.locator('del')).toHaveCount(0);
  expect((await projectTrace(page)).filter((name) => name === 'notes.set')).toEqual([]);

  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(async () => (await projectTrace(page)).filter((name) => name === 'notes.set')).toEqual(['notes.set']);
});
