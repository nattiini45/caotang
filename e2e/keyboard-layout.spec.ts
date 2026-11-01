import { expect, test, type Page } from '@playwright/test';

import { binderRow, countOf, createProject } from './support.js';

/**
 * #189 (ui-modules §2.5): the keyboard map hears the layout. The event-to-facts callers pass `KeyboardEvent.code` and
 * `getModifierState('AltGraph')`, so a shortcut works when the layout prints another script (`Ctrl+Я` is still undo) and a
 * character typed with AltGraph is never a chord, even though Windows reports AltGr as Ctrl+Alt.
 *
 * These are the caller-wiring witnesses: the pure matching rule is asserted in `unit/keymap-and-corkboard.spec.ts`. A
 * synthetic event is the only way to name a key on a layout this machine does not have, so the tests dispatch one and read
 * what the app did with it.
 */

/** A project whose chapter "Chapter 1" is selected, so Ctrl+N has a parent to create a document in. */
async function chapterSelected(page: Page): Promise<void> {
  await createProject(page, 'Layout Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
}

test('Ctrl+N on a Russian layout creates a document: the window listener passes the physical key', async ({ page }) => {
  await chapterSelected(page);
  const before = await countOf(page, 'binder.create');

  const prevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'т', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

  // The chord ran: the app cancelled the key and created the document the shortcut asks for.
  expect(prevented).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Rename Untitled' })).toBeFocused();
  expect(await countOf(page, 'binder.create')).toBe(before + 1);
});

test('an AltGr character in a text field is not prevented: the listener passes the AltGraph fact, not Ctrl+Alt', async ({ page }) => {
  await chapterSelected(page);
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  const field = page.getByRole('textbox', { name: 'Rename Untitled' });
  await expect(field).toBeFocused();

  // Hungarian AltGr+F types `[` and arrives as Ctrl+Alt; Ctrl+Alt+F without the AltGraph fact would focus the filter.
  const outcome = await field.evaluate((input) => {
    const event = new KeyboardEvent('keydown', {
      key: '[',
      code: 'KeyF',
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return { altGraph: event.getModifierState('AltGraph'), prevented: event.defaultPrevented };
  });

  expect(outcome).toEqual({ altGraph: true, prevented: false });
  // The field keeps the focus, and no shortcut acted on the character.
  await expect(field).toBeFocused();
});
