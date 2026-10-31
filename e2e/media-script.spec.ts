/**
 * The screenplay in the app (screenplay.md §2.2, §3). A whole Fountain file is imported as sections and scenes in one
 * command, the Source tab draws the script's elements, answers Enter and Tab on a cue and turns a line into another element
 * from its element menu, and the Pages tab shows the scene as it prints and opens a line in the Source tab. media/README.md says what each view does; these tests read the app through its gestures.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderRow, binderTitle, bodyOf, createProject, firstChapter, idOf, traceNames, treeOf, waitForSaved } from './support.js';

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

test('a Final Draft file shows its notes and dual dialogue before it imports, then imports with its scene numbers', async ({ page }) => {
  await createProject(page, PROJECT);
  // A byte order mark and Windows line ends, as a Windows editor saves the file. The note and the wrapped dual-dialogue pair
  // nest paragraphs inside paragraphs, as Final Draft writes them (issue #264).
  const fdx = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="3">',
    '  <TitlePage><Content><Paragraph><Text>Title: Night Watch</Text></Paragraph></Content></TitlePage>',
    '  <Content>',
    '    <Paragraph Type="Scene Heading" Number="2A"><Text>INT. HOUSE - DAY</Text></Paragraph>',
    '    <Paragraph Type="Action"><ScriptNote><Paragraph><Text>Louder?</Text></Paragraph></ScriptNote><Text>Alice waves.</Text></Paragraph>',
    '    <Paragraph><DualDialogue>',
    '      <Paragraph Type="Character"><Text>ALICE</Text></Paragraph><Paragraph Type="Dialogue"><Text>Hi.</Text></Paragraph>',
    '      <Paragraph Type="Character"><Text>BOB</Text></Paragraph><Paragraph Type="Dialogue"><Text>Hey.</Text></Paragraph>',
    '    </DualDialogue></Paragraph>',
    '  </Content>',
    '</FinalDraft>',
  ].join('\r\n');
  const choose = async (): Promise<void> => {
    await page.locator('input[type="file"][aria-label="Script file"]').setInputFiles({
      name: 'night.fdx',
      mimeType: 'application/xml',
      buffer: Buffer.from(`\uFEFF${fdx}`, 'utf8'),
    });
  };

  await choose();
  const dialog = page.getByRole('dialog', { name: 'Import this Final Draft script?' });
  await expect(dialog).toBeVisible();
  const report = dialog.getByRole('list', { name: 'What the import does' });
  await expect(report).toContainText('1 scene and 0 sections will be made, in one undo step.');
  await expect(report).toContainText('1 script note kept as Fountain notes');
  await expect(report).toContainText('1 dual-dialogue pair kept side by side');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('screenplay.import');

  await choose();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Imported 1 scene and .* from night\.fdx/)).toBeVisible();
  await expect(page.getByText(/The title page was read but not stored/)).toBeVisible();
  await waitForSaved(page);

  const house = (await treeOf(page)).find((node) => node.title === 'INT. HOUSE - DAY');
  expect(house).toBeDefined();
  await expect.poll(() => bodyOf(page, house?.id ?? '')).toBe('INT. HOUSE - DAY #2A#\n\nAlice waves. [[Louder?]]\n\nALICE\nHi.\n\nBOB ^\nHey.');
});

test('a Final Draft outline imports as folders, a scene title names its scene, and a ticked cast row joins the codex in the same import', async ({ page }) => {
  await createProject(page, PROJECT);
  // Outline elements, a scene's title and colour, and the SmartType cast, as Final Draft writes them (issue #265).
  const fdx = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<FinalDraft DocumentType="Script" Template="No" Version="6">',
    '  <Content>',
    '    <Paragraph Type="Outline 1"><Text>ACT ONE</Text></Paragraph>',
    '    <Paragraph Type="Summary"><Text>Anna arrives.</Text></Paragraph>',
    '    <Paragraph Type="Scene Heading" Number="1"><SceneProperties Title="Anna arrives" Color="#FFFF00000000"/><Text>INT. STATION - NIGHT</Text></Paragraph>',
    '    <Paragraph Type="Action"><Text>ANNA drags a suitcase.</Text></Paragraph>',
    '  </Content>',
    '  <SmartType><Characters><Character>ANNA</Character><Character>BEN</Character></Characters></SmartType>',
    '</FinalDraft>',
  ].join('\n');
  await page.locator('input[type="file"][aria-label="Script file"]').setInputFiles({
    name: 'outline.fdx',
    mimeType: 'application/xml',
    buffer: Buffer.from(fdx, 'utf8'),
  });
  const dialog = page.getByRole('dialog', { name: 'Import this Final Draft script?' });
  await expect(dialog).toBeVisible();
  const report = dialog.getByRole('list', { name: 'What the import does' });
  await expect(report).toContainText('1 outline element or act break made a section');
  await expect(report).toContainText('1 scene title used as binder title');
  const rows = dialog.getByRole('list', { name: 'Codex entries to add' });
  const anna = rows.getByRole('checkbox', { name: /ANNA/ });
  // The rows start unticked: nothing reaches the codex unless the writer ticks it.
  await expect(anna).not.toBeChecked();
  await expect(rows.getByRole('checkbox', { name: /BEN/ })).not.toBeChecked();
  await anna.check();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Imported 1 scene and 1 section, with 1 codex entry, from outline\.fdx/)).toBeVisible();
  await waitForSaved(page);

  const tree = await treeOf(page);
  const act = tree.find((node) => node.title === 'ACT ONE');
  expect(act?.type).toBe('folder');
  expect(tree.find((node) => node.title === 'Anna arrives')?.parentId).toBe(act?.id);
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

  // Start at the converted cue's end, then keep the vertical navigation under test after the edit.
  const converted = ['INT. HOUSE - DAY', '', '@marcus', 'Hi.'].join('\n');
  const cueCaret = converted.indexOf('@marcus') + '@marcus'.length;
  const dialogueCaret = converted.indexOf('Hi.') + 'Hi.'.length;
  await source(page).evaluate((field, at) => {
    const input = field as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(at, at);
  }, cueCaret);
  await source(page).press('ArrowDown');
  await source(page).press('End');
  expect(await caretOf(page)).toEqual([dialogueCaret, dialogueCaret]);
  // The Element button opens the menu too, and a digit chooses.
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

test('the Pages tab shows the scene as it prints and writes nothing', async ({ page }) => {
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
  // Nothing in the tab takes input, and its note says what a line does.
  const preview = page.getByLabel('Paginated preview');
  await expect(preview.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
  await expect(preview.getByText('Choose a line to open it in the Source tab. The page breaks follow the screenplay page: about 55 lines a page, 12 point Courier.')).toBeVisible();
});

/** Where the caret is in the Source tab, as offsets into the text. */
async function caretOf(page: Page): Promise<[number, number]> {
  return source(page).evaluate((field) => [(field as HTMLTextAreaElement).selectionStart, (field as HTMLTextAreaElement).selectionEnd] as [number, number]);
}

const CLICKABLE = ['INT. HOUSE - DAY', '', 'A long action line that surely wraps over the sixty columns of the action width, and then some more words follow it.', '', 'MARCUS', 'Hi there.'].join('\n');

test('a line of the Pages tab opens its element in the Source tab, by click or by Enter', async ({ page }) => {
  const sheet = await pagesOf(page, CLICKABLE);
  const preview = page.getByLabel('Paginated preview');
  const action = CLICKABLE.indexOf('A long action');
  // The second line of a wrapped element opens the element, not the line.
  await sheet.getByRole('button', { name: 'of the action width, and then some more words follow it.' }).click();
  await expect(page.getByRole('radio', { name: 'Source', exact: true })).toBeChecked();
  await expect(source(page)).toBeFocused();
  expect(await caretOf(page)).toEqual([action, action]);

  await page.getByRole('radio', { name: 'Pages', exact: true }).click();
  // One line is in the tab order; Down moves to the next, and Enter opens it.
  await preview.getByRole('button', { name: 'INT. HOUSE - DAY' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(preview.getByRole('button', { name: /^A long action line/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(preview.getByRole('button', { name: 'MARCUS' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(source(page)).toBeFocused();
  const cue = CLICKABLE.indexOf('MARCUS');
  expect(await caretOf(page)).toEqual([cue, cue]);
  // Nothing was written by looking at the pages.
  await expect(source(page)).toHaveValue(CLICKABLE);
});

test('the Pages tab leaves the generated lines alone: the title page, page numbers and (MORE) open nothing', async ({ page }) => {
  const speech = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something fairly long about the lamp and the sea.`).join(' ');
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  const text = ['Title: Night Shift', '', 'INT. HOUSE - DAY', '', 'MARCUS', speech].join('\n');
  await source(page).fill(text);
  await page.getByRole('radio', { name: 'Pages', exact: true }).click();
  const preview = page.getByLabel('Paginated preview');
  await expect(page.getByRole('region', { name: 'Page 2' })).toBeVisible();
  await expect(preview.getByRole('region', { name: 'Title page' }).getByRole('button')).toHaveCount(0);
  await expect(preview.locator('.sp-line-more, .sp-line-continued, .sp-line-pageNumber')).not.toHaveCount(0);
  await expect(preview.locator('.sp-line-more[role="button"], .sp-line-continued[role="button"], .sp-line-pageNumber[role="button"]')).toHaveCount(0);
  // Only one line is a tab stop for the whole tab.
  await expect(preview.locator('[role="button"][tabindex="0"]')).toHaveCount(1);
  // A line on the second page opens the one speech, and the caret is where the speech starts.
  const start = text.indexOf('Sentence number 0');
  await page.getByRole('region', { name: 'Page 2' }).locator('.sp-line-dialogue').first().click();
  await expect(source(page)).toBeFocused();
  expect(await caretOf(page)).toEqual([start, start]);
});

test('a line far down the Pages tab opens the Source tab scrolled to its element', async ({ page }) => {
  const lines = Array.from({ length: 150 }, (_, i) => `Action line number ${i}.`);
  const text = ['INT. HOUSE - DAY', '', ...lines.flatMap((line) => [line, ''])].join('\n');
  const sheet = await pagesOf(page, text);
  await expect(sheet).toBeVisible();
  const last = page.getByRole('region').filter({ has: page.getByRole('button', { name: 'Action line number 149.' }) });
  await last.getByRole('button', { name: 'Action line number 149.' }).click();
  await expect(source(page)).toBeFocused();
  const at = text.indexOf('Action line number 149.');
  expect(await caretOf(page)).toEqual([at, at]);
  // The caret is on screen: the field has scrolled, and the caret's line is inside the part it shows.
  const shown = await source(page).evaluate((field) => {
    const box = field as HTMLTextAreaElement;
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
    const top = (box.value.slice(0, box.selectionStart).split('\n').length - 1) * lineHeight;
    return top >= box.scrollTop && top <= box.scrollTop + box.clientHeight;
  });
  expect(shown).toBe(true);
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
    // Menu selection restores the editor focus asynchronously; send Undo only after the same control is active.
    await expect(source(page)).toBeFocused();
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

/** The route chord for a letter, spelled for Playwright, on the platform the browser reports. */
async function route(page: Page, letter: 'S' | 'Y'): Promise<string> {
  return `${(await onMac(page)) ? 'Meta+Alt' : 'Control+Shift'}+Key${letter}`;
}

test('the section chord on the Source tab selects the folder the scene is in and focuses its binder row, and changes no text', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill('INT. HOUSE - DAY');
  const field = source(page);
  await expect(field).toHaveAttribute('aria-keyshortcuts', (await onMac(page)) ? 'Meta+Alt+S Meta+Alt+Y' : 'Control+Shift+S Control+Shift+Y');
  await page.keyboard.press(await route(page, 'S'));
  const row = binderRow(page, 'Chapter 1');
  await expect(row).toBeFocused();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  // The scene's text is as it was: the chord typed nothing and wrote nothing.
  const id = await idOf(page, 'Untitled scene');
  await waitForSaved(page);
  await expect.poll(() => bodyOf(page, id)).toBe('INT. HOUSE - DAY');
});

test('the synopsis chord focuses the scene\'s synopsis in the inspector, and what is typed there is the scene\'s synopsis', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill('INT. HOUSE - DAY');
  await page.keyboard.press(await route(page, 'Y'));
  const synopsis = page.locator('#inspector-synopsis');
  await expect(synopsis).toBeFocused();
  await page.keyboard.type('Marcus comes home.');
  await synopsis.blur();
  // The synopsis is the binder's field (screenplay.md §2.2), never a `=` line in the scene's text.
  await expect(source(page)).toHaveValue('INT. HOUSE - DAY');
  await page.getByRole('radio', { name: 'Script', exact: true }).click();
  await binderTitle(page, 'Untitled scene').click();
  await expect(page.locator('#inspector-synopsis')).toHaveValue('Marcus comes home.');
  const id = await idOf(page, 'Untitled scene');
  await waitForSaved(page);
  await expect.poll(() => bodyOf(page, id)).toBe('INT. HOUSE - DAY');
});

test('AltGraph with S, and the route chords with a key held down, change nothing and move no focus', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page);
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await source(page).fill('Anna waits.');
  const mac = await onMac(page);
  const fire = (init: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; modifierAltGraph?: boolean }) =>
    source(page).evaluate((field, eventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyS', key: 'S', ...eventInit });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    }, init);
  const own = mac ? { metaKey: true, altKey: true } : { ctrlKey: true, shiftKey: true };
  // Polish: AltGr+S types ś, and Windows reports AltGr as Ctrl+Alt.
  expect(await fire({ ctrlKey: true, altKey: true, modifierAltGraph: true })).toBe(false);
  expect(await fire({ ...own, modifierAltGraph: true })).toBe(false);
  expect(await fire({ ...own, repeat: true })).toBe(false);
  await expect(source(page)).toBeFocused();
  await expect(source(page)).toHaveValue('Anna waits.');
});
