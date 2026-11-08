import { expect, test } from '@playwright/test';

import { createProject, idOf, waitForSaved } from './support.js';
import { showBinder, switchToModern } from './modern-walk.js';
import { fakeEndpoint, useFakeEndpoint } from './endpoint.js';

test('sidebar panels explain real empty and disabled states with named glyphs', async ({ page }) => {
  await createProject(page, 'Panel states');
  await switchToModern(page);
  await showBinder(page);
  await page.getByTestId('modern-binder-pin').click();
  const sidebar = page.getByTestId('modern-sidebar');
  await expect(sidebar.getByRole('img', { name: 'Empty manuscript', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('img', { name: 'Empty research', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Create Chapter 1' })).toBeVisible();
  await sidebar.getByRole('tab', { name: 'Activity' }).click();
  await expect(sidebar.getByRole('img', { name: 'No changes', exact: true })).toBeVisible();
  await sidebar.getByRole('tab', { name: 'Findings' }).click();
  await expect(sidebar.getByRole('img', { name: 'No findings to show', exact: true })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Scan the manuscript' }).click();
  await expect(sidebar.getByRole('heading', { name: 'No findings recorded' })).toBeVisible();
  await expect(sidebar.getByRole('img', { name: 'No open findings', exact: true })).toBeVisible();
  await sidebar.getByRole('tab', { name: 'Trace' }).click();
  await expect(sidebar.getByRole('img', { name: 'No recorded turns', exact: true })).toBeVisible();
  await sidebar.getByRole('switch', { name: 'Keep agent traces for this tab' }).uncheck();
  await expect(sidebar.getByRole('img', { name: 'Recording is off', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('region', { name: 'Traces are off' })).toContainText('Turn on “Keep agent traces for this tab”');
  await expect(sidebar.getByRole('region', { name: 'Traces are off' })).toHaveAttribute('data-panel-state', 'off');
  await sidebar.getByRole('switch', { name: 'Keep agent traces for this tab' }).check();
  await expect(sidebar.getByRole('heading', { name: 'No turns traced yet' })).toBeVisible();
});

test('empty sidebar actions and trace guidance follow a German interface', async ({ page }) => {
  await createProject(page, 'Deutsche Seitenleiste');
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="de"]').click();
  await expect(settings.locator('input[name="interface-language"][value="de"]')).toBeChecked();
  await settings.getByRole('button', { name: 'Schließen', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'Manuskript', exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'Recherche', exact: true })).toBeVisible();
  expect(await idOf(page, 'Manuscript')).toBe('manuscript');
  expect(await idOf(page, 'Research')).toBe('research');
  await expect(page.getByRole('img', { name: 'Leeres Manuskript', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kapitel 1 erstellen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Neue Recherchenotiz' })).toBeVisible();
  await page.getByRole('button', { name: 'Kapitel 1 erstellen' }).click();
  const chapterId = await idOf(page, 'Chapter 1');
  const chapter = page.locator(`[data-node-id="${chapterId}"]`);
  await chapter.press('F2');
  await chapter.getByRole('textbox').fill('Manuscript');
  await page.keyboard.press('Enter');
  await expect(chapter.locator('.row-title')).toHaveText('Manuscript');
  await page.getByRole('tab', { name: 'Ablauf', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Noch keine Durchläufe aufgezeichnet' })).toBeVisible();
  await page.getByRole('switch', { name: 'Agentenabläufe für diesen Tab aufzeichnen' }).uncheck();
  await expect(page.getByRole('img', { name: 'Aufzeichnung ausgeschaltet', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ablaufaufzeichnung ausgeschaltet' })).toContainText('Schalten Sie „Agentenabläufe für diesen Tab aufzeichnen“ ein');
});

test('a sidebar loading its code is distinct from empty content', async ({ page }) => {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await createProject(page, 'Loading panel');
  await page.route('**/src/components/FindingsPanel.tsx*', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole('tab', { name: 'Findings' }).click();
  const loading = page.getByRole('status').filter({ hasText: 'Loading Findings' });
  await expect(loading.getByRole('img', { name: 'Loading', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No findings yet' })).toHaveCount(0);
  release();
  await expect(page.getByRole('heading', { name: 'No findings yet' })).toBeVisible();
  await expect(loading).toHaveCount(0);
});

test('a failed sidebar code load has a named error glyph and recovery actions', async ({ page }) => {
  await createProject(page, 'Failed panel');
  await page.route('**/src/components/TracePanel.tsx*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("simulated panel load failure");' }));
  await page.getByRole('tab', { name: 'Trace' }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Trace could not be loaded' });
  await expect(error.getByRole('img', { name: 'Error', exact: true })).toBeVisible();
  await expect(error.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(error.getByRole('button', { name: 'Reload' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No turns traced yet' })).toHaveCount(0);
});

test('a review in progress does not claim to be empty, and a failed review retains recovery guidance', async ({ page }) => {
  await fakeEndpoint(page, () => '{}');
  await useFakeEndpoint(page);
  await createProject(page, 'Review states');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry reached the harbour before dawn.');
  await waitForSaved(page);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://127.0.0.1:5999/v1/chat/completions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await held;
    await route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify({ error: { message: 'The test model refused this review.' } }) });
  });
  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.getByRole('button', { name: 'Review with agent' }).click();
  await page.getByRole('button', { name: 'Start the review' }).click();
  const running = page.getByTestId('review-running');
  await expect(running.getByRole('img', { name: 'Review in progress' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No findings yet' })).toHaveCount(0);
  await expect(running.getByRole('button', { name: 'Stop the review' })).toBeEnabled();
  release();
  const failed = page.getByRole('alert').filter({ hasText: 'Run a scan or start another review to try again.' });
  await expect(failed.getByRole('img', { name: 'Check stopped' })).toBeVisible();
  await expect(running).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No findings recorded' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review with agent' })).toBeEnabled();
});

test('findings save failures offer a working retry without pretending the panel is empty', async ({ page }) => {
  await page.addInitScript(() => {
    const control = { refuse: false };
    (globalThis as unknown as { __findingsSave: typeof control }).__findingsSave = control;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>): IDBRequest<IDBValidKey> {
      const request = put.apply(this, args);
      const record = args[0] as { coherenceFiles?: unknown } | undefined;
      if (control.refuse && record?.coherenceFiles !== undefined) this.transaction.abort();
      return request;
    };
  });
  await createProject(page, 'Save states');
  await page.getByRole('tab', { name: 'Findings' }).click();
  await page.evaluate(() => { (globalThis as unknown as { __findingsSave: { refuse: boolean } }).__findingsSave.refuse = true; });
  await page.getByRole('button', { name: 'Scan the manuscript' }).click();
  const failed = page.getByRole('alert').filter({ hasText: 'Your findings could not be saved in this browser' });
  await expect(failed.getByRole('img', { name: 'Save failed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No findings recorded' })).toHaveCount(0);
  await page.evaluate(() => { (globalThis as unknown as { __findingsSave: { refuse: boolean } }).__findingsSave.refuse = false; });
  await failed.getByRole('button', { name: 'Try saving findings again' }).click();
  await expect(failed).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No findings recorded' })).toBeVisible();
});

test('Activity explains an Undo refused because pending typing became a later change', async ({ page }) => {
  await createProject(page, 'Undo states');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Scene');
  await page.keyboard.press('Enter');
  await page.clock.install();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.getByRole('textbox', { name: 'Document text' }).fill('Typing that has not reached the autosave timer.');
  await page.getByRole('tab', { name: 'Activity' }).click();
  const rows = page.getByRole('list', { name: 'Activity' });
  await rows.getByRole('button', { name: 'Undo: Renamed' }).first().click();
  const failure = page.getByRole('alert').filter({ has: page.getByRole('img', { name: 'Undo failed' }) });
  await expect(failure).toContainText('later changes');
  await expect(failure.getByRole('button', { name: 'Try Undo again' })).toBeDisabled();
  await rows.getByRole('listitem').first().getByRole('button', { name: 'Undo' }).click();
  await expect(failure).toHaveCount(0);
});
