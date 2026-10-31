import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { binderTitle, createProject, firstChapter, projectTrace, trace, waitForSaved } from './support.js';

/**
 * What a shots.derive card shows before the writer approves it (storyboard.md §4, agent-harness §2): the shot list the derive proposes,
 * and the storyboard folder and its shots as the target tree. A derive of a prose scene is refused before its shots are asked for, and
 * the turn says why in a failed card. Each is read in the rendered panel before anything is written, and the project is checked to be
 * untouched.
 */

const PROJECT = 'Derive Card';
const DERIVE_SCENE = 'INT. LIGHTHOUSE - NIGHT\n\nELENA\nIs anyone there?\n';

/** Makes a node from the context menu of the row it goes under, and keeps its default title. */
async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  // The media entries are on chapters, so "under the manuscript" is its first chapter, made when there is none.
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

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

/** The shot list the model proposes for the scene: two shots, the first quoting the scene's one line of dialogue. */
const SHOT_LIST = {
  shots: [
    { action: 'Elena asks the question at the rail.', shotSize: 'MS', durationSec: 4, dialogueQuotes: ['Is anyone there?'] },
    { action: 'The lamp turns in the dark.', durationSec: 3 },
  ],
};

test('the derive card shows the shot list and the storyboard folder it creates, before Approve is clicked', async ({ page }) => {
  // The derive call answers with the shot list; the planner's reply is the derive step, which names the scene by its title.
  const plan = { steps: [{ tool: 'shots.derive', params: { doc: 'Untitled scene', granularity: 'key-shots' }, expect: 'The scene has its shots' }] };
  const planner = planThenAnswer(plan, 'The shots are ready.');
  await fakeEndpoint(page, (request) => (request.system.includes('Plan the shots of the screenplay scene') ? JSON.stringify(SHOT_LIST) : planner(request)));
  await useFakeEndpoint(page);
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New screenplay scene here');
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill(DERIVE_SCENE);
  await waitForSaved(page);
  await makeUnder(page, 'Manuscript', 'New storyboard here');

  await binderTitle(page, 'Storyboard').click();
  await page.getByRole('button', { name: /^Derive shots from/ }).click();

  // The card names each shot and the folder it lands in, so the writer reads both before approving them.
  const card = page.getByTestId('plan-card');
  const shots = card.getByRole('figure', { name: 'Shots this step creates' });
  await expect(shots).toContainText('Elena asks the question at the rail.');
  await expect(shots).toContainText('The lamp turns in the dark.');
  // Each shot carries its number and its spec row: the first is shot 1, a medium shot of four seconds.
  const first = shots.getByRole('listitem').first();
  await expect(first).toHaveAttribute('value', '1');
  await expect(first).toContainText('Elena asks the question at the rail. (Medium shot (MS) · 4 s)');
  await expect(shots.getByRole('listitem').nth(1)).toHaveAttribute('value', '2');
  await expect(card.getByLabel('Target tree')).toContainText('+ folder "Untitled scene — Shots"');
  await expect(card.getByLabel('Target tree')).toContainText('+ shot 2');
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  // Nothing is written until Approve is clicked: the folder is not made, and no storyboard command has run.
  expect((await trace(page)).some((row) => row.command === 'storyboard.create')).toBe(false);
});

test('a derive of a prose document is refused before the shots are asked for, and the turn says why in a failed card', async ({ page }) => {
  // The Friend is prose. A derive reads only a screenplay scene, and that check needs no shot list, so the step is refused before the
  // model is asked for one: the refusal is a failed card in the turn, and no derive request reaches the endpoint.
  const plan = { steps: [{ tool: 'shots.derive', params: { doc: 'The Friend', granularity: 'key-shots' }, expect: 'The Friend has its shots' }] };
  const planner = planThenAnswer(plan, 'Done.');
  let derives = 0;
  await fakeEndpoint(page, (request) => {
    if (!request.system.includes('Plan the shots of the screenplay scene')) return planner(request);
    derives += 1;
    return JSON.stringify(SHOT_LIST);
  });
  await useFakeEndpoint(page);
  await openSample(page);
  await sendIntent(page, 'Derive shots from The Friend.');

  const failed = page.locator('.status-card[data-tool="shots.derive"][data-status="failed"]');
  await expect(failed).toContainText('Derive works on screenplay scenes');
  await expect(failed.getByText('Why it did not run')).toBeVisible();
  expect(derives).toBe(0);
  // The refused derive wrote nothing.
  expect((await projectTrace(page)).filter((name) => name === 'storyboard.create')).toEqual([]);
});
