import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderRow, binderTitle, bodyOf, countOf, createProject, idOf, selectionOf, traceNames, waitForSaved } from './support.js';

/**
 * The findings tab and the scene declarations (coherence.md §5.2, §6.3, §8): declare two scenes in the inspector, run the scan,
 * open a quoted passage in the editor, dismiss a finding with a reason through the picker, and see that the file it lives in
 * is kept across a reload. Every status change is asserted against the command the bus logged.
 */

/** A chapter with two scenes, built from the binder the way a writer would. */
async function chapterWithScenes(page: Page): Promise<void> {
  await createProject(page, 'Findings Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  for (const scene of ['Scene A', 'Scene B']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    const field = page.getByRole('textbox', { name: 'Rename Untitled' });
    await field.fill(scene);
    await page.keyboard.press('Enter');
    await expect(binderRow(page, scene)).toBeVisible();
  }
}

/** The inspector's scene declarations, opened (the disclosure starts closed for each scene). */
async function openDeclarations(page: Page): Promise<void> {
  const meta = page.getByTestId('scene-meta');
  if ((await meta.getAttribute('open')) === null) await meta.locator('summary').click();
}

/** Opens a project from the projects screen, after a reload. */
async function reopen(page: Page, name: string): Promise<void> {
  await page.reload();
  await page.locator('.project-row', { hasText: name }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

/** The scene a quoted passage is in: the description of the button that opens it, which names its document. */
async function sceneOfQuote(button: Locator): Promise<string> {
  return button.evaluate((element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent?.trim() ?? '');
}

/**
 * Two declared scenes, each with a line to be read from, and a scan run over them: the state every findings test starts from.
 * Scene A is declared on day five and Scene B, which the binder lists after it, follows it but is declared on day one, so the
 * declared order breaks the declared days (an error); the binder order is no longer the day order (a note).
 */
async function declaredAndScanned(page: Page): Promise<void> {
  await chapterWithScenes(page);

  const surface = page.getByRole('textbox', { name: 'Document text' });
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  await page.getByRole('spinbutton', { name: 'Day offset' }).fill('5');
  await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');
  await surface.click();
  await page.keyboard.type('The ferry was late, as always.');
  await waitForSaved(page);

  await binderTitle(page, 'Scene B').click();
  await openDeclarations(page);
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
  await expect(page.getByTestId('findings-open')).toHaveText('2 open');
}

test('a scan reports the scene declarations a writer made, and a dismissal is one reasoned command that survives a reload', async ({
  page,
}) => {
  await declaredAndScanned(page);

  // The scan, from the Findings tab: the declared order that breaks the declared days is an error, and it is grouped as one.
  const errors = page.getByRole('region', { name: 'Errors' });
  await expect(errors.locator('article.finding')).toHaveCount(1);

  // A quoted passage opens its document at the passage: the editor shows that scene, and the passage is what it has selected.
  const quote = errors.locator('.finding-quote').first();
  const quoted = ((await quote.textContent()) ?? '').replace(/^“|”$/g, '');
  await quote.click();
  await expect(page.locator('.editor-title')).toHaveText(/Scene [AB]/);
  await expect.poll(() => selectionOf(page)).not.toBeNull();
  const selection = await selectionOf(page);
  if (selection === null) throw new Error('nothing is selected after the reveal');
  expect(selection.docId).toBe(await idOf(page, (await page.locator('.editor-title').textContent()) ?? ''));
  // The editor has no position after a document's last line break, so the selection is the passage up to that break, at the
  // passage's own offsets: its length is the passage's, and its text is the passage.
  const passage = quoted.trimEnd();
  const body = (await bodyOf(page, selection.docId)) ?? '';
  expect(selection.to - selection.from).toBe(passage.length);
  expect(body.slice(selection.from, selection.to)).toBe(passage);
  expect(selection.from).toBe(body.indexOf(passage));

  // Dismissal is the writer's judgment: the picker asks for a reason, and the reason is the command's.
  await page.getByRole('tab', { name: 'Findings' }).click();
  await errors.getByRole('button', { name: 'Dismiss…' }).click();
  const picker = page.getByRole('dialog', { name: /Dismiss the finding/ });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Dismiss finding' })).toBeDisabled();
  await picker.getByRole('radio', { name: 'In-world lie' }).check();
  await expect(picker).toContainText('In-story deception between characters.');
  await expect(picker).toContainText('Declare this as a scene mode instead.');
  await picker.getByRole('radio', { name: 'False positive' }).check();
  await picker.getByRole('button', { name: 'Dismiss finding' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.findings article.finding[data-status="dismissed"]')).toHaveCount(0);
  await expect.poll(() => traceNames(page)).toContain('coherence.setFindingStatus');
  await expect(page.getByTestId('findings-open')).toHaveText('1 open');

  // The dismissed finding is kept, under its status, with the reason the writer gave.
  await page.getByRole('combobox', { name: 'Show findings with status' }).selectOption('dismissed');
  await expect(page.getByRole('article').filter({ hasText: 'Dismissed as: False positive' })).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Show findings with status' }).selectOption('open');

  // The file was saved with the project: after a reload, the same open count and the same dismissal are there.
  await waitForSaved(page);
  await reopen(page, 'Findings Book');
  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(page.getByTestId('findings-open')).toHaveText('1 open');
  await page.getByRole('combobox', { name: 'Show findings with status' }).selectOption('dismissed');
  await expect(page.getByRole('article').filter({ hasText: 'Dismissed as: False positive' })).toHaveCount(1);
});

test('a quoted passage the writer has edited since the scan is not revealed, and its card says so', async ({ page }) => {
  await declaredAndScanned(page);
  const errors = page.getByRole('region', { name: 'Errors' });
  const title = await sceneOfQuote(errors.locator('.finding-quote').first());

  // Text is typed at the start of the quoted scene, which moves every offset the scan took after it.
  await page.getByRole('tab', { name: 'Binder' }).click();
  await binderTitle(page, title).click();
  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('Prologue. ');
  await waitForSaved(page);

  await page.getByRole('tab', { name: 'Findings' }).click();
  await errors.locator('.finding-quote').first().click();
  await expect(errors.getByText('This passage has changed since the scan. Scan again to find it.')).toBeVisible();
  // Nothing was revealed: the editor is still where the writer left it, with no range selected.
  await expect(page.locator('.editor-title')).toHaveText(title);
  expect(await selectionOf(page)).toBeNull();
});

test('a finding is marked fixed and re-opened from its card, and a fixed finding stays fixed across a reload', async ({ page }) => {
  await declaredAndScanned(page);
  const notes = page.getByRole('region', { name: 'Notes' });
  await notes.getByRole('button', { name: 'Mark fixed' }).click();
  await expect(page.getByTestId('findings-open')).toHaveText('1 open');
  await expect.poll(() => traceNames(page)).toContain('coherence.setFindingStatus');
  await waitForSaved(page);

  await reopen(page, 'Findings Book');
  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(page.getByTestId('findings-open')).toHaveText('1 open');
  await page.getByRole('combobox', { name: 'Show findings with status' }).selectOption('fixed');
  const fixed = page.locator('.findings article.finding[data-status="fixed"]');
  await expect(fixed).toHaveCount(1);
  await fixed.getByRole('button', { name: 'Re-open' }).click();
  await expect(fixed).toHaveCount(0);
  await expect(page.getByTestId('findings-open')).toHaveText('2 open');
  await expect.poll(() => countOf(page, 'coherence.setFindingStatus')).toBe(1);
});

test('the scene declarations: point of view, duration, timeline mode and an expected entry are each kept across a reload, and can be removed', async ({
  page,
}) => {
  await chapterWithScenes(page);

  // An entry in the codex, to be the scene's point of view and an entry expected in it.
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Elena');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page.getByRole('button', { name: '← All entries' }).click();

  await page.getByRole('tab', { name: 'Binder' }).click();
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  await page.getByRole('combobox', { name: 'Point of view' }).selectOption({ label: 'Elena' });
  await page.getByRole('spinbutton', { name: 'Duration in days' }).fill('3');
  await page.getByRole('spinbutton', { name: 'Duration in days' }).press('Enter');
  await page.getByRole('combobox', { name: 'Timeline mode' }).selectOption({ label: 'Flashback' });
  await page.getByRole('combobox', { name: 'Add an entry expected here' }).selectOption({ label: 'Elena' });
  await expect(page.getByRole('list', { name: 'Expected to appear' })).toContainText('Elena');
  await expect.poll(() => traceNames(page)).toContain('coherence.setSceneMeta');
  await waitForSaved(page);

  // After a reload, every declaration reads back in its control.
  await reopen(page, 'Findings Book');
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  await expect(page.getByRole('combobox', { name: 'Point of view' }).locator('option:checked')).toHaveText('Elena');
  await expect(page.getByRole('spinbutton', { name: 'Duration in days' })).toHaveValue('3');
  await expect(page.getByRole('combobox', { name: 'Timeline mode' })).toHaveValue('flashback');
  await expect(page.getByRole('list', { name: 'Expected to appear' })).toContainText('Elena');

  // Removing the expected entry is the same command, the other way round.
  await page.getByRole('button', { name: 'Stop expecting Elena' }).click();
  await expect(page.getByRole('list', { name: 'Expected to appear' })).toContainText('None declared.');
  await expect.poll(() => traceNames(page)).toContain('coherence.setSceneMeta');
});

test('two scenes a week or more apart raise a gap finding whose dismissal points at the Time skip mode, which is kept across a reload', async ({
  page,
}) => {
  await chapterWithScenes(page);

  const surface = page.getByRole('textbox', { name: 'Document text' });
  for (const [scene, day] of [
    ['Scene A', '2'],
    ['Scene B', '14'],
  ] as const) {
    await binderTitle(page, scene).click();
    await openDeclarations(page);
    await page.getByRole('spinbutton', { name: 'Day offset' }).fill(day);
    await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');
    await surface.click();
    await page.keyboard.type(`The ferry on day ${day}.`);
    await waitForSaved(page);
  }

  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  const notes = page.getByRole('region', { name: 'Notes' });
  const gap = notes.locator('article.finding').filter({ hasText: '12 days after' });
  await expect(gap).toHaveCount(1);
  // The titles are writer content and are isolated once in the sentence (I7), so the marks sit between the quotes and the words.
  await expect(gap).toContainText(/Scene B.*happens 12 days after.*Scene A/);

  // The dismissal dialog says what to declare instead, whichever reason is picked.
  await gap.getByRole('button', { name: 'Dismiss…' }).click();
  const picker = page.getByRole('dialog', { name: /Dismiss the finding/ });
  await expect(picker.getByTestId('dismiss-check-cross-link')).toHaveText('Declare a time skip on one of these scenes instead.');
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await expect(picker).toHaveCount(0);

  // The mode the line points at is in the Inspector's dropdown, and it is kept.
  await page.getByRole('tab', { name: 'Binder' }).click();
  await binderTitle(page, 'Scene B').click();
  await openDeclarations(page);
  await page.getByRole('combobox', { name: 'Timeline mode' }).selectOption({ label: 'Time skip' });
  await expect.poll(() => traceNames(page)).toContain('coherence.setSceneMeta');
  await waitForSaved(page);
  await reopen(page, 'Findings Book');
  await binderTitle(page, 'Scene B').click();
  await openDeclarations(page);
  await expect(page.getByRole('combobox', { name: 'Timeline mode' })).toHaveValue('time-skip');
});
