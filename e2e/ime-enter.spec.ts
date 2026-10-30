import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderRow, binderTitle, createProject, trace } from './support.js';

/**
 * i18n §7.3, issue #188: a writer typing Chinese, Japanese or Korean confirms a candidate with Enter, and that Enter reaches the
 * page as a `keydown` while the composition is still active. It is the input method's: a field must not commit, save, add or
 * blur on it. Only the Enter pressed after the composition ends does that.
 *
 * Playwright cannot drive a real input method, so the spec plays one: `compositionstart`, the candidate typed in
 * (`input` while composing), the confirming Enter (`isComposing`, or only `keyCode` 229 as Safari reports the last one), then
 * `compositionend`.
 */

type Belt = 'isComposing' | 'keyCode';

/**
 * Compose `text` into a focused text field and confirm it with Enter, the way an input method does. Resolves to whether any
 * handler took the Enter (called `preventDefault`), which it must not: the key belongs to the input method.
 */
async function composeAndConfirm(field: Locator, text: string, belt: Belt = 'isComposing'): Promise<boolean> {
  await field.focus();
  return field.evaluate(
    (element, { text, belt }) => {
      const input = element as HTMLInputElement;
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      // React tracks a field's value through the prototype's setter, so the candidate goes in the way the browser puts it in.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setValue?.call(input, text);
      input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertCompositionText', isComposing: true }));
      // Each belt alone: Chromium and Firefox say isComposing; Safari's last Enter says only keyCode 229.
      const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: belt === 'isComposing' });
      if (belt === 'keyCode') Object.defineProperty(enter, 'keyCode', { value: 229 });
      input.dispatchEvent(enter);
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
      return enter.defaultPrevented;
    },
    { text, belt },
  );
}

function inspector(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Inspector' });
}

/** A chapter with one scene in it, the scene selected, so the inspector shows a document. */
async function selectedScene(page: Page): Promise<void> {
  await createProject(page, 'Composition Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'The Landing')).toBeVisible();
  await binderTitle(page, 'The Landing').click();
}

/** A new codex entry, open in the codex tab with its Name field. */
async function newEntry(page: Page): Promise<Locator> {
  await createProject(page, 'Composition Codex');
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  return page.getByRole('textbox', { name: 'Name', exact: true });
}

test('the Enter that confirms a candidate in the codex Name field keeps the field open, and the next Enter commits the name', async ({ page }) => {
  const name = await newEntry(page);
  const title = page.locator('.codex-entry-title');
  await expect(title).toHaveText('Untitled entry');
  const upserts = (await trace(page)).filter((row) => row.command === 'codex.upsert').length;

  expect(await composeAndConfirm(name, '艾莲娜')).toBe(false);
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('艾莲娜');
  await expect(title).toHaveText('Untitled entry');
  expect((await trace(page)).filter((row) => row.command === 'codex.upsert')).toHaveLength(upserts);

  await name.press('Enter');
  await expect(title).toHaveText('艾莲娜');
});

test('a candidate confirmed in a codex chip field is not added until the writer presses Enter again, Safari’s keyCode 229 included', async ({
  page,
}) => {
  const name = await newEntry(page);
  await name.fill('Elena');
  await name.press('Enter');
  const alias = page.getByRole('textbox', { name: 'Add to aliases' });

  expect(await composeAndConfirm(alias, 'エレナ')).toBe(false);
  expect(await composeAndConfirm(alias, 'エレナ', 'keyCode')).toBe(false);
  await expect(alias).toHaveValue('エレナ');
  await expect(page.getByRole('list', { name: 'Aliases' }).getByRole('listitem')).toHaveCount(0);

  await alias.press('Enter');
  await expect(page.getByRole('list', { name: 'Aliases' })).toContainText('エレナ');
});

test('a candidate confirmed in the inspector’s keyword field is not added, and the next Enter adds it as one command', async ({ page }) => {
  await selectedScene(page);
  const input = inspector(page).getByLabel('Add keyword');
  const metas = (await trace(page)).filter((row) => row.command === 'binder.setMeta').length;

  expect(await composeAndConfirm(input, '海')).toBe(false);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('海');
  await expect(inspector(page).getByRole('listitem').filter({ hasText: '海' })).toHaveCount(0);
  expect((await trace(page)).filter((row) => row.command === 'binder.setMeta')).toHaveLength(metas);

  await input.press('Enter');
  await expect(inspector(page).getByRole('listitem').filter({ hasText: '海' })).toBeVisible();
  expect((await trace(page)).filter((row) => row.command === 'binder.setMeta')).toHaveLength(metas + 1);
});
