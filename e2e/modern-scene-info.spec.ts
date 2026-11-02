import { expect, test, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { binderRow, binderTitle, createProject, waitForSaved } from './support.js';

/**
 * Modern's Scene info (M7, #308; modern-interface.md §7.3, §7.5, §8.2, §8.3): the inspector as a non-modal dialog of thick glass, with
 * the same ids, so the routes to `#inspector-synopsis` keep working; the first fields, **Notes** and **Story details** as disclosures,
 * and **Progress** with today's words and the save state in words. Escape commits the field and closes, and focus goes back; a click
 * outside closes; **Keep open** docks it; reduced motion fades it in place of the morph. Most specs open it by the binder's **Edit
 * synopsis**, the route every shell has; it then grows out of #306's title capsule, its opener. They run Modern, so they start without
 * the pin.
 */

test.use({ storageState: NO_PIN });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('caotang.interface', 'modern');
    // Once the binder lives in Modern's sidebar (#307), closed and inert until opened, a pinned sidebar keeps the tree in reach; the
    // key is ignored where there is no sidebar.
    localStorage.setItem('caotang.modern.binderPinned', 'true');
  });
});

/** A Modern project with one scene, selected. */
async function sceneInModern(page: Page, project: string): Promise<void> {
  await createProject(page, project);
  await expect(page.getByTestId('modern-stage')).toBeVisible();
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The crossing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry left at dawn.');
  await waitForSaved(page);
  // Where the browser has not kept the storage (WebKit here), the banner floats at the top centre; it is #311's, so out of the way.
  const banner = page.getByTestId('storage-banner');
  await banner.waitFor({ state: 'visible', timeout: 1_500 }).catch(() => undefined);
  if (await banner.isVisible()) await banner.getByRole('button', { name: 'Dismiss' }).click();
}

/** Opens Scene info on the synopsis by the binder row's Edit synopsis (its context menu). */
async function editSynopsis(page: Page, title = 'The crossing'): Promise<void> {
  await binderTitle(page, title).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${title}` }).getByRole('menuitem', { name: 'Edit synopsis' }).click();
}

function sceneInfo(page: Page) {
  return page.getByRole('dialog', { name: 'Scene info' });
}

test('Edit synopsis opens Scene info on the synopsis, with the inspector’s ids, its sections and Progress', async ({ page }) => {
  await sceneInModern(page, 'Harbour Book');
  // Closed, the inspector is not in the page: Scene info holds it.
  await expect(page.locator('#inspector-synopsis')).toHaveCount(0);

  await editSynopsis(page);
  const dialog = sceneInfo(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'false');
  await expect(dialog).toHaveAttribute('id', 'modern-scene-info');
  // Focus moves to the synopsis as it opens; the field keeps its Classic id.
  await expect(dialog.locator('#inspector-synopsis')).toBeFocused();
  await expect(dialog.getByRole('heading', { name: 'The crossing' })).toBeVisible();

  // The first section: synopsis, status and label, keywords. Then the two disclosures, closed.
  await expect(dialog.getByRole('button', { name: /^Status: No status/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Label: No label/ })).toBeVisible();
  const notes = dialog.getByTestId('inspector-notes-disclosure');
  const story = dialog.getByTestId('inspector-story-disclosure');
  // Their own summaries (a section inside may have a disclosure of its own).
  await expect(notes.locator(':scope > summary')).toHaveText('Notes');
  await expect(story.locator(':scope > summary')).toHaveText('Story details');
  await expect(notes).not.toHaveAttribute('open', /.*/);
  await notes.locator(':scope > summary').click();
  await expect(dialog.getByRole('textbox', { name: 'Notes' })).toBeVisible();

  // Progress: the daily target's quick-set and today's words, and the save state in words.
  const progress = dialog.getByTestId('scene-info-progress');
  await expect(progress.getByRole('heading', { name: 'Progress' })).toBeVisible();
  await expect(progress.getByRole('button', { name: /words today/ })).toBeVisible();
  await expect(progress.getByTestId('scene-info-save-state')).toHaveText('All changes saved in this browser');

  // The status picker is the inspector's own, and the binder row follows it: the same command as in Classic.
  await dialog.getByRole('button', { name: /^Status: No status/ }).click();
  await page.getByRole('menuitemradio', { name: 'Final' }).click();
  await expect(dialog.getByRole('button', { name: /^Status: Final/ })).toBeVisible();
  await expect(binderRow(page, 'The crossing').getByRole('button', { name: /^Status of The crossing: Final/ })).toBeVisible();
});

test('Escape in the synopsis commits it, closes Scene info and gives focus back', async ({ page }) => {
  await sceneInModern(page, 'Escape Book');
  await editSynopsis(page);
  const field = sceneInfo(page).locator('#inspector-synopsis');
  await expect(field).toBeFocused();
  await page.keyboard.type('Lin crosses at dawn.');
  // Escape at once, inside the field's debounce: the field commits before Scene info goes.
  await page.keyboard.press('Escape');
  await expect(sceneInfo(page)).toHaveCount(0);
  // The menu item that asked is gone with its menu, so focus goes to #306's title capsule, Scene info's opener.
  await expect(page.getByTestId('modern-title-capsule')).toBeFocused();

  await editSynopsis(page);
  await expect(sceneInfo(page).locator('#inspector-synopsis')).toHaveValue('Lin crosses at dawn.');
  // The store holds the synopsis: it was written through the inspector's own command.
  await page.keyboard.press('Escape');
  await waitForSaved(page);
  const synopsis = await page.evaluate(() => {
    const caotang = (globalThis as unknown as { __caotang?: { tree(): { title: string; synopsis: string }[] } }).__caotang;
    return caotang?.tree().find((node) => node.title === 'The crossing')?.synopsis ?? null;
  });
  expect(synopsis).toBe('Lin crosses at dawn.');
});

test('a click outside closes Scene info and leaves focus where the writer clicked; Close closes it too', async ({ page }) => {
  await sceneInModern(page, 'Outside Book');
  await editSynopsis(page);
  await expect(sceneInfo(page)).toBeVisible();
  // The binder, beside the popover: the click lands there, and focus stays with it.
  await binderTitle(page, 'The crossing').click();
  await expect(sceneInfo(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.closest('[role="tree"]') !== null)).toBe(true);

  await editSynopsis(page);
  await sceneInfo(page).getByRole('button', { name: 'Close' }).click();
  await expect(sceneInfo(page)).toHaveCount(0);
});

test('an inspector request from the text (the route the synopsis chord takes) opens Scene info, and Escape goes back to the text', async ({ page }) => {
  await sceneInModern(page, 'Chord Book');
  // Ctrl+Shift+Y in a screenplay's Source and Edit synopsis send the same request (app/inspector-request.ts); this sends it from the text.
  await page.getByRole('textbox', { name: 'Document text' }).click();
  const synopsisRequest = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const event = new CustomEvent('caotang-inspector-request', { detail: { field: 'synopsis' }, cancelable: true });
        window.dispatchEvent(event);
        resolve(event.defaultPrevented);
      }),
  );
  expect(await synopsisRequest).toBe(true);
  await expect(sceneInfo(page).locator('#inspector-synopsis')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sceneInfo(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
});

test('Keep open docks Scene info beside the page: a click outside leaves it, Escape gives focus back, and it is kept in this browser', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await sceneInModern(page, 'Docked Book');
  const pageBox = async () => (await page.locator('#modern-page').boundingBox())?.x ?? 0;
  const before = await pageBox();

  await editSynopsis(page);
  const keep = sceneInfo(page).getByRole('button', { name: 'Keep open' });
  await expect(keep).toHaveAttribute('aria-pressed', 'false');
  await keep.click();
  await expect(keep).toHaveAttribute('aria-pressed', 'true');
  await expect(sceneInfo(page)).toHaveClass(/is-docked/);
  expect(await page.evaluate(() => localStorage.getItem('caotang.modern.sceneInfoDocked'))).toBe('docked');

  // Docked at the inline-end edge, and the page moved over for it.
  const dock = await sceneInfo(page).boundingBox();
  expect(dock).not.toBeNull();
  expect((dock?.x ?? 0) + (dock?.width ?? 0)).toBeGreaterThan(1440 - 64);
  await expect.poll(pageBox).toBeLessThan(before);

  await page.getByRole('textbox', { name: 'Document text' }).click();
  await expect(sceneInfo(page)).toBeVisible();

  await sceneInfo(page).locator('#inspector-synopsis').click();
  await page.keyboard.press('Escape');
  await expect(sceneInfo(page)).toBeVisible();
  await expect(sceneInfo(page).locator('#inspector-synopsis')).not.toBeFocused();

  // Off again: a popover, and nothing kept.
  await sceneInfo(page).getByRole('button', { name: 'Keep open' }).click();
  await expect(sceneInfo(page)).toHaveClass(/is-popover/);
  expect(await page.evaluate(() => localStorage.getItem('caotang.modern.sceneInfoDocked'))).toBeNull();
  await expect.poll(pageBox).toBe(before);
});

test.describe('motion', () => {
  test('with motion on, the durations stand, and Scene info grows out of the title capsule, from a route too', async ({ page }) => {
    await sceneInModern(page, 'Morph Book');
    await editSynopsis(page);
    // A route has no control of its own to grow from, so Scene info grows out of #306's title capsule, its opener (§8.3).
    await expect(sceneInfo(page)).toHaveAttribute('data-entrance', 'morph');
    await page.keyboard.press('Escape');
    await expect(sceneInfo(page)).toHaveCount(0);
    await page.getByTestId('modern-title-capsule').click();
    await expect(sceneInfo(page)).toHaveAttribute('data-entrance', 'morph');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-3').trim())).toBe('520ms');
  });

  test('under reduced motion it fades in place, and nothing moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await sceneInModern(page, 'Still Book');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-3').trim())).toBe('0s');
    await editSynopsis(page);
    await expect(sceneInfo(page)).toHaveAttribute('data-entrance', 'fade');
    const moving = await sceneInfo(page).evaluate((element) =>
      element.getAnimations({ subtree: true }).some((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        return (effect?.getKeyframes() ?? []).some((frame) => 'transform' in frame && frame['transform'] !== 'none');
      }),
    );
    expect(moving).toBe(false);
  });
});
