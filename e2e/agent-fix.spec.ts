import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { binderRow, binderTitle, bodyOf, createProject, firstChapter, idOf, traceNames, waitForSaved } from './support.js';

/**
 * The agent's surfaces for a draft and for a fix (agent-harness §8, coherence.md §6.3, context-assembly §6): a demo draft lands with
 * its Apply bar in view above the drawer, and the header says a card waits for the writer; the Undo button names an agent's change
 * in the writer's words; a passage the demo does not script is refused in words with no card; a dialogue finding offers no Fix; and a
 * screenplay scene's fix card can be approved. The demo runs on the built-in profile with no key. The screenplay fix runs on a fake
 * endpoint, because the demo answers only its three intents.
 */

/** The card's button for one demo, by its label. */
function demo(page: Page, label: string) {
  return page.getByRole('button', { name: label, exact: true });
}

/** The Fix with agent button of the first finding in a group, by the region's name. */
function fixOf(page: Page, region: string) {
  return page.getByRole('region', { name: region }).locator('article.finding').first().getByRole('button', { name: 'Fix with agent', exact: true });
}

test('a demo draft lands with its Apply bar in view above the agent drawer, and the header says the card waits for the writer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await demo(page, 'Draft the opening scene').click();

  const bar = page.getByTestId('ghost-bar');
  await expect(bar).toBeVisible();
  const drawer = page.getByTestId('agent-panel');
  // The turn is waiting on the writer's decision, so the header says so and does not say the agent is working.
  await expect(drawer.locator('.agent-busy')).toContainText('Waiting for you');

  // Without scrolling, the Apply button is inside the editor's visible area and above the drawer.
  const apply = bar.getByRole('button', { name: 'Apply', exact: true });
  const pane = page.locator('.editor-pane:not([hidden])');
  const applyBox = await apply.boundingBox();
  const paneBox = await pane.boundingBox();
  const drawerBox = await drawer.boundingBox();
  expect({ apply: applyBox !== null, pane: paneBox !== null, drawer: drawerBox !== null }).toEqual({ apply: true, pane: true, drawer: true });
  if (applyBox === null || paneBox === null || drawerBox === null) return;
  expect(applyBox.y).toBeGreaterThanOrEqual(paneBox.y);
  expect(applyBox.y + applyBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height);
  expect(applyBox.y + applyBox.height).toBeLessThanOrEqual(drawerBox.y);
});

test('an applied draft is named in the writer’s words on the Undo button', async ({ page }) => {
  await page.goto('/');
  await demo(page, 'Draft the opening scene').click();
  await expect(page.getByTestId('ghost-bar')).toBeVisible();
  await page.getByTestId('ghost-bar').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();

  // The label is the agent's edit to the scene, not the store's own words for the write.
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveAttribute('title', 'Undo: the agent’s edit to “The Friend”');
});

/** A chapter with two scenes, and a declared order that breaks the declared days, scanned (an error the Fix can start from). */
async function scannedWithAnError(page: Page): Promise<void> {
  await createProject(page, 'Refusal Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  for (const scene of ['Scene A', 'Scene B']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
    await page.keyboard.press('Enter');
    await expect(binderRow(page, scene)).toBeVisible();
  }

  const surface = page.getByRole('textbox', { name: 'Document text' });
  await binderTitle(page, 'Scene A').click();
  await page.getByTestId('scene-meta').locator('summary').click();
  await page.getByRole('spinbutton', { name: 'Day offset' }).fill('5');
  await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');
  await surface.click();
  await page.keyboard.type('The ferry was late, as always.');
  await waitForSaved(page);

  await binderTitle(page, 'Scene B').click();
  await page.getByTestId('scene-meta').locator('summary').click();
  await page.getByRole('spinbutton', { name: 'Day offset' }).fill('1');
  await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');
  await page.getByRole('combobox', { name: 'Add a scene this follows' }).selectOption({ label: 'Scene A' });
  await expect(page.getByRole('list', { name: 'Follows these scenes' })).toContainText('Scene A');
  await expect.poll(() => traceNames(page)).toContain('coherence.setSceneMeta');
  await surface.click();
  await page.keyboard.type('The lamp went out before the ferry came in.');
  await waitForSaved(page);

  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(page.getByRole('region', { name: 'Errors' })).toBeVisible();
}

test('Fix with agent on a passage the demo does not script opens the drawer, says why in words, and offers no card', async ({ page }) => {
  await scannedWithAnError(page);
  const fix = fixOf(page, 'Errors');
  await expect(fix).toBeVisible();
  await fix.click();

  // The note under the finding makes no promise of a card: the demo's refusal arrives in the drawer after the note is written, so the
  // note names where the outcome shows and does not say a card waits for approval.
  const note = page.getByRole('region', { name: 'Errors' }).locator('article.finding').first().getByRole('status');
  await expect(note).toHaveText('The fix has started in the agent panel. Its outcome shows there.');
  await expect(note).not.toContainText('Approve its card');

  // The drawer opens with the fix's answer in it: the demo's words, and no card for a draft it will not write.
  const drawer = page.getByTestId('agent-panel');
  await expect(drawer).toHaveClass(/is-open/);
  await expect(drawer).toContainText('answers only the three demo requests');
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await expect(page.getByTestId('ghost-bar')).toHaveCount(0);

  // Neither scene takes a project overview or any other text the demo made up. A body is stored with its final newline.
  expect(((await bodyOf(page, await idOf(page, 'Scene A'))) ?? '').trim()).toBe('The ferry was late, as always.');
  expect(((await bodyOf(page, await idOf(page, 'Scene B'))) ?? '').trim()).toBe('The lamp went out before the ferry came in.');
});

test('a finding on dialogue offers no Fix with agent, because the agent drafts scenes and not the passages of dialogue', async ({ page }) => {
  const ORPHAN_INK = ['=== start ===', 'Mara: The boat is back.', '-> END', '', '=== orphan ===', 'Elena: Nobody comes to this knot.', '-> END', ''].join('\n');
  await createProject(page, 'Harbour Book');
  // The media entries are on chapters, so the node goes into the manuscript's first chapter.
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New dialogue here' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Dialogue: Untitled dialogue' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Ink source' }).fill(ORPHAN_INK);
  await waitForSaved(page);

  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(page.locator('article.finding').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fix with agent', exact: true })).toHaveCount(0);
});

test('a screenplay scene’s fix card can be approved, because its draft is read in the card', async ({ page }) => {
  await fakeEndpoint(page, planThenAnswer({ reply: 'Done.' }, 'Done.', 'MARA'));
  await useFakeEndpoint(page);
  await createProject(page, 'Lamp Book');
  // The media entries are on chapters, so the node goes into the manuscript's first chapter.
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New screenplay scene here' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Screenplay: Untitled scene' })).toBeVisible();
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill(['INT. LIGHTHOUSE - NIGHT', '', 'ELENA', 'Is anyone there?'].join('\n'));
  await waitForSaved(page);

  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  const finding = page.locator('article.finding', { hasText: 'ELENA' }).first();
  await expect(finding).toBeVisible();
  await finding.getByRole('button', { name: 'Fix with agent', exact: true }).click();

  // The card holds the screenplay draft, and its Approve is enabled: the draft is read where the card shows it.
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  const approve = card.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(async () => (await bodyOf(page, await idOf(page, 'Untitled scene'))) ?? '').toContain('MARA');
});
