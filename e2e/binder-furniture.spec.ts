import { expect, test, type Page } from '@playwright/test';

import { binderRow, binderTitle, createProject, traceNames, waitForSaved } from './support.js';

/**
 * The writing furniture (binder-filters §5, goals-progress §4, the sprint timer): the binder filter by text, a saved filter that
 * is kept across a reload, a project goal with its progress and pace in the footer, and the sprint timer. None of it changes the
 * manuscript; the assertions are on what the binder and the footer show.
 */

/** A chapter with two scenes, built from the binder the way a writer would. */
async function chapterWithScenes(page: Page): Promise<void> {
  await createProject(page, 'Furniture Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  for (const scene of ['The Lamp', 'The Harbour']) {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
    await page.keyboard.press('Enter');
    await expect(binderRow(page, scene)).toBeVisible();
  }
}

/** Opens a project from the projects screen, after a reload. */
async function reopen(page: Page, name: string): Promise<void> {
  await page.reload();
  await page.locator('.project-row', { hasText: name }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('the binder filters by text, a saved filter is kept across a reload, and goals and the sprint sit in the footer', async ({
  page,
}) => {
  await chapterWithScenes(page);

  // The filter bar narrows the tree to what matches, and says how many.
  await page.getByRole('searchbox', { name: 'Filter the binder by text' }).fill('lamp');
  await expect(binderRow(page, 'The Harbour')).toHaveCount(0);
  await expect(binderRow(page, 'The Lamp')).toBeVisible();
  await expect(page.getByTestId('filter-status')).toContainText('1 scene match');

  // Saved under a name, it is a row in the footer, applied and counted.
  await page.getByRole('button', { name: 'Save current…' }).click();
  await page.getByRole('textbox', { name: 'Filter name' }).fill('Lamp scenes');
  await page.getByRole('button', { name: 'Save filter' }).click();
  const footer = page.getByTestId('binder-footer');
  await expect(footer.getByRole('button', { name: /^Lamp scenes/ })).toHaveAttribute('aria-pressed', 'true');

  // Cleared, the whole binder comes back; the saved filter is still there after a reload, and applies again.
  await page.getByRole('button', { name: 'Clear the filter' }).click();
  await expect(binderRow(page, 'The Harbour')).toBeVisible();
  await waitForSaved(page);
  await reopen(page, 'Furniture Book');
  const again = page.getByTestId('binder-footer');
  await again.getByRole('button', { name: 'Lamp scenes', exact: true }).click();
  await expect(binderRow(page, 'The Harbour')).toHaveCount(0);
  await expect(binderRow(page, 'The Lamp')).toBeVisible();

  // Edit: the saved filter goes back into the bar, its text changes there, and saving the bar updates it under a new name.
  await again.getByRole('button', { name: 'Edit Lamp scenes' }).click();
  await page.getByRole('searchbox', { name: 'Filter the binder by text' }).fill('harbour');
  await expect(binderRow(page, 'The Lamp')).toHaveCount(0);
  await page.getByRole('button', { name: 'Update saved filter…' }).click();
  await page.getByRole('textbox', { name: 'Filter name' }).fill('Harbour scenes');
  await page.getByRole('button', { name: 'Save filter' }).click();
  await expect(again.getByRole('button', { name: /^Harbour scenes/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(again.getByRole('button', { name: /^Lamp scenes/ })).toHaveCount(0);

  // A goal on the manuscript, with a deadline: set in the manuscript's inspector, which shows its sentence, progress and pace, and
  // the binder footer keeps it as one line.
  await page.getByRole('button', { name: 'Clear the filter' }).click();
  await binderRow(page, 'Manuscript').click();
  const goals = page.getByTestId('inspector-goals');
  await goals.getByLabel('Inspector goal words').fill('1000');
  await goals.getByLabel('By (optional)').fill('2030-12-31');
  await goals.getByRole('button', { name: 'Add goal' }).click();
  await expect(goals.locator('.goal-sentence')).toContainText('at least 1,000 words on');
  await expect(goals.locator('.goal-line')).toContainText('0 of 1,000 words · in progress');
  // A pace of one word a day is written in the singular (writer copy): the whole line, so "1 words/day" fails. The date is the
  // formatter locale's (i18n.md §4.1, D3), and this suite runs a US-English browser, so it reads "Dec 31, 2030" where the footer
  // used to pin "31 Dec 2030" whatever the system said.
  await expect(goals.locator('.goal-pace')).toHaveText('≈ 1 word/day to finish by Dec 31, 2030');
  await expect(page.getByTestId('binder-footer').locator('.goal-sentence')).toContainText('at least 1,000 words on');
  await expect(page.getByTestId('binder-footer').getByTestId('goal-progress')).toContainText('0 of 1,000 words · in progress');

  // The sprint: started, it counts down; stopped by hand, it says so.
  await again.getByRole('button', { name: 'Start sprint' }).click();
  await expect(again.getByTestId('sprint-reading')).toContainText(/\d+:\d{2} left/);
  await again.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(again.getByTestId('sprint-reading')).toContainText('Stopped.');
});

test('the binder filters by status, and the status a scene has is what the filter reads', async ({ page }) => {
  await chapterWithScenes(page);

  // The Lamp is set to Revised from its binder chip: one binder.setMeta, and the chip shows it.
  await binderRow(page, 'The Lamp').getByRole('button', { name: /^Status of The Lamp/ }).click();
  await page.getByRole('menuitemradio', { name: 'Revised' }).click();
  await expect(binderRow(page, 'The Lamp').getByRole('button', { name: /^Status of The Lamp/ })).toContainText('Revised');
  await expect.poll(() => traceNames(page)).toContain('binder.setMeta');

  // Filtered to Revised, only that scene shows, and the bar says how many matched.
  const status = page.getByRole('combobox', { name: 'Status filter' });
  await status.selectOption({ label: 'Revised' });
  await expect(binderRow(page, 'The Harbour')).toHaveCount(0);
  await expect(binderRow(page, 'The Lamp')).toBeVisible();
  await expect(page.getByTestId('filter-status')).toContainText('1 scene match');

  // Filtered to Final, nothing matches: the empty state says so and offers the way back.
  await status.selectOption({ label: 'Final' });
  await expect(binderRow(page, 'The Lamp')).toHaveCount(0);
  await expect(binderRow(page, 'The Harbour')).toHaveCount(0);
  await expect(page.getByText('No scenes match', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(binderRow(page, 'The Harbour')).toBeVisible();
  await expect(binderRow(page, 'The Lamp')).toBeVisible();

  // The status is part of the project: after a reload the chip still says Revised, and the filter still finds the scene.
  await waitForSaved(page);
  await reopen(page, 'Furniture Book');
  await expect(binderRow(page, 'The Lamp').getByRole('button', { name: /^Status of The Lamp/ })).toContainText('Revised');
  await page.getByRole('combobox', { name: 'Status filter' }).selectOption({ label: 'Revised' });
  await expect(binderRow(page, 'The Harbour')).toHaveCount(0);
  await expect(binderRow(page, 'The Lamp')).toBeVisible();
});

test('the binder filters by word count, and a saved word bound is kept across a reload', async ({ page }) => {
  await chapterWithScenes(page);

  // The Lamp has five words, the Harbour one, so one bound separates them.
  await binderTitle(page, 'The Lamp').click();
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.type('One two three four five.');
  await waitForSaved(page);
  await binderTitle(page, 'The Harbour').click();
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.type('Sea.');
  await waitForSaved(page);

  await page.getByRole('spinbutton', { name: 'Minimum words' }).fill('3');
  await expect(binderRow(page, 'The Harbour')).toHaveCount(0);
  await expect(binderRow(page, 'The Lamp')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Minimum words' }).fill('');
  await page.getByRole('spinbutton', { name: 'Maximum words' }).fill('2');
  await expect(binderRow(page, 'The Lamp')).toHaveCount(0);
  await expect(binderRow(page, 'The Harbour')).toBeVisible();
  await expect(page.getByTestId('filter-status')).toContainText('1 scene match');

  // Saved with its bound, the filter is a row in the footer; after a reload it applies again, and the bound is in the bar.
  await page.getByRole('button', { name: 'Save current…' }).click();
  await page.getByRole('textbox', { name: 'Filter name' }).fill('Short scenes');
  await page.getByRole('button', { name: 'Save filter' }).click();
  await waitForSaved(page);
  await reopen(page, 'Furniture Book');
  const footer = page.getByTestId('binder-footer');
  await footer.getByRole('button', { name: 'Short scenes', exact: true }).click();
  await expect(binderRow(page, 'The Lamp')).toHaveCount(0);
  await expect(binderRow(page, 'The Harbour')).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Maximum words' })).toHaveValue('2');
});

test('Chinese text is counted by words: the footer, the word filter and the daily target agree', async ({ page }) => {
  // The browser's own segmenter, so the expectation does not pin one engine's dictionary.
  const text = '我喜欢在海边的灯塔里写作，每天清晨都会出发。';
  const expected = await page.evaluate((body) => {
    let n = 0;
    for (const part of new Intl.Segmenter('und', { granularity: 'word' }).segment(body)) if (part.isWordLike) n++;
    return n;
  }, text);
  expect(expected).toBeGreaterThan(1);

  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Writing' }).click();
  await settings.getByLabel('Daily target, in words (0 for none)').fill(String(expected));
  await settings.getByRole('button', { name: 'Save writing settings' }).click();
  await expect(settings.getByText(/Saved\. The save delay/)).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();

  await chapterWithScenes(page);
  await binderTitle(page, 'The Lamp').click();
  await page.getByRole('textbox', { name: 'Document text' }).fill(text);
  await waitForSaved(page);

  await expect(page.locator('.editor-count')).toHaveText(`${expected} words`);
  await expect(page.getByTestId('session-target')).toContainText(`${expected} / ${expected} words today`);

  // The word filter reads the same number: the Harbour is empty, the Lamp holds `expected` words.
  await page.getByRole('spinbutton', { name: 'Minimum words' }).fill(String(expected));
  await expect(binderRow(page, 'The Harbour')).toHaveCount(0);
  await expect(binderRow(page, 'The Lamp')).toBeVisible();
});

test('a goal is added and removed in the inspector of the manuscript, and the removal is kept across a reload', async ({ page }) => {
  await chapterWithScenes(page);

  await binderRow(page, 'Manuscript').click();
  const goals = page.getByTestId('inspector-goals');
  await goals.getByLabel('Inspector goal words').fill('500');
  await goals.getByRole('button', { name: 'Add goal' }).click();
  await expect(goals.locator('.goal-sentence')).toContainText('at least 500 words on');

  // The goal is a manifest entry (goals-progress §3), so it is kept by the project: after a reload the footer's one line still shows it.
  await reopen(page, 'Furniture Book');
  await expect(page.getByTestId('binder-footer').locator('.goal-sentence')).toContainText('at least 500 words on');

  // Removed in the inspector, the goal leaves the footer, and the removal is kept across a reload.
  await binderRow(page, 'Manuscript').click();
  await page.getByTestId('inspector-goals').getByRole('button', { name: /^Remove the goal/ }).click();
  await expect(page.getByTestId('binder-footer').locator('.goal-sentence')).toHaveCount(0);
  await reopen(page, 'Furniture Book');
  await expect(page.getByTestId('binder-footer').locator('.goal-sentence')).toHaveCount(0);
});
