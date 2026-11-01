import { expect, test, type Page } from '@playwright/test';

import { NO_PIN } from './classic-pin.js';
import { binderRow, createProject, waitForSaved } from './support.js';

/**
 * Modern's Scene info (M7, #308; modern-interface.md §7.3, §7.5, §8.2, §8.3): the inspector as a non-modal dialog of thick glass from
 * the title capsule (until #306's capsule registers itself, Scene info's provisional opener), with the same ids, so the routes to
 * `#inspector-synopsis` keep working; the first fields, **Notes** and **Story details** as disclosures, and **Progress** with today's
 * words and the save state in words. Escape commits the field and closes, and focus returns to the opener; a click outside closes;
 * **Keep open** docks it; reduced motion fades it in place of the morph. These specs run Modern, so they start without the Classic pin.
 */

test.use({ storageState: NO_PIN });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('caotang.interface', 'modern'));
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
}

function opener(page: Page) {
  return page.getByTestId('scene-info-opener').getByRole('button', { name: 'Scene info' });
}

function sceneInfo(page: Page) {
  return page.getByRole('dialog', { name: 'Scene info' });
}

test('Scene info opens from its opener on the synopsis, with the inspector’s ids, its sections and Progress', async ({ page }) => {
  await sceneInModern(page, 'Harbour Book');
  // Closed, the inspector is not in the page: Scene info holds it.
  await expect(page.locator('#inspector-synopsis')).toHaveCount(0);

  const open = opener(page);
  await expect(open).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.click();

  const dialog = sceneInfo(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'false');
  await expect(dialog).toHaveAttribute('id', 'modern-scene-info');
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expect(open).toHaveAttribute('aria-controls', 'modern-scene-info');
  // Focus moves to the first field as it opens; the field keeps its Classic id.
  await expect(dialog.locator('#inspector-synopsis')).toBeFocused();
  await expect(dialog.getByRole('heading', { name: 'The crossing' })).toBeVisible();

  // The first section: synopsis, status and label, keywords. Then the two disclosures, closed.
  await expect(dialog.getByRole('button', { name: /^Status: No status/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Label: No label/ })).toBeVisible();
  const notes = dialog.getByTestId('inspector-notes-disclosure');
  const story = dialog.getByTestId('inspector-story-disclosure');
  await expect(notes.locator('summary')).toHaveText('Notes');
  await expect(story.locator('summary')).toHaveText('Story details');
  await expect(notes).not.toHaveAttribute('open', /.*/);
  await notes.locator('summary').click();
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

test('Escape in the synopsis commits it, closes Scene info and returns focus to the opener', async ({ page }) => {
  await sceneInModern(page, 'Escape Book');
  await opener(page).click();
  const field = sceneInfo(page).locator('#inspector-synopsis');
  await expect(field).toBeFocused();
  await page.keyboard.type('Lin crosses at dawn.');
  // Escape at once, inside the field's debounce: the field commits before Scene info goes.
  await page.keyboard.press('Escape');
  await expect(sceneInfo(page)).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
  await expect(opener(page)).toHaveAttribute('aria-expanded', 'false');

  await opener(page).click();
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

test('a click outside closes Scene info and leaves focus where the writer clicked; the opener closes it too', async ({ page }) => {
  await sceneInModern(page, 'Outside Book');
  await opener(page).click();
  await expect(sceneInfo(page)).toBeVisible();
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await expect(sceneInfo(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();

  await opener(page).click();
  await expect(sceneInfo(page)).toBeVisible();
  await opener(page).click();
  await expect(sceneInfo(page)).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
});

test('Edit synopsis in the binder opens Scene info on the synopsis', async ({ page }) => {
  await sceneInModern(page, 'Route Book');
  await page.getByRole('button', { name: 'Actions for The crossing' }).click();
  await page.getByRole('menuitem', { name: 'Edit synopsis' }).click();
  await expect(sceneInfo(page)).toBeVisible();
  await expect(page.locator('#inspector-synopsis')).toBeFocused();
  await page.keyboard.type('A ferry, late.');
  await page.keyboard.press('Escape');
  await expect(sceneInfo(page)).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
  await opener(page).click();
  await expect(page.locator('#inspector-synopsis')).toHaveValue('A ferry, late.');
});

test('Keep open docks Scene info beside the page: a click outside leaves it, Escape gives focus back, and it is kept', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await sceneInModern(page, 'Docked Book');
  const pageBox = async () => (await page.locator('#modern-page').boundingBox())?.x ?? 0;
  const before = await pageBox();

  await opener(page).click();
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
  await expect(opener(page)).toBeFocused();

  // Kept across a reload: the next opening is docked.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await page.getByRole('listitem').filter({ hasText: 'Docked Book' }).getByRole('button', { name: 'Open', exact: true }).click();
  await opener(page).click();
  await expect(sceneInfo(page)).toHaveClass(/is-docked/);
  await sceneInfo(page).getByRole('button', { name: 'Keep open' }).click();
  await expect(sceneInfo(page)).toHaveClass(/is-popover/);
});

test.describe('motion', () => {
  test('Scene info morphs out of its opener', async ({ page }) => {
    await sceneInModern(page, 'Morph Book');
    await opener(page).click();
    await expect(sceneInfo(page)).toHaveAttribute('data-entrance', 'morph');
  });

  test('under reduced motion it fades in place, and nothing moves', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await sceneInModern(page, 'Still Book');
    await opener(page).click();
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
