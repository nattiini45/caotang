import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile, type SceneMeta } from '../packages/coherence/src/index.js';
import { addDocument, createEmptyManifest, createProjectState, exportProjectZip } from '../packages/store/src/index.js';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { binderTitle, projectTrace, trace, waitForSaved } from './support.js';

/**
 * The agent's `timeline.edit` through the page (timeline.md §5.1): the model proposes a batch, the plan card lists each row as before
 * and after and waits for Approve, nothing is written until then, the applied batch is one change that one Undo takes back, and a scene
 * changed under the card refuses the whole batch with nothing written. The model is the fake endpoint, and the project is made in Node
 * with the store's own primitives and opened as a bundle, as `timeline-edit.spec.ts` does.
 */

const NOW = new Date('2026-10-01T09:00:00.000Z');

const ids = new Map<string, string>();

function nodeId(key: string): string {
  let id = ids.get(key);
  if (id === undefined) {
    id = `n_A${String(ids.size + 1).padStart(9, '0')}`;
    ids.set(key, id);
  }
  return id;
}

interface Scene {
  readonly id: string;
  readonly title: string;
  readonly meta?: SceneMeta;
}

const SCENES: readonly Scene[] = [
  { id: 'pro', title: 'Before the storm', meta: { dayOffset: -400, storyPart: 'prologue' } },
  { id: 'm1', title: 'Arrival', meta: { dayOffset: 0 } },
  { id: 'm2', title: 'The letter', meta: { dayOffset: 1, after: [nodeId('m1')] } },
  { id: 'm3', title: 'The quarrel', meta: { dayOffset: 2 } },
  { id: 'm4', title: 'Departure', meta: { dayOffset: 6 } },
];

async function openBook(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const state = createProjectState(createEmptyManifest(name, NOW, { locale: 'en-US' }), { now: NOW });
  const sceneMeta: Record<string, SceneMeta> = {};
  for (const scene of SCENES) {
    addDocument(state, { id: nodeId(scene.id), parentId: 'manuscript', title: scene.title, body: `${scene.title} is written here.`, now: NOW });
    if (scene.meta !== undefined) sceneMeta[nodeId(scene.id)] = scene.meta;
  }
  const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta, findings: [] };
  const bundle = await exportProjectZip(state, { now: NOW, coherence: serializeCoherenceFile(file) });
  const path = testInfo.outputPath(`${name.replace(/\W+/g, '-')}.caotang`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bundle.bytes);
  await page.goto('/');
  await page.getByTestId('bundle-input').setInputFiles(path);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

async function sendIntent(page: Page, intent: string): Promise<void> {
  const toggle = page.locator('.agent-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const field = page.getByRole('textbox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const cell = (page: Page, key: string): Locator => page.locator(`[role="gridcell"][data-node="${nodeId(key)}"]`).first();

const PLAN = {
  steps: [
    {
      tool: 'timeline.edit',
      params: {
        label: 'Slip the ending',
        ops: [
          { op: 'meta', nodeId: 'Departure', patch: { dayOffset: 9 } },
          { op: 'meta', nodeId: 'The quarrel', patch: { storyPart: 'epilogue' } },
        ],
      },
      expect: 'The departure and the quarrel are re-timed',
    },
  ],
};

/** The Undo button's name, which says what the next Undo takes back. */
const undoButton = (page: Page): Locator => page.getByRole('button', { name: /^Undo/ });

async function slipProposed(page: Page, testInfo: TestInfo, name: string, intent = 'Slip the departure to day 9 and make the quarrel an epilogue scene.'): Promise<Locator> {
  await openBook(page, testInfo, name);
  await page.locator('#center-timeline').click();
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await sendIntent(page, intent);
  const card = page.getByTestId('plan-card');
  await expect(card.locator('.plan-step[data-tool="timeline.edit"]')).toBeVisible();
  return card;
}

test('the agent proposes a timeline batch, it asks before writing, and one Undo takes the whole batch back', async ({ page }, testInfo) => {
  await fakeEndpoint(page, planThenAnswer(PLAN, 'The ending is moved.'));
  await useFakeEndpoint(page);
  const card = await slipProposed(page, testInfo, 'Agent Timeline');

  // The step is a write that asks, with the model's own params open to edit, and nothing has reached the project.
  const step = card.locator('.plan-step[data-tool="timeline.edit"]');
  await expect(step).toContainText('write-confirm');
  await expect(step.getByLabel('label of step 1')).toHaveValue('Slip the ending');
  await expect(step.getByLabel('ops of step 1')).toHaveValue(/"dayOffset": 9/);
  await expect(page.getByTestId('agent-panel')).toContainText('Waiting for you');
  await expect(cell(page, 'm4')).toHaveAttribute('aria-label', /Day 6,/);
  await expect(cell(page, 'm3')).not.toHaveAttribute('aria-label', /Epilogue/);
  expect(await projectTrace(page)).toEqual([]);

  await card.getByRole('button', { name: 'Approve', exact: true }).click();

  // One timeline.apply, issued by the agent, names the batch and the two scenes it touched; the outcome is read back in words.
  await expect.poll(() => projectTrace(page)).toEqual(['timeline.apply']);
  const [row] = await trace(page);
  expect(row).toMatchObject({ command: 'timeline.apply', issuedBy: 'agent', summary: 'Timeline: Slip the ending' });
  expect(row?.affected?.map((entry) => entry.title).sort()).toEqual(['Departure', 'The quarrel']);
  const panel = page.getByTestId('agent-panel');
  await expect(panel.locator('.status-card[data-tool="timeline.edit"]')).toHaveAttribute('data-status', 'done');
  await expect(panel).toContainText('Applied: applied “Slip the ending” 2 timeline changes (1 day, 1 part).');

  // The timeline shows the batch: the day moved, and the quarrel is now in the epilogue.
  await expect(cell(page, 'm4')).toHaveAttribute('aria-label', /Day 9,/);
  await expect(cell(page, 'm3')).toHaveAttribute('aria-label', /Epilogue/);

  // One Undo, named for the batch, restores both scenes.
  await expect(undoButton(page)).toHaveAttribute('title', 'Undo: Timeline: Slip the ending');
  await undoButton(page).click();
  await expect(cell(page, 'm4')).toHaveAttribute('aria-label', /Day 6,/);
  await expect(cell(page, 'm3')).not.toHaveAttribute('aria-label', /Epilogue/);
  await expect(undoButton(page)).toHaveAttribute('title', 'Nothing to undo');
});

test('a change made after the agent applied the batch is undone first, then the batch, in order', async ({ page }, testInfo) => {
  await fakeEndpoint(page, planThenAnswer(PLAN, 'The ending is moved.'));
  await useFakeEndpoint(page);
  const card = await slipProposed(page, testInfo, 'Agent Undo Order');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => projectTrace(page)).toEqual(['timeline.apply']);

  await binderTitle(page, 'Departure').click();
  await page.getByTestId('scene-meta').locator('summary').click();
  const day = page.getByRole('spinbutton', { name: 'Day offset' });
  await day.fill('12');
  await day.press('Enter');
  await expect.poll(() => projectTrace(page)).toEqual(['timeline.apply', 'coherence.setSceneMeta']);

  await expect(undoButton(page)).toHaveAttribute('title', /^Undo: set day on the scene declarations of/);
  await undoButton(page).click();
  await expect(undoButton(page)).toHaveAttribute('title', 'Undo: Timeline: Slip the ending');
  await page.locator('#center-timeline').click();
  await expect(cell(page, 'm4')).toHaveAttribute('aria-label', /Day 9,/);

  await undoButton(page).click();
  await expect(cell(page, 'm4')).toHaveAttribute('aria-label', /Day 6,/);
  await expect(cell(page, 'm3')).not.toHaveAttribute('aria-label', /Epilogue/);
});

test('the plan card lists each changed field before and after, and the findings the batch would resolve or raise, before Approve', async ({ page }, testInfo) => {
  await fakeEndpoint(page, planThenAnswer(PLAN, 'The ending is moved.'));
  await useFakeEndpoint(page);
  const card = await slipProposed(page, testInfo, 'Agent Rows');

  const changes = card.getByRole('figure', { name: 'Timeline changes this step makes' });
  await expect(changes).toContainText('2 timeline changes, shown before approval');
  const table = changes.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Scene or folder', 'Part', 'Field', 'Before', 'After']);
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  // The day moves, in the part the scene is in after the batch.
  await expect(rows.nth(0).getByRole('rowheader')).toHaveText('Departure');
  await expect(rows.nth(0).getByRole('cell')).toHaveText(['Main story', 'Day', 'day 6', 'day 9']);
  // The quarrel changes part, and its day stays, so it has the one row, and it names the epilogue it moves to.
  await expect(rows.nth(1).getByRole('rowheader')).toHaveText('The quarrel');
  await expect(rows.nth(1).getByRole('cell')).toHaveText(['Epilogue', 'Story part', 'inherited', 'epilogue']);

  // Both lists of findings are there before the writer decides, each with its count, and nothing has reached the project.
  await expect(changes.getByRole('region', { name: 'Findings this would resolve' })).toBeVisible();
  await expect(changes.getByRole('region', { name: 'Findings this would raise' })).toBeVisible();
  expect(await projectTrace(page)).toEqual([]);
});

test('the plan card names the findings a batch would raise, with their severity, before Approve', async ({ page }, testInfo) => {
  const plan = { steps: [{ tool: 'timeline.edit', params: { ops: [{ op: 'meta', nodeId: 'Arrival', patch: { dayOffset: 5 } }] }, expect: 'Arrival moves after the letter' }] };
  await fakeEndpoint(page, planThenAnswer(plan, 'Arrival is moved.'));
  await useFakeEndpoint(page);
  const card = await slipProposed(page, testInfo, 'Agent Findings', 'Move the arrival to day 5.');
  const changes = card.getByRole('figure', { name: 'Timeline changes this step makes' });
  await expect(changes.locator('tbody tr').first().getByRole('cell')).toHaveText(['Main story', 'Day', 'day 0', 'day 5']);
  const raised = changes.getByRole('region', { name: 'Findings this would raise' });
  await expect(raised.getByRole('listitem')).toHaveCount(2);
  await expect(raised.getByRole('listitem').filter({ hasText: 'Error' })).toContainText('is declared to follow');
  await expect(raised.getByRole('listitem').filter({ hasText: 'Error' })).toContainText('it happens on day 1, before day 5');
  await expect(raised.getByRole('listitem').filter({ hasText: 'Note' })).toContainText('but happens after it (day 5 against day 2)');
  await expect(changes.getByRole('region', { name: 'Findings this would resolve' })).toContainText('It would resolve no open finding.');
  expect(await projectTrace(page)).toEqual([]);
});

test('a scene changed under the card refuses the whole batch, writes nothing, and the card is read again before it can be applied', async ({ page }, testInfo) => {
  await fakeEndpoint(page, planThenAnswer(PLAN, 'The ending is moved.'));
  await useFakeEndpoint(page);
  const card = await slipProposed(page, testInfo, 'Agent Conflict');
  const panel = page.getByTestId('agent-panel');

  // The writer dates the Departure by hand while the card is open.
  await binderTitle(page, 'Departure').click();
  await page.getByTestId('scene-meta').locator('summary').click();
  const day = page.getByRole('spinbutton', { name: 'Day offset' });
  await day.fill('7');
  await day.press('Enter');
  await expect.poll(() => projectTrace(page)).toEqual(['coherence.setSceneMeta']);
  await waitForSaved(page);

  // Approving the card as it was shown refuses it whole: the quarrel's part is not applied either, and the timeline.apply never ran.
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  const failed = panel.locator('.status-card[data-tool="timeline.edit"][data-status="failed"]');
  await expect(failed).toBeVisible();
  await expect(failed).toContainText('‘Departure’ changed since this was proposed: its day was 6 and is now 7');
  expect(await projectTrace(page)).toEqual(['coherence.setSceneMeta']);
  await page.locator('#center-timeline').click();
  await expect(cell(page, 'm4')).toHaveAttribute('aria-label', /Day 7,/);
  await expect(cell(page, 'm3')).not.toHaveAttribute('aria-label', /Epilogue/);

  // The card comes back for the writer, stale and not approvable, and says what to do.
  const again = page.getByTestId('plan-card');
  await expect(again.locator('.plan-step[data-tool="timeline.edit"]')).toContainText('Proposed against earlier days or parts');
  await expect(again).toContainText('The edit was kept: retry it to read the timeline again, or cancel the card.');
  await expect(again.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();

  // Reading the timeline again stages the batch against the day the writer set, and the card then says so and can be approved.
  await again.getByRole('button', { name: 'Read the timeline again' }).click();
  const rows = again.getByRole('figure', { name: 'Timeline changes this step makes' }).locator('tbody tr');
  await expect(rows.nth(0).getByRole('cell')).toHaveText(['Main story', 'Day', 'day 7', 'day 9']);
  await again.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => projectTrace(page)).toEqual(['coherence.setSceneMeta', 'timeline.apply']);
  await expect(cell(page, 'm4')).toHaveAttribute('aria-label', /Day 9,/);
  await expect(cell(page, 'm3')).toHaveAttribute('aria-label', /Epilogue/);
});