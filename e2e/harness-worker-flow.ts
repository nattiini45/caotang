import { expect, type BrowserContext, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';
import type { HarnessWorkerRequest } from '../apps/desktop/src/workers/harness-protocol.js';

export async function scanProject(page: Page, shell: 'classic' | 'modern', theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: theme });
  await page.addInitScript((chosen) => {
    localStorage.setItem('caotang.interface', chosen.shell);
    localStorage.setItem('caotang.theme', chosen.theme);
    const proto = Object.getPrototypeOf(navigator.storage) as Record<string, unknown>;
    proto['persisted'] = async () => true;
    proto['persist'] = async () => true;
  }, { shell, theme });
  await createProject(page, `Worker lifecycle ${shell}`);
  if (shell === 'modern') await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
  await firstChapter(page);
  const createDocument = async (name: string, text: string): Promise<void> => {
    await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
    await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(name);
    await page.keyboard.press('Enter');
    await page.getByRole('textbox', { name: 'Document text' }).fill(text);
    await waitForSaved(page);
  };
  await createDocument('The lamp', 'The fictional ferry arrived after dawn.');
  await binderTitle(page, 'Research').click();
  await createDocument('Research note', 'IRRELEVANT-RESEARCH-BODY-MUST-STAY-HERE');
  await binderTitle(page, 'The lamp').click();
  if (shell === 'modern') await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Findings', exact: true }).click();
  else await page.getByRole('tab', { name: 'Findings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Scope of the scan and the review' }).selectOption('full');
}

export async function holdHarnessWorker(page: Page, context: BrowserContext) {
  let release = (): void => {};
  let entered = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let starts = 0;
  await context.route(/\/harness-worker(?:\.ts|-[A-Za-z0-9_-]{8}\.js)(?:[?#]|$)/, async (route) => {
    starts++;
    entered();
    await held;
    await route.continue();
  });
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    const observed = globalThis as unknown as { cpuTransfers: { op: string; input: string; bodyIds: string[] }[] };
    observed.cpuTransfers = [];
    Worker.prototype.postMessage = function (message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const request = message as HarnessWorkerRequest;
      if (request?.op === 'scan' || request?.op === 'assemble') {
        const state = request.op === 'scan' ? request.input.state : request.input.app.state;
        observed.cpuTransfers.push({
          op: request.op,
          input: JSON.stringify(request.input, (_, value: unknown) => value instanceof Map ? [...value] : value instanceof Set ? [...value] : value),
          bodyIds: [...state.documents.keys()],
        });
      }
      return original.call(this, message, Array.isArray(options) ? { transfer: options } : options);
    };
  });
  return { started, release, starts: () => starts };
}

export async function scanStartupCancellation(page: Page, context: BrowserContext, shell: 'classic' | 'modern', cancelWithAgent?: (page: Page) => Promise<void>, pendingScreenshot?: string): Promise<void> {
  const gate = await holdHarnessWorker(page, context);
  try {
    await scanProject(page, shell);
    expect(gate.starts()).toBe(0);
    const scan = page.getByRole('button', { name: 'Scan the manuscript', exact: true });
    await scan.click();
    await gate.started;
    await expect(page.getByTestId('scan-running')).toBeVisible();
    await expect(scan).toBeDisabled();
    await expect(scan).toHaveAttribute('aria-busy', 'true');
    if (pendingScreenshot !== undefined) await page.screenshot({ path: pendingScreenshot });
    const editor = page.getByRole('textbox', { name: 'Document text' });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' The writer keeps typing.');
    await expect(editor).toContainText('The writer keeps typing.');
    const sent = await page.evaluate(() => (globalThis as unknown as { cpuTransfers: { op: string; input: string; bodyIds: string[] }[] }).cpuTransfers);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.op).toBe('scan');
    expect(sent[0]?.bodyIds).toHaveLength(1);
    expect(sent[0]?.input).not.toContain('IRRELEVANT-RESEARCH-BODY-MUST-STAY-HERE');
    expect(sent[0]?.input).not.toContain('"findings":');
    expect(sent[0]?.input).not.toContain('"runs":');
    if (cancelWithAgent !== undefined) await cancelWithAgent(page);
    else {
      await page.getByRole('button', { name: 'Cancel scan', exact: true }).focus();
      await page.keyboard.press('Enter');
    }
    await expect(page.getByTestId('scan-running')).toHaveCount(0);
    await expect(page.getByTestId('scan-note')).toContainText('cancelled');
    await expect(page.getByRole('region', { name: 'Run history' }).locator('[data-run]')).toHaveCount(0);
    await expect(editor).toContainText('The writer keeps typing.');
    if (cancelWithAgent !== undefined) await expect(editor).toBeFocused();
    else await expect(scan).toBeFocused();
  } finally { gate.release(); }
}
