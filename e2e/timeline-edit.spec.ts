import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile, type SceneMeta } from '../packages/coherence/src/index.js';
import { addDocument, addFolder, createEmptyManifest, createProjectState, exportProjectZip } from '../packages/store/src/index.js';

import { binderTitle } from './support.js';

/**
 * Editing on the timeline (timeline.md §4), through the page: every gesture and its keyboard alternative proposes, the tray holds the
 * proposals, and nothing reaches the project until Apply, which is one step to undo. The projects are made in Node with the store's own
 * primitives and opened as a bundle, as `timeline-view.spec.ts` does.
 */

const NOW = new Date('2026-10-01T09:00:00.000Z');

const assigned = new Map<string, string>();

function nodeId(key: string): string {
  let id = assigned.get(key);
  if (id === undefined) {
    id = `n_K${String(assigned.size + 1).padStart(9, '0')}`;
    assigned.set(key, id);
  }
  return id;
}

interface SceneSpec {
  readonly id: string;
  readonly title: string;
  readonly parent?: string;
  readonly meta?: SceneMeta;
}

interface BookSpec {
  readonly name: string;
  readonly folders?: readonly { readonly id: string; readonly title: string }[];
  readonly scenes: readonly SceneSpec[];
}

async function openBook(page: Page, testInfo: TestInfo, spec: BookSpec): Promise<void> {
  const manifest = createEmptyManifest(spec.name, NOW, { locale: 'en-US' });
  const state = createProjectState(manifest, { now: NOW });
  for (const folder of spec.folders ?? []) addFolder(state, { id: nodeId(folder.id), parentId: 'manuscript', title: folder.title, now: NOW });
  const sceneMeta: Record<string, SceneMeta> = {};
  for (const scene of spec.scenes) {
    addDocument(state, { id: nodeId(scene.id), parentId: scene.parent === undefined ? 'manuscript' : nodeId(scene.parent), title: scene.title, body: `${scene.title} is written here.`, now: NOW });
    if (scene.meta !== undefined) sceneMeta[nodeId(scene.id)] = scene.meta;
  }
  const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta, findings: [] };
  const bundle = await exportProjectZip(state, { now: NOW, coherence: serializeCoherenceFile(file) });
  const path = testInfo.outputPath(`${spec.name.replace(/\W+/g, '-')}.caotang`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bundle.bytes);
  await page.goto('/');
  await page.getByTestId('bundle-input').setInputFiles(path);
  await expect(page.getByRole('heading', { name: spec.name, level: 1 })).toBeVisible();
}

async function openTimeline(page: Page): Promise<Locator> {
  await page.locator('#center-timeline').click();
  const view = page.getByTestId('timeline-view');
  await expect(view).toBeVisible();
  return view;
}

const cell = (page: Page, key: string): Locator => page.locator(`[role="gridcell"][data-node="${nodeId(key)}"]`).first();
const tray = (page: Page): Locator => page.getByTestId('timeline-tray');
const live = (page: Page): Locator => page.getByTestId('timeline-live');
const applyAll = (page: Page): Locator => tray(page).getByRole('button', { name: /^Apply \d+ changes?$/ });
const applySelected = (page: Page): Locator => tray(page).getByRole('button', { name: /^Apply selected/ });

const MINUS = '\u2212';

const STORY: BookSpec = {
  name: 'Edit Book',
  scenes: [
    { id: 'pro', title: 'Before the storm', meta: { dayOffset: -400, storyPart: 'prologue' } },
    { id: 'm1', title: 'Arrival', meta: { dayOffset: 0 } },
    { id: 'm2', title: 'The letter', meta: { dayOffset: 1, after: [nodeId('m1')] } },
    { id: 'm3', title: 'The quarrel', meta: { dayOffset: 2 } },
    { id: 'm4', title: 'Departure', meta: { dayOffset: 6 } },
    { id: 'loose', title: 'A scene without a day' },
  ],
};

/** The project's own words for a scene, from the grid: they come from the model, so a proposal never changes them. */
async function dayOf(page: Page, key: string): Promise<string> {
  const label = (await cell(page, key).getAttribute('aria-label')) ?? '';
  return /Day [\u2212-]?\d+(?:,\d{3})*/.exec(label)?.[0] ?? label;
}

async function undo(page: Page): Promise<void> {
  await page.locator('body').press('Control+z');
}

test.describe('the keyboard alternatives', () => {
  test('Alt+arrows propose days, nothing is written until Apply, and one Undo takes the batch back', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    await expect(tray(page)).toHaveCount(0);

    const m2 = cell(page, 'm2');
    await m2.focus();
    expect(await dayOf(page, 'm2')).toBe('Day 1');
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(tray(page)).toBeVisible();
    await expect(tray(page).locator('[data-row]')).toHaveCount(1);
    await expect(tray(page)).toContainText('The letter');
    await expect(tray(page)).toContainText('Day 1 \u2192 Day 3');
    await expect(m2).toHaveAttribute('aria-label', /1 proposed change/);
    await expect(live(page)).toContainText('Added to the proposed changes');
    // The scene is as it was: the project still says day 1.
    expect(await dayOf(page, 'm2')).toBe('Day 1');

    // Both directions, a week with Shift.
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await expect(tray(page)).toContainText('Day 1 \u2192 Day \u22124');
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect(tray(page)).toContainText('Day 1 \u2192 Day 3');

    await applyAll(page).click();
    await expect(live(page)).toContainText('1 change applied. Undo restores it.');
    await expect(tray(page)).toHaveCount(0);
    // The tray took the pressed button with it; focus goes back to the scene the writer was working on, not to the page.
    await expect(cell(page, 'm2')).toBeFocused();
    await expect.poll(() => dayOf(page, 'm2')).toBe('Day 3');

    await undo(page);
    await expect.poll(() => dayOf(page, 'm2')).toBe('Day 1');
    await undo(page);
    await expect(page.getByText('There is nothing to undo.')).toBeVisible();
  });

  test('several rows apply as one change and one Undo takes all of them back', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    await cell(page, 'm1').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await cell(page, 'm3').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await cell(page, 'm4').focus();
    await page.keyboard.press('Alt+]');
    await expect(tray(page).locator('[data-row]:not(.is-suggestion)')).toHaveCount(3);
    await expect(applyAll(page)).toHaveText(/Apply 3 changes/);
    await applyAll(page).click();
    await expect(live(page)).toContainText('3 changes applied');
    await expect.poll(() => dayOf(page, 'm1')).toBe('Day 1');
    await expect.poll(() => dayOf(page, 'm3')).toBe('Day 1');
    await undo(page);
    await expect.poll(() => dayOf(page, 'm1')).toBe('Day 0');
    await expect.poll(() => dayOf(page, 'm3')).toBe('Day 2');
    await expect.poll(() => dayOf(page, 'm4')).toBe('Day 6');
  });

  test('a row can be removed or discarded, and the Delete key on a scene removes its proposal', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    await cell(page, 'm3').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(tray(page)).toBeVisible();
    await page.keyboard.press('Delete');
    await expect(tray(page)).toHaveCount(0);
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Alt+ArrowLeft');
    // A nudge back to the base value leaves nothing to apply.
    await expect(tray(page)).toHaveCount(0);
    await cell(page, 'm3').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await tray(page).getByRole('button', { name: /^Remove change 1/ }).click();
    await expect(tray(page)).toHaveCount(0);
    await expect(cell(page, 'm3')).toBeFocused();
    await cell(page, 'm3').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await tray(page).getByRole('button', { name: 'Discard all' }).click();
    await expect(tray(page)).toHaveCount(0);
    await expect(cell(page, 'm3')).toBeFocused();
  });

  test('the part, a typed day, a must-follow link and a shift are proposed from the scene menu', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    await cell(page, 'm4').focus();
    await page.getByRole('button', { name: /^Change a scene/ }).click();
    await page.getByRole('button', { name: 'Make epilogue' }).click();
    await expect(tray(page)).toContainText(/‘Departure’ \(epilogue\)/);
    await expect(tray(page)).toContainText('Main story \u2192 Epilogue');

    await cell(page, 'm3').focus();
    await page.getByRole('button', { name: /^Change a scene/ }).click();
    await page.getByRole('button', { name: /^Set day/ }).click();
    await page.getByRole('textbox', { name: 'Day for this scene' }).fill(`${MINUS}3`);
    await page.getByRole('textbox', { name: 'Day for this scene' }).press('Enter');
    await expect(tray(page)).toContainText(`Day 2 \u2192 Day ${MINUS}3`);

    await cell(page, 'm1').focus();
    await page.getByRole('button', { name: /^Change a scene/ }).click();
    await page.getByRole('button', { name: /^Must follow/ }).click();
    await page.getByRole('searchbox', { name: 'Find the scene it must follow' }).fill('quarrel');
    await page.getByRole('button', { name: 'The quarrel', exact: true }).click();
    await expect(tray(page)).toContainText('must follow');

    await page.getByRole('button', { name: /^Change a scene/ }).click();
    await page.getByRole('button', { name: /^Shift all days/ }).click();
    await page.getByRole('textbox', { name: /^Days to shift by/ }).fill('5');
    await page.getByRole('textbox', { name: /^Days to shift by/ }).press('Enter');
    await expect(tray(page)).toContainText('Shift');
    await expect(tray(page).locator('[data-kind="shift"]').getByRole('textbox', { name: /^Days to shift for change/ })).toHaveValue('5');
    await expect(applyAll(page)).toBeEnabled();
  });

  test('Alt+R places a scene some days after another, and Alt+Up and Alt+Down need a grouping to change lane', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    await cell(page, 'm4').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(live(page)).toContainText('There is no lane to change to');
    await page.keyboard.press('Alt+r');
    await page.getByRole('textbox', { name: 'Days after the other scene ends' }).count();
    await page.getByRole('searchbox', { name: 'Find the scene to place it after' }).fill('Arrival');
    await page.getByRole('button', { name: 'Arrival', exact: true }).click();
    await expect(tray(page)).toContainText('Departure');
  });
});

test.describe('the pointer', () => {
  test('a drag needs four pixels, shows one ghost, Esc cancels it, and a drop proposes the day', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    const first = (await cell(page, 'm1').boundingBox())!;
    const second = (await cell(page, 'm2').boundingBox())!;
    const perDay = second.x - first.x;
    const box = (await cell(page, 'm3').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const ghost = page.getByTestId('timeline-drag-ghost');

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 3, y);
    await expect(ghost).toBeHidden();
    await page.mouse.move(x + perDay * 2, y, { steps: 6 });
    await expect(ghost).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ghost).toBeHidden();
    await page.mouse.up();
    await expect(tray(page)).toHaveCount(0);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + perDay * 2, y, { steps: 6 });
    await expect(ghost).toBeVisible();
    await page.mouse.up();
    await expect(ghost).toBeHidden();
    await expect(tray(page)).toContainText('The quarrel');
    await expect(tray(page)).toContainText('Day 2 \u2192 Day 4');
    await expect(page.locator('.tl-ghost')).toHaveCount(1);
    expect(await dayOf(page, 'm3')).toBe('Day 2');
  });

  test('a drag on the background or with the middle button pans, and proposes nothing', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const scenes: SceneSpec[] = Array.from({ length: 28 }, (_, at) => ({ id: `p${at}`, title: `Scene ${at}`, meta: { dayOffset: at } }));
    await openBook(page, testInfo, { name: 'Wide Book', scenes });
    await openTimeline(page);
    const scroll = page.getByTestId('timeline-scroll');
    const area = (await scroll.boundingBox())!;
    const position = (): Promise<number> => scroll.evaluate((el) => el.scrollLeft);
    expect(await position()).toBe(0);
    const y = area.y + area.height - 10;
    await page.mouse.move(area.x + 300, y);
    await page.mouse.down();
    await page.mouse.move(area.x + 100, y, { steps: 5 });
    await page.mouse.up();
    expect(await position()).toBeGreaterThan(100);
    const before = await position();

    const chip = (await cell(page, 'p3').boundingBox())!;
    const cx = Math.min(Math.max(chip.x + chip.width / 2, area.x + 20), area.x + area.width - 20);
    await page.mouse.move(cx, chip.y + chip.height / 2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(cx + 80, chip.y + chip.height / 2, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
    expect(await position()).toBeLessThan(before);
    await expect(tray(page)).toHaveCount(0);
  });

  test('a scene from the shelf dropped on the axis proposes its day', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    const item = page.getByTestId('timeline-shelf').getByRole('button', { name: /A scene without a day/ });
    const from = (await item.boundingBox())!;
    const target = (await cell(page, 'm3').boundingBox())!;
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 4, target.y + target.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(tray(page)).toContainText('A scene without a day');
    await expect(tray(page)).toContainText('no day \u2192 Day');
  });
});

test.describe('the tray', () => {
  test('Apply selected applies the checked rows and leaves the rest; a suggested follow-up starts unchecked', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    await cell(page, 'm1').focus();
    for (let at = 0; at < 3; at += 1) await page.keyboard.press('Alt+ArrowRight');
    await cell(page, 'm4').focus();
    await page.keyboard.press('Alt+ArrowRight');

    // m1 moved to day 3 and "The letter" must follow it: a follow-up is suggested, unchecked, and not counted in Apply.
    const suggestion = tray(page).locator('.tl-suggestions [data-row]');
    await expect(suggestion).toHaveCount(1);
    await expect(suggestion).toContainText('The letter');
    await expect(suggestion.getByRole('checkbox')).not.toBeChecked();
    await expect(applyAll(page)).toHaveText('Apply 2 changes');

    await tray(page).getByRole('button', { name: 'Check all suggestions' }).click();
    await expect(applyAll(page)).toHaveText('Apply 3 changes');
    await expect(applySelected(page)).toHaveText('Apply selected (3)');

    // Uncheck the departure row: Apply selected takes the other two and leaves it in the tray.
    await tray(page).locator('[data-row]', { hasText: 'Departure' }).getByRole('checkbox').uncheck();
    await expect(applySelected(page)).toHaveText('Apply selected (2)');
    await applySelected(page).click();
    await expect(live(page)).toContainText('2 changes applied');
    await expect(tray(page).locator('[data-row]')).toHaveCount(1);
    await expect(tray(page)).toContainText('Departure');
    await expect.poll(() => dayOf(page, 'm1')).toBe('Day 3');
    await expect.poll(() => dayOf(page, 'm2')).toBe('Day 3');
    expect(await dayOf(page, 'm4')).toBe('Day 6');
    // One Undo took the whole selected batch.
    await undo(page);
    await expect.poll(() => dayOf(page, 'm1')).toBe('Day 0');
    await expect.poll(() => dayOf(page, 'm2')).toBe('Day 1');
  });

  test('the what-if delta follows the rows after a pause and names what they would resolve or raise', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    await cell(page, 'm1').focus();
    for (let at = 0; at < 3; at += 1) await page.keyboard.press('Alt+ArrowRight');
    await tray(page).getByRole('button', { name: 'Check all suggestions' }).click();
    const whatIf = page.getByTestId('timeline-whatif');
    await expect(whatIf).toContainText(/Resolves \d+ finding/, { timeout: 5000 });
    await expect(whatIf).toContainText(/New: \d+ finding/);
  });

  test('leaving the timeline with rows asks first: Cancel keeps them, and leaving discards them', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await openTimeline(page);
    await cell(page, 'm2').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(tray(page)).toBeVisible();

    await page.locator('#center-editor').click();
    const dialog = page.getByRole('dialog', { name: /Leave with proposed timeline changes/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#center-timeline')).toHaveAttribute('aria-checked', 'true');
    await expect(tray(page)).toBeVisible();

    await page.locator('#center-editor').click();
    await dialog.getByRole('button', { name: /^Discard the changes and leave/ }).click();
    await expect(page.locator('#center-editor')).toHaveAttribute('aria-checked', 'true');
    await openTimeline(page);
    await expect(tray(page)).toHaveCount(0);
    expect(await dayOf(page, 'm2')).toBe('Day 1');
  });

  test('a change made under the tray marks its row out of date until it is read again', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await binderTitle(page, 'The quarrel').click();
    await openTimeline(page);
    await cell(page, 'm3').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(tray(page)).toContainText('Day 2 \u2192 Day 3');

    await page.getByTestId('scene-meta').locator('summary').click();
    await page.getByRole('spinbutton', { name: 'Day offset' }).fill('9');
    await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');

    await expect(tray(page)).toContainText('changed since it was proposed');
    await expect(applyAll(page)).toBeDisabled();
    await tray(page).getByRole('button', { name: 'Read again' }).click();
    await expect(tray(page)).toContainText('Day 9 \u2192 Day 3');
    await expect(applyAll(page)).toBeEnabled();
    await applyAll(page).click();
    await expect.poll(() => dayOf(page, 'm3')).toBe('Day 3');
  });
});

test.describe('the Agenda', () => {
  async function openAgenda(page: Page): Promise<Locator> {
    const view = await openTimeline(page);
    await view.getByRole('radio', { name: 'Agenda' }).click();
    const agenda = page.getByTestId('timeline-agenda');
    await expect(agenda).toBeVisible();
    return agenda;
  }
  const agendaDay = async (agenda: Locator, title: string): Promise<string> => {
    const label = (await agenda.getByRole('button', { name: new RegExp(title) }).first().getAttribute('aria-label')) ?? '';
    return /Day [\u2212-]?\d+(?:,\d{3})*/.exec(label)?.[0] ?? label;
  };

  test('witness: sort, edit a signed day and a part by keyboard, see the delta, apply selected and undo, with no mutation before Apply', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    const agenda = await openAgenda(page);

    // Sort by keyboard.
    const dayHeader = agenda.getByRole('columnheader', { name: 'Day', exact: true });
    await dayHeader.getByRole('button').focus();
    await page.keyboard.press('Enter');
    await expect(dayHeader).toHaveAttribute('aria-sort', 'ascending');
    await page.keyboard.press('Enter');
    await expect(dayHeader).toHaveAttribute('aria-sort', 'descending');

    // The end day, the reading index and the findings are not editable.
    await expect(agenda.getByRole('textbox', { name: /^Ends/ })).toHaveCount(0);

    // A signed day, typed with the real minus sign.
    const day = agenda.getByRole('textbox', { name: 'Day for Arrival' });
    await day.focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(`${MINUS}14`);
    await page.keyboard.press('Enter');
    // A part, by the arrow keys on the select.
    const part = agenda.getByRole('combobox', { name: 'Story part for Departure' });
    await part.focus();
    await page.keyboard.press('ArrowDown');
    await expect(part).not.toHaveValue('');

    const tray = page.getByTestId('timeline-tray');
    await expect(tray.locator('[data-row]:not(.is-suggestion)')).toHaveCount(2);
    await expect(tray).toContainText(`Day 0 \u2192 Day ${MINUS}14`);
    await expect(tray).toContainText('Departure');
    // Nothing has been written: the project still says day 0.
    expect(await agendaDay(agenda, 'Arrival')).toBe('Day 0');
    await expect(agenda.getByTestId('agenda-proposed').filter({ hasText: 'Change 1' })).toHaveCount(1);

    // The delta is inspectable, and Apply selected takes the checked rows only.
    await expect(page.getByTestId('timeline-whatif')).toContainText(/finding/, { timeout: 5000 });
    await tray.getByRole('checkbox', { name: /Include change 2/ }).uncheck();
    await applySelected(page).click();
    await expect(live(page)).toContainText(/change applied/);
    await expect.poll(() => agendaDay(agenda, 'Arrival')).toBe(`Day ${MINUS}14`);
    await expect(tray.locator('[data-row]')).toHaveCount(1);

    await undo(page);
    await expect.poll(() => agendaDay(agenda, 'Arrival')).toBe('Day 0');
  });

  test('witness with a stale base: a change made elsewhere is found, the row is read again, and only then applied', async ({ page }, testInfo) => {
    await openBook(page, testInfo, STORY);
    await binderTitle(page, 'The quarrel').click();
    const agenda = await openAgenda(page);
    const day = agenda.getByRole('textbox', { name: 'Day for The quarrel' });
    await day.focus();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(`${MINUS}2`);
    await page.keyboard.press('Enter');
    const tray = page.getByTestId('timeline-tray');
    await expect(tray).toContainText(`Day 2 \u2192 Day ${MINUS}2`);

    await page.getByTestId('scene-meta').locator('summary').click();
    await page.getByRole('spinbutton', { name: 'Day offset' }).fill('8');
    await page.getByRole('spinbutton', { name: 'Day offset' }).press('Enter');

    await expect(tray).toContainText('changed since it was proposed');
    await expect(applySelected(page)).toBeDisabled();
    await tray.getByRole('button', { name: 'Read again' }).click();
    await expect(tray).toContainText(`Day 8 \u2192 Day ${MINUS}2`);
    await applySelected(page).click();
    await expect.poll(() => agendaDay(agenda, 'The quarrel')).toBe(`Day ${MINUS}2`);
    await undo(page);
    await expect.poll(() => agendaDay(agenda, 'The quarrel')).toBe('Day 8');
  });

  test('under forced colours and reduced motion the Agenda comes first and is as editable as the timeline', async ({ page }, testInfo) => {
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await openBook(page, testInfo, STORY);
    await page.locator('#center-timeline').click();
    const agenda = page.getByTestId('timeline-agenda');
    await expect(agenda).toBeVisible();
    await agenda.getByRole('textbox', { name: 'Days long for Arrival' }).fill('3');
    await agenda.getByRole('textbox', { name: 'Days long for Arrival' }).press('Enter');
    const tray = page.getByTestId('timeline-tray');
    await expect(tray).toContainText('length 0 days \u2192 3 days');
    await expect(tray).toBeVisible();
    await applyAll(page).click();
    await expect(live(page)).toContainText('1 change applied');
    // The skip link and the radio group still lead back to the timeline.
    await page.getByTestId('timeline-view').getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.getByRole('grid', { name: /Timeline/ })).toBeVisible();
    await expect(page.locator('.tl-ghost')).toHaveCount(0);
  });
});

test.describe('the Inspector controls the timeline reads', () => {
  test('a negative day reads as "Day \u221214", and the Story part is a select on a scene and on a folder', async ({ page }, testInfo) => {
    await openBook(page, testInfo, {
      name: 'Inspector Book',
      folders: [{ id: 'ch', title: 'Chapter One' }],
      scenes: [{ id: 'sc', title: 'The opening', parent: 'ch', meta: { dayOffset: 3 } }],
    });
    await binderTitle(page, 'The opening').click();
    await page.getByTestId('scene-meta').locator('summary').click();
    const day = page.getByRole('spinbutton', { name: 'Day offset' });
    await day.fill('-14');
    await day.press('Enter');
    await expect(page.getByTestId('day-reading')).toContainText(new RegExp(`Day .?${MINUS}14`));
    const sceneSelect = page.getByTestId('story-part');
    await expect(sceneSelect).toBeVisible();
    await sceneSelect.selectOption('prologue');
    await expect(sceneSelect).toHaveValue('prologue');
    await sceneSelect.selectOption('');
    await expect(sceneSelect).toHaveValue('');

    await binderTitle(page, 'Chapter One').click();
    const folder = page.getByTestId('folder-part').getByRole('combobox', { name: 'Story part' });
    await expect(folder).toBeVisible();
    await folder.selectOption('epilogue');
    await expect(folder).toHaveValue('epilogue');
  });
});
