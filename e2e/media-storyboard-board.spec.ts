/**
 * The board's gestures and its header, in the app (storyboard.md §3.1). A card dragged onto another takes its
 * place through `binder.move`, the Earlier and Later buttons still move a card, and the header gives the animatic total and how
 * many shots are left out of it for want of a duration.
 */

import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { binderTitle, createProject, firstChapter, trace, waitForSaved } from './support.js';

const PROJECT = 'Board Walk';

/** Makes a node from the context menu of the row it goes under, and keeps its default title. */
async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  // The media entries are on chapters, so "under the manuscript" is its first chapter, made when there is none.
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

/** A storyboard holding two shots, in creation order. */
async function storyboardWithTwoShots(page: Page): Promise<void> {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await expect(page.locator('article.sb-card')).toHaveCount(2);
}

test('a card dragged onto another takes its place through binder.move, and Later still moves a card', async ({ page }) => {
  await storyboardWithTwoShots(page);
  const cards = page.locator('article.sb-card');
  const first = await cards.nth(0).getAttribute('data-shot-id');
  const second = await cards.nth(1).getAttribute('data-shot-id');
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  await cards.nth(1).dragTo(cards.nth(0), {
    sourcePosition: { x: 48, y: 24 },
    targetPosition: { x: 48, y: 24 },
  });
  await expect.poll(() => cards.nth(0).getAttribute('data-shot-id')).toBe(second);
  expect((await trace(page)).some((row) => row.command === 'binder.move')).toBe(true);

  // The buttons are still the keyboard's way to the same move: the card now first moves later, back to the front.
  await page.getByRole('button', { name: 'Move shot 1 later' }).click();
  await expect.poll(() => cards.nth(0).getAttribute('data-shot-id')).toBe(first);
});

test('the board header gives the animatic total, and how many shots are left out of it', async ({ page }) => {
  await storyboardWithTwoShots(page);
  await expect(page.locator('.sb-bar')).toContainText('0 s of animatic, with 2 shots left out for want of a duration');

  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  await page.getByLabel('Duration, seconds').fill('4');
  await page.getByRole('button', { name: 'Save shot' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();

  await expect(page.locator('.sb-bar')).toContainText('4 s of animatic, with 1 shot left out for want of a duration');
});

test('an empty storyboard beside one scene offers to derive that scene, and the offer sends its request to the agent', async ({ page }) => {
  // The request goes to the agent, so the endpoint is the fake one (endpoint.ts), and no network is used.
  await fakeEndpoint(page, planThenAnswer({ reply: 'Done.' }));
  await useFakeEndpoint(page);
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New screenplay scene here');
  await makeUnder(page, 'Manuscript', 'New storyboard here');

  // The empty board carries the storyboard.md §3.1 copy, and the derive names the scene it would derive from.
  await binderTitle(page, 'Storyboard').click();
  const empty = page.getByRole('region', { name: "No shots — derive from the scene's script, or draw/import a frame." });
  await expect(empty).toBeVisible();
  // The derive does not fill this board, so the copy says where the shots go.
  await expect(empty).toContainText('Derived shots go in a new folder, “Untitled scene — Shots”, not on this board.');
  await page.getByRole('button', { name: /^Derive shots from/ }).click();

  // The drawer opens, and the request it sends names the scene the board derives from.
  const drawer = page.getByTestId('agent-panel');
  await expect(drawer).toHaveClass(/is-open/);
  await expect(drawer.locator('.agent-intent-text').first()).toContainText('Derive the shots for the scene "Untitled scene" from its script.');
  // The scene's own view offers the same derive, so the writer has it in both places.
  await binderTitle(page, 'Untitled scene').click();
  await expect(page.getByRole('button', { name: 'Derive shots from this scene' })).toBeVisible();
});

const DERIVE_SCENE = 'INT. LIGHTHOUSE - NIGHT\n\nELENA\nIs anyone there?\n';

test('the derive the offer sends is planned, and Approve puts its shots in the scene’s own shots folder', async ({ page }) => {
  // The model's reply to the derive call is its shot list, which quotes the scene's one line of dialogue. The planner's reply is the
  // derive step, which names the scene by its title, as the offer's request does. Nothing else is asked of the endpoint.
  const shotList = {
    shots: [
      { action: 'Elena asks the question at the rail.', durationSec: 4, dialogueQuotes: ['Is anyone there?'] },
      { action: 'The lamp turns in the dark.', durationSec: 3 },
    ],
  };
  const plan = { steps: [{ tool: 'shots.derive', params: { doc: 'Untitled scene', granularity: 'key-shots' }, expect: 'The scene has its shots' }] };
  const answer = planThenAnswer(plan, 'The shots are ready.');
  await fakeEndpoint(page, (request) => (request.system.includes('Plan the shots of the screenplay scene') ? JSON.stringify(shotList) : answer(request)));
  await useFakeEndpoint(page);
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New screenplay scene here');
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill(DERIVE_SCENE);
  await waitForSaved(page);
  await makeUnder(page, 'Manuscript', 'New storyboard here');

  await binderTitle(page, 'Storyboard').click();
  await page.getByRole('button', { name: /^Derive shots from/ }).click();

  // The step waits on its card, and Approve is what writes the folder: nothing is written before it is clicked. The card does not
  // show the shot list or the folder's tree yet (storyboard.md §4 asks for both), so this test reads only the card's Approve.
  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  expect((await trace(page)).some((row) => row.command === 'storyboard.create')).toBe(false);

  await card.getByRole('button', { name: 'Approve', exact: true }).click();

  // The folder is made beside the scene, and the two shots are its cards in the order the model proposed them.
  await binderTitle(page, 'Untitled scene — Shots').click();
  const cards = page.locator('article.sb-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Elena asks the question at the rail.');
  await expect(cards.nth(1)).toContainText('The lamp turns in the dark.');
  expect((await trace(page)).some((row) => row.command === 'storyboard.create')).toBe(true);
});
