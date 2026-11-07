import { expect, test, type Locator, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { fakeEndpoint, useFakeEndpoint, type FakeReply } from './endpoint.js';
import { createProject } from './support.js';

/**
 * The agent's companion window in Modern (M8, #309; modern-interface.md §8.3, §8.4, §8.10, §8.11, §9.1, §9.2): an `aside` named
 * "Agent" hosting the agent panel with Agent, Mode, Stop and Close in its header. It opens from Ctrl+J (Cmd+J), from every
 * `runAgentIntent` caller (here the empty manuscript's "Let the agent structure it") and from **Ask** (#306, once it is built), and
 * morphs out of what opened it. The page moves over above 1,280 px and recedes, except under reduced motion; from 1,280 px down the
 * window is a sheet over a scrim. Escape stops a stoppable turn while the Intent box is empty, as in Classic, and otherwise closes the
 * window; focus returns to **Ask** (or, until **Ask** exists, to what opened it, or the page). A turn keeps running while it is closed.
 *
 * Ctrl+J reaching the page is checked in every engine the suite runs (Chromium here; Firefox and WebKit in the pull-request shards):
 * the window opening is the proof (§18, Q3).
 */

test.use({ storageState: NO_PIN });

const companion = (page: Page): Locator => page.getByRole('complementary', { name: 'Agent' });
const intentBox = (page: Page): Locator => companion(page).getByRole('combobox', { name: 'Intent' });
/** The window by its id, which still finds it while it is `hidden` (a role query leaves hidden elements out). */
const companionElement = (page: Page): Locator => page.locator('#modern-companion');

/**
 * Waits until the window's morph (and its content's fade) has run out, so a measure reads where the window sits and not a frame of
 * the FLIP transform, which starts at the opener's size (the whole editor for Ctrl+J) and overshoots on the spring.
 */
async function settled(pane: Locator): Promise<void> {
  await pane.evaluate((element) =>
    Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))),
  );
}

/** Modern, chosen before the app starts, as a writer who picked it in Settings would have it. */
async function modern(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
}

/** Where focus should be after the window closes: **Ask** once #306 has built it, otherwise `fallback`. */
async function expectFocusBack(page: Page, fallback: Locator): Promise<void> {
  const ask = page.locator('#modern-ask');
  if ((await ask.count()) > 0) await expect(ask).toBeFocused();
  else await expect(fallback).toBeFocused();
}

/** Whether focus is inside the window. */
function focusInside(page: Page): Promise<boolean> {
  return page.evaluate(() => document.getElementById('modern-companion')?.contains(document.activeElement) === true);
}

/** Records whether the page saw Ctrl+J and cancelled the browser's own use of it. */
async function watchChord(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as Window & { __chord?: boolean[] }).__chord = seen;
    window.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'j' && (event.ctrlKey || event.metaKey)) seen.push(event.defaultPrevented);
    });
  });
}

/**
 * Opens the binder before the empty manuscript's **Create Chapter 1**. Once #307's sidebar is in, the binder sits in a sidebar that is
 * closed and inert until Manuscript in the tab bar opens it; before that it is on the page, and this does nothing.
 */
async function openBinder(page: Page): Promise<void> {
  // Keyed on #307's tab bar itself: a navigation named "Binder" exists before it too (the binder's own), without Manuscript.
  if ((await page.getByTestId('modern-binder-bar').count()) === 0) return;
  await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
  await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
}

/** Lets #307's sidebar close as the pointer leaves it, so the page and the window are not behind it. Nothing without the sidebar. */
async function leaveBinder(page: Page): Promise<void> {
  const binder = page.getByTestId('modern-binder');
  if ((await binder.count()) === 0) return;
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.mouse.move(size.width - 60, Math.round(size.height / 2));
  await expect(binder).toHaveAttribute('data-state', 'closed');
}

async function sceneInModern(page: Page, name: string): Promise<Locator> {
  await createProject(page, name);
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await openBinder(page);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Document text' });
  await editor.fill('The boat came in with the tide.');
  await leaveBinder(page);
  return editor;
}

test('Ctrl+J opens the window from the editor while typing, with Agent, Mode and Close in its header, and closes it again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await modern(page);
  const editor = await sceneInModern(page, 'Chord Book');
  // Closed at first: a new project starts with the agent out of sight, and the page holds no drawer.
  await expect(companion(page)).toBeHidden();
  await expect(page.locator('#modern-page .agent')).toHaveCount(0);

  await watchChord(page);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(companion(page)).toBeVisible();
  // The page received the chord and kept it from the browser (downloads).
  expect(await page.evaluate(() => (window as Window & { __chord?: boolean[] }).__chord)).toEqual([true]);
  // Typing in the editor did not take the chord as text.
  await expect(editor).toHaveText('The boat came in with the tide.');

  const pane = companion(page);
  await expect(pane.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
  await expect(pane.getByRole('group', { name: 'Mode' })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Close' })).toBeVisible();
  // The drawer's toggle is not drawn in the window.
  await expect(pane.locator('.agent-toggle')).toHaveCount(0);
  // Focus moved into the window as it opened (§9.2).
  await expect.poll(() => focusInside(page)).toBe(true);

  // Ctrl+J again closes it, and focus goes back where the writer was.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(companion(page)).toBeHidden();
  await expectFocusBack(page, editor);

  // Close in the header closes it too.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(companion(page)).toBeVisible();
  await companion(page).getByRole('button', { name: 'Close' }).click();
  await expect(companion(page)).toBeHidden();
});

test('an empty state’s agent request opens the window out of its button, and the page moves over and recedes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await modern(page);
  await createProject(page, 'Empty Book');
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  const area = page.locator('.modern-page-area');
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).insetInlineEnd)).toBe('0px');

  // The empty manuscript's buttons are the binder's own, so in Modern they sit in the sidebar: open it first (§8.5). The pointer
  // stays on the button, so the sidebar stays open while focus moves into the window, and Escape can hand focus back to it.
  await openBinder(page);
  const ask = page.getByRole('button', { name: 'Let the agent structure it', exact: true });
  await ask.click();
  const pane = companion(page);
  await expect(pane).toBeVisible();
  // It grew out of the button that asked (§8.3), and took focus as it started.
  await expect(pane).toHaveAttribute('data-morph', 'grow');
  await expect.poll(() => focusInside(page)).toBe(true);

  // Beside the page above 1,280 px: the page moves over by the window and a gutter, and recedes to 98.5%.
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).insetInlineEnd)).toBe('432px');
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).transform)).toBe('matrix(0.985, 0, 0, 0.985, 0, 0)');
  await settled(pane);
  const pageBox = await page.locator('#modern-page').boundingBox();
  const windowBox = await pane.boundingBox();
  expect(windowBox?.width).toBe(400);
  // Side by side: the window starts after the page ends.
  expect((pageBox?.x ?? 0) + (pageBox?.width ?? 0)).toBeLessThanOrEqual(windowBox?.x ?? 0);
  await expect(page.getByTestId('modern-companion-scrim')).toBeHidden();

  // Escape with nothing to stop closes it; focus goes back to Ask, or to the button that opened it until Ask exists.
  await page.keyboard.press('Escape');
  await expect(pane).toBeHidden();
  await expectFocusBack(page, page.getByRole('button', { name: 'Let the agent structure it', exact: true }));
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
});

test('from 1,280 px down the window is a sheet over the page with a scrim, and a click on the scrim closes it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await modern(page);
  const editor = await sceneInModern(page, 'Sheet Book');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+j');
  const pane = companion(page);
  await expect(pane).toBeVisible();

  // The page is not pushed: the window overlaps it, over a scrim.
  const area = page.locator('.modern-page-area');
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).insetInlineEnd)).toBe('0px');
  await settled(pane);
  const windowBox = await pane.boundingBox();
  const pageBox = await page.locator('#modern-page').boundingBox();
  expect(windowBox?.width).toBe(400);
  expect((pageBox?.x ?? 0) + (pageBox?.width ?? 0)).toBeGreaterThan(windowBox?.x ?? 0);
  // The window ends a gutter from the stage's edge.
  expect(Math.round((windowBox?.x ?? 0) + (windowBox?.width ?? 0))).toBe(1280 - 32);
  const scrim = page.getByTestId('modern-companion-scrim');
  await expect(scrim).toBeVisible();

  await scrim.click({ position: { x: 40, y: 400 } });
  await expect(pane).toBeHidden();
  await expect(scrim).toHaveCount(0);
});

test('under reduced motion the window fades in place and the page does not recede', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await modern(page);
  const editor = await sceneInModern(page, 'Still Book');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+j');
  const pane = companion(page);
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute('data-morph', 'fade');
  const area = page.locator('.modern-page-area');
  // It still moves over (at once), but never scales.
  await expect.poll(() => area.evaluate((element) => getComputedStyle(element).insetInlineEnd)).toBe('432px');
  expect(await area.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
  await page.keyboard.press('ControlOrMeta+j');
  await expect(pane).toBeHidden();
  // Closed at once, with no shrink; the role query no longer finds the hidden window, so read it by id.
  await expect(companionElement(page)).toHaveAttribute('data-morph', 'none');
});

/** The text after "Request: " in the request's user messages, up to the line's end. */
function requestOf(user: string): string {
  const at = user.indexOf('Request: ');
  if (at === -1) return '';
  const rest = user.slice(at + 'Request: '.length);
  const end = rest.indexOf('\n');
  return end === -1 ? rest : rest.slice(0, end);
}

const echo: FakeReply = (request) => {
  if (request.system.startsWith('You are drafting prose')) return 'A drafted synopsis.';
  const text = `Answered: ${requestOf(request.user)}`;
  return request.tools !== undefined ? { text } : JSON.stringify({ reply: text });
};

/** Holds every request that carries `marker` until the returned function is called. Registered after the fake, so it runs first. */
async function hold(page: Page, marker: string): Promise<() => void> {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('https://127.0.0.1:5999/**', async (route) => {
    const body = route.request().postData() ?? '';
    if (route.request().method() === 'POST' && body.includes(marker)) await released;
    try {
      await route.fallback();
    } catch {
      // The app stopped the request while it was held.
    }
  });
  return release;
}

test('Escape stops a running turn while the Intent box is empty; with words in it, or nothing to stop, it closes the window', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await modern(page);
  await fakeEndpoint(page, echo);
  const releaseFirst = await hold(page, 'Request: First held question');
  const releaseSecond = await hold(page, 'Request: Second held question');
  await useFakeEndpoint(page);
  await createProject(page, 'Escape Book');
  await page.keyboard.press('ControlOrMeta+j');
  const pane = companion(page);
  await expect(pane).toBeVisible();
  // Focus is in the Intent box once the panel has loaded, even when Ctrl+J came before it.
  await expect(intentBox(page)).toBeFocused();

  // A turn runs; the Intent box is empty again: Escape stops the turn, and the window stays.
  await intentBox(page).fill('First held question');
  await intentBox(page).press('Enter');
  const stop = pane.getByTestId('agent-stop');
  await expect(stop).toBeVisible();
  await expect(intentBox(page)).toHaveValue('');
  await intentBox(page).press('Escape');
  releaseFirst();
  await expect(stop).toBeHidden();
  await expect(pane).toBeVisible();

  // Nothing to stop: Escape closes the window.
  await intentBox(page).press('Escape');
  await expect(pane).toBeHidden();
  await expectFocusBack(page, page.locator('#modern-page'));

  // A turn keeps running while the window is closed, and a draft left in the Intent box is still there when it opens again.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(pane).toBeVisible();
  await intentBox(page).fill('Second held question');
  await intentBox(page).press('Enter');
  await expect(stop).toBeVisible();
  await intentBox(page).fill('a half-typed note');
  // Words in the box: Escape closes the window rather than stopping the turn.
  await intentBox(page).press('Escape');
  await expect(pane).toBeHidden();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(pane).toBeVisible();
  await expect(stop).toBeVisible();
  await expect(intentBox(page)).toHaveValue('a half-typed note');
  releaseSecond();
  await expect(stop).toBeHidden();
  await expect(pane.locator('.agent-turn').last()).toContainText('Answered: Second held question');
});

test('Classic keeps its drawer: Ctrl+J does nothing there, and the drawer still folds with its toggle', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'classic'));
  await createProject(page, 'Classic Book');
  await expect(page.locator('.workspace')).toBeVisible();
  const drawer = page.getByRole('region', { name: 'Agent' });
  await expect(drawer.locator('.agent-toggle')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Agent' })).toHaveCount(0);
  const before = await drawer.locator('.agent-toggle').getAttribute('aria-expanded');
  await page.locator('body').press('ControlOrMeta+j');
  await expect(drawer.locator('.agent-toggle')).toHaveAttribute('aria-expanded', before ?? 'false');
  await expect(page.getByTestId('modern-companion')).toHaveCount(0);
});
