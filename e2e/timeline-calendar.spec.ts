import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile, type SceneMeta } from '../packages/coherence/src/index.js';
import { addDocument, createEmptyManifest, createProjectState, exportProjectZip } from '../packages/store/src/index.js';

import { projectTrace, withoutIsolates } from './support.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');

const ids = new Map<string, string>();
function nodeId(key: string): string {
  let id = ids.get(key);
  if (id === undefined) {
    id = `n_C${String(ids.size + 1).padStart(9, '0')}`;
    ids.set(key, id);
  }
  return id;
}

const SCENES: readonly { id: string; title: string; day: number }[] = [
  { id: 'a', title: 'Arrival', day: 0 },
  { id: 'b', title: 'The letter', day: 1 },
  { id: 'c', title: 'The quarrel', day: 12 },
  { id: 'e', title: 'The feast', day: 31 },
  { id: 'd', title: 'Departure', day: 40 },
];

async function openBook(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const state = createProjectState(createEmptyManifest(name, NOW, { locale: 'en-US' }), { now: NOW });
  const sceneMeta: Record<string, SceneMeta> = {};
  for (const scene of SCENES) {
    addDocument(state, { id: nodeId(scene.id), parentId: 'manuscript', title: scene.title, body: `${scene.title} is written here.`, now: NOW });
    sceneMeta[nodeId(scene.id)] = { dayOffset: scene.day };
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

const cell = (page: Page, key: string): Locator => page.locator(`[role="gridcell"][data-node="${nodeId(key)}"]`).first();

/**
 * The project's own calendar (timeline.md §3.8), through the dialog: a writer types a calendar with months of their own, an extra
 * stretch of days and an era, is told at once what is wrong and how it would name a few days, saves it as the lens, sees the timeline
 * name every day with it, edits it, and finds it after the project is closed and opened again. The scenes' stored days are numbers
 * throughout: the calendar only names them.
 */

const calendar = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify(
    {
      version: 1,
      id: 'ember-reckoning',
      name: 'Ember Reckoning',
      yearZero: 'include',
      epoch: { year: 100, month: 1, day: 1 },
      months: [
        { name: 'Ember', days: 10 },
        { name: 'Cinder', days: 20 },
      ],
      intercalary: [{ name: 'Feast', days: 2, after: 2 }],
      eras: [{ name: 'EA' }],
      ...overrides,
    },
    null,
    2,
  );

const label = async (page: Page, key: string): Promise<string> => (await cell(page, key).getAttribute('aria-label')) ?? '';

async function openCalendar(page: Page): Promise<Locator> {
  await page.getByTestId('timeline-calendar').click();
  const dialog = page.getByTestId('calendar-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a custom calendar is written, checked, saved, used on the timeline, edited and kept after the project is reopened', async ({ page }, testInfo) => {
  await openBook(page, testInfo, 'Calendar Book');
  await page.locator('#center-timeline').click();
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await expect(cell(page, 'c')).toHaveAttribute('aria-label', /Day 12,/);

  const dialog = await openCalendar(page);
  const box = dialog.getByRole('textbox', { name: 'Calendar definition' });
  const save = dialog.getByTestId('calendar-save');
  const status = dialog.getByRole('status');
  await dialog.getByRole('radio', { name: 'The project calendar below' }).check();
  await expect(box).toHaveValue('');
  await expect(status).toContainText('There is no calendar yet.');
  await expect(save).toBeDisabled();

  // What is typed is checked as it is typed: first it is not JSON, then it is JSON that is not yet a calendar, then it is one.
  await box.fill('{ "version": 1, ');
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await expect(status).toContainText('This is not valid JSON, so it cannot be a calendar yet');
  await expect(save).toBeDisabled();

  await box.fill(calendar({ months: [{ name: 'Ember', days: 0 }, { name: 'Cinder', days: 20 }] }));
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await expect(status).toContainText('This calendar cannot be used yet.');
  await expect(status.getByRole('listitem').first()).toContainText('months[0].days');
  await expect(save).toBeDisabled();

  await box.fill(calendar());
  await expect(box).toHaveAttribute('aria-invalid', 'false');
  const preview = dialog.getByTestId('calendar-preview');
  await expect(preview).toContainText('Day 0 is');
  expect(withoutIsolates(await preview.innerText())).toBe(
    ['Day 0 is 1 Ember, 100 EA', 'Day 1 is 2 Ember, 100 EA', 'Day 30 is Feast 1, 100 EA', 'Day 365 is 4 Cinder, 111 EA'].join('\n'),
  );
  await expect(save).toBeEnabled();

  // Nothing is written until Save, and Cancel leaves the project as it was.
  await dialog.getByTestId('calendar-cancel').click();
  await expect(dialog).toBeHidden();
  expect(await projectTrace(page)).toEqual([]);
  await expect(cell(page, 'c')).toHaveAttribute('aria-label', /Day 12,/);

  // The dialog opens again empty, and Save is one command.
  const again = await openCalendar(page);
  await again.getByRole('radio', { name: 'The project calendar below' }).check();
  await again.getByRole('textbox', { name: 'Calendar definition' }).fill(calendar());
  await again.getByTestId('calendar-save').click();
  await expect(again).toBeHidden();
  expect(await projectTrace(page)).toEqual(['project.setCalendar']);

  // Every scene is named by the calendar: day 0, a day inside Cinder, the days outside any month, and the next year.
  await expect(cell(page, 'a')).toHaveAttribute('aria-label', /1 Ember, 100 EA,/);
  await expect(cell(page, 'c')).toHaveAttribute('aria-label', /3 Cinder, 100 EA,/);
  await expect(cell(page, 'e')).toHaveAttribute('aria-label', /Feast 2, 100 EA,/);
  await expect(cell(page, 'd')).toHaveAttribute('aria-label', /9 Ember, 101 EA,/);

  // A proposal is read and written in the same words, and what it stores is still a day number.
  await cell(page, 'b').focus();
  await page.keyboard.press('Alt+ArrowRight');
  const tray = page.getByTestId('timeline-tray');
  await expect(tray).toContainText('2 Ember, 100 EA \u2192 3 Ember, 100 EA');
  await tray.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect(cell(page, 'b')).toHaveAttribute('aria-label', /3 Ember, 100 EA,/);

  // Editing the definition renames the days at once and keeps the stored numbers.
  const edit = await openCalendar(page);
  const editBox = edit.getByRole('textbox', { name: 'Calendar definition' });
  await expect(editBox).toHaveValue(/"id": "ember-reckoning"/);
  await expect(edit.getByRole('radio', { name: 'The project calendar below' })).toBeChecked();
  await editBox.fill(calendar({ name: 'Ash Reckoning', months: [{ name: 'Ember', days: 10 }, { name: 'Dusk', days: 20 }] }));
  await edit.getByTestId('calendar-save').click();
  await expect(edit).toBeHidden();
  await expect(cell(page, 'c')).toHaveAttribute('aria-label', /3 Dusk, 100 EA,/);
  expect(await projectTrace(page)).toEqual(['project.setCalendar', 'timeline.apply', 'project.setCalendar']);

  // Choosing day numbers again keeps the calendar for later, and the days are the numbers they always were.
  const back = await openCalendar(page);
  await back.getByRole('radio', { name: 'Day numbers' }).check();
  await back.getByTestId('calendar-save').click();
  await expect(back).toBeHidden();
  expect(await label(page, 'c')).toContain('Day 12,');
  expect(await label(page, 'b')).toContain('Day 2,');
  const kept = await openCalendar(page);
  await expect(kept.getByTestId('calendar-remove')).toBeVisible();
  await kept.getByRole('radio', { name: 'The project calendar below' }).check();
  await expect(kept.getByRole('textbox', { name: 'Calendar definition' })).toHaveValue(/"name": "Ash Reckoning"/);
  await kept.getByTestId('calendar-save').click();
  await expect(cell(page, 'c')).toHaveAttribute('aria-label', /3 Dusk, 100 EA,/);

  // The choice and the definition are the project's own: they are there after the project is closed and opened again.
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Calendar Book' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await page.locator('#center-timeline').click();
  await expect(cell(page, 'c')).toHaveAttribute('aria-label', /3 Dusk, 100 EA,/);
  await expect(cell(page, 'b')).toHaveAttribute('aria-label', /3 Ember, 100 EA,/);
  const reopened = await openCalendar(page);
  await expect(reopened.getByRole('textbox', { name: 'Calendar definition' })).toHaveValue(/"name": "Ash Reckoning"/);

  // Removing the calendar returns the days to numbers, and the scenes still hold the same days.
  await reopened.getByTestId('calendar-remove').click();
  await expect(reopened).toBeHidden();
  await expect(cell(page, 'c')).toHaveAttribute('aria-label', /Day 12,/);
  await expect(cell(page, 'b')).toHaveAttribute('aria-label', /Day 2,/);
});