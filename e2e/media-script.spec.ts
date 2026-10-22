/**
 * The screenplay in the app (screenplay.md §2.2, §3). A whole Fountain file is imported as sections and scenes in one
 * command, the Source tab draws the script's elements, answers Enter and Tab on a cue and turns a line into another element
 * from its element menu, and the Pages tab shows the scene as it prints, read only. media/README.md says what each view does; these tests read the app through its gestures.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderTitle, bodyOf, createProject, firstChapter, idOf, traceNames, treeOf, waitForSaved } from './support.js';

const PROJECT = 'Night Shift';

/** A two-act script with a section synopsis, a sequence, and a scene synopsis, in the form the importer reads back. */
const SCRIPT = [
  '# Act One',
  '= The setup.',
  '## Sequence A',
  'INT. HOUSE - DAY',
  '',
  'Alice waves.',
  '',
  'EXT. STREET - NIGHT',
  '= Rain.',
  '',
  'Rain falls.',
  '',
  '# Act Two',
  '',
  'INT. CELLAR - NIGHT',
  '',
  'Cold.',
  '',
].join('\n');

const SCENE = ['INT. HOUSE - DAY', '', 'MARCUS', 'Hi.', '', 'MA'].join('\n');

/**
 * Makes a screenplay scene from the context menu of the manuscript, as the media node specs do, and leaves it with the title
 * the binder gave it.
 */
async function makeScene(page: Page): Promise<void> {
  // The media entries are on chapters, so the node goes into the manuscript's first chapter.
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New screenplay scene here' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Screenplay: Untitled scene' })).toBeVisible();
}

/** The Fountain source field, which the Source tab shows. */
function source(page: Page) {
  return page.getByRole('textbox', { name: 'Fountain source' });
}

test('a whole Fountain file imports as sections and scenes, and the import is one step the trace names', async ({ page }) => {
  await createProject(page, PROJECT);
  await page.locator('input[type="file"][aria-label="Script file"]').setInputFiles({
    name: 'night.fountain',
    mimeType: 'text/plain',
    buffer: Buffer.from(SCRIPT),
  });

  await expect(page.getByText(/Imported 3 scenes and 3 sections from night\.fountain/)).toBeVisible();
  await waitForSaved(page);
  await expect.poll(() => traceNames(page)).toContain('screenplay.import');

  const tree = await treeOf(page);
  const actOne = tree.find((node) => node.title === 'Act One');
  const sequence = tree.find((node) => node.title === 'Sequence A');
  expect(actOne?.type).toBe('folder');
  expect(sequence?.parentId).toBe(actOne?.id);
  const house = tree.find((node) => node.title === 'INT. HOUSE - DAY');
  expect(house?.parentId).toBe(sequence?.id);
  await expect.poll(() => bodyOf(page, house?.id ?? '')).toBe('INT. HOUSE - DAY\n\nAlice waves.');
});

test('the Source tab draws a scene heading and a cue, and Tab completes a cue from the cues already in the scene', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill(SCENE);

  // The decoration layer draws the heading and the cue, under the input, and changes none of the text.
  await expect(page.locator('.src-layer .tok-heading')).toHaveText('INT. HOUSE - DAY');
  await expect(page.locator('.src-layer .tok-cue')).toHaveText('MARCUS');
  await expect(source(page)).toHaveValue(SCENE);

  // "MA" is the start of "MARCUS", the cue already in the scene, so Tab completes it in capitals.
  await source(page).press('Tab');
  await expect(source(page)).toHaveValue(SCENE.replace(/MA$/, 'MARCUS'));
});

test('Enter at the end of a cue moves onto its dialogue, with no blank line made between them', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill(['INT. HOUSE - DAY', '', 'MARCUS', 'Hi.'].join('\n'));

  // The caret is at the end of "Hi."; up and to the end of the line above puts it at the end of the cue.
  await source(page).press('ArrowUp');
  await source(page).press('End');
  await source(page).press('Enter');
  // The caret is now at the start of "Hi.", so what is typed goes in front of it.
  await source(page).pressSequentially('X');
  await expect(source(page)).toHaveValue(['INT. HOUSE - DAY', '', 'MARCUS', 'XHi.'].join('\n'));
});

test('the element menu turns the caret\'s line into the element chosen, from the Element button and from Ctrl+E', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill(['INT. HOUSE - DAY', '', 'marcus', 'Hi.'].join('\n'));

  // The caret goes to the end of "marcus", the line above the last.
  await source(page).press('ArrowUp');
  await source(page).press('End');
  await page.keyboard.press('ControlOrMeta+e');
  const menu = page.getByRole('menu', { name: 'Element of this line' });
  await expect(menu).toBeVisible();
  // "marcus" over "Hi." reads as action, and the menu marks it.
  await expect(menu.getByRole('menuitemradio', { name: 'Action' })).toHaveAttribute('aria-checked', 'true');
  // Arrow keys move through the entries, and Enter chooses one: the lower-case cue is forced with @, and its words are kept.
  await expect(menu.getByRole('menuitemradio', { name: 'Scene heading' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'Character' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(source(page)).toBeFocused();
  await expect(source(page)).toHaveValue(['INT. HOUSE - DAY', '', '@marcus', 'Hi.'].join('\n'));

  // The caret is after the cue, so the next line down is the dialogue. The Element button opens the menu too, and a digit chooses.
  await source(page).press('ArrowDown');
  await source(page).press('End');
  await page.getByRole('button', { name: 'Element', exact: true }).click();
  await expect(menu.getByRole('menuitemradio', { name: 'Dialogue' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('4');
  await expect(source(page)).toHaveValue(['INT. HOUSE - DAY', '', '@marcus', '(Hi.)'].join('\n'));
  await expect(source(page)).toBeFocused();

  // The change is an ordinary edit of the scene, saved as typing is.
  await waitForSaved(page);
  const id = await idOf(page, 'Untitled scene');
  await expect.poll(() => bodyOf(page, id)).toContain('(Hi.)');
});

test('the element menu closes on Escape and leaves the line as it was', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill('INT. HOUSE - DAY');
  await page.keyboard.press('ControlOrMeta+e');
  const menu = page.getByRole('menu', { name: 'Element of this line' });
  // Dialogue needs a cue above it, so it is not offered on a heading.
  await expect(menu.getByRole('menuitemradio', { name: 'Dialogue' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(source(page)).toBeFocused();
  await expect(source(page)).toHaveValue('INT. HOUSE - DAY');
});

test('the Pages tab shows the scene as it prints, read only', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill(SCENE);

  await page.getByRole('radio', { name: 'Pages', exact: true }).click();
  const preview = page.getByLabel('Paginated preview');
  await expect(preview).toBeVisible();
  await expect(page.getByRole('region', { name: 'Page 1' })).toBeVisible();
  await expect(preview.locator('.sp-line-scene')).toHaveText('INT. HOUSE - DAY');
  // The preview writes nothing: the text is the one the Source tab holds.
  await waitForSaved(page);
  const id = await idOf(page, 'Untitled scene');
  await expect.poll(() => bodyOf(page, id)).toContain('MARCUS');
});

/** The Pages tab of a new scene holding this Fountain source. */
async function pagesOf(page: Page, fountain: string) {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill(fountain);
  await page.getByRole('radio', { name: 'Pages', exact: true }).click();
  const sheet = page.getByRole('region', { name: 'Page 1' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The box of the sheet's line with exactly this text. */
async function boxOf(sheet: Locator, text: string) {
  const box = await sheet.locator('.sp-line', { hasText: new RegExp(`^${text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`) }).boundingBox();
  if (box === null) throw new Error(`no line ${text}`);
  return box;
}

const DUAL = ['INT. HALL - DAY', '', 'ANNA', '(softly)', 'I go left.', '', 'BEN ^', 'I go right.'].join('\n');

test('the Pages tab draws a dual-dialogue pair side by side, and keeps the reading order', async ({ page }) => {
  const sheet = await pagesOf(page, DUAL);
  const heading = await boxOf(sheet, 'INT. HALL - DAY');
  const anna = await boxOf(sheet, 'ANNA');
  const ben = await boxOf(sheet, 'BEN');
  const aside = await boxOf(sheet, '(softly)');
  const left = await boxOf(sheet, 'I go left.');
  const right = await boxOf(sheet, 'I go right.');
  // The right cue stands on the left cue's line, 30 characters (216px at 12px Courier) to its right.
  expect(ben.y).toBeCloseTo(anna.y, 1);
  expect(ben.x - anna.x).toBeCloseTo(30 * 7.2, 0);
  // The right dialogue starts beside the left parenthetical, and the left speech is still one row above the next.
  expect(right.y).toBeCloseTo(aside.y, 1);
  expect(right.x - left.x).toBeCloseTo(30 * 7.2, 0);
  expect(aside.y - anna.y).toBeCloseTo(14, 1);
  expect(left.y - aside.y).toBeCloseTo(14, 1);
  // The blank row before the pair stays collapsed.
  expect(anna.y - heading.y).toBeCloseTo(14, 1);
  // The lines are in the paginator's order: the left speech whole, then the right speech whole.
  await expect(sheet.locator('.sp-line')).toHaveText([
    'INT. HALL - DAY',
    'ANNA',
    '(softly)',
    'I go left.',
    'BEN',
    'I go right.',
  ]);
  // The tab is still a preview: nothing in it takes input, and its note is the same.
  const preview = page.getByLabel('Paginated preview');
  await expect(preview.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
  await expect(preview.getByText('Read only. The page breaks follow the screenplay page: about 55 lines a page, 12 point Courier.')).toBeVisible();
});

test('a script page without a pair keeps one 14px row to each line, from the sheet\'s own padding', async ({ page }) => {
  const sheet = await pagesOf(page, SCENE);
  const frame = await sheet.boundingBox();
  const heading = await boxOf(sheet, 'INT. HOUSE - DAY');
  const cue = await boxOf(sheet, 'MARCUS');
  const dialogue = await boxOf(sheet, 'Hi.');
  if (frame === null) throw new Error('no sheet');
  // A 1px border and 24px padding above the first row, 16px beside it; the heading is at the left margin, 15 characters in.
  expect(heading.y - frame.y).toBeCloseTo(25, 1);
  expect(heading.x - frame.x).toBeCloseTo(1 + 16 + 15 * 7.2, 0);
  expect(cue.y - heading.y).toBeCloseTo(14, 1);
  expect(dialogue.y - cue.y).toBeCloseTo(14, 1);
  expect(cue.x - heading.x).toBeCloseTo(22 * 7.2, 0);
  expect(frame.height).toBeCloseTo(2 + 48 + 14 * 4, 0);
  // A bold heading does not move the columns: the advance is the same in either weight.
  const advances = await page.evaluate(() => {
    const measure = (weight: string) => {
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;white-space:pre;font:${weight} 12px 'Courier Prime', 'Courier New', Courier, monospace`;
      probe.textContent = 'x'.repeat(40);
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };
    return [measure('400'), measure('700')];
  });
  expect(advances[1]).toBeCloseTo(advances[0] ?? 0, 3);
});

test('the scene\'s heading and cue carry their decoration after a reload', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill(SCENE);
  await waitForSaved(page);
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: PROJECT }).getByRole('button', { name: 'Open' }).click();
  await binderTitle(page, 'Untitled scene').click();
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await expect(page.locator('.src-layer .tok-heading')).toHaveText('INT. HOUSE - DAY');
});

/** The element menu's chord family for this browser, which the Element button names. Playwright's Chromium reports its host OS. */
async function onMac(page: Page): Promise<boolean> {
  return page.evaluate(() => (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform?.toLowerCase().startsWith('mac') ?? navigator.platform.toLowerCase().startsWith('mac'));
}

/** The chord for an element digit, spelled for Playwright, on the platform the browser reports. */
async function chord(page: Page, digit: number): Promise<string> {
  return `${(await onMac(page)) ? 'Meta+Alt' : 'Control+Shift'}+Digit${digit}`;
}

test('a chord on the Source tab turns the caret\'s line into the element of that digit, as the menu\'s digit does', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  const lines = ['INT. HOUSE - DAY', '', 'marcus', 'Hi.'];
  await source(page).fill(lines.join('\n'));
  await source(page).press('ArrowUp');
  await source(page).press('End');

  // The menu shows the chord beside each digit, in the platform's family.
  await page.keyboard.press('ControlOrMeta+e');
  const menu = page.getByRole('menu', { name: 'Element of this line' });
  const family = (await onMac(page)) ? 'Cmd+Alt' : 'Ctrl+Shift';
  await expect(menu.getByRole('menuitemradio', { name: 'Character' })).toContainText(`${family}+3`);
  await expect(menu.getByRole('menuitemradio', { name: 'Page break' })).toContainText(`${family}+9`);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByRole('button', { name: 'Element', exact: true })).toHaveAttribute('title', expect.stringContaining(`${family}+1 to 9`));

  // Chord 3 is Character, as the digit 3 is in the menu: the lower-case cue is forced with @, and the caret stays after it.
  await source(page).focus();
  await page.keyboard.press(await chord(page, 3));
  await expect(source(page)).toHaveValue(['INT. HOUSE - DAY', '', '@marcus', 'Hi.'].join('\n'));
  await expect(source(page)).toBeFocused();
  // A line that already is the element is left alone, and no character is typed.
  await page.keyboard.press(await chord(page, 3));
  await expect(source(page)).toHaveValue(['INT. HOUSE - DAY', '', '@marcus', 'Hi.'].join('\n'));

  // The dialogue line below becomes a parenthetical with chord 4.
  await source(page).press('ArrowDown');
  await source(page).press('End');
  await page.keyboard.press(await chord(page, 4));
  await expect(source(page)).toHaveValue(['INT. HOUSE - DAY', '', '@marcus', '(Hi.)'].join('\n'));

  // The change is an ordinary edit of the scene, saved as typing is.
  await waitForSaved(page);
  const id = await idOf(page, 'Untitled scene');
  await expect.poll(() => bodyOf(page, id)).toContain('(Hi.)');
});

test('a chord for an element the line cannot be says so on the status line and changes nothing', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill('INT. HOUSE - DAY');
  // Dialogue needs a cue above it, so chord 5 cannot apply to a heading.
  await page.keyboard.press(await chord(page, 5));
  await expect(page.getByRole('status').filter({ hasText: 'This line cannot be dialogue here.' })).toBeVisible();
  await expect(source(page)).toHaveValue('INT. HOUSE - DAY');
});

test('AltGraph with a digit, Ctrl+Alt and a held chord change nothing', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill('Anna waits.');
  const mac = await onMac(page);
  const fire = (init: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; modifierAltGraph?: boolean }) =>
    source(page).evaluate((field, eventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Digit3', key: '3', ...eventInit });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
  const own = mac ? { metaKey: true, altKey: true } : { ctrlKey: true, shiftKey: true };
  // AltGraph is down: on Windows layouts that is Ctrl+Alt, and the layout types a character with it.
  expect(await fire({ ...own, modifierAltGraph: true })).toBe(false);
  expect(await fire({ ctrlKey: true, altKey: true, modifierAltGraph: true })).toBe(false);
  expect(await fire({ ctrlKey: true, altKey: true })).toBe(false);
  expect(await fire({ ...own, repeat: true })).toBe(false);
  await expect(source(page)).toHaveValue('Anna waits.');
  // The chord itself, sent the same way, is taken.
  expect(await fire(own)).toBe(true);
  await expect(source(page)).toHaveValue('@Anna waits.');
});

test('Ctrl+Z after a chord leaves the text a menu choice leaves', async ({ page }) => {
  // Each route runs on a scene of its own, so the browser's undo history of one does not reach the other.
  const afterUndo: Record<'menu' | 'chord', string> = { menu: '', chord: '' };
  for (const route of ['menu', 'chord'] as const) {
    await createProject(page, `${PROJECT} ${route}`);
    await makeScene(page);
    await page.getByRole('radio', { name: 'Source', exact: true }).click();
    await source(page).fill('Anna waits.');
    if (route === 'menu') {
      await page.getByRole('button', { name: 'Element', exact: true }).click();
      await page.keyboard.press('7');
    } else {
      await page.keyboard.press(await chord(page, 7));
    }
    await expect(source(page)).toHaveValue('> Anna waits. <');
    await page.keyboard.press('ControlOrMeta+z');
    afterUndo[route] = await source(page).inputValue();
  }
  expect(afterUndo.chord).toBe(afterUndo.menu);
});

test('a browser that reports a Mac gets the Cmd+Alt chords, and its Ctrl+Shift chord does nothing', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', { value: undefined });
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
  });
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill('Anna waits.');
  await page.keyboard.press('Control+Shift+Digit3');
  await expect(source(page)).toHaveValue('Anna waits.');
  await page.getByRole('button', { name: 'Element', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Character' })).toContainText('Cmd+Alt+3');
  await page.keyboard.press('Escape');
  await source(page).focus();
  await page.keyboard.press('Meta+Alt+Digit3');
  await expect(source(page)).toHaveValue('@Anna waits.');
});
