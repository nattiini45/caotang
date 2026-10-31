/**
 * The P14 handwriting-transcription witness (pictures.md §8.4, #146/C3), driven through the real app UI end to end:
 * the agent's `pictures.transcribe` plan card shows the three handwritten pages, the real request schedule, both
 * vision routes and their costs before any image is sent; Approve runs the two reads as separate model requests at
 * temperature 0, each pinned to its own route; the review gate (`TranscriptionReviewDialog`) lets the writer exclude
 * one page, edit another and see the `[?…?]`/`[illegible]` and second-read disagreement marks; approving the selected
 * pages publishes one `asset.transcribe` — one Research document with reciprocal source links and no excluded text;
 * a re-transcription is diffed against the approved text (the edit included) and never overwrites it; restoring the
 * turns takes each publication back.
 *
 * Providers: the existing e2e fake-endpoint fixture (endpoint.ts) on one routed preset origin — Mistral, whose
 * registry rows for the two models used carry vision and native tools. The key field takes the suite's placeholder
 * ('test-key', as settings-providers.spec.ts uses), never a real key, and nothing leaves the page: Playwright answers
 * every request to that origin. The raw request bodies are recorded at that boundary (a recorder route registered in
 * front of the fixture, falling through to it), which is where temperature 0, the three image parts per read and the
 * two distinct route models are asserted. The in-process mock provider's `calls` list is reachable only from the
 * pure-model specs in e2e/unit; the app's demo mock is built without `capsVision`, so a browser run of §8.4 needs a
 * routed vision-capable profile — the harness mock path itself is covered by
 * packages/harness/test/agent/picture-transcribe.test.ts.
 */

import { expect, test, type Page } from '@playwright/test';

import {
  formatTranscriptionSections,
  TRANSCRIPTION_TEMPERATURE,
  type TranscriptionPageSection,
} from '../packages/harness/src/tools/transcription-model.js';
import { endpointRoute, planThenAnswer, type FakeReply } from './endpoint.js';
import { registry, solidPng } from './pictures-support.js';
import { bodyOf, countOf, createProject, hasTitle, idOf, loose, projectTrace, savedMessage, treeOf, waitForSaved } from './support.js';

/** The one preset origin both vision profiles use; every request to it is answered by the routed fake. */
const ORIGIN = 'https://api.mistral.ai';
const PRIMARY = { name: 'Primary fake', model: 'mistral-large-2512', promptPrice: '0.001', replyPrice: '0.002' };
const SECOND = { name: 'Second fake', model: 'ministral-14b-2512', promptPrice: '0.003', replyPrice: '0.004' };
const MODELS = [PRIMARY.model, SECOND.model];
/** A placeholder, never a real key: every request to the routed origin is answered by the fake, so it goes nowhere. */
const PLACEHOLDER_KEY = 'test-key';

/** The three handwritten pages, as the two reads answer them (the page-section wire of transcription-model.ts). */
const FIRST_READ = [
  "Keeper's notebook, page one.\nThe lamp burned low all night.",
  'Page two: the ferry was [?recieved?] at dawn.',
  'Page three: rain on the [illegible] glass.',
];
const SECOND_READ = ["Keeper's notebook, page one.\nThe lamp burned low all dawn.", FIRST_READ[1], FIRST_READ[2]];
/** What the writer corrects page two to, in the review gate. */
const EDITED_PAGE_TWO = 'Page two: the ferry was received at dawn. (checked against the ink)';
const TITLE = "Keeper's notebook";
const SECOND_TITLE = 'Second pass';

const PAGES = [
  { name: 'page-one.png', color: [200, 30, 30] as const },
  { name: 'page-two.png', color: [30, 30, 200] as const },
  { name: 'page-three.png', color: [30, 200, 30] as const },
];

/** The transcribe step's params, as the fake planner sends them; the asset ids are filled in after the import. */
const transcribeParams: { assetIds: string[]; into: string } = { assetIds: [], into: 'new-document' };

/** The plan the fake planner proposes on every turn's first call. */
const plan = {
  steps: [{ tool: 'pictures.transcribe', params: transcribeParams, expect: 'The three handwritten pages are transcribed' }],
};

interface WireBody {
  readonly model?: string;
  readonly temperature?: unknown;
  readonly messages?: readonly { readonly role: string; readonly content: unknown }[];
}

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

/** Every request the page made to the routed origin, recorded in front of the fixture. */
const seen: Seen[] = [];
/** The raw body of the request currently being answered, read by the transcription reply for its pages and route. */
let currentBody = '';

const readBody = (body: string): WireBody => JSON.parse(body) as WireBody;
const partsOf = (content: unknown): readonly Record<string, unknown>[] => (Array.isArray(content) ? (content as readonly Record<string, unknown>[]) : []);
const lastUserOf = (body: WireBody): { readonly role: string; readonly content: unknown } | undefined =>
  (body.messages ?? []).filter((message) => message.role === 'user').at(-1);
const promptTextOf = (body: WireBody): string =>
  partsOf(lastUserOf(body)?.content)
    .filter((part) => part['type'] === 'text')
    .map((part) => String(part['text'] ?? ''))
    .join('');

/** The page ids a transcription request lists, in order, from its prompt's numbered page list. */
function pageIdsOf(body: WireBody): string[] {
  return [...promptTextOf(body).matchAll(/^\s*\d+\.\s+(a_\S+)\s*$/gm)].map((match) => match[1] as string);
}

/** The wire-format reply for one read: the pages this request lists, answered with that read's texts. */
function wireReply(): string {
  const body = readBody(currentBody);
  const ids = pageIdsOf(body);
  const read = body.model === SECOND.model ? SECOND_READ : FIRST_READ;
  const sections: TranscriptionPageSection[] = ids.map((assetId, index) => ({ assetId, text: read[index] ?? `A read of ${assetId}.` }));
  return formatTranscriptionSections(sections);
}

/**
 * The fake's reply: a transcription read carries images and declares no tools, while the planner's calls declare
 * tools — so the two are told apart the way the wire tells them apart.
 */
const reply: FakeReply = (request) => {
  if (request.stream && request.tools === undefined) return wireReply();
  return planThenAnswer(plan, 'The transcription is published.')(request);
};

/** The model requests that carried images, reduced to what the boundary assertions read. */
function imageReads(): { readonly model: string; readonly temperature: unknown; readonly images: number; readonly prompt: string }[] {
  return seen
    .filter((row) => row.method === 'POST' && row.url.includes('/chat/completions') && row.body.includes('image_url'))
    .map((row) => {
      const body = readBody(row.body);
      const parts = partsOf(lastUserOf(body)?.content);
      return {
        model: String(body.model ?? ''),
        temperature: body.temperature,
        images: parts.filter((part) => part['type'] === 'image_url').length,
        prompt: parts.filter((part) => part['type'] === 'text').map((part) => String(part['text'] ?? '')).join(''),
      };
    });
}

/** Adds one Mistral profile (vision rows for both models) with a price, so the card can cost both routes. */
async function addVisionProfile(page: Page, spec: typeof PRIMARY): Promise<void> {
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Add a provider' }).click();
  const form = settings.getByRole('form', { name: 'New provider' });
  await form.getByRole('combobox', { name: 'Provider' }).selectOption('mistral');
  await form.getByLabel('Name').fill(spec.name);
  await form.getByLabel('API key (required)').fill(PLACEHOLDER_KEY);
  await form.getByLabel('Model', { exact: true }).fill(spec.model);
  await form.getByLabel('Prompt', { exact: true }).fill(spec.promptPrice);
  await form.getByLabel('Reply', { exact: true }).fill(spec.replyPrice);
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(settings.getByText(savedMessage(spec.name))).toBeVisible();
}

/** Opens the agent drawer, which a freshly made project starts closed. */
async function openAgent(page: Page): Promise<void> {
  const panel = page.getByTestId('agent-panel');
  const toggle = panel.getByRole('button', { name: 'Agent', exact: true });
  if ((await toggle.count()) > 0) await toggle.click();
  await expect(panel).toHaveClass(/is-open/);
}

/** An intent sent from the agent panel, to the active provider. */
async function sendIntent(page: Page, intent: string): Promise<void> {
  const field = page.getByRole('textbox', { name: 'Intent' });
  await expect(field).toBeEnabled();
  await field.fill(intent);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('the P14 transcription flow: the plan card shows pages, schedule, both vision routes and costs, the review gate excludes and edits, one publication lands with source links, a re-transcription diffs without overwriting, and undo takes it back', async ({
  page,
}) => {
  test.setTimeout(180_000);

  // The fixture answers the one preset origin both profiles use; the recorder is registered after it, so it runs
  // first, records the raw body, and falls through — the fixture's own answers are unchanged.
  await endpointRoute(page, ORIGIN, reply, MODELS);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const body = request.postData() ?? '';
    seen.push({ url: request.url(), method: request.method(), body });
    currentBody = body;
    await route.fallback();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await addVisionProfile(page, PRIMARY);
  await addVisionProfile(page, SECOND);
  await settings.locator(`[data-profile="${PRIMARY.name}"]`).getByRole('button', { name: 'Use this profile' }).click();
  await expect(settings.getByText('is now the active profile')).toBeVisible();
  await settings.getByRole('button', { name: 'Close' }).click();

  await createProject(page, 'Transcription Book');

  // Three handwritten pages come in through the picture board, as one batch.
  await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
  const board = page.locator('section.pb-board');
  await expect(board).toBeVisible();
  await page.getByTestId('pictures-file-input').setInputFiles(
    PAGES.map((pageFile) => ({ name: pageFile.name, mimeType: 'image/png', buffer: solidPng(pageFile.color) })),
  );
  await expect(board.locator('.pb-tile')).toHaveCount(3);
  await expect(page.locator('.status-line')).toContainText('Imported 3 pictures.');
  await waitForSaved(page);
  const { records } = await registry(page);
  expect(records).toHaveLength(3);
  const ids = records.map((record) => record.id);
  const files = records.map((record) => record.file);
  transcribeParams.assetIds = ids;

  // The intent reaches the planner on the active profile; the card stages before anything is sent.
  await openAgent(page);
  await sendIntent(page, 'Transcribe the three handwritten pages.');
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('pictures.transcribe');
  const figure = card.getByRole('figure', { name: 'Transcription plan' });
  await expect(figure).toBeVisible();
  // The three pages, with their thumbnails, and the real request schedule: one batch of three (the §8.4 cap is 6),
  // one read so far, worst case three single-page retries.
  await expect(figure.locator('.transcription-thumb')).toHaveCount(3);
  await expect(figure).toContainText(/3 pages in 1 request per read \(3\)\./);
  await expect(figure).toContainText(/Up to 3 requests if every batch needs single-page retries\./);
  await expect(figure).toContainText('Approved pages become one Research document with source links.');
  await expect(figure).toContainText(/Language hint: en\./);
  // The primary route with its cost, before generation.
  const firstRoute = figure.locator('p').filter({ hasText: 'First read:' });
  await expect(firstRoute).toContainText(loose(`${PRIMARY.name}, ${PRIMARY.model}`));
  await expect(firstRoute).toContainText(/About \$[\d.]+ \(prompt \$[\d.]+, reply \$[\d.]+\)\./);
  await expect(figure.locator('.context-cost')).toContainText(/Estimated input [\d,]+ tokens and output [\d,]+ tokens across the planned reads\./);

  // The writer picks the second read on another vision route, on the card, before approving.
  await card.getByRole('combobox', { name: 'Second read on another vision route' }).selectOption({ label: `${SECOND.name}, ${SECOND.model}` });
  const secondRoute = figure.locator('p').filter({ hasText: 'Second read:' });
  await expect(secondRoute).toContainText(loose(`${SECOND.name}, ${SECOND.model}`));
  await expect(secondRoute).toContainText(/About \$[\d.]+ \(prompt \$[\d.]+, reply \$[\d.]+\)\./);
  // Two reads now: both the worst-case schedule and the token estimate double.
  await expect(figure).toContainText(/Up to 6 requests if every batch needs single-page retries\./);
  await expect(figure.locator('.context-cost')).toContainText(/output 7,200 tokens across the planned reads\./);

  // Nothing has been sent and nothing has run: no request carried an image, and no command is in the trace.
  const approve = card.getByRole('button', { name: /^Approve( plan)?$/ });
  await expect(approve).toBeEnabled();
  expect(imageReads()).toHaveLength(0);
  expect((await projectTrace(page)).filter((name) => name === 'asset.transcribe')).toEqual([]);

  await approve.click();

  // Approval generates: two reads, two requests, each on its own route, at temperature 0, three pages each.
  const dialog = page.getByTestId('transcription-review-dialog');
  await expect(dialog).toBeVisible();
  await expect.poll(() => imageReads().length).toBe(2);
  const reads = imageReads();
  for (const read of reads) {
    expect(read.temperature).toBe(TRANSCRIPTION_TEMPERATURE);
    expect(read.images).toBe(3);
    expect(read.prompt).toContain('Transcribe the handwritten pages sent with this request.');
    for (const id of ids) expect(read.prompt).toContain(id);
  }
  expect(reads.map((read) => read.model).sort()).toEqual([PRIMARY.model, SECOND.model].sort());

  // The review gate: page one shows the first read, the second read's disagreement marked beside it, and no earlier text.
  await expect(dialog.getByRole('heading', { name: 'Review the transcription' })).toBeVisible();
  await expect(dialog).toContainText('3 pages to review');
  await expect(dialog).toContainText('3 pages selected');
  await expect(dialog).toContainText('Page 1 of 3');
  const areaOne = dialog.getByRole('textbox', { name: `Transcribed text of ${files[0] ?? ''}` });
  await expect(areaOne).toHaveValue(FIRST_READ[0] ?? '');
  const disagreement = dialog.locator('mark[data-mark="disagree"]');
  await expect(disagreement).toHaveCount(1);
  await expect(disagreement).toContainText('night');
  await expect(disagreement).toHaveAttribute('title', /dawn/);
  await expect(dialog).toContainText(/The second read differs on 1 word:/);
  await expect(dialog).toContainText('No earlier approved text is available for this page');

  // Page two carries the uncertain-word mark; the writer edits the text.
  await dialog.getByRole('button', { name: 'Next page' }).click();
  await expect(dialog).toContainText('Page 2 of 3');
  const areaTwo = dialog.getByRole('textbox', { name: `Transcribed text of ${files[1] ?? ''}` });
  await expect(areaTwo).toHaveValue(FIRST_READ[1] ?? '');
  await expect(dialog.locator('mark[data-mark="uncertain"]')).toContainText('[?recieved?]');
  await areaTwo.fill(EDITED_PAGE_TWO);

  // Page three carries the illegible mark; the writer leaves the page out of the publication.
  await dialog.getByRole('button', { name: 'Next page' }).click();
  await expect(dialog).toContainText('Page 3 of 3');
  await expect(dialog.locator('mark[data-mark="illegible"]')).toContainText('[illegible]');
  await dialog.getByRole('checkbox', { name: 'Include this page' }).uncheck();
  await expect(dialog).toContainText('2 pages selected');
  await dialog.locator('input[type="text"]').fill(TITLE);
  await dialog.getByTestId('transcription-review-approve').click();
  await expect(dialog).toBeHidden();

  // One publication: one asset.transcribe, one checkpoint, one Research document holding the two selected pages
  // in order with the edit kept and the excluded page's text nowhere.
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  expect(await countOf(page, 'asset.transcribe')).toBe(1);
  expect(await hasTitle(page, TITLE)).toBe(true);
  const docId = await idOf(page, TITLE);
  const tree = await treeOf(page);
  const research = tree.find((node) => node.title === 'Research');
  expect(tree.find((node) => node.id === docId)?.parentId).toBe(research?.id);
  expect(await bodyOf(page, docId)).toBe(`${FIRST_READ[0]}\n\n${EDITED_PAGE_TWO}`);

  // Reciprocal source links on exactly the two published records, pinned to the new document's paragraphs.
  const sourceLinks = (await registry(page)).links.filter((link) => link.role === 'source');
  expect(sourceLinks.map((link) => link.assetId).sort()).toEqual([ids[0], ids[1]].sort());
  for (const link of sourceLinks) {
    expect(link.kind).toBe('paragraph');
    expect(link.nodeId).toBe(docId);
  }
  // The link is visible where the writer looks: the board's details list the placement, and the transcription filter appears.
  await expect(board.getByRole('checkbox', { name: 'Has a transcription' })).toBeVisible();
  await board.getByRole('button', { name: 'Details of page-one.png' }).click();
  const details = board.locator('aside.pb-details');
  await expect(details).toBeVisible();
  await expect(details.getByRole('region', { name: 'Placements' })).toContainText(loose(`Placed on a paragraph of “${TITLE}”`));

  // A re-transcription: the card warns that pages already point at an approved document, and the run is a new ghost.
  await sendIntent(page, 'Transcribe the three handwritten pages again.');
  // The first turn's card stays in the turns list; the new decision is the last card.
  const cardAgain = page.getByTestId('plan-card').last();
  await expect(cardAgain).toBeVisible();
  const figureAgain = cardAgain.getByRole('figure', { name: 'Transcription plan' });
  await expect(figureAgain).toContainText('Some pages already point to an approved transcription document. This run is a new ghost and will not rewrite that document.');
  await cardAgain.getByRole('combobox', { name: 'Second read on another vision route' }).selectOption({ label: `${SECOND.name}, ${SECOND.model}` });
  await expect(figureAgain.locator('p').filter({ hasText: 'Second read:' })).toContainText(loose(`${SECOND.name}, ${SECOND.model}`));
  await cardAgain.getByRole('button', { name: /^Approve( plan)?$/ }).click();

  await expect(dialog).toBeVisible();
  await expect.poll(() => imageReads().length).toBe(4);
  // The re-read is diffed against the approved text — the writer's edit included — and never overwrites it.
  await expect(dialog).toContainText('Page 1 of 3');
  await expect(dialog).toContainText(loose(`Diff against the approved text of ${files[0] ?? ''}:`));
  await expect(dialog).toContainText('The new read matches the approved text.');
  await dialog.getByRole('button', { name: 'Next page' }).click();
  await expect(dialog).toContainText(loose(`Diff against the approved text of ${files[1] ?? ''}:`));
  const areaTwoAgain = dialog.getByRole('textbox', { name: `Transcribed text of ${files[1] ?? ''}` });
  // The editable text is the new read, not the approved edit; the edit is only the diff's baseline.
  await expect(areaTwoAgain).toHaveValue(FIRST_READ[1] ?? '');
  await expect(dialog.locator('mark[data-mark="disagree"]').first()).toBeVisible();
  // Page three was never approved, so it has honestly no earlier text to diff against.
  await dialog.getByRole('button', { name: 'Next page' }).click();
  await expect(dialog).toContainText('No earlier approved text is available for this page');
  await dialog.locator('input[type="text"]').fill(SECOND_TITLE);
  await dialog.getByTestId('transcription-review-approve').click();
  await expect(dialog).toBeHidden();

  // The re-run published a second document; the first one still holds the edit — nothing was overwritten.
  expect(await countOf(page, 'asset.transcribe')).toBe(2);
  expect(await bodyOf(page, docId)).toBe(`${FIRST_READ[0]}\n\n${EDITED_PAGE_TWO}`);
  const secondDocId = await idOf(page, SECOND_TITLE);
  expect(await bodyOf(page, secondDocId)).toBe(FIRST_READ.join('\n\n'));

  // Restoring the re-transcription turn takes its publication back; the first document and the edit stand.
  await page.getByRole('button', { name: 'Restore to before this turn' }).last().click();
  await page.getByRole('dialog', { name: 'Restore to before this turn?' }).getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restored to before that turn.' })).toBeVisible();
  expect(await hasTitle(page, SECOND_TITLE)).toBe(false);
  expect((await registry(page)).links.filter((link) => link.role === 'source')).toHaveLength(2);
  expect(await bodyOf(page, docId)).toBe(`${FIRST_READ[0]}\n\n${EDITED_PAGE_TWO}`);

  // Restoring the first turn takes its publication back too: document, links and records in the one undo group.
  await page.getByRole('button', { name: 'Restore to before this turn' }).click();
  await page.getByRole('dialog', { name: 'Restore to before this turn?' }).getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restored to before that turn.' })).toBeVisible();
  expect(await hasTitle(page, TITLE)).toBe(false);
  expect((await registry(page)).links.filter((link) => link.role === 'source')).toHaveLength(0);
});
