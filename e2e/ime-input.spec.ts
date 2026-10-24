import { expect, test, type Locator, type Page } from '@playwright/test';

import { fakeEndpoint, useFakeEndpoint, type FakeReply } from './endpoint.js';
import { binderTitle, bodyOf, countOf, createProject, firstChapter, idOf, waitForSaved } from './support.js';

/**
 * Composition-safe input (#188, ui-modules §2.5). With an input method, the Enter that commits a candidate reaches the app as a
 * keydown marked `isComposing` (or, on older Windows paths, `keyCode === 229`). It must not send, save, blur, open or fire a
 * shortcut; the candidate's own text must still land. Every surface here is driven the way a browser presents the facts:
 * a composition starts, the composing Enter arrives, and the ordinary Enter after `compositionend` is the one that acts.
 *
 * These events are synthetic at the browser boundary: they prove the guard, not a real Windows IME. The report carries the
 * manual checklist a real IME needs.
 */

/** Which of the two signals a browser uses for the candidate-commit Enter: the standard fact, or the older Windows key code. */
type ComposingKind = 'isComposing' | 'keyCode-229';

const BOTH: readonly ComposingKind[] = ['isComposing', 'keyCode-229'];

/** An Enter that belongs to the input method, dispatched on the focused field as the candidate window's keydown. */
async function composingKeyDown(locator: Locator, kind: ComposingKind): Promise<void> {
  await locator.evaluate((element, kind) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: kind === 'isComposing',
    });
    if (kind === 'keyCode-229') Object.defineProperty(event, 'keyCode', { value: 229 });
    element.dispatchEvent(event);
  }, kind);
}

/**
 * The same Enter inside a form, followed in the same task by the submit the browser's default action would run. A synthetic
 * keydown has no default action of its own, so the submit is dispatched beside it: the form's guard sees the two as one Enter.
 */
async function composingEnterWithSubmit(input: Locator, kind: ComposingKind): Promise<void> {
  await input.evaluate((element, kind) => {
    const key = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: kind === 'isComposing',
    });
    if (kind === 'keyCode-229') Object.defineProperty(key, 'keyCode', { value: 229 });
    element.dispatchEvent(key);
    element.closest('form')?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  }, kind);
}

/** The browser's side of a composition: it starts before the candidate and ends after the commit. */
async function compositionStart(locator: Locator): Promise<void> {
  await locator.dispatchEvent('compositionstart', { data: '' });
}
async function compositionEnd(locator: Locator): Promise<void> {
  await locator.dispatchEvent('compositionend', { data: '' });
}

/** The sample project, opened by the first-run card's demo, with the agent panel showing its one demo turn. */
async function openSample(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check for continuity problems', exact: true }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.locator('.agent-report-text').first()).toBeVisible();
}

/** A plain answer to every call: one model call per turn, and no tool steps to follow. */
const ANSWER: FakeReply = (request) => (request.tools !== undefined ? { text: 'Answered.' } : JSON.stringify({ reply: 'Answered.' }));

/** Count the model calls the page makes after this point: one POST per chat completion. */
function countModelCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/chat/completions')) calls.push(request.url());
  });
  return calls;
}

/** A chapter with one scene in it, selected, so the inspector shows the scene's fields. */
async function selectedScene(page: Page): Promise<void> {
  await createProject(page, 'IME Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await binderTitle(page, 'The Landing').click();
}

test('the Intent box sends on the ordinary Enter and never on the composing one, where both Enter facts are used', async ({ page }) => {
  await fakeEndpoint(page, ANSWER);
  await useFakeEndpoint(page);
  await openSample(page);
  const calls = countModelCalls(page);
  const turns = page.locator('.agent-turn');
  await expect(turns).toHaveCount(1);

  const intent = page.getByRole('textbox', { name: 'Intent' });
  await intent.fill('A candidate-committed question.');

  // The keydown and the implicit submit it causes: one composing Enter, then the older Windows one.
  await compositionStart(intent);
  for (const kind of BOTH) await composingEnterWithSubmit(intent, kind);
  await expect(turns).toHaveCount(1);
  expect(calls).toHaveLength(0);
  await expect(intent).toHaveValue('A candidate-committed question.');
  await expect(intent).toBeFocused();

  // The composition ends, and the writer's own Enter is the one that sends.
  await compositionEnd(intent);
  await intent.press('Enter');
  await expect(turns).toHaveCount(2);
  await expect.poll(() => calls.length).toBe(1);
});

test('a browser-level Chromium composition keeps its text in the Intent box and sends nothing until the composition ends', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The composition is driven through CDP, which only Chromium offers; the synthetic cases cover the rest.');
  await fakeEndpoint(page, ANSWER);
  await useFakeEndpoint(page);
  await openSample(page);
  const calls = countModelCalls(page);
  const turns = page.locator('.agent-turn');
  await expect(turns).toHaveCount(1);

  const intent = page.getByRole('textbox', { name: 'Intent' });
  await intent.click();
  const cdp = await page.context().newCDPSession(page);
  // The browser itself starts a composition and marks the keydown that follows it as composing.
  await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await expect(intent).toHaveValue('ni');
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await page.waitForTimeout(200);
  await expect(turns).toHaveCount(1);
  expect(calls).toHaveLength(0);
  await expect(intent).toHaveValue('ni');
  await expect(intent).toBeFocused();

  // The input method commits the candidate it chose: the chosen character replaces the composing text, and the ordinary
  // Enter then sends it once. (Headless Chromium does not commit a candidate on Enter itself, so the commit is inserted.)
  await cdp.send('Input.insertText', { text: '你' });
  await expect(intent).toHaveValue('你');
  await intent.press('Enter');
  await expect(turns).toHaveCount(2);
  await expect(turns.last().locator('.agent-intent-text')).toHaveText('你');
  await expect.poll(() => calls.length).toBe(1);
});

test('a Codex name saves on the ordinary Enter and never on the composing one', async ({ page }) => {
  await createProject(page, 'IME Codex');
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  const name = page.getByRole('textbox', { name: 'Name' });
  await expect(name).toBeVisible();
  // The entry was made with its default name, so a save is one more codex.upsert and nothing else.
  const before = await countOf(page, 'codex.upsert');

  await name.fill('Elena');
  await compositionStart(name);
  for (const kind of BOTH) await composingKeyDown(name, kind);
  expect(await countOf(page, 'codex.upsert')).toBe(before);
  await expect(name).toHaveValue('Elena');
  await expect(name).toBeFocused();

  await compositionEnd(name);
  await name.press('Enter');
  await expect.poll(() => countOf(page, 'codex.upsert')).toBe(before + 1);
  await expect(name).toHaveValue('Elena');
});

test('an Inspector keyword saves on the ordinary Enter and never on the composing one', async ({ page }) => {
  await selectedScene(page);
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const keyword = inspector.getByLabel('Add keyword');
  const before = await countOf(page, 'binder.setMeta');

  await keyword.fill('ime-keyword');
  await compositionStart(keyword);
  for (const kind of BOTH) await composingKeyDown(keyword, kind);
  expect(await countOf(page, 'binder.setMeta')).toBe(before);
  await expect(inspector.getByRole('listitem').filter({ hasText: 'ime-keyword' })).toHaveCount(0);
  await expect(keyword).toHaveValue('ime-keyword');
  await expect(keyword).toBeFocused();

  await compositionEnd(keyword);
  await keyword.press('Enter');
  await expect.poll(() => countOf(page, 'binder.setMeta')).toBe(before + 1);
  await expect(inspector.getByRole('listitem').filter({ hasText: 'ime-keyword' })).toHaveCount(1);
});

test('the screenplay Source acts on the ordinary Enter and never on the composing one', async ({ page }) => {
  await createProject(page, 'IME Screenplay');
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitem', { name: 'New screenplay scene here' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Screenplay: Untitled scene' })).toBeVisible();
  await page.getByRole('radio', { name: 'Source', exact: true }).click();

  const source = page.getByRole('textbox', { name: 'Fountain source' });
  await source.fill(['INT. HOUSE - DAY', '', 'MARCUS', 'Hi.'].join('\n'));
  await waitForSaved(page);
  const sceneId = await idOf(page, 'Untitled scene');
  const before = await bodyOf(page, sceneId);

  // The caret goes to the end of the cue, where Enter is the screenplay's own edit.
  await source.press('ArrowUp');
  await source.press('End');
  await compositionStart(source);
  for (const kind of BOTH) await composingKeyDown(source, kind);
  await expect(source).toHaveValue(['INT. HOUSE - DAY', '', 'MARCUS', 'Hi.'].join('\n'));
  await waitForSaved(page);
  expect(await bodyOf(page, sceneId)).toBe(before);

  await compositionEnd(source);
  await source.press('Enter');
  // The caret is at the start of "Hi.": the cue edit happened exactly once.
  await source.pressSequentially('X');
  await expect(source).toHaveValue(['INT. HOUSE - DAY', '', 'MARCUS', 'XHi.'].join('\n'));
  await waitForSaved(page);
  expect(await bodyOf(page, sceneId)).toBe(['INT. HOUSE - DAY', '', 'MARCUS', 'XHi.'].join('\n'));
});
