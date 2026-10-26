import { expect, test, type Page } from '@playwright/test';

import { binderRow, binderTitle, countOf, createProject, traceNames, waitForSaved, withoutIsolates } from './support.js';

/**
 * Threads on a scene (coherence.md §5.5): a writer declares that Scene A plants a thread and Scene B pays it off, edits and
 * removes it, and the scan names a payoff it did not read. Each change is one `coherence.setSceneMeta`.
 */

async function twoScenes(page: Page): Promise<void> {
  await createProject(page, 'Threads Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  for (const scene of ['Scene A', 'Scene B']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
    await page.keyboard.press('Enter');
    await expect(binderRow(page, scene)).toBeVisible();
  }
}

async function openDeclarations(page: Page): Promise<void> {
  const meta = page.getByTestId('scene-meta');
  if ((await meta.getAttribute('open')) === null) await meta.locator('summary').click();
}

async function typeInto(page: Page, scene: string, text: string): Promise<void> {
  await binderTitle(page, scene).click();
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.type(text);
  await waitForSaved(page);
}

test('a thread is declared, edited and removed in the inspector, and the scan names a payoff it did not read', async ({ page }) => {
  await twoScenes(page);
  await typeInto(page, 'Scene A', 'A lamp stood on the sill.');

  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  const threads = page.getByTestId('scene-threads');
  const add = threads.getByRole('button', { name: 'Add thread' });

  // Nothing can be added without a name and a scene that pays it off.
  await expect(add).toBeDisabled();
  await threads.getByRole('textbox', { name: 'Thread name' }).fill('the lamp');
  await expect(add).toBeDisabled();
  await threads.getByRole('combobox', { name: 'Paid off in' }).selectOption({ label: 'Scene B' });
  await threads.getByRole('textbox', { name: 'What the payoff is for' }).fill('it is lit again');
  await add.click();
  await expect(threads.getByRole('list', { name: 'Threads' })).toContainText('the lamp is paid off in Scene B: it is lit again');
  await expect.poll(() => countOf(page, 'coherence.setSceneMeta')).toBe(1);

  // Scene B has no text, so the scan cannot read the payoff: it says so, and does not call the thread unresolved.
  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  const notes = page.getByTestId('findings-panel').getByRole('region', { name: 'Notes' });
  await expect
    .poll(async () => withoutIsolates(await notes.textContent()))
    .toContain('"Scene A" declares the thread "the lamp" with its payoff in "Scene B", which this scan did not read');
  await expect(page.getByTestId('findings-panel').getByRole('region', { name: 'Warnings' })).toHaveCount(0);

  // Once Scene B has text, the payoff is there and the next scan raises nothing.
  await page.getByRole('tab', { name: 'Binder' }).click();
  await typeInto(page, 'Scene B', 'The lamp was lit again.');
  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(page.getByTestId('findings-open')).toHaveText('0 open');

  // Editing a thread is one command, and survives a reload.
  await page.getByRole('tab', { name: 'Binder' }).click();
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  await threads.getByRole('button', { name: 'Edit the thread the lamp' }).click();
  await expect(threads.getByRole('textbox', { name: 'Thread name' })).toHaveValue('the lamp');
  await threads.getByRole('textbox', { name: 'Thread name' }).fill('the lantern');
  await threads.getByRole('button', { name: 'Save thread' }).click();
  await expect(threads.getByRole('list', { name: 'Threads' })).toContainText('the lantern is paid off in Scene B: it is lit again');
  await expect(threads.getByRole('list', { name: 'Threads' })).not.toContainText('the lamp');
  await expect.poll(() => countOf(page, 'coherence.setSceneMeta')).toBe(2);
  await waitForSaved(page);

  await page.reload();
  await page.locator('.project-row', { hasText: 'Threads Book' }).getByRole('button', { name: 'Open' }).click();
  await binderTitle(page, 'Scene A').click();
  await openDeclarations(page);
  await expect(threads.getByRole('list', { name: 'Threads' })).toContainText('the lantern is paid off in Scene B');

  // Removing it leaves the scene with none, and undo brings it back.
  await threads.getByRole('button', { name: 'Remove the thread the lantern' }).click();
  await expect(threads.getByRole('list', { name: 'Threads' })).toContainText('None declared.');
  await binderTitle(page, 'Scene A').click();
  await page.keyboard.press('Control+z');
  await expect(threads.getByRole('list', { name: 'Threads' })).toContainText('the lantern is paid off in Scene B');
  expect((await traceNames(page)).filter((name) => name === 'coherence.setSceneMeta')).toHaveLength(2);
});
