import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint, type FakeRequest } from './endpoint.js';
import { traceNames } from './support.js';

/**
 * Macros (extensibility §10), end to end on the sample project with a fake model: a plan the writer approved is saved as a macro with one
 * value marked, Settings › Macros lists it and runs it for another scene, the run shows its card with every step written out and one undo
 * takes it back, and a macro can be deleted. The model plans once; the macro's run asks it nothing.
 */

const INTENT = 'Mark the landing revised and note it.';

const PLAN = {
  steps: [
    { tool: 'meta.set', params: { targets: ['The Landing'], status: 'revised' }, expect: 'The Landing is revised' },
    { tool: 'notes.append', params: { doc: 'The Landing', text: 'Checked the tide.' }, expect: 'A note is added to The Landing' },
  ],
};

const turn = (page: Page) => page.locator('.agent-turn', { hasText: INTENT });
const treeStatus = (page: Page, title: string) =>
  page.evaluate((wanted) => (globalThis as unknown as { __caotang: { tree(): { title: string; status: string | null }[] } }).__caotang.tree().find((row) => row.title === wanted)?.status ?? null, title);

/** Every request the model was sent, so a test can say what it was and was not told. */
const seen: FakeRequest[] = [];

test.beforeEach(async ({ page }) => {
  seen.length = 0;
  const reply = planThenAnswer(PLAN, 'The scene is marked.');
  await fakeEndpoint(page, (request) => {
    seen.push(request);
    return reply(request);
  });
  await useFakeEndpoint(page);
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  const field = page.getByRole('combobox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(INTENT);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByTestId('plan-card').getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(turn(page).getByTestId('checkpoint')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /The Landing/ })).toContainText(/revised/i);
});

async function saveAsMacro(page: Page): Promise<void> {
  await turn(page).getByTestId('save-as-macro').click();
  const dialog = page.getByRole('dialog', { name: 'Save as macro' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill('Revise a scene');
  // The scene is the value that changes: it is the first step's target and the second step's document, one value asked for once.
  await dialog.getByLabel('Ask for Step 1, targets[1]').check();
  await dialog.getByLabel('Name of the value for Step 1, targets[1]').fill('scene');
  await dialog.getByLabel('Ask for Step 2, doc').check();
  await dialog.getByLabel('Name of the value for Step 2, doc').fill('scene');
  await dialog.getByRole('button', { name: 'Save macro' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Saved the macro “Revise a scene”' })).toBeVisible();
}

async function openMacros(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Macros', exact: true }).click();
  await expect(settings.getByTestId('macros-panel')).toBeVisible();
}

test('Save as macro is offered under the approved plan, and the macro it makes runs as that plan with another value', async ({ page }) => {
  await saveAsMacro(page);
  expect(await traceNames(page)).toContain('macro.save');

  await openMacros(page);
  const row = page.getByTestId('macro-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Revise a scene');
  await expect(row).toContainText('2 steps');
  await expect(row).toContainText('A card shows every step first');

  await row.getByRole('button', { name: /^Run/ }).click();
  const run = page.getByTestId('macro-run');
  // The value starts as it was in the plan, and the steps it would take are written out before anything is shown to the agent.
  await expect(run.getByLabel('scene')).toHaveValue('The Landing');
  await run.getByLabel('scene').fill('The Storm');
  await expect(run.getByRole('list', { name: 'Steps this run would take' })).toContainText('{"targets":["The Storm"],"status":"revised"}');
  await expect(run.getByRole('list', { name: 'Steps this run would take' })).toContainText('{"doc":"The Storm","text":"Checked the tide."}');
  await run.getByRole('button', { name: 'Show the card' }).click();

  // Settings steps aside, and the agent panel has the card, named by the macro, with both steps and nothing written yet.
  await expect(page.getByTestId('settings')).toHaveCount(0);
  const card = page.locator('[data-testid="plan-card"].is-live');
  await expect(card).toBeVisible();
  await expect(card).toContainText('meta.set');
  await expect(card).toContainText('notes.append');
  await expect(page.getByTestId('turn-command').last()).toHaveText('/macro-revise-a-scene');
  await expect(page.locator('.agent-intent-text').last()).toHaveText('Run the macro “Revise a scene”');
  expect(await treeStatus(page, 'The Storm')).not.toBe('revised');

  await card.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect.poll(() => treeStatus(page, 'The Storm')).toBe('revised');
  const last = page.locator('.agent-turn').last();
  await expect(last.getByTestId('checkpoint')).toBeVisible();

  // One undo group for the run: restoring the turn takes both steps back.
  await last.getByTestId('checkpoint').getByRole('button', { name: 'Restore to before this turn' }).click();
  await page.getByRole('dialog', { name: 'Restore to before this turn?' }).getByRole('button', { name: 'Restore', exact: true }).click();
  await expect.poll(() => treeStatus(page, 'The Storm')).not.toBe('revised');
  // The first turn's change to The Landing is still there.
  expect(await treeStatus(page, 'The Landing')).toBe('revised');
});

test('a macro can be edited and deleted, and the panel lists, edits and deletes', async ({ page }) => {
  await saveAsMacro(page);
  await openMacros(page);
  const settings = page.getByTestId('settings');

  await settings.getByRole('button', { name: /^Edit/ }).click();
  const edit = settings.getByTestId('macro-edit');
  await edit.getByLabel('Name', { exact: true }).fill('Revise and note');
  await edit.getByLabel('What step 2 should do').fill('A note about the tide is added');
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings.getByTestId('macro-row')).toContainText('Revise and note');

  await settings.getByRole('button', { name: /^Delete/ }).click();
  await expect(settings.getByTestId('macro-row')).toHaveCount(0);
  await expect(settings.getByText('This project has no macros yet.')).toBeVisible();
  const names = await traceNames(page);
  expect(names.filter((name) => name === 'macro.save')).toHaveLength(2);
  expect(names).toContain('macro.delete');
});

test('the agent is not told of a macro: no request after the save names one, lists a tool for one, or carries its text', async ({ page }) => {
  await saveAsMacro(page);
  const before = seen.length;
  const field = page.getByRole('combobox', { name: 'Intent' });
  await field.fill('How many scenes are there?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => seen.length).toBeGreaterThan(before);
  const after = seen.slice(before);
  for (const request of after) {
    expect(request.tools ?? []).not.toContainEqual(expect.stringMatching(/macro/i));
    expect(`${request.system}
${request.user}
${request.tool}`).not.toMatch(/macro|Revise a scene/i);
  }
  // Only the writer saved it.
  const rows = await page.evaluate(() => (globalThis as unknown as { __caotang: { activity(): { command: string; issuedBy: string }[] } }).__caotang.activity().filter((row) => row.command.startsWith('macro.')));
  expect(rows).toHaveLength(1);
  expect(rows.every((row) => row.issuedBy === 'user')).toBe(true);
});
