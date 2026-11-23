import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './test.js';
import type * as UiAgentModule from '../apps/desktop/test/ui-agent-fixture.js';
import type * as TaskStoreModule from '../apps/desktop/src/app/task-store.js';
import type * as AgentModule from '../apps/desktop/src/app/agent.js';
import type { PlanStep } from '../packages/harness/src/index.js';

import { holdCancellingTask, releaseTaskStartup } from './task-cancellation.js';
import { openSaveSettings } from './save-channel-fixture.js';
import { idOf, projectTrace, chooseInterfaceLanguage} from './support.js';
import { openReviewInbox, queuedReviewProject, storedReviewTasks } from './queued-review.js';

type UiAgent = typeof UiAgentModule;
interface HeldQueueSave {
  started: boolean;
  release: () => void;
  restore: () => void;
}
const uiAgentUrl = `/@fs/${fileURLToPath(new URL('../apps/desktop/test/ui-agent-fixture.ts', import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;

test('the Inbox stays reachable after keyboard dismissal, and an agent cannot discard a task without a person', async ({ page }) => {
  const task = await holdCancellingTask(page);
  await expect(task.getByTestId('task-status')).toBeFocused();
  await releaseTaskStartup(page);
  await expect(task).toHaveAttribute('data-state', 'cancelled');
  const entries = await page.evaluate(async (url) => (await import(url) as UiAgent).agent.snapshot(), uiAgentUrl);
  const dismiss = entries.find((entry) => entry.label === 'Dismiss Draft five openings.');
  expect(dismiss).toBeDefined();
  const refused = await page.evaluate(async ({ url, ref }) => (await import(url) as UiAgent).agent.act({ steps: [{ ref, action: 'press' }] }), { url: uiAgentUrl, ref: dismiss!.ref });
  expect(refused.ok).toBe(false);
  expect(dismiss?.confirm).toContain('Published findings stay');
  await expect(task).toHaveCount(1);
  await expect(task.getByTestId('task-status')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(task.getByRole('button', { name: /^Dismiss/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(task).toHaveCount(0);
  const inbox = page.getByTestId('review-inbox');
  await expect(inbox.getByRole('heading', { name: 'Review Inbox', exact: true })).toBeFocused();
  await expect(inbox).toContainText('No drafts or review reports are waiting.');
  expect(await projectTrace(page)).not.toContain('doc.replace');
});

test('a costed queued review publishes a real report, opens its findings and returns without another model call', async ({ page }) => {
  test.setTimeout(90_000);
  const { requests, models } = await queuedReviewProject(page);
  const traceBefore = await projectTrace(page);
  await page.getByRole('tab', { name: 'Findings', exact: true }).click();
  const queue = page.getByRole('button', { name: 'Queue a review', exact: true });
  await queue.click();
  const preview = page.getByTestId('queued-review-plan');
  await expect(preview.getByRole('heading', { name: 'Approve a background review' })).toBeFocused();
  await expect(preview).toContainText('other-model');
  await expect(preview).toContainText('East ferry');
  await expect(preview).toContainText('West ferry');
  await expect(preview).toContainText('A price estimate is unavailable.');
  await preview.getByRole('button', { name: 'First prompt for this background review' }).click();
  await expect(preview.locator('pre')).toContainText('The ferry left at noon.');
  expect(requests).toHaveLength(0);
  const entries = await page.evaluate(async (url) => (await import(url) as UiAgent).agent.snapshot(), uiAgentUrl);
  const approval = entries.find((entry) => entry.label === 'Queue this review');
  expect(approval).toBeDefined();
  const refused = await page.evaluate(async ({ url, ref }) => (await import(url) as UiAgent).agent.act({ steps: [{ ref, action: 'press' }] }), { url: uiAgentUrl, ref: approval!.ref });
  expect(refused.ok).toBe(false);
  expect(requests).toHaveLength(0);
  await expect(preview).toBeVisible();
  await preview.getByRole('button', { name: 'Cancel this preview' }).focus();
  await page.keyboard.press('Enter');
  await expect(preview).toHaveCount(0);
  await expect(queue).toBeFocused();
  expect(requests).toHaveLength(0);
  await queue.click();
  await preview.getByRole('button', { name: 'Queue this review' }).focus();
  await page.keyboard.press('Enter');
  await expect(preview).toHaveCount(0);
  const editor = page.getByRole('textbox', { name: 'Document text' });
  await editor.focus();
  await expect.poll(() => requests.length).toBe(3);
  await expect.poll(async () => (await storedReviewTasks(page))[0]?.status).toBe('completed');
  await expect(editor).toBeFocused();
  await openReviewInbox(page);
  const inbox = page.getByTestId('review-inbox');
  const task = inbox.locator('[data-task]');
  await expect(task).toHaveAttribute('data-status', 'completed');
  await expect(task).toContainText('Unread review report');
  await expect(task.getByTestId('task-status')).toContainText('Review complete: 1 finding published');
  await expect(task).toContainText('other-model');
  await expect(task.getByRole('button', { name: /^Review / })).toHaveCount(0);
  expect(models).toEqual(['other-model', 'other-model', 'other-model']);
  const stored = (await storedReviewTasks(page))[0];
  expect(stored?.report?.usage).toMatchObject({ modelCalls: 3, promptTokens: 120, source: 'reported' });
  expect(stored?.review?.route.model).toBe('other-model');
  const before = requests.length;
  const open = task.getByRole('button', { name: /^See findings/ });
  const history = page.getByTestId('run-history');
  await page.evaluate(async () => {
    const path = '/src/app/task-store.ts';
    const { TaskStore } = await import(path) as typeof TaskStoreModule;
    const save = TaskStore.prototype.save;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handle: HeldQueueSave = { started: false, release, restore: () => { TaskStore.prototype.save = save; } };
    (window as unknown as { heldAcknowledgment: HeldQueueSave }).heldAcknowledgment = handle;
    TaskStore.prototype.save = async function (task) {
      if (task.acknowledged === true && !handle.started) {
        handle.started = true;
        await held;
      }
      await save.call(this, task);
    };
  });
  try {
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(history.locator('[data-run]')).toHaveCount(1);
    await expect(history.locator('[data-run]')).toBeFocused();
    await expect(page.locator('article.finding')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldAcknowledgment: HeldQueueSave }).heldAcknowledgment.started)).toBe(true);
    await editor.focus();
    await page.evaluate(() => (window as unknown as { heldAcknowledgment: HeldQueueSave }).heldAcknowledgment.release());
    await expect.poll(async () => (await storedReviewTasks(page))[0]?.acknowledged).toBe(true);
    await expect(editor).toBeFocused();
    await history.getByRole('button', { name: 'Back to Review Inbox' }).focus();
    await page.keyboard.press('Enter');
    await expect(open).toBeFocused();
    await expect(task).toContainText('Review report opened');
  } finally {
    await page.evaluate(() => {
      const held = (window as unknown as { heldAcknowledgment: HeldQueueSave }).heldAcknowledgment;
      held.release();
      held.restore();
    });
  }
  await page.reload();
  const projectRow = page.getByRole('listitem').filter({ hasText: 'Ferry Notebook' });
  await expect(projectRow).toBeVisible({ timeout: 20_000 });
  await projectRow.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await openReviewInbox(page);
  await expect(task).toHaveAttribute('data-status', 'completed');
  await expect(task).toContainText('Review report opened');
  expect(requests).toHaveLength(before);
  await task.getByRole('button', { name: /^Dismiss / }).click();
  await expect(task).toHaveCount(0);
  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(page.locator('article.finding')).toHaveCount(1);
  await expect(history.locator('[data-run]')).toHaveCount(1);
  expect(requests).toHaveLength(before);
  expect((await projectTrace(page)).slice(traceBefore.length).filter((command) => !command.startsWith('view.'))).toEqual([]);
});

test('a mixed review publishes its report but leaves a native write on the ordinary foreground approval card', async ({ page }) => {
  const plan = { steps: [
    { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'Review the ferry times' },
    { tool: 'notes.replace', params: { doc: 'East ferry', notes: 'Check the ferry timetable.' }, expect: 'Keep a timetable note' },
  ] };
  const { requests } = await queuedReviewProject(page, plan);
  await openReviewInbox(page);
  await page.getByRole('combobox', { name: 'Intent' }).fill('Review the ferry times, then keep a note.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const offer = page.getByTestId('plan-offer');
  await expect(offer.getByTestId('queued-review-details')).toBeVisible();
  await expect(offer).toContainText('other-model');
  await offer.getByRole('button', { name: 'Run in background' }).click();
  const task = page.getByTestId('review-inbox').locator('[data-task]');
  await expect(task).toHaveAttribute('data-status', 'ready');
  await expect(task).toContainText('Its other steps are ready for review.');
  await expect(task).toContainText('The other steps still wait for your approval.');
  await expect(page.getByTestId('review-inbox').getByRole('heading', { name: 'Other steps ready for review (1)', exact: true })).toBeVisible();
  await expect(task).not.toContainText('drafted');
  expect(await projectTrace(page)).not.toContain('notes.set');
  const before = requests.length;
  await task.getByRole('button', { name: /^Review / }).click();
  const card = page.getByTestId('plan-card');
  await expect(card).toContainText('notes.replace');
  await expect(card).not.toContainText('coherence.review');
  expect(await projectTrace(page)).not.toContain('notes.set');
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(task).toHaveAttribute('data-status', 'applied');
  expect((await projectTrace(page)).filter((command) => command === 'notes.set')).toHaveLength(1);
  expect(requests).toHaveLength(before);
});

test('cancelling a review while its first durable save is held never admits a model request', async ({ page }) => {
  const { requests } = await queuedReviewProject(page);
  await page.getByRole('tab', { name: 'Findings', exact: true }).click();
  await page.getByRole('button', { name: 'Queue a review', exact: true }).click();
  await page.evaluate(async () => {
    const path = '/src/app/task-store.ts';
    const { TaskStore } = await import(path) as typeof TaskStoreModule;
    const save = TaskStore.prototype.save;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const handle: HeldQueueSave = { started: false, release, restore: () => { TaskStore.prototype.save = save; } };
    (window as unknown as { heldReviewSave: HeldQueueSave }).heldReviewSave = handle;
    TaskStore.prototype.save = async function (task) {
      if (!handle.started && task.kind === 'review' && task.status === 'queued') {
        handle.started = true;
        await held;
      }
      await save.call(this, task);
    };
  });
  try {
    const preview = page.getByTestId('queued-review-plan');
    await preview.getByRole('button', { name: 'Queue this review', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldReviewSave: HeldQueueSave }).heldReviewSave.started)).toBe(true);
    expect(requests).toHaveLength(0);
    await preview.getByRole('button', { name: 'Cancel queue request' }).click();
    await expect(preview).toContainText('Cancelling the queue request. Waiting for its save to settle.');
    await expect(preview.getByRole('button', { name: 'Cancel queue request' })).toBeDisabled();
    expect(requests).toHaveLength(0);
    await page.evaluate(() => (window as unknown as { heldReviewSave: HeldQueueSave }).heldReviewSave.release());
    await expect(preview).toHaveCount(0);
    await openReviewInbox(page);
    await expect(page.locator('[data-task]')).toHaveCount(0);
    const storedAfterCancel = await storedReviewTasks(page);
    expect(storedAfterCancel).toHaveLength(1);
    expect(storedAfterCancel[0]).toMatchObject({ status: 'cancelled', runs: 0, used: 0 });
    expect(requests).toHaveLength(0);
    expect(await projectTrace(page)).not.toContain('doc.replace');
  } finally {
    await page.evaluate(() => {
      const held = (window as unknown as { heldReviewSave: HeldQueueSave }).heldReviewSave;
      held.release();
      held.restore();
    });
  }
});

test('a preview prepared after leaving Findings is discarded without a provider request', async ({ page }) => {
  const { requests } = await queuedReviewProject(page);
  await page.evaluate(async () => {
    const path = '/src/app/agent.ts';
    const { AgentController } = await import(path) as typeof AgentModule;
    const prepare = AgentController.prototype.prepareQueuedReview;
    const discard = AgentController.prototype.discardQueuedReview;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const state = { prepared: false, discarded: 0, release, restore: () => {
      AgentController.prototype.prepareQueuedReview = prepare;
      AgentController.prototype.discardQueuedReview = discard;
    } };
    (window as unknown as { heldPreview: typeof state }).heldPreview = state;
    AgentController.prototype.prepareQueuedReview = async function (choice) {
      const result = await prepare.call(this, choice);
      state.prepared = true;
      await held;
      return result;
    };
    AgentController.prototype.discardQueuedReview = function (preview) {
      state.discarded += 1;
      discard.call(this, preview);
    };
  });
  try {
    await page.getByRole('tab', { name: 'Findings', exact: true }).click();
    await page.getByRole('button', { name: 'Queue a review', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldPreview: { prepared: boolean } }).heldPreview.prepared)).toBe(true);
    await page.getByRole('tab', { name: 'Binder', exact: true }).click();
    await page.evaluate(() => (window as unknown as { heldPreview: { release: () => void } }).heldPreview.release());
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldPreview: { discarded: number } }).heldPreview.discarded)).toBe(1);
    await expect(page.getByTestId('queued-review-plan')).toHaveCount(0);
    expect(await storedReviewTasks(page)).toHaveLength(0);
    expect(requests).toHaveLength(0);
  } finally {
    await page.evaluate(() => {
      const held = (window as unknown as { heldPreview: { release: () => void; restore: () => void } }).heldPreview;
      held.release();
      held.restore();
    });
  }
});

test('separate review steps have scope-named prompt controls before either review starts', async ({ page }) => {
  const plan: { steps: PlanStep[] } = { steps: [] };
  const { requests } = await queuedReviewProject(page, plan);
  for (const title of ['East ferry', 'West ferry']) {
    plan.steps.push({ tool: 'coherence.review', params: { scope: { mode: 'doc', docIds: [await idOf(page, title)] } }, expect: `Review ${title}` });
  }
  await openReviewInbox(page);
  await page.getByRole('combobox', { name: 'Intent' }).fill('Plan two separate ferry reviews.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const offer = page.getByTestId('plan-offer');
  await expect(offer.getByTestId('queued-review-details')).toHaveCount(2);
  await expect(offer.getByRole('button', { name: 'Run in background', exact: true })).toHaveCount(0);
  await expect(offer).toContainText('Queue one coherence review at a time.');
  const first = offer.getByRole('button', { name: /First prompt for background review step 1:.*East ferry/ });
  const second = offer.getByRole('button', { name: /First prompt for background review step 2:.*West ferry/ });
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(offer.getByTestId('queued-review-details').nth(0).locator('pre')).toContainText('The ferry left at noon.');
  await second.focus();
  await page.keyboard.press('Enter');
  await expect(offer.getByTestId('queued-review-details').nth(1).locator('pre')).toContainText('The ferry left at midnight.');
  expect(requests).toHaveLength(0);
  await offer.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await storedReviewTasks(page)).toHaveLength(0);
});

test.describe('the localized touch Inbox', () => {
  test.use({ hasTouch: true, viewport: { width: 1280, height: 900 } });

  test('Modern keeps a German review and its return action usable in a narrow dark window', { tag: '@modern' }, async ({ page }) => {
    // The same queue-and-report flow as the costed review above, plus the settings, language switch and the 390 px layout; it measured
    // 26 s on Firefox locally, so the default 30 s deadline is what failed on a loaded runner, not the flow (§8.3's narrow walk).
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      localStorage.setItem('caotang.interface', 'modern');
      localStorage.setItem('caotang.theme', 'dark');
    });
    const { requests } = await queuedReviewProject(page);
    await openSaveSettings(page);
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="appearance"]').click();
    await settings.locator('input[name="shell"]').nth(1).check();
    await expect(settings.getByTestId('interface-choice')).toHaveAttribute('data-state', 'ready');
    await settings.locator('input[name="theme"]').nth(1).check();
    await chooseInterfaceLanguage(page, settings, 'de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('modern-narrow-binder').tap();
    await page.getByTestId('modern-drawer').getByRole('tab', { name: /^Feststellungen/ }).tap();
    await page.getByRole('button', { name: 'Prüfung einreihen', exact: true }).tap();
    const preview = page.getByTestId('queued-review-plan');
    await expect(preview).toContainText('other-model');
    await preview.getByRole('button', { name: 'Erster Prompt für diese Hintergrundprüfung' }).tap();
    await expect(preview.locator('pre')).toContainText('The ferry left at noon.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const approve = preview.getByRole('button', { name: 'Diese Prüfung einreihen', exact: true });
    await approve.scrollIntoViewIfNeeded();
    expect((await approve.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await approve.tap();
    await expect(preview).toHaveCount(0);
    await page.keyboard.press('Escape');
    await openReviewInbox(page, 'Fragen');
    const inbox = page.getByTestId('review-inbox');
    await expect(inbox.getByRole('heading', { name: 'Posteingang', exact: true })).toBeVisible();
    const task = inbox.locator('[data-task]');
    await expect(task).toHaveAttribute('data-status', 'completed');
    await expect(task).toContainText('Ungelesener Prüfbericht');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const open = task.getByRole('button', { name: /^Feststellungen anzeigen/ });
    await open.tap();
    const history = page.getByTestId('run-history');
    await expect(history.locator('[data-run]')).toBeVisible();
    await expect(page.locator('article.finding')).toHaveCount(1);
    await history.getByRole('button', { name: 'Zurück zum Posteingang' }).tap();
    await expect(open).toBeFocused();
    await expect(task).toContainText('Prüfbericht geöffnet');
    expect(requests).toHaveLength(3);
  });
});
