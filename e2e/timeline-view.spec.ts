import { readFileSync, writeFileSync } from 'node:fs';

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile, type Finding, type SceneMeta } from '../packages/coherence/src/index.js';
import { addDocument, addFolder, createEmptyManifest, createProjectState, exportProjectZip } from '../packages/store/src/index.js';

/**
 * The timeline in the desktop app (timeline.md §3.3, §4.6, §5.2, §6, §7), through the page. The projects are made in Node with
 * the store's own primitives, packed as a bundle and opened the way a writer opens one, so the view reads exactly what a saved
 * project holds. Nothing here needs a provider.
 */

const NOW = new Date('2026-10-01T09:00:00.000Z');

const assigned = new Map<string, string>();

/** A node id the store accepts (`n_` and ten base32 characters) for a name the test can read. */
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
  readonly language?: string;
  readonly folders?: readonly { readonly id: string; readonly title: string }[];
  readonly scenes: readonly SceneSpec[];
  readonly findings?: readonly Finding[];
}

/** A finding id the coherence file accepts (`f_` and ten base32 characters), from a short name. */
function findingId(key: string): string {
  return `f_${key.toUpperCase().padEnd(10, 'A').slice(0, 10)}`;
}

function finding(id: string, checkId: string, docIds: readonly string[], severity: Finding['severity'], message: string): Finding {
  return {
    id: findingId(id),
    runId: 'r_AAAAAAAAAA',
    class: 'deterministic',
    checkId,
    type: checkId.split('.')[1] ?? 'x',
    severity,
    status: 'open',
    factGroup: `${checkId}|${findingId(id)}`,
    evidence: docIds.map((docId) => ({ docId: nodeId(docId), quote: '', from: 0, to: 0 })),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    message,
  } as Finding;
}

/** Packs the book as a `.caotang` bundle and opens it from the projects screen. */
async function openBook(page: Page, testInfo: TestInfo, spec: BookSpec): Promise<void> {
  const manifest = createEmptyManifest(spec.name, NOW, { locale: 'en-US' });
  if (spec.language !== undefined) manifest.project.language = spec.language;
  const state = createProjectState(manifest, { now: NOW });
  for (const folder of spec.folders ?? []) addFolder(state, { id: nodeId(folder.id), parentId: 'manuscript', title: folder.title, now: NOW });
  const sceneMeta: Record<string, SceneMeta> = {};
  for (const scene of spec.scenes) {
    addDocument(state, { id: nodeId(scene.id), parentId: scene.parent === undefined ? 'manuscript' : nodeId(scene.parent), title: scene.title, body: `${scene.title} is written here.`, now: NOW });
    if (scene.meta !== undefined) sceneMeta[nodeId(scene.id)] = scene.meta;
  }
  const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta, findings: [...(spec.findings ?? [])] };
  const bundle = await exportProjectZip(state, { now: NOW, coherence: serializeCoherenceFile(file) });
  const path = testInfo.outputPath(`${spec.name.replace(/\W+/g, '-')}.caotang`);
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

function cell(page: Page, key: string): Locator {
  return page.locator(`[role="gridcell"][data-node="${nodeId(key)}"]`).first();
}

const STORY: BookSpec = {
  name: 'Story Book',
  scenes: [
    { id: 'pro', title: 'Before the storm', meta: { dayOffset: -400, storyPart: 'prologue' } },
    { id: 'm1', title: 'Arrival', meta: { dayOffset: 0 } },
    { id: 'm2', title: 'The letter', meta: { dayOffset: 1 } },
    { id: 'm3', title: 'The quarrel', meta: { dayOffset: 2 } },
    { id: 'm4', title: 'Departure', meta: { dayOffset: 6 } },
    { id: 'loose', title: 'A scene without a day' },
  ],
};

test('the timeline opens from the centre switch on the story axis once most scenes have a day, and offers the rest on a shelf', async ({ page }, testInfo) => {
  await openBook(page, testInfo, STORY);
  const view = await openTimeline(page);
  await expect(view).toHaveAttribute('data-axis', 'story');
  await expect(view.getByRole('radio', { name: /Story time · 5 of 6 scheduled/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('grid', { name: /Timeline, story time/ })).toBeVisible();
  await expect(cell(page, 'm1')).toBeVisible();
  await expect(cell(page, 'm1')).toHaveAttribute('aria-label', /Arrival/);
  const shelf = page.getByTestId('timeline-shelf');
  await expect(shelf).toContainText('A scene without a day');
  // Nothing on the timeline writes directly: the view carries no button that applies a change.
  await expect(view.getByRole('button', { name: /^(Move|Delete|Rename|Set a day)/ })).toHaveCount(0);
});

test('the grid is one tab stop, the arrows move between scenes, Space marks one and Enter opens it', async ({ page }, testInfo) => {
  await openBook(page, testInfo, STORY);
  await openTimeline(page);
  const first = cell(page, 'pro');
  await first.focus();
  await expect(first).toBeFocused();
  // One tab stop: only the focused cell is reachable by Tab.
  await expect(page.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
  // A fold stays reachable to a screen reader and by a click, but Tab walks past it.
  await expect(page.locator('.tl-fold')).toHaveCount(1);
  await expect(page.locator('.tl-fold[tabindex="0"]')).toHaveCount(0);

  await page.keyboard.press('ArrowRight');
  await expect(cell(page, 'm1')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(cell(page, 'm2')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(cell(page, 'm1')).toBeFocused();
  await page.keyboard.press('End');
  await expect(cell(page, 'm4')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(cell(page, 'pro')).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Space');
  await expect(cell(page, 'm1')).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 'm2')).toHaveAttribute('aria-selected', 'false');

  await page.keyboard.press('Enter');
  await expect(page.locator('#center-editor')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('Arrival is written here.');
});

test('crossing the fold between the prologue and the main story is announced', async ({ page }, testInfo) => {
  await openBook(page, testInfo, STORY);
  await openTimeline(page);
  await cell(page, 'pro').focus();
  await page.keyboard.press('ArrowRight');
  await expect(cell(page, 'm1')).toBeFocused();
  await expect(page.getByTestId('timeline-live')).toContainText(/Fold: prologue/i);
  // Inside a part nothing is announced anew.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('timeline-live')).toContainText(/Fold: prologue/i);
});

test('the Agenda lists every scene as a table grouped by part, and a column sorts it', async ({ page }, testInfo) => {
  await openBook(page, testInfo, STORY);
  const view = await openTimeline(page);
  await view.getByRole('radio', { name: 'Agenda' }).click();
  const agenda = page.getByTestId('timeline-agenda');
  await expect(agenda).toBeVisible();
  const table = agenda.getByRole('table');
  await expect(table.getByRole('rowgroup')).toHaveCount(3);
  await expect(table.locator('tbody').first()).toContainText('Before the storm');
  await expect(table.locator('tbody').nth(1)).toContainText('A scene without a day');
  await expect(table.locator('tbody').nth(1)).toContainText('The quarrel');
  const day = table.getByRole('columnheader', { name: 'Day', exact: true });
  await day.getByRole('button').click();
  await expect(day).toHaveAttribute('aria-sort', 'ascending');
  await day.getByRole('button').click();
  await expect(day).toHaveAttribute('aria-sort', 'descending');
  // A row title opens the scene.
  await agenda.getByRole('button', { name: /Arrival/ }).first().click();
  await expect(page.locator('#center-editor')).toHaveAttribute('aria-checked', 'true');
});

test('a person who forces colours or asks for less motion is offered the Agenda first, with a way to the timeline and a skip link otherwise', async ({ page }, testInfo) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await openBook(page, testInfo, STORY);
  const view = await openTimeline(page);
  await expect(page.getByTestId('timeline-agenda')).toBeVisible();
  await expect(view.getByRole('radio', { name: 'Agenda' })).toHaveAttribute('aria-checked', 'true');
  await view.getByRole('radio', { name: 'Timeline' }).click();
  await expect(page.getByRole('grid', { name: /Timeline/ })).toBeVisible();
  const skip = view.getByRole('button', { name: 'Skip to the Agenda' });
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('timeline-agenda')).toBeFocused();
});

test('findings show as badges with a glyph and a count, a gap as a band, and a badge opens its group in Findings', async ({ page }, testInfo) => {
  await openBook(page, testInfo, {
    ...STORY,
    name: 'Findings Book',
    findings: [
      finding('gap', 'timeline.gap', ['m3', 'm4'], 'warning', 'Four quiet days pass between The quarrel and Departure.'),
      finding('drft', 'timeline.order-drift', ['m2', 'm1'], 'error', 'The letter comes after Arrival in the text but before it in time.'),
    ],
  });
  await openTimeline(page);
  const departure = cell(page, 'm4');
  await expect(departure).toContainText('1');
  // Never colour alone: the badge carries its severity glyph as text.
  await expect(departure.locator('.tl-badge')).toContainText('\u25b2');
  await expect(cell(page, 'm1').locator('.tl-badge')).toContainText('\u2715');
  await expect(page.locator('.tl-gap-band')).toHaveCount(1);
  // The gap is the band; the order drift is the connector.
  await expect(page.locator('.tl-conn.is-finding')).toHaveCount(1);

  await departure.focus();
  await page.keyboard.press('f');
  const group = page.locator(`.finding-group[data-group="timeline.gap|${findingId('gap')}"]`);
  await expect(page.getByRole('tab', { name: /Findings/ })).toHaveAttribute('aria-selected', 'true');
  await expect(group).toBeVisible();
  await expect(group).toBeFocused();
});

test('F reads the letter the layout prints, follows a physical F on another script, and yields to an input method', async ({ page }, testInfo) => {
  await openBook(page, testInfo, {
    ...STORY,
    name: 'Layout Book',
    findings: [finding('gap', 'timeline.gap', ['m3', 'm4'], 'warning', 'Four quiet days pass between The quarrel and Departure.')],
  });
  await openTimeline(page);
  const departure = cell(page, 'm4');
  const group = page.locator(`.finding-group[data-group="timeline.gap|${findingId('gap')}"]`);
  await departure.focus();
  // A key an input method is composing is its own, and a key typed with AltGraph is a character, not a shortcut.
  await departure.dispatchEvent('keydown', { key: 'f', code: 'KeyF', isComposing: true });
  await departure.dispatchEvent('keydown', { key: 'f', code: 'KeyF', keyCode: 229 });
  await expect(group).toHaveCount(0);
  // A Russian layout prints \u0430 on the physical F key.
  await departure.dispatchEvent('keydown', { key: '\u0430', code: 'KeyF' });
  await expect(group).toBeVisible();
  await expect(group).toBeFocused();
});

test('"Show on timeline" in the Findings tab brings the timeline forward on the scene a finding cites', async ({ page }, testInfo) => {
  await openBook(page, testInfo, {
    ...STORY,
    name: 'Round Trip',
    findings: [finding('gap', 'timeline.gap', ['m3', 'm4'], 'warning', 'Four quiet days pass between The quarrel and Departure.')],
  });
  await page.getByRole('tab', { name: /Findings/ }).click();
  const group = page.locator(`.finding-group[data-group="timeline.gap|${findingId('gap')}"]`);
  await expect(group).toBeVisible();
  await group.getByRole('button', { name: 'Show on timeline' }).click();
  await expect(page.locator('#center-timeline')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('timeline-view')).toBeVisible();
  await expect(cell(page, 'm3')).toBeFocused();
  await expect(page.getByTestId('timeline-live')).toContainText(/Showing/);
});

test('the view, the axis and the group-by are remembered while the project stays open', async ({ page }, testInfo) => {
  await openBook(page, testInfo, STORY);
  const view = await openTimeline(page);
  await view.getByRole('radio', { name: 'Reading order' }).click();
  await expect(view).toHaveAttribute('data-axis', 'narrative');
  await view.getByLabel('Group by').selectOption('mode');
  await page.locator('#center-editor').click();
  await page.locator('#center-timeline').click();
  await expect(page.getByTestId('timeline-view')).toHaveAttribute('data-axis', 'narrative');
  await expect(page.getByTestId('timeline-view').getByLabel('Group by')).toHaveValue('mode');
});

test('a book with few days opens on reading order, and an empty book says so', async ({ page }, testInfo) => {
  await openBook(page, testInfo, {
    name: 'Mostly Undated',
    scenes: [
      { id: 'a', title: 'One', meta: { dayOffset: 0 } },
      { id: 'b', title: 'Two' },
      { id: 'c', title: 'Three' },
    ],
  });
  const view = await openTimeline(page);
  await expect(view).toHaveAttribute('data-axis', 'narrative');

  await openBook(page, testInfo, { name: 'Blank Book', scenes: [] });
  await openTimeline(page);
  await expect(page.getByText('No scenes to place yet')).toBeVisible();
});

test('a right-to-left book under a left-to-right interface mirrors the canvas and keeps the controls and the arrow keys in the interface direction', async ({ page }, testInfo) => {
  await openBook(page, testInfo, {
    name: 'Arabic Book',
    language: 'ar',
    scenes: [
      { id: 'a', title: 'One', meta: { dayOffset: 0 } },
      { id: 'b', title: 'Two', meta: { dayOffset: 1 } },
      { id: 'c', title: 'Three', meta: { dayOffset: 2 } },
    ],
  });
  const view = await openTimeline(page);
  await expect(view).toHaveAttribute('data-direction', 'rtl');
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('ltr');
  const boxes = await Promise.all(['a', 'b', 'c'].map(async (id) => cell(page, id).boundingBox()));
  // The reading start is on the right: day 0 sits to the right of day 2.
  expect((boxes[0]?.x ?? 0) > (boxes[2]?.x ?? 0)).toBe(true);
  // The interface is left to right: its toolbar starts on the left, and the arrow toward the start of the interface goes to the earlier scene.
  await cell(page, 'b').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(cell(page, 'a')).toBeFocused();
});

test('a left-to-right book under a right-to-left interface keeps its canvas and reverses the arrows with the interface', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('caotang.pseudo', '1');
  });
  await openBook(page, testInfo, {
    name: 'English Book',
    scenes: [
      { id: 'a', title: 'One', meta: { dayOffset: 0 } },
      { id: 'b', title: 'Two', meta: { dayOffset: 1 } },
      { id: 'c', title: 'Three', meta: { dayOffset: 2 } },
    ],
  });
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="ar-XB"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  await settings.locator('.settings-head button').click();

  await page.locator('#center-timeline').click();
  const view = page.getByTestId('timeline-view');
  await expect(view).toHaveAttribute('data-direction', 'ltr');
  const boxes = await Promise.all(['a', 'c'].map(async (id) => cell(page, id).boundingBox()));
  expect((boxes[0]?.x ?? 0) < (boxes[1]?.x ?? 0)).toBe(true);
  await cell(page, 'a').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(cell(page, 'b')).toBeFocused();
});

test('2,000 scenes stay inside the DOM budget at day zoom and at fit zoom', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const folders = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, title: `Chapter ${i + 1}` }));
  const scenes: SceneSpec[] = Array.from({ length: 2000 }, (_, i) => ({
    id: `s${i}`,
    title: `Scene ${i + 1}`,
    parent: `c${Math.floor(i / 50)}`,
    meta: { dayOffset: i },
  }));
  await openBook(page, testInfo, { name: 'Big Book', folders, scenes });
  const view = await openTimeline(page);
  const nodes = async (): Promise<number> => view.evaluate((root) => root.querySelectorAll('*').length);

  await expect(view).toHaveAttribute('data-axis', 'story');
  await expect(page.getByTestId('timeline-grid')).toBeVisible();
  expect(await nodes()).toBeLessThanOrEqual(1500);
  const chips = await page.locator('[role="gridcell"]').count();
  expect(chips).toBeGreaterThan(0);
  expect(chips).toBeLessThan(2000);

  await view.getByRole('radio', { name: 'Fit all' }).click();
  await expect(page.getByTestId('timeline-grid')).toBeVisible();
  expect(await nodes()).toBeLessThanOrEqual(1500);

  // Scrolling across the book keeps the page inside the budget.
  await view.getByTestId('timeline-scroll').evaluate((el) => {
    el.scrollLeft = el.scrollWidth / 2;
  });
  await expect.poll(nodes).toBeLessThanOrEqual(1500);
  await view.getByRole('radio', { name: 'Day' }).click();
  await view.getByTestId('timeline-scroll').evaluate((el) => {
    el.scrollLeft = el.scrollWidth / 2;
  });
  await expect.poll(nodes).toBeLessThanOrEqual(1500);
});

test('Save image downloads the timeline as a PNG, drawn from the whole selection', async ({ page }, testInfo) => {
  await openBook(page, testInfo, STORY);
  const view = await openTimeline(page);
  const save = view.getByRole('button', { name: 'Save image' });
  await expect(save).toBeVisible();
  await save.focus();
  await expect(save).toBeFocused();

  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(download.suggestedFilename()).toBe('Story Book (timeline).png');
  const path = await download.path();
  const bytes = readFileSync(path);
  expect(bytes.byteLength).toBeGreaterThan(0);
  // The PNG signature: the file is a real image, not the SVG text under another name.
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await expect(view.getByTestId('timeline-image-error')).toHaveCount(0);
  await expect(save).toBeEnabled();
});
