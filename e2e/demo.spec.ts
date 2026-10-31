import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { DEMO_INTENTS } from '../packages/gateway/src/mock/index.js';

import { binderTitle, bodyOf, card, createProject, idOf, trace, waitForSaved } from './support.js';

/**
 * The demo, scripted end to end: create a project, build a three-chapter
 * story with scenes, have the agent draft a scene through the agent panel and approve it, reorder the story on the corkboard,
 * and compile it to DOCX. The downloaded file is then unzipped and its structure asserted.
 *
 * Everything runs on the built-in demo provider, so no key is configured and nothing leaves the machine. The demo intent is
 * the mock provider's own wording, and the mock drafts into the scene it names, "The Friend": that scene is left empty, so the
 * draft has somewhere to land.
 */

/** The opening of the prose the demo provider drafts into "The Friend" (the mock's fixed answer). */
const DRAFT_OPENING = 'The ferry came in on the evening tide, low in the water and slow to answer the rope.';

/** Rename the row or card that is in rename mode, as the writer does: the field is named for the placeholder it was given. */
async function nameIt(page: Page, title: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Rename Untitled' });
  await expect(field).toBeFocused();
  await field.fill(title);
  await page.keyboard.press('Enter');
}

/** A chapter, from the binder's own New folder button. With no part selected, a new folder goes beside the selected chapter, into the manuscript. */
async function newChapter(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder' }).click();
  await nameIt(page, title);
  await expect(binderTitle(page, title)).toBeVisible();
}

/**
 * A scene in the selected chapter, from the binder's New document button. It opens in the editor, so its text is typed there
 * when a text is given. The scene the writer has selected is the chapter it goes into.
 */
async function newScene(page: Page, title: string, text?: string): Promise<void> {
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await nameIt(page, title);
  if (text !== undefined) await page.getByRole('textbox', { name: 'Document text' }).fill(text);
  await waitForSaved(page);
}

test('the demo: a three-chapter story, an agent draft approved in the agent panel, a corkboard reorder, and a DOCX compile that reads back in order', async ({
  page,
}, testInfo: TestInfo) => {
  test.setTimeout(120_000);

  // Every request the page makes, and every error it reports: the demo must leave nothing outside this machine, and run clean.
  const remote = new Set<string>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.hostname !== '127.0.0.1') remote.add(url.href);
  });
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(message.text());
  });

  // 1. A project, and a three-chapter story with scenes. Chapter 2's first scene is the one the agent drafts.
  await createProject(page, 'The Lighthouse Keeper');
  await newChapter(page, 'Arrival');
  await newScene(page, 'The Landing', 'The ferry was late, as always.');
  await newScene(page, 'The Storm', 'Rain. The lamp failed.');
  await newChapter(page, 'The Crossing');
  await newScene(page, 'The Friend');
  await newScene(page, 'The Lamp Room', 'Nobody had lit it in three nights.');
  await newChapter(page, 'The Return');
  await newScene(page, 'The Letter', 'The letter was short, and the ink had run in the rain.');

  // 2. The agent, on the built-in demo provider. The panel is closed until the writer opens it.
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByTestId('agent-provider')).toHaveText('Provider: Demo (no key)');
  await page.getByRole('combobox', { name: 'Intent' }).fill(DEMO_INTENTS.draftScene);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  // The agent proposes one write, so it shows a one-step confirm card, and the draft waits in its scene's ghost preview.
  const plan = page.getByTestId('plan-card');
  await expect(plan.getByRole('heading', { name: 'One step to confirm' })).toBeVisible();
  await expect(plan.locator('.plan-step[data-step="1"]')).toHaveAttribute('data-tool', 'scene.draft');
  await expect(page.getByTestId('ghost-bar')).toContainText('The Friend');

  // The writer approves the card. The card's Approve and the ghost's Apply answer the same decision, so approving writes the
  // draft into the scene and clears its ghost.
  const approve = plan.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();

  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await expect(page.getByTestId('ghost-bar')).toHaveCount(0);
  await expect(page.locator('.agent-report').last()).toContainText('Applied:');
  const friend = await idOf(page, 'The Friend');
  await expect.poll(async () => (await bodyOf(page, friend)) ?? '').toContain(DRAFT_OPENING);
  // The write is the agent's, and it is recorded against the scene it landed in.
  const rows = await trace(page);
  expect(rows.some((row) => row.issuedBy === 'agent' && row.affected.some((node) => node.title === 'The Friend'))).toBe(true);

  // The panel is closed before the corkboard drags, as the writer would close it to see the board. The drag with the panel open is
  // its own test ("the third card drags with the agent panel open").
  await page.getByRole('button', { name: 'Hide the agent' }).click();
  await expect(page.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();

  // 3. The corkboard. Inside a chapter the cards are its scenes: "The Lamp Room" moves in front of "The Friend".
  await binderTitle(page, 'The Crossing').click();
  const cards = page.locator('.cards .card-title');
  await expect(cards).toHaveText(['The Friend', 'The Lamp Room']);
  await card(page, 'The Lamp Room').locator('.card-grip').dragTo(card(page, 'The Friend'), { targetPosition: { x: 4, y: 40 } });
  await expect(cards).toHaveText(['The Lamp Room', 'The Friend']);

  // At the manuscript level the cards are the chapters: "The Return" moves to the front of the book.
  await page.locator('.row.is-section', { hasText: 'Manuscript' }).click();
  await expect(page.locator('.corkboard-head .crumbs li')).toHaveText(['Manuscript']);
  await expect(cards).toHaveText(['Arrival', 'The Crossing', 'The Return']);
  await card(page, 'The Return').locator('.card-grip').dragTo(card(page, 'Arrival'), { targetPosition: { x: 4, y: 40 } });
  await expect(cards).toHaveText(['The Return', 'Arrival', 'The Crossing']);
  await waitForSaved(page);

  // 4. Compile the whole manuscript to Word, and keep the file the browser downloads.
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Word \(\.docx\)/ }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  const file = testInfo.outputPath('the-lighthouse-keeper.docx');
  await download.saveAs(file);
  await expect(dialog).toHaveCount(0);

  // 5. The DOCX, unzipped. The chapters are Heading 1 in the order the corkboard now shows them, numbered as they fall,
  // and the drafted text is in the scene that was drafted, after the scene the writer moved in front of it.
  const xml = unzip(readFileSync(file)).get('word/document.xml')?.toString('utf8') ?? '';
  const paragraphs = paragraphsOf(xml);
  expect(paragraphs.find((paragraph) => paragraph.style === 'Title')?.text).toBe('The Lighthouse Keeper');

  const headings = paragraphs.filter((paragraph) => paragraph.style === 'Heading1').map((paragraph) => paragraph.text);
  expect(headings).toEqual(['1. The Return', '2. Arrival', '3. The Crossing']);

  const crossing = paragraphs.findIndex((paragraph) => paragraph.style === 'Heading1' && paragraph.text === '3. The Crossing');
  const lampRoom = paragraphs.findIndex((paragraph) => paragraph.text === 'Nobody had lit it in three nights.');
  const drafted = paragraphs.findIndex((paragraph) => paragraph.text.startsWith(DRAFT_OPENING));
  expect(crossing).toBeGreaterThan(-1);
  expect(lampRoom).toBeGreaterThan(crossing);
  expect(drafted).toBeGreaterThan(lampRoom);

  // 6. Nothing left the machine, and the page reported no errors.
  expect([...remote]).toEqual([]);
  expect(problems).toEqual([]);
});

/** A chapter with three scenes, selected, so the corkboard shows them as three cards in two rows at the 1280 by 720 viewport. */
async function chapterOfThreeScenes(page: Page): Promise<void> {
  await createProject(page, 'The Lighthouse Keeper');
  await newChapter(page, 'Arrival');
  await newScene(page, 'Alpha');
  await newScene(page, 'Beta');
  await newScene(page, 'Gamma');
  await binderTitle(page, 'Arrival').click();
  await expect(page.locator('.cards .card-title')).toHaveText(['Alpha', 'Beta', 'Gamma']);
}

// The layout that once hid the corkboard's second row under the agent drawer. The drawer now takes at most 30% of the centre column
// when open (styles.css `.agent.is-open`), so the third card of a chapter drags with the panel open as well as closed. Both are
// plain tests: the panel-closed drag is the control for the setup, and the panel-open drag is the regression it guards.
test('the third card drags with the agent panel closed', async ({ page }) => {
  await chapterOfThreeScenes(page);
  await card(page, 'Gamma').locator('.card-grip').dragTo(card(page, 'Alpha'), { targetPosition: { x: 4, y: 40 } });
  await expect(page.locator('.cards .card-title')).toHaveText(['Gamma', 'Alpha', 'Beta']);
});

test('the third card drags with the agent panel open', async ({ page }) => {
  await chapterOfThreeScenes(page);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hide the agent' })).toBeVisible();
  await card(page, 'Gamma').locator('.card-grip').dragTo(card(page, 'Alpha'), { targetPosition: { x: 4, y: 40 } });
  await expect(page.locator('.cards .card-title')).toHaveText(['Gamma', 'Alpha', 'Beta']);
});

/** One paragraph of a WordprocessingML part: its style, if it names one, and the text its runs carry. */
interface Paragraph {
  readonly style: string | null;
  readonly text: string;
}

/** The paragraphs of `word/document.xml`, in order. Only the style and the text are read, which is all the assertions need. */
function paragraphsOf(xml: string): Paragraph[] {
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => {
    const body = match[0];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(body)?.[1] ?? null;
    const text = [...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((run) => unescapeXml(run[1] ?? '')).join('');
    return { style, text };
  });
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_whole, name: string) => XML_ENTITIES[name] ?? '');
}

/**
 * The entries of a ZIP archive, by name. A .docx holds stored and deflated entries, which is all this reads. The central
 * directory gives the sizes, so a local header that carries no sizes (a data descriptor) reads the same as one that does.
 */
function unzip(archive: Buffer): Map<string, Buffer> {
  const end = endOfCentralDirectory(archive);
  const entries = new Map<string, Buffer>();
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error(`the central directory entry ${index} is not where it should be`);
    const method = archive.readUInt16LE(at + 10);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    const local = archive.readUInt32LE(at + 42);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(start, start + size);
    entries.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return entries;
}

/** Where the end-of-central-directory record starts: it sits in the last 64 KiB, after an optional archive comment. */
function endOfCentralDirectory(archive: Buffer): number {
  for (let at = archive.length - 22; at >= 0 && at >= archive.length - 22 - 0xffff; at -= 1) {
    if (archive.readUInt32LE(at) === 0x06054b50) return at;
  }
  throw new Error('the file is not a ZIP archive: no end-of-directory record');
}
