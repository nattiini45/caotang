import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { binderRow, binderTitle, createProject, traceNames, waitForSaved } from './support.js';

/**
 * The Findings tab's new parts (coherence.md §6.2, §7.1, §8, ui-modules §5.2): the Coherence section of Settings decides which
 * quick checks the Findings tab's scan runs, and the tab says so; a model review is held until a provider is connected; and the
 * run history lists each scan, with a discard that removes the run and the findings it made, and is logged like any other command.
 */

/** Opens Settings on the projects screen, at the Coherence section. */
async function openCoherenceSettings(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Coherence' }).click();
  await expect(settings.getByRole('heading', { name: 'Coherence' })).toBeVisible();
  return settings;
}

/** A chapter with two scenes, built from the binder the way a writer would. */
async function chapterWithScenes(page: Page, name: string): Promise<void> {
  await createProject(page, name);
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

/** Two declared scenes, scanned: the same declarations the findings tab's own spec uses, so the scan yields two findings. */
async function declaredAndScanned(page: Page, name: string): Promise<void> {
  await chapterWithScenes(page, name);
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
  await expect(page.getByTestId('findings-open')).toHaveText('2 open');
}

/**
 * A project with one scene of text and a codex entry the text never names, scanned from the Findings tab. With the check that
 * reports an unnamed entry on, the scan reports it; with that check off, the scan runs and reports nothing of the kind.
 */
async function scanWithUnnamedEntry(page: Page, name: string): Promise<void> {
  await createProject(page, name);
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Mirela');
  await page.getByRole('textbox', { name: 'Name', exact: true }).press('Enter');
  await page.getByRole('button', { name: '← All entries' }).click();

  await page.getByRole('tab', { name: 'Binder' }).click();
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Scene A');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Scene A')).toBeVisible();
  await binderTitle(page, 'Scene A').click();
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.type('The ferry was late, as always.');
  await waitForSaved(page);

  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(page.getByTestId('run-history').locator('[data-run]')).toHaveCount(1);
}

test('a quick check that is on reports a codex entry the manuscript never names', async ({ page }) => {
  await scanWithUnnamedEntry(page, 'Control Book');
  await expect(page.getByTestId('findings-open')).toHaveText('1 open');
  // The codex name is writer content and is isolated once (I7); the marks sit between the quotes and the name.
  await expect(page.locator('.findings')).toContainText(/Mirela.*is never named in the scanned manuscript/);
});

test('a quick check turned off in Settings does not run, and the Findings tab says what a scan covers', async ({ page }) => {
  const settings = await openCoherenceSettings(page);
  await settings.getByRole('checkbox', { name: 'A codex entry is never named in the manuscript' }).uncheck();
  await settings.getByRole('spinbutton', { name: /Most findings one model review may add/ }).fill('25');
  await settings.getByRole('button', { name: 'Save coherence settings' }).click();
  await expect(settings.getByRole('status')).toContainText('Saved.');

  // The choice holds across a reload, because the settings are the writer's and are kept in this browser.
  await openCoherenceSettings(page);
  await expect(page.getByTestId('settings').getByRole('checkbox', { name: 'A codex entry is never named in the manuscript' })).not.toBeChecked();
  await page.getByTestId('settings').getByRole('button', { name: 'Close', exact: true }).click();

  // The same manuscript the control test reports on: the scan runs, and no card of that check appears.
  await scanWithUnnamedEntry(page, 'Coverage Book');
  await expect(page.getByTestId('findings-open')).toHaveText('0 open');
  await expect(page.locator('.findings')).not.toContainText('is never named in the scanned manuscript');

  const coverage = page.getByTestId('findings-coverage');
  await expect(coverage).toContainText('The Findings tab’s quick scan checks for:');
  await expect(coverage).not.toContainText('never named in the manuscript');
  await expect(coverage).toContainText('does not read the story for plot or character problems');
});

test('a model review is held until a provider is connected, and the tab says why', async ({ page }) => {
  await createProject(page, 'Review Book');
  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(page.getByRole('button', { name: 'Review with agent' })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'The model review needs a provider.' })).toBeVisible();
});

test('the run history lists each scan, and a discard removes the run and the findings it made, and is logged', async ({ page }) => {
  await declaredAndScanned(page, 'History Book');
  await page.getByRole('tab', { name: 'Findings' }).click();

  const history = page.getByTestId('run-history');
  await expect(history.locator('[data-run]')).toHaveCount(1);
  await expect(history.locator('[data-run]').first()).toContainText('Quick scan');
  await expect(history.locator('[data-run]').first()).toContainText('2 documents');
  await expect(history.locator('[data-run]').first()).not.toContainText('2026-10-08T');

  await history.getByRole('button', { name: /Discard run from / }).click();
  await expect(history.locator('[data-run]')).toHaveCount(0);
  await expect(page.getByTestId('findings-open')).toHaveText('0 open');
  await expect.poll(() => traceNames(page)).toContain('coherence.discardRun');
});

test('the coherence report downloads as Markdown, with the findings and the run history in it', async ({ page }) => {
  await declaredAndScanned(page, 'Report Book');

  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /^Coherence report \(\.md\)/ }).check();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\(coherence report\)\.md$/);
  const text = readFileSync((await download.path()) ?? '', 'utf8');
  expect(text).toContain('# Coherence report: Report Book');
  expect(text).toContain('## Errors');
  expect(text).toContain('## Run history');
});
