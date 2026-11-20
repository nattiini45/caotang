import { expect, test, type Page } from '@playwright/test';
import type * as RecurringModule from '../apps/desktop/src/app/recurring-tasks.js';
import type { TaskRecord } from '../apps/desktop/src/app/task-store.js';

import { fakeEndpoint, useFakeEndpoint, type FakeReply } from './endpoint.js';
import { binderTitle, createProject, waitForSaved, chooseInterfaceLanguage} from './support.js';
import { projectTrace } from './support.js';

/**
 * Recurring tasks as a writer meets them (agent-harness.md §12): a task made in the agent drawer, a scan that starts by itself when
 * the project opens and makes no model request, a task that is due offered with Run now and Skip even with the drawer closed, and
 * a model task that is only ever offered. The model is a fake endpoint (endpoint.ts), counted; the tasks, the offers and the history
 * are the app's own.
 */

/** The wait for what a project does as it opens, on a machine that is also building the app for other specs. */
const LOADED = 20_000;

async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry was late, as always.');
  await waitForSaved(page);
}

async function openAgent(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByTestId('recurring-tasks')).toBeVisible();
}

/** Reloads and opens the project again. A reload begun while the indicator reads saving could take the task a writer has just made. */
async function reopen(page: Page, name: string, openLabel = 'Open', shell: 'classic' | 'modern' = 'classic'): Promise<void> {
  await waitForSaved(page);
  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: openLabel }).click();
  if (shell === 'classic') await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  else await expect(page.getByTestId('shell')).toHaveAttribute('data-state', 'modern');
}

interface NewTask {
  readonly name: string;
  readonly does: 'Ask the agent' | 'Scan for continuity problems';
  readonly ask?: string;
  readonly when: 'Only when I run it' | 'Each time the project opens' | 'Every day' | 'Every week';
  readonly due: 'Offer it to me' | 'Start it by itself';
  readonly from?: string;
  readonly calls?: string;
}

async function makeTask(page: Page, task: NewTask): Promise<void> {
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task name').fill(task.name);
  await form.getByLabel('What it does').selectOption({ label: task.does });
  if (task.ask !== undefined) await form.getByLabel('What to ask').fill(task.ask);
  await form.getByLabel('When', { exact: true }).selectOption({ label: task.when });
  if (task.from !== undefined) await form.getByLabel('From').fill(task.from);
  await form.getByLabel('When it is due').selectOption({ label: task.due });
  if (task.calls !== undefined) await form.getByLabel('Most model calls in a run').fill(task.calls);
  await form.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: task.name })).toBeVisible();
}

/** A fake model that counts the chat requests it is asked for and answers with a plain reply. */
function countingReply(counter: { calls: number }): FakeReply {
  return (request) => {
    counter.calls += 1;
    return request.tools !== undefined ? { text: 'Looked it over.' } : JSON.stringify({ reply: 'Looked it over.' });
  };
}

test('a scan set to start when the project opens runs by itself the next time, and makes no model request', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await createProject(page, 'Scan Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await makeTask(page, { name: 'Open scan', does: 'Scan for continuity problems', when: 'Each time the project opens', due: 'Start it by itself' });

  const row = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Open scan' });
  await expect(row).toContainText('Each time the project opens');
  await expect(row).toContainText('Calls no model');
  // Made this visit, it has not been due: the open that made it is behind it.
  await expect(row.getByText(/Runs on this machine/)).toHaveCount(0);

  await reopen(page, 'Scan Book');
  await openAgent(page);
  const again = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Open scan' });
  // No click started it, and nothing is offered for it.
  await expect(again.getByText('Runs on this machine (1)')).toBeVisible({ timeout: LOADED });
  await expect(page.getByTestId('task-offers').getByRole('group')).toHaveCount(0);
  await again.getByText('Runs on this machine (1)').click();
  await expect(again.getByRole('list', { name: 'Runs of Open scan' })).toContainText('Done');
  await expect(again.getByRole('list', { name: 'Runs of Open scan' })).toContainText('Scan complete');
  await expect(again.getByRole('list', { name: 'Runs of Open scan' })).toContainText('no model calls');
  expect(counter.calls).toBe(0);
});

test('a task that is due is offered with the drawer closed, announced, and Skip keeps it from coming back', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await createProject(page, 'Offer Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await makeTask(page, { name: 'Daily read', does: 'Ask the agent', ask: 'Look over the newest scene.', when: 'Every day', from: '00:00', due: 'Offer it to me' });

  await reopen(page, 'Offer Book');
  // The drawer is closed, and the writer is still offered the task.
  const offers = page.getByTestId('task-offers');
  const offer = offers.getByRole('group', { name: 'Task due: Daily read' });
  await expect(offer).toBeVisible({ timeout: LOADED });
  await expect(offer).toContainText('It uses the model');
  await expect(page.getByTestId('task-announcement')).toHaveText('Task due: Daily read. Run now or Skip.');
  expect(counter.calls).toBe(0);

  // Skip is a button the keyboard reaches.
  await offer.getByRole('button', { name: 'Skip' }).focus();
  await page.keyboard.press('Enter');
  await expect(offer).toHaveCount(0);
  expect(counter.calls).toBe(0);

  await reopen(page, 'Offer Book');
  await expect(page.getByTestId('task-offers').getByRole('group')).toHaveCount(0);
  await openAgent(page);
  const row = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Daily read' });
  await row.getByText('Runs on this machine (1)').click();
  await expect(row.getByRole('list', { name: 'Runs of Daily read' })).toContainText('Skipped');
});

test('Run now on an offered model task is an agent turn in the Background role, recorded with what it used', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await createProject(page, 'Run Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await makeTask(page, { name: 'Daily read', does: 'Ask the agent', ask: 'Look over the newest scene.', when: 'Every day', from: '00:00', due: 'Offer it to me', calls: '3' });
  await expect(page.getByTestId('recurring-tasks')).toContainText('at most 3 model calls');

  await reopen(page, 'Run Book');
  await expect(page.getByTestId('task-offers').getByRole('button', { name: 'Run now' })).toBeVisible({ timeout: LOADED });
  await page.getByTestId('task-offers').getByRole('button', { name: 'Run now' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => counter.calls).toBeGreaterThan(0);

  await openAgent(page);
  const row = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Daily read' });
  await row.getByText('Runs on this machine (1)').click();
  const runs = row.getByRole('list', { name: 'Runs of Daily read' });
  await expect(runs).toContainText('Done');
  await expect(runs).toContainText('model call');
  await expect(page.getByTestId('task-offers').getByRole('group')).toHaveCount(0);
  // The turn is in the drawer like any other.
  await expect(page.getByRole('list', { name: 'Turns' })).toContainText('Look over the newest scene.');
});

test('a model task saved to start by itself is offered instead, and says so', async ({ page }) => {
  const counter = { calls: 0 };
  await fakeEndpoint(page, countingReply(counter));
  await useFakeEndpoint(page);
  await createProject(page, 'Consent Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task name').fill('Self-start read');
  await form.getByLabel('What to ask').fill('Look over the newest scene.');
  await form.getByLabel('When', { exact: true }).selectOption({ label: 'Each time the project opens' });
  await form.getByLabel('When it is due').selectOption({ label: 'Start it by itself' });
  await expect(form).toContainText('An instruction needs a plan before it can start by itself');
  // A model task that starts by itself needs its limit on model calls.
  await form.getByRole('button', { name: 'Save task' }).click();
  await expect(form.getByRole('alert')).toContainText('limit on its model calls');
  await form.getByLabel('Most model calls in a run').fill('2');
  await form.getByRole('button', { name: 'Save task' }).click();
  // The task is a row of its own once it is saved. The note alone proves nothing: the form shows the same sentence before the save.
  const saved = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Self-start read' });
  await expect(saved).toContainText('An instruction needs a plan before it can start by itself');

  await reopen(page, 'Consent Book');
  await expect(page.getByTestId('task-offers').getByRole('group', { name: 'Task due: Self-start read' })).toBeVisible({ timeout: LOADED });
  expect(counter.calls).toBe(0);
});

test('tasks are the writer’s: they are kept in the project, switched off and deleted from the drawer', async ({ page }) => {
  await createProject(page, 'Keep Book');
  await chapterWithScene(page, 'Opening');
  await openAgent(page);
  await makeTask(page, { name: 'Weekly scan', does: 'Scan for continuity problems', when: 'Only when I run it', due: 'Offer it to me' });
  await reopen(page, 'Keep Book');
  await binderTitle(page, 'Opening').click();
  await openAgent(page);
  const row = page.getByTestId('recurring-tasks').locator('[data-task]', { hasText: 'Weekly scan' });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: /^Turn off/ }).click();
  await expect(row).toContainText('(off)');
  await row.getByRole('button', { name: /^Run now/ }).click();
  await expect(row.getByText('Runs on this machine (1)')).toBeVisible();

  await row.getByRole('button', { name: /^Delete/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('recurring-tasks').locator('[data-task]')).toHaveCount(0);
  await expect(page.getByTestId('recurring-tasks')).toContainText('No tasks yet.');
});

test('a save in flight holds the form and the rows inert until the write settles', async ({ page }) => {
  test.setTimeout(60_000);
  await createProject(page, 'Held Save');
  await openAgent(page);
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task name').fill('Held task');
  await form.getByLabel('What it does').selectOption({ label: 'Scan for continuity problems' });
  await form.getByRole('button', { name: 'Save task' }).click();
  const row = page.getByTestId('recurring-tasks').locator('[data-task]');
  await expect(row).toHaveCount(1);

  await page.evaluate(async () => {
    const path = '/src/app/recurring-tasks.ts';
    const mod = await import(path) as typeof RecurringModule;
    const original = mod.RecurringTasks.prototype.save;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mod.RecurringTasks.prototype.save = function (this: InstanceType<typeof mod.RecurringTasks>, ...args: Parameters<typeof original>) {
      Object.assign(window, { __releaseTaskSave: () => { release(); mod.RecurringTasks.prototype.save = original; } });
      return gate.then(() => original.apply(this, args));
    };
  });
  await row.locator('[data-action="edit"]').click();
  const editForm = page.getByRole('form', { name: 'Edit task' });
  await editForm.getByLabel('Task name').fill('Held task renamed');
  await editForm.getByRole('button', { name: 'Save task' }).click();
  await expect(editForm.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expect(editForm.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(editForm.getByLabel('Task name')).toBeDisabled();
  await expect(editForm).toHaveAttribute('aria-busy', 'true');
  await expect(row.locator('[data-action="edit"]')).toBeDisabled();
  await page.evaluate(() => (window as unknown as { __releaseTaskSave: () => void }).__releaseTaskSave());
  await expect(page.getByRole('form', { name: 'Edit task' })).toHaveCount(0);
  await expect(row).toContainText('Held task renamed');
});

for (const language of ['en', 'de'] as const) {
  const words = language === 'en'
    ? { newTask: 'New task', taskName: 'Task name', does: 'What it does', when: 'When', onlyMine: 'Only when I run it', may: 'What it may do', nothing: 'Change nothing', plan: 'Run a plan', steps: 'Plan steps', save: 'Save task', open: 'Open', mayNot: 'May not change anything', edit: 'Edit', cancel: 'Cancel', runs: 'Runs on this machine (1)', runNow: 'Run now' }
    : { newTask: 'Neue Aufgabe', taskName: 'Aufgabenname', does: 'Was es tut', when: 'Wann', onlyMine: 'Nur wenn ich es ausführe', may: 'Was es darf', nothing: 'Nichts ändern', plan: 'Einen Plan ausführen', steps: 'Schritte des Plans', save: 'Aufgabe speichern', open: 'Öffnen', mayNot: 'Darf nichts ändern', edit: 'Bearbeiten', cancel: 'Abbrechen', runs: 'Durchläufe auf diesem Rechner (1)', runNow: 'Jetzt ausführen' };
  test(`a plan is written, refused when it does not parse, edited and run from the keyboard (${language})`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const counter = { calls: 0 };
    await fakeEndpoint(page, countingReply(counter));
    await useFakeEndpoint(page);
    await createProject(page, 'Plan Book');
    await chapterWithScene(page, 'Opening');
    if (language === 'de') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByTestId('settings');
      await settings.locator('[data-section="appearance"]').click();
      await chooseInterfaceLanguage(page, settings, 'de');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await settings.locator('.settings-head button').click();
    }
    const toggle = page.locator('.agent-toggle');
    const openDrawer = async (): Promise<void> => {
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await expect(page.getByTestId('recurring-tasks')).toBeVisible();
    };
    await openDrawer();

    const tasks = page.getByTestId('recurring-tasks');
    await tasks.getByRole('button', { name: words.newTask, exact: true }).click();
    const form = tasks.getByRole('form');
    await form.getByLabel(words.taskName).fill('Weekly plan scan');
    await form.getByLabel(words.does).selectOption({ label: words.plan });
    await form.getByLabel(words.when, { exact: true }).selectOption({ label: words.onlyMine });
    await form.getByLabel(words.may).selectOption({ label: words.nothing });
    const steps = form.getByLabel(words.steps);
    await expect(steps).toBeVisible();
    // Choosing Run a plan starts from steps that parse, so the writer edits a plan rather than inventing one.
    await expect(steps).toHaveValue(/coherence\.scan/);
    await page.setViewportSize({ width: 390, height: 844 });
    const fit = await steps.evaluate((area) => {
      const box = area.getBoundingClientRect();
      const formBox = area.closest('form')?.getBoundingClientRect();
      return { wide: box.width <= (formBox?.width ?? 0) + 1, page: document.documentElement.scrollWidth <= innerWidth + 1 };
    });
    expect(fit).toEqual({ wide: true, page: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`plan-form-${language}.png`) });

    const save = form.getByRole('button', { name: words.save });
    await steps.focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('[{"tool":');
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(form.getByRole('alert')).toContainText('The steps are not valid JSON');
    await expect(steps).toHaveValue('[{"tool":');
    await expect(steps).toBeFocused();
    await expect(steps).toHaveAttribute('aria-invalid', 'true');

    const written = [{ tool: 'coherence.scan', params: { scope: { mode: 'full' } }, expect: 'A scan is recorded' }];
    await steps.focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(JSON.stringify(written));
    await save.focus();
    await page.keyboard.press('Enter');
    const row = tasks.locator('[data-task]', { hasText: 'Weekly plan scan' });
    await expect(row).toContainText('Run a plan of 1 step');
    await expect(row).toContainText(words.mayNot);
    await expect(row.getByRole('button', { name: new RegExp(`^${words.edit}`) })).toBeFocused();

    await row.getByRole('button', { name: new RegExp(`^${words.edit}`) }).click();
    await expect(steps).toHaveValue(JSON.stringify(written, null, 2));
    const changed = [{ ...written[0], expect: 'A scan is recorded and its findings are listed' }];
    await steps.focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(JSON.stringify(changed, null, 2));
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(form).toHaveCount(0);

    await reopen(page, 'Plan Book', words.open);
    await binderTitle(page, 'Opening').click();
    await openDrawer();
    const kept = tasks.locator('[data-task]', { hasText: 'Weekly plan scan' });
    await expect(kept).toContainText('Run a plan of 1 step');
    await kept.getByRole('button', { name: new RegExp(`^${words.edit}`) }).click();
    await expect(form.getByLabel(words.steps)).toHaveValue(JSON.stringify(changed, null, 2));
    await form.getByRole('button', { name: words.cancel }).click();
    await expect(kept.getByRole('button', { name: new RegExp(`^${words.edit}`) })).toBeFocused();

    await kept.getByRole('button', { name: new RegExp(`^${words.runNow}`) }).click();
    await expect(kept.getByText(words.runs)).toBeVisible({ timeout: LOADED });
    expect(counter.calls).toBe(0);
  });
}

for (const [shell, language] of [['classic', 'en'], ['modern', 'de']] as const) {
  test(`an exact plan allowance stages due drafts in the Inbox without applying them (${shell}, ${language})`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    let calls = 0;
    await fakeEndpoint(page, () => { calls += 1; return { text: 'The ferry arrives after a long wait.' }; });
    await useFakeEndpoint(page);
    await createProject(page, 'Allowed Plan Book');
    await chapterWithScene(page, 'Opening');
    await openAgent(page);
    await page.getByRole('button', { name: 'New task' }).click();
    const form = page.getByRole('form', { name: 'New task' });
    await form.getByLabel('Task name').fill('Opening synopsis');
    await form.getByLabel('What it does').selectOption('plan');
    await form.getByLabel('Plan steps').fill(JSON.stringify([{ tool: 'synopsis.fill', params: { docs: ['Opening'], source: 'text', max_words: 20 }, expect: 'A synopsis is ready' }]));
    await form.getByLabel('When', { exact: true }).selectOption('on-open');
    await form.getByLabel('When it is due').selectOption('run');
    await form.getByLabel('Most model calls in a run').fill('2');
    await form.getByRole('button', { name: 'Save task' }).click();
    await expect(form).toHaveCount(0);
    expect(calls).toBe(0);
    if (language === 'de') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByTestId('settings');
      await settings.locator('[data-section="appearance"]').click();
      await chooseInterfaceLanguage(page, settings, 'de');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await settings.locator('.settings-head button').click();
    }
    await page.evaluate((value) => localStorage.setItem('caotang.interface', value), shell);
    await reopen(page, 'Allowed Plan Book', language === 'de' ? 'Öffnen' : 'Open', shell);
    expect(calls).toBe(0);
    const tasks = page.getByTestId('recurring-tasks');
    const reveal = async (): Promise<void> => {
      if (shell === 'classic') {
        const toggle = page.locator('.agent-toggle');
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      } else if (!(await tasks.isVisible())) await page.getByRole('button', { name: 'Fragen', exact: true }).click();
      await expect(tasks).toBeVisible();
    };
    await reveal();
    const row = tasks.locator('[data-task]', { hasText: 'Opening synopsis' });
    const allow = row.getByRole('button', { name: language === 'de' ? /^Automatische Starts erlauben/ : /^Allow automatic starts/ });
    await allow.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: language === 'de' ? 'Diese Aufgabe automatisch starten lassen?' : 'Allow this task to start by itself?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: language === 'de' ? 'Abbrechen' : 'Cancel', exact: true })).toBeFocused();
    await expect(dialog).toContainText('synopsis.fill');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(allow).toBeFocused();
    expect(calls).toBe(0);
    await allow.click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: language === 'de' ? 'Abbrechen' : 'Cancel', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: language === 'de' ? 'Automatische Starts erlauben' : 'Allow automatic starts', exact: true })).toBeInViewport({ ratio: 1 });
    const bounds = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(bounds).not.toBeNull();
    expect(Math.abs((bounds!.x + bounds!.width / 2) - viewport!.width / 2)).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath(`allowance-${shell}-${language}.png`) });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: language === 'de' ? 'Abbrechen' : 'Cancel', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole('button', { name: language === 'de' ? 'Automatische Starts erlauben' : 'Allow automatic starts', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`allowance-${shell}-${language}-narrow.png`) });
    await page.setViewportSize({ width: 1280, height: 720 });
    await dialog.getByRole('button', { name: language === 'de' ? 'Automatische Starts erlauben' : 'Allow automatic starts', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row.getByRole('button', { name: language === 'de' ? /^Automatische Starts widerrufen/ : /^Revoke automatic starts/ })).toBeFocused();
    expect(calls).toBe(0);
    await reopen(page, 'Allowed Plan Book', language === 'de' ? 'Öffnen' : 'Open', shell);
    await reveal();
    const inbox = page.getByTestId('review-inbox');
    await expect(inbox.locator('[data-task][data-status="ready"]')).toBeVisible({ timeout: LOADED });
    expect(calls).toBe(1);
    expect(await projectTrace(page)).not.toContain('binder.setSynopsis');
    await expect(page.getByRole('combobox', { name: language === 'de' ? 'Absicht' : 'Intent' })).toBeEnabled();
    await inbox.locator('[data-task][data-status="ready"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`inbox-${shell}-${language}.png`) });
    const interrupted = await page.evaluate(() => new Promise<number>((resolve, reject) => {
      const request = indexedDB.open('caotang-app');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const rows = store.getAll();
        let changed = 0;
        rows.onsuccess = () => {
          for (const row of rows.result as { key: string; value?: TaskRecord }[]) {
            if (row.value?.recurringTaskId === undefined || row.value.status !== 'ready') continue;
            store.put({ ...row, value: { ...row.value, status: 'interrupted', items: row.value.items.map((item) => ({ ...item, state: 'pending' })) } });
            changed += 1;
          }
        };
        tx.oncomplete = () => { db.close(); resolve(changed); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }));
    expect(interrupted).toBe(1);
    await reopen(page, 'Allowed Plan Book', language === 'de' ? 'Öffnen' : 'Open', shell);
    await reveal();
    const backgroundTasks = page.getByTestId('background-tasks');
    const recovered = backgroundTasks.locator('[data-task][data-status="interrupted"]');
    await expect(recovered).toBeVisible();
    await expect(recovered.getByRole('button', { name: language === 'de' ? /^Fortsetzen/ : /^Resume/ })).toBeVisible();
    await expect(recovered.getByRole('button', { name: language === 'de' ? /^Abbrechen/ : /^Cancel/ })).toBeVisible();
    const revoke = tasks.locator('[data-task]', { hasText: 'Opening synopsis' }).getByRole('button', { name: language === 'de' ? /^Automatische Starts widerrufen/ : /^Revoke automatic starts/ });
    await revoke.click();
    await expect(backgroundTasks.locator('[data-task][data-status="cancelled"]')).toBeVisible();
    await expect(backgroundTasks.locator('[data-task][data-status="interrupted"]')).toHaveCount(0);
    await expect(tasks.getByRole('button', { name: language === 'de' ? /^Automatische Starts erlauben/ : /^Allow automatic starts/ })).toBeVisible();
    await reopen(page, 'Allowed Plan Book', language === 'de' ? 'Öffnen' : 'Open', shell);
    await reveal();
    await expect(page.getByTestId('task-offers').locator('[data-task]', { hasText: 'Opening synopsis' })).toBeVisible({ timeout: LOADED });
    expect(calls).toBe(1);
  });
}

test('with no task due, the offers section takes no room, so the closed drawer is no taller for it', async ({ page }) => {
  await createProject(page, 'Quiet Book');
  // The section stays in the page for its announcement region, so it must not add a margin of its own: the board above the drawer
  // shares the column with it, and a few pixels there move a card under the storage notice.
  const offers = page.getByTestId('task-offers');
  await expect(offers).toBeAttached();
  const box = await offers.evaluate((section) => {
    const style = getComputedStyle(section);
    return { height: section.getBoundingClientRect().height, above: style.marginTop, below: style.marginBottom };
  });
  expect(box).toEqual({ height: 0, above: '0px', below: '0px' });
});
