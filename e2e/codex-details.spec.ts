import { expect, test } from '@playwright/test';
import { createProject, waitForSaved } from './support.js';

test('a custom type shares typed detail fields between entries after reopening', async ({ page }) => {
  test.setTimeout(60_000);
  await createProject(page, 'Tide Log');
  const codex = page.getByRole('tab', { name: 'Codex' });
  await codex.click();
  await page.getByRole('button', { name: 'New entry' }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Fenn');
  await name.press('Enter');

  const details = page.getByRole('region', { name: 'Details', exact: true });
  const add = details.getByRole('button', { name: 'Add detail field' });
  await add.click();
  await details.getByRole('textbox', { name: 'Entry type' }).fill('Guest');
  await details.getByRole('textbox', { name: 'Field label' }).fill('Episode');
  await details.getByRole('textbox', { name: 'Field key' }).fill('episode');
  await details.getByRole('combobox', { name: 'Value type' }).click();
  await page.getByRole('option', { name: 'Number', exact: true }).click();
  await details.getByRole('button', { name: 'Save field' }).click();
  await expect(add).toBeFocused();
  await expect(page.getByLabel('Type', { exact: true })).toHaveValue('Guest');
  const episode = details.getByRole('spinbutton', { name: 'Episode' });
  await episode.fill('12');
  await episode.press('Enter');
  await waitForSaved(page);

  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Tide Log' }).getByRole('button', { name: 'Open' }).click();
  await codex.click();
  await page.getByRole('button', { name: /^Fenn/ }).click();
  await expect(episode).toHaveValue('12');
  await episode.fill('');
  await episode.press('Enter');
  await waitForSaved(page);

  await page.getByRole('button', { name: '← All entries' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByLabel('Type', { exact: true }).selectOption('Guest');
  await expect(episode).toHaveValue('');
});
