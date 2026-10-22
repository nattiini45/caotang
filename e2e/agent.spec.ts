import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { bodyOf, idOf, projectTrace, waitForSaved } from './support.js';

/**
 * The agent panel on a model that answers through an endpoint: a plan card that is reordered and edited before it is
 * approved, and a turn whose checkpoint takes it back. The endpoint is a fake (endpoint.ts), so the plan is the one each
 * test names; the cards, the approvals and the undo are the app's own. The sample project is opened by the first-run card's
 * read-only demo, which runs on the built-in demo profile and never reaches the endpoint; each plan is asked for by an intent
 * sent to the active endpoint from the agent panel.
 */

const FRIEND_PROSE = 'The ferry came in on the evening tide, low in the water and slow to answer the rope.';

/** The sample project, opened by the first-run card's read-only demo. */
async function openSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

/** An intent sent from the agent panel, to the active provider. */
async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** A note (written as the user asked) and a drafted synopsis for The Storm, in that order. */
const NOTE_THEN_SYNOPSIS = {
  steps: [
    { tool: 'notes.append', params: { doc: 'The Landing', text: 'First note.' }, expect: 'A note is added to The Landing' },
    {
      tool: 'synopsis.fill',
      params: { docs: ['The Storm'], source: 'text', max_words: 30 },
      expect: 'The Storm has a synopsis',
    },
  ],
};

test('a plan can be reordered and a drafted step edited, and approving it runs the steps in the edited order', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer(NOTE_THEN_SYNOPSIS, 'Both steps are in.', 'A storm takes the lamp.'));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Add a note to The Landing and a synopsis for The Storm.');

  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();
  await expect(page.locator('.plan-step[data-step="1"]')).toHaveAttribute('data-tool', 'notes.append');

  // Move the note down: the synopsis now runs first, and the card is shown again in its new order.
  await card.getByRole('button', { name: 'Move step 1 down' }).click();
  await expect(page.locator('.plan-step[data-step="1"]')).toHaveAttribute('data-tool', 'synopsis.fill');
  await expect(page.locator('.plan-step[data-step="2"]')).toHaveAttribute('data-tool', 'notes.append');

  // Edit the drafted step's limit. The loop drafts it again, and the card can be approved again.
  const limit = card.getByRole('spinbutton', { name: 'max_words of step 1' });
  await limit.fill('25');
  await limit.blur();
  await expect(card.getByRole('button', { name: 'Approve plan', exact: true })).toBeEnabled();

  await card.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  expect((await projectTrace(page)).filter((name) => name === 'binder.setSynopsis' || name === 'notes.append')).toEqual([
    'binder.setSynopsis',
    'notes.append',
  ]);
  await expect(page.locator('.agent-turn').last().locator('.agent-report')).toContainText('Applied:');
});

test('a dropped step is not run, and the card keeps the rest of the plan', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer(NOTE_THEN_SYNOPSIS, 'One step is in.', 'A storm takes the lamp.'));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Add a note to The Landing and a synopsis for The Storm.');

  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();
  await card.getByRole('button', { name: 'Drop step 1' }).click();
  await expect(card.getByRole('heading', { name: 'Plan, 1 step' })).toBeVisible();
  await card.getByRole('button', { name: 'Approve plan', exact: true }).click();

  await expect(page.getByTestId('checkpoint')).toBeVisible();
  expect((await projectTrace(page)).filter((name) => name === 'notes.append' || name === 'binder.setSynopsis')).toEqual([
    'binder.setSynopsis',
  ]);
});

test('the checkpoint row restores the project to before the turn, and the status it set goes back', async ({ page }) => {
  const single = {
    steps: [{ tool: 'meta.set', params: { targets: ['The Landing'], status: 'draft' }, expect: 'The Landing is a draft' }],
  };
  await fakeEndpoint(page, planThenAnswer(single, 'Marked The Landing as a draft.'));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Mark The Landing as a draft.');

  // A write-auto step runs at once, with no card, and leaves a checkpoint.
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /The Landing/ })).toContainText(/draft/i);

  await page.getByTestId('checkpoint').getByRole('button', { name: 'Restore to before this turn' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore to before this turn?' });
  await expect(dialog).toContainText('Your edits since then are included in the restore');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Restored to before that turn.' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /The Landing/ })).not.toContainText(/draft/i);
});

test('restoring a turn after typing in its scene takes the typing back too, and the scene is as it was before the turn', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Draft the opening scene', exact: true }).click();
  await expect(page.getByTestId('ghost-bar')).toBeVisible();
  await page.getByTestId('ghost-bar').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  const friend = await idOf(page, 'The Friend');
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toContain(FRIEND_PROSE.slice(0, 20));

  // The writer keeps typing in the scene after the turn, and the typing is saved.
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Typed after the turn.');
  await waitForSaved(page);

  await page.getByTestId('checkpoint').getByRole('button', { name: 'Restore to before this turn' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore to before this turn?' });
  await expect(dialog).toContainText('Your edits since then are included in the restore');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Restored to before that turn. 1 later change was taken back with it.' })).toBeVisible();
  expect((await bodyOf(page, friend)) ?? '').toBe('');
});

test('an edit the loop refuses is not kept in its field: the field goes back to the value the card holds, and the card says why', async ({ page }) => {
  const plan = {
    steps: [
      {
        tool: 'scene.draft',
        params: { doc: 'The Friend', instruction: 'The friend arrives by boat.', mode: 'draft' },
        expect: 'The Friend holds a drafted opening scene',
      },
    ],
  };
  await fakeEndpoint(page, planThenAnswer(plan, 'Drafted.', FRIEND_PROSE));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Draft the opening of The Friend.');

  const card = page.getByTestId('plan-card');
  const doc = card.getByRole('textbox', { name: 'doc of step 1' });
  await expect(doc).toHaveValue('The Friend');
  await doc.fill('Nowhere Town');
  await doc.blur();

  await expect(card.locator('.plan-notice').filter({ hasText: 'no document is titled or identified by' })).toBeVisible();
  await expect(doc).toHaveValue('The Friend');
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
});

test('a step the loop does not draft again has its params editable, and is not badged as drafted', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer(NOTE_THEN_SYNOPSIS, 'Both steps are in.', 'A storm takes the lamp.'));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Add a note to The Landing and a synopsis for The Storm.');

  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();
  const note = page.locator('.plan-step[data-step="1"]');
  // A step that has not run can be changed in place: the loop checks the edit again before the card is shown (agent-harness §2).
  await expect(note.getByLabel('text of step 1')).toBeEnabled();
  await expect(note).not.toContainText('Its settings cannot be changed here');
  await expect(note).not.toContainText('Drafted against an earlier text');
  // The synopsis is drafted again when its settings change, so its limit can be edited.
  await expect(card.getByRole('spinbutton', { name: 'max_words of step 2' })).toBeEnabled();
});

test('a step with no draft, edited in its param and its expectation, is approved as edited and the run completes', async ({ page }) => {
  const plan = {
    steps: [
      { tool: 'notes.append', params: { doc: 'The Landing', text: 'First note.' }, expect: 'A note is added to The Landing' },
      { tool: 'notes.append', params: { doc: 'The Friend', text: 'Second note.' }, expect: 'A note is added to The Friend' },
    ],
  };
  await fakeEndpoint(page, planThenAnswer(plan, 'Both notes are in.', FRIEND_PROSE));
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Add a note to The Landing and one to The Friend.');

  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();
  // Neither step is drafted, so an edit to either leaves the card approvable: the loop checks each edit when it is shown.
  const text = card.getByRole('textbox', { name: 'text of step 1' });
  await text.fill('Edited note.');
  await text.blur();
  const expectation = card.getByRole('textbox', { name: 'Expected effect of step 2' });
  await expectation.fill('A second note is added to The Friend');
  await expectation.blur();
  await expect(card.getByRole('button', { name: 'Approve plan', exact: true })).toBeEnabled();
  await expect(page.locator('.plan-step').filter({ hasText: 'Changed since it was checked' })).toHaveCount(0);

  await card.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  expect((await projectTrace(page)).filter((name) => name === 'notes.append')).toEqual(['notes.append', 'notes.append']);
  await expect(page.locator('.agent-turn').last().locator('.agent-report')).toContainText('Applied:');
});

test('a draft addressed by a title in another case reaches its scene, and the card is approved once the draft is on screen', async ({ page }) => {
  const plan = {
    steps: [
      {
        tool: 'scene.draft',
        params: { doc: 'the friend', instruction: 'The friend arrives by boat.', mode: 'draft' },
        expect: 'The Friend holds a drafted opening scene',
      },
    ],
  };
  await fakeEndpoint(page, planThenAnswer(plan, 'Drafted.', FRIEND_PROSE));
  await useFakeEndpoint(page);
  await openSample(page);
  const friend = await idOf(page, 'The Friend');
  await sendIntent(page, 'Draft the opening of The Friend.');

  // The draft is shown in the scene it names, which is the one the card approves.
  await expect(page.getByTestId('ghost-bar')).toContainText('The Friend');
  const card = page.getByTestId('plan-card');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();

  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toContain(FRIEND_PROSE.slice(0, 20));
});

test('a multi-step turn shows its step in the header with the drawer open or closed, and its checklist ticks to done and folds', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer(NOTE_THEN_SYNOPSIS, 'Both steps are in.', 'A storm takes the lamp.'));
  await useFakeEndpoint(page);
  await openSample(page);

  // The model's first answer is held, so the turn stays in its first step long enough to be read.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://127.0.0.1:5999/**', async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.fallback();
  });
  await sendIntent(page, 'Add a note to The Landing and a synopsis for The Storm.');

  const step = page.getByTestId('agent-step');
  await expect(step).toHaveText('Step 1 of 1 · Planning');
  release();

  // The plan card waits for the writer, and the header says so with the drawer open and closed.
  await expect(page.getByTestId('plan-card').getByRole('heading', { name: 'Plan, 2 steps' })).toBeVisible();
  await expect(step).toHaveText('Waiting for you · Plan, 2 steps');
  await page.getByRole('button', { name: 'Hide the agent' }).click();
  await expect(page.getByTestId('agent-panel')).not.toHaveClass(/is-open/);
  await expect(step).toHaveText('Waiting for you · Plan, 2 steps');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();

  const list = page.getByRole('list', { name: 'Task list' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.locator('[data-state="waiting"]')).toHaveCount(2);
  await expect(list).toContainText('Add to the notes of “The Landing”');
  await expect(list).toContainText('Fill the synopsis of “The Storm”');

  await page.getByTestId('plan-card').getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();

  // The turn settled: the header says nothing more, every item reads Done as text, and the list is folded but still in the turn.
  await expect(step).toHaveCount(0);
  const tasks = page.locator('.agent-turn').last().getByTestId('agent-tasks');
  await expect(tasks.locator('details')).not.toHaveAttribute('open', '');
  await tasks.getByText(/Task list/).click();
  await expect(tasks.locator('.task-item[data-state="done"]')).toHaveCount(3);
  await expect(tasks.locator('.task-item').first()).toContainText('Done');
  await expect(tasks.locator('.task-calls')).toContainText(/Model calls: \d of 8/);
});
