import { expect, test, type Page } from '@playwright/test';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint } from './endpoint.js';
import { holdHarnessWorker, scanProject } from './harness-worker-flow.js';
import { binderTitle, projectTrace } from './support.js';

async function sendPlan(page: Page): Promise<void> {
  await page.getByRole('combobox', { name: 'Intent' }).fill('Draft five fictional openings.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('plan-offer')).toBeVisible();
}

for (const outcome of ['complete', 'cancel', 'read-change', 'worker-unavailable'] as const) {
  test(`background context preparation: ${outcome}`, async ({ page, context }, testInfo) => {
    let drafts = 0;
    const steps = Array.from({ length: 5 }, () => ({ tool: 'scene.draft', params: { doc: 'The lamp', instruction: 'Draft a short opening.', mode: 'continue' }, expect: 'A draft' }));
    const reply = planThenAnswer({ steps });
    await fakeEndpoint(page, (request) => {
      if (request.system.startsWith('You are drafting prose')) drafts++;
      return reply(request);
    });
    const gate = await holdHarnessWorker(page, context);
    try {
      await useFakeEndpoint(page);
      await scanProject(page, 'classic');
      await page.getByRole('tab', { name: 'Binder', exact: true }).click();
      await binderTitle(page, 'Research').click({ button: 'right' });
      await page.getByRole('menu', { name: 'Actions for Research' }).getByRole('menuitemradio', { name: 'Agent: may not read' }).click();
      await binderTitle(page, 'The lamp').click();
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      if (outcome === 'worker-unavailable') {
        await page.evaluate(() => Object.defineProperty(window, 'Worker', { configurable: true, value: undefined }));
        await sendPlan(page);
        await page.getByTestId('plan-offer').getByRole('button', { name: 'Run now', exact: true }).click();
        await expect(page.getByTestId('plan-card')).toBeVisible();
        expect(drafts).toBe(5);
        expect(gate.starts()).toBe(0);
        await page.getByTestId('plan-card').getByRole('button', { name: /^Cancel/ }).click();
      }
      await sendPlan(page);
      await page.getByTestId('plan-offer').getByRole('button', { name: 'Run in background', exact: true }).click();
      const task = page.getByTestId('background-tasks').locator('[data-task]');
      if (outcome === 'worker-unavailable') {
        await expect(task).toHaveAttribute('data-state', 'failed');
        await expect(task.getByRole('list', { name: 'Why drafting failed' })).toContainText('Background preparation is unavailable');
        expect(drafts).toBe(5);
        expect(gate.starts()).toBe(0);
        expect(await projectTrace(page)).not.toContain('doc.replace');
        return;
      }
      await gate.started;
      await expect(task.getByTestId('task-status')).toHaveText('Preparing the next draft.');
      await expect(task).toContainText('0 of 5 model calls');
      expect(drafts).toBe(0);
      const sent = await page.evaluate(() => (globalThis as unknown as { cpuTransfers: { op: string; input: string }[] }).cpuTransfers);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.op).toBe('assemble');
      expect(sent[0]?.input).not.toContain('IRRELEVANT-RESEARCH-BODY-MUST-STAY-HERE');
      expect(sent[0]?.input).not.toContain('https://127.0.0.1:5999');
      const editor = page.getByRole('textbox', { name: 'Document text' });
      await editor.click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type(' The writer keeps typing.');
      await expect(editor).toContainText('The writer keeps typing.');
      await task.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('context-preparing.png') });
      if (outcome === 'cancel') {
        await task.getByRole('button', { name: /^Cancel/ }).focus();
        await page.keyboard.press('Enter');
        await expect(task).toHaveAttribute('data-state', 'cancelled');
        await expect(task.getByRole('button', { name: /^Resume/ })).toHaveCount(0);
        await expect(task.locator(':focus')).toHaveCount(1);
      } else if (outcome === 'read-change') {
        await binderTitle(page, 'Chapter 1').click({ button: 'right' });
        await page.getByRole('menu', { name: 'Actions for Chapter 1' }).getByRole('menuitemradio', { name: 'Agent: may not read' }).click();
      }
      gate.release();
      if (outcome === 'complete') {
        await expect(task).toHaveAttribute('data-state', 'ready');
        expect(drafts).toBe(5);
        await expect(editor).toBeFocused();
      } else {
        await expect(task).toHaveAttribute('data-state', outcome === 'cancel' ? 'cancelled' : 'failed');
        expect(drafts).toBe(0);
      }
      expect(await projectTrace(page)).not.toContain('doc.replace');
    } finally { gate.release(); }
  });
}
