import { expect, test, type Page } from '@playwright/test';
import { fakeEndpoint, planThenAnswer, useFakeEndpoint as pointAtFakeEndpoint } from './endpoint.js';
import { bodyOf, createProject, idOf, projectTrace, waitForSaved } from './support.js';

async function finishedRun(page: Page, name: string): Promise<void> {
  await fakeEndpoint(page, planThenAnswer({ steps: [
    { tool: 'notes.append', params: { doc: 'Opening', text: 'First recorded note.' }, expect: 'The first note is added' },
    { tool: 'notes.append', params: { doc: 'Opening', text: 'Second recorded note.' }, expect: 'The second note is added' },
  ] }, 'Both notes are recorded.'));
  await pointAtFakeEndpoint(page);
  await createProject(page, name);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Opening');
  await page.keyboard.press('Enter');
  await waitForSaved(page);
  const toggle = page.getByRole('button', { name: 'Agent', exact: true });
  if (await toggle.count() > 0) await toggle.click();
  await page.getByRole('combobox', { name: 'Intent' }).fill('Add two notes to Opening.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByTestId('plan-card');
  await expect(card.getByRole('button', { name: 'Approve plan', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Approve plan', exact: true }).click();
  await expect(page.getByTestId('checkpoint')).toBeVisible();
  await waitForSaved(page);
}

async function history(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^Agent run logs$/ }).click();
  await expect(page.getByTestId('run-log-card')).toHaveCount(1);
}

test('a retained run restores after reload, confirms later-edit scope, and exports without its baseline', async ({ page }) => {
  await finishedRun(page, 'Durable Restore Book');
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Durable Restore Book' });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await page.getByRole('treeitem', { name: /Opening/ }).locator('.row-title').click();
  const opening = await idOf(page, 'Opening');
  const original = await bodyOf(page, opening);
  await page.getByRole('textbox', { name: 'Document text' }).fill('Later saved manuscript text.');
  await waitForSaved(page);
  await history(page);
  const run = page.getByTestId('run-log-card');
  await expect(run.getByRole('heading', { name: 'Agent run finished' })).toBeVisible();
  await expect(run.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await run.locator('summary').filter({ hasText: /^Run log and details$/ }).click();
  const download = page.waitForEvent('download');
  await run.getByRole('button', { name: 'Export run log as JSONL' }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(/^run_[A-Za-z0-9_-]+\.jsonl$/);
  const stream = await exported.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows[0]?.t).toBe('run.metadata');
  expect(rows[0]?.outcome).toBe('applied');
  expect(JSON.stringify(rows)).not.toContain('baseline');
  await run.getByRole('button', { name: 'Restore to before this run…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Restore to before this run?' });
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(confirm).toContainText('Later edits will be taken back too.');
  await expect(confirm).toContainText('Conversation, recorded spend, exports, picture files and external side effects stay as they are.');
  await confirm.getByRole('button', { name: 'Restore project', exact: true }).click();
  await expect.poll(() => projectTrace(page)).toContain('project.restoreRun');
  await waitForSaved(page);
  await expect(run.getByRole('status').filter({ hasText: 'The project was restored to before this run.' })).toBeVisible();
  expect(await bodyOf(page, opening)).toBe(original);
  const undo = page.getByRole('button', { name: 'Undo', exact: true }).first();
  await expect(undo).toBeEnabled();
  await undo.click();
  await waitForSaved(page);
  expect(await bodyOf(page, opening)).toContain('Later saved manuscript text.');
});

test('run cards disclose export privacy and refuse enabling a folder copy without a folder', async ({ page }) => {
  await finishedRun(page, 'Run Log Privacy Book');
  await history(page);
  const copy = page.getByRole('checkbox', { name: 'Keep derived run-log copies in this project’s folder on this device.' });
  await expect(copy).not.toBeChecked();
  await copy.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Save or open this project in a folder and allow write access first.' })).toBeVisible();
  await expect(copy).not.toBeChecked();
  await page.getByTestId('run-log-card').locator('summary').click();
  await expect(page.getByTestId('run-log-card')).toContainText('The log can contain manuscript and conversation text.');
  await page.getByTestId('run-log-card').getByRole('button', { name: 'Discard log', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Discard this run log?' });
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(confirm).toContainText('Its restore point is deleted.');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('run-log-card')).toHaveCount(1);
});

test('Activity retries a failed folder-copy preference read without enabling a copy', async ({ page }) => {
  await createProject(page, 'Run Copy Preference Book');
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.get;
    (globalThis as unknown as { restoreRunCopyRead: () => void }).restoreRunCopyRead = () => { IDBObjectStore.prototype.get = get; };
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'kv' && typeof key === 'string' && key.startsWith('run-copy:')) {
        throw new Error('Preference read refused for this test.');
      }
      return get.call(this, key);
    };
  });
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.locator('.activity-runs > summary').click();
  const copy = page.getByRole('checkbox', { name: 'Keep derived run-log copies in this project’s folder on this device.' });
  await expect(copy).toBeDisabled();
  await page.evaluate(() => (globalThis as unknown as { restoreRunCopyRead: () => void }).restoreRunCopyRead());
  await page.getByRole('button', { name: 'Retry folder-copy preference' }).click();
  await expect(copy).toBeEnabled();
  await expect(copy).not.toBeChecked();
});

for (const shell of ['classic', 'modern'] as const) {
  test(`German run-card actions fit their ${shell} Activity rail and narrow drawer`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await finishedRun(page, 'Localized Run Book');
    await page.getByRole('button', { name: 'Hide the agent', exact: true }).click();
    await history(page);
    await page.getByTestId('open-settings').click();
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="appearance"]').click();
    if (shell === 'modern') {
      await settings.getByTestId('interface-choice').getByRole('radio', { name: 'Modern', exact: true }).check();
      await expect(page.getByTestId('shell')).toHaveAttribute('data-state', 'modern');
    }
    await settings.locator('input[name="interface-language"][value="de"]').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await settings.locator('.settings-head button').click();
    if (shell === 'modern') await page.locator('#modern-binder-agent').click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) {
        const trigger = shell === 'classic' ? page.locator('button[aria-controls="narrow-rail"]') : page.getByTestId('modern-narrow-binder');
        if (await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
      }
      const logs = page.locator('.activity-runs');
      await expect(logs).toBeVisible();
      if (await logs.getAttribute('open') === null) await logs.locator(':scope > summary').click();
      const run = page.getByTestId('run-log-card');
      await expect(run).toBeVisible();
      if (await run.locator('details').getAttribute('open') === null) await run.locator('summary').click();
      await expect(run.locator('time')).not.toBeEmpty();
      await expect(run.getByTestId('interrupted-progress')).toContainText('gearbeitet');
      await expect.poll(() => run.evaluate((element) => {
        const rail = element.closest('.activity')!.getBoundingClientRect();
        const card = element.getBoundingClientRect();
        const clipped = [...element.querySelectorAll<HTMLElement>('button, summary, p')].some((control) => control.scrollWidth > control.clientWidth + 1);
        return card.left >= rail.left && card.right <= rail.right + 1 && !clipped;
      })).toBe(true);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  });
}
