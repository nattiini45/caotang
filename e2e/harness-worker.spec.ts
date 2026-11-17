import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { test } from './test.js';
import type * as UiAgentModule from '../apps/desktop/test/ui-agent-fixture.js';

import { holdHarnessWorker, scanProject, scanStartupCancellation } from './harness-worker-flow.js';
import { waitForSaved } from './support.js';
type UiAgent = typeof UiAgentModule;

const uiAgentUrl = `/@fs/${fileURLToPath(new URL('../apps/desktop/test/ui-agent-fixture.ts', import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: scan startup stays cancellable and leaves typing and findings intact`, { tag: shell === 'modern' ? '@modern' : [] }, async ({ page, context }, testInfo) => {
    const agentCancel = shell === 'modern' ? async (target: typeof page): Promise<void> => {
      const entries = await target.evaluate(async (url) => (await import(/* @vite-ignore */ url) as UiAgent).agent.snapshot(), uiAgentUrl);
      const cancel = entries.find((entry) => entry.label === 'Cancel scan');
      expect(cancel).toBeDefined();
      const result = await target.evaluate(async ({ url, ref }) => (await import(/* @vite-ignore */ url) as UiAgent).agent.act({ steps: [{ ref, action: 'press' }] }), { url: uiAgentUrl, ref: cancel!.ref });
      expect(result.ok, JSON.stringify(result)).toBe(true);
    } : undefined;
    await scanStartupCancellation(page, context, shell, agentCancel, testInfo.outputPath(`${shell}-pending-scan.png`));
    await page.screenshot({ path: testInfo.outputPath(`${shell}-cancelled-scan.png`) });
  });

  test(`${shell}: an edited scan snapshot is refused and a fresh retry records one real worker run`, { tag: shell === 'modern' ? '@modern' : [] }, async ({ page, context }, testInfo) => {
    const gate = await holdHarnessWorker(page, context);
    try {
      await scanProject(page, shell);
      const scan = page.getByRole('button', { name: 'Scan the manuscript', exact: true });
      await scan.click();
      await gate.started;
      const editor = page.getByRole('textbox', { name: 'Document text' });
      await editor.fill('The writer changed this scene during preparation.');
      await waitForSaved(page);
      gate.release();
      await expect(page.getByTestId('scan-note')).toContainText('project changed');
      await expect(page.getByRole('region', { name: 'Run history' }).locator('[data-run]')).toHaveCount(0);
      await expect(editor).toBeFocused();
      await expect(editor).toContainText('The writer changed this scene during preparation.');
      await scan.click();
      await expect(page.getByRole('region', { name: 'Run history' }).locator('[data-run]')).toHaveCount(1);
      await expect(page.getByTestId('scan-running')).toHaveCount(0);
      expect(gate.starts()).toBe(1);
      await page.screenshot({ path: testInfo.outputPath(`${shell}-completed-scan.png`) });
    } finally { gate.release(); }
  });
}

test.describe('narrow dark touch controls', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the pending scan and touch Cancel stay within the Findings drawer', async ({ page, context }, testInfo) => {
    const gate = await holdHarnessWorker(page, context);
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await scanProject(page, 'modern', 'dark');
      await page.setViewportSize({ width: 390, height: 844 });
      const binder = page.getByRole('navigation', { name: 'Views and tools' }).getByRole('button', { name: 'Binder', exact: true });
      if (await binder.getAttribute('aria-expanded') !== 'true') await binder.tap();
      await page.getByRole('button', { name: 'Scan the manuscript', exact: true }).tap();
      await gate.started;
      const cancel = page.getByRole('button', { name: 'Cancel scan', exact: true });
      await expect(cancel).toBeVisible();
      const bounds = await cancel.boundingBox();
      expect(Math.round(bounds?.height ?? 0)).toBeGreaterThanOrEqual(44);
      expect(Math.round(bounds?.width ?? 0)).toBeGreaterThanOrEqual(44);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath('narrow-dark-pending-scan.png') });
      await cancel.tap();
      await expect(page.getByTestId('scan-note')).toContainText('cancelled');
      await expect(page.getByTestId('scan-running')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Run history' }).locator('[data-run]')).toHaveCount(0);
    } finally { gate.release(); }
  });
});

test('cancelling while reply validation loads settles immediately and never publishes the late result', async ({ page, context }) => {
  let release = (): void => {};
  let entered = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  await context.route(/\/harness-worker-validation\.ts(?:[?#]|$)/, async (route) => {
    entered();
    await held;
    await route.continue();
  });
  try {
    await scanProject(page, 'classic');
    const scan = page.getByRole('button', { name: 'Scan the manuscript', exact: true });
    await scan.click();
    await started;
    await page.getByRole('button', { name: 'Cancel scan', exact: true }).click();
    await expect(page.getByTestId('scan-running')).toHaveCount(0);
    await expect(scan).toBeEnabled();
    await expect(page.getByTestId('scan-note')).toContainText('cancelled');
    await expect(page.getByRole('region', { name: 'Run history' }).locator('[data-run]')).toHaveCount(0);
    release();
    await scan.click();
    await expect(page.getByRole('region', { name: 'Run history' }).locator('[data-run]')).toHaveCount(1);
    await expect(page.getByTestId('scan-running')).toHaveCount(0);
  } finally { release(); }
});
