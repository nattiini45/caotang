import { expect, test, type Page } from '@playwright/test';

import { binderRow, binderTitle, countOf, createProject, traceNames, waitForSaved, withoutIsolates } from './support.js';

/**
 * Knowledge (coherence.md §4.4): a writer states a fact in the Findings tab, declares in the Inspector that a character knows
 * it in one scene and learns it in a later one, and the scan reports the character who knows it too early. Swapping the two
 * clears the finding. Each change is a bus command, and removing the fact takes its declarations with it, in one undo.
 */

async function twoScenes(page: Page): Promise<void> {
  await createProject(page, 'Knowledge Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  for (const scene of ['Scene A', 'Scene B']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
    await page.keyboard.press('Enter');
    await expect(binderRow(page, scene)).toBeVisible();
    await page.getByRole('textbox', { name: 'Document text' }).fill(`${scene}: Anna crossed the yard.`);
    await waitForSaved(page);
  }
}

async function openDeclarations(page: Page): Promise<void> {
  const meta = page.getByTestId('scene-meta');
  if ((await meta.getAttribute('open')) === null) await meta.locator('summary').click();
}

async function declare(page: Page, scene: string, row: 'Learns' | 'Knows'): Promise<void> {
  await binderTitle(page, scene).click();
  await openDeclarations(page);
  const knowledge = page.getByTestId('scene-knowledge');
  const who = row === 'Learns' ? 'Character who learns' : 'Character who knows';
  const what = row === 'Learns' ? 'Fact learned' : 'Fact known';
  await knowledge.getByRole('combobox', { name: who }).selectOption({ label: 'Anna' });
  await knowledge.getByRole('combobox', { name: what }).selectOption({ label: 'Mara is the heir' });
  await knowledge.getByRole('button', { name: `Add to ${row}` }).click();
}

async function undeclare(page: Page, scene: string, row: 'Learns' | 'Knows'): Promise<void> {
  await binderTitle(page, scene).click();
  await openDeclarations(page);
  await page.getByTestId('scene-knowledge').getByRole('button', { name: `Stop declaring Anna: Mara is the heir under ${row}` }).click();
}

test('a character who knows a fact before the scene that teaches it is reported, and swapping the scenes clears it', async ({ page }) => {
  await twoScenes(page);

  // The character: a new codex entry is a character.
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Anna');
  await page.getByRole('textbox', { name: 'Name' }).press('Enter');
  await page.getByRole('button', { name: '← All entries' }).click();

  // With no fact yet, the Inspector says where to add one and offers nothing to pick.
  await page.getByRole('tab', { name: 'Binder' }).click();
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  const knowledge = page.getByTestId('scene-knowledge');
  await expect(knowledge).toContainText('Add a fact in the Knowledge list of the Findings tab first.');
  await expect(knowledge.getByRole('combobox')).toHaveCount(0);

  // The fact, in the Knowledge list. Add stays disabled until there is text, and Enter adds it.
  await page.getByRole('tab', { name: 'Findings' }).click();
  const list = page.getByTestId('knowledge-list');
  await expect(list.getByRole('button', { name: 'Add fact' })).toBeDisabled();
  await list.getByRole('textbox', { name: 'New knowledge fact' }).fill('Mara is the heir');
  await list.getByRole('textbox', { name: 'New knowledge fact' }).press('Enter');
  await expect(list.getByRole('list', { name: 'Knowledge facts' })).toContainText('Mara is the heir');
  await expect(list).toContainText('No one learns it yet.');
  await expect.poll(() => countOf(page, 'coherence.addKnowledgeFact')).toBe(1);

  // Scene A shows Anna knowing it; Scene B is where she learns it. The pickers are native controls, reached by keyboard.
  await page.getByRole('tab', { name: 'Binder' }).click();
  await declare(page, 'Scene A', 'Knows');
  expect(withoutIsolates(await page.getByTestId('scene-knowledge').getByRole('list', { name: 'Knows', exact: true }).textContent())).toContain('Anna: Mara is the heir');
  await declare(page, 'Scene B', 'Learns');
  expect(withoutIsolates(await page.getByTestId('scene-knowledge').getByRole('list', { name: 'Learns', exact: true }).textContent())).toContain('Anna: Mara is the heir');
  await expect.poll(() => countOf(page, 'coherence.setSceneMeta')).toBe(2);

  // The ledger lists where she learns it and where she is shown knowing it, each scene a button.
  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(list.getByRole('list', { name: /is learned$/ })).toContainText('Anna learns it in Scene B');
  await expect(list.getByRole('list', { name: /is acted on$/ })).toContainText('Anna is shown knowing it in Scene A');

  // The scan names the order the writer declared.
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  const errors = page.getByTestId('findings-panel').getByRole('region', { name: 'Errors' });
  await expect
    .poll(async () => withoutIsolates(await errors.textContent()))
    .toContain('"Anna" knows that "Mara is the heir" in "Scene A", but learns it only in "Scene B"');
  await expect(page.getByTestId('findings-open')).toHaveText('1 open');

  // Fixing the order: she learns it in Scene A and is shown knowing it in Scene B.
  await page.getByRole('tab', { name: 'Binder' }).click();
  await undeclare(page, 'Scene A', 'Knows');
  await undeclare(page, 'Scene B', 'Learns');
  await declare(page, 'Scene A', 'Learns');
  await declare(page, 'Scene B', 'Knows');
  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(page.getByTestId('findings-open')).toHaveText('0 open');
  await expect(list.getByRole('list', { name: /is learned$/ })).toContainText('Anna learns it in Scene A');

  // The declarations are kept across a reload.
  await waitForSaved(page);
  await page.reload();
  await page.locator('.project-row', { hasText: 'Knowledge Book' }).getByRole('button', { name: 'Open' }).click();
  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(page.getByTestId('knowledge-list').getByRole('list', { name: /is learned$/ })).toContainText('Anna learns it in Scene A');
});

test('removing a fact takes its declarations with it, and one undo brings them all back', async ({ page }) => {
  await twoScenes(page);
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Anna');
  await page.getByRole('textbox', { name: 'Name' }).press('Enter');
  await page.getByRole('button', { name: '← All entries' }).click();

  await page.getByRole('tab', { name: 'Findings' }).click();
  const list = page.getByTestId('knowledge-list');
  await list.getByRole('textbox', { name: 'New knowledge fact' }).fill('Mara is the heir');
  await list.getByRole('button', { name: 'Add fact' }).click();
  await page.getByRole('tab', { name: 'Binder' }).click();
  await declare(page, 'Scene A', 'Learns');
  await declare(page, 'Scene B', 'Knows');

  // Editing the fact is one command and leaves the declarations alone.
  await page.getByRole('tab', { name: 'Findings' }).click();
  await list.getByRole('button', { name: 'Edit the fact Mara is the heir' }).click();
  const edit = list.getByRole('textbox', { name: 'Edit the fact Mara is the heir' });
  await edit.fill('Mara is the rightful heir');
  await list.getByRole('button', { name: 'Save fact' }).click();
  await expect(list.getByRole('list', { name: 'Knowledge facts' })).toContainText('Mara is the rightful heir');
  await expect(list.getByRole('list', { name: /is learned$/ })).toContainText('Anna learns it in Scene A');

  // The removal says what it takes with it.
  await expect(list).toContainText('Removing it also takes 2 declarations from scenes.');
  await list.getByRole('button', { name: 'Remove the fact Mara is the rightful heir' }).click();
  await expect(list).toContainText('No facts yet.');
  await page.getByRole('tab', { name: 'Binder' }).click();
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  expect(withoutIsolates(await page.getByTestId('scene-knowledge').getByRole('list', { name: 'Learns', exact: true }).textContent())).toContain('None declared.');
  expect(await countOf(page, 'coherence.removeKnowledgeFact')).toBe(1);

  // One undo puts the fact and both declarations back.
  await page.keyboard.press('Control+z');
  expect(withoutIsolates(await page.getByTestId('scene-knowledge').getByRole('list', { name: 'Learns', exact: true }).textContent())).toContain('Anna: Mara is the rightful heir');
  await binderTitle(page, 'Scene B').click();
  await openDeclarations(page);
  expect(withoutIsolates(await page.getByTestId('scene-knowledge').getByRole('list', { name: 'Knows', exact: true }).textContent())).toContain('Anna: Mara is the rightful heir');
  expect((await traceNames(page)).filter((name) => name === 'coherence.removeKnowledgeFact')).toHaveLength(1);
});
