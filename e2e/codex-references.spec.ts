import { expect, test } from '@playwright/test';
import { createProject, waitForSaved } from './support.js';

test('external research references survive reopening and can be edited and removed', async ({ page }) => {
  test.setTimeout(60_000);
  const externalRequests: string[] = [];
  page.on('request', (request) => { if (request.url().startsWith('https://example.org')) externalRequests.push(request.url()); });
  await createProject(page, 'Tide Research');
  const codex = page.getByRole('tab', { name: 'Codex' });
  await codex.click();
  await page.getByRole('button', { name: 'New entry' }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Fenn');
  await name.press('Enter');
  const references = page.getByRole('region', { name: 'External references' });
  const add = references.getByRole('button', { name: 'Add reference' });
  await add.click();
  await references.getByLabel('Reference title').fill('The Tidemaker');
  await references.getByLabel('URL', { exact: true }).fill('https://example.org/tides');
  await references.getByLabel('Publisher', { exact: true }).fill('Gull Press');
  await references.getByLabel('Publication date').fill('2024-02-29');
  await references.getByLabel('Quote', { exact: true }).fill('The harbour keeps a separate tide log.');
  await references.getByRole('button', { name: 'Save reference' }).click();
  await expect(add).toBeFocused();
  await waitForSaved(page);

  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Tide Research' }).getByRole('button', { name: 'Open' }).click();
  await codex.click();
  await page.getByRole('button', { name: /^Fenn/ }).click();
  await expect(references).toContainText('Gull Press');
  await expect(references.locator('time')).toHaveAttribute('datetime', '2024-02-29');
  await expect(references.locator('blockquote')).toHaveText('The harbour keeps a separate tide log.');
  const link = references.getByRole('link', { name: /example\.org/ });
  await expect(link).toHaveAttribute('href', 'https://example.org/tides');
  await expect(link).toHaveAttribute('rel', /noreferrer/);
  expect(externalRequests).toEqual([]);

  const edit = references.getByRole('button', { name: 'Edit reference The Tidemaker' });
  await edit.click();
  await references.getByLabel('Publisher', { exact: true }).fill('');
  await references.getByRole('button', { name: 'Save reference' }).click();
  await expect(edit).toBeFocused();
  await expect(references).not.toContainText('Gull Press');
  await expect(link).toBeVisible();
  await references.getByRole('button', { name: 'Remove reference The Tidemaker' }).click();
  await expect(link).not.toBeVisible();
  await expect(add).toBeFocused();
});
