import { expect, type Page } from '@playwright/test';
import type * as SessionModule from '../apps/desktop/src/app/session.js';
import { waitForSaved } from './support.js';

export async function makeFailingDocument(page: Page): Promise<void> {
  if (await page.getByTestId('modern-stage').count()) {
    await page.getByRole('navigation', { name: 'Binder' }).getByRole('button', { name: 'Binder', exact: true }).click();
    await expect(page.getByTestId('modern-binder')).toHaveAttribute('data-state', 'open');
  }
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Document text' });
  await editor.fill('Original saved words.');
  await waitForSaved(page);
  await page.evaluate(async () => {
    const path = '/src/app/session.ts';
    const { ProjectSession } = await import(path) as typeof SessionModule;
    const dispatch = ProjectSession.prototype.dispatch;
    ProjectSession.prototype.dispatch = function (name, params, options) {
      if (name === 'doc.write') {
        const { docId } = params as { docId: string };
        Object.assign(window, { documentConflictStatus: () => this.autosave.status(docId) });
        return { ok: false, error: { code: 'revision-conflict', message: 'The test stored newer text.', details: { actualRevision: 9 } } };
      }
      return dispatch.call(this, name, params, options);
    };
    Object.assign(window, { releaseDocumentConflict: () => { ProjectSession.prototype.dispatch = dispatch; } });
  });
  await editor.fill('My unsaved words.');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'failed');
}

export async function installSaveRefusals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const flags = { tasks: false, settings: false };
    Object.assign(globalThis, { __saveRefusals: flags });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>): IDBRequest<IDBValidKey> {
      const value = args[0] as Record<string, unknown>;
      const taskWrite = this.name === 'projects' && value['taskFiles'] !== undefined;
      const settingsWrite = this.name === 'kv' && value['key'] === 'settings';
      const request = put.apply(this, args);
      if ((flags.tasks && taskWrite) || (flags.settings && settingsWrite)) this.transaction.abort();
      return request;
    };
  });
}

export async function refuseSave(page: Page, channel: 'tasks' | 'settings', refused: boolean): Promise<void> {
  await page.evaluate(([name, value]) => {
    (globalThis as unknown as { __saveRefusals: Record<string, boolean> }).__saveRefusals[name] = value;
  }, [channel, refused] as const);
}

export async function makeFailingTask(page: Page): Promise<void> {
  if (await page.getByTestId('modern-stage').count()) await page.keyboard.press('Control+j');
  else await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByTestId('recurring-tasks')).toBeVisible();
  await page.getByRole('button', { name: 'New task' }).click();
  const form = page.getByRole('form', { name: 'New task' });
  await form.getByLabel('Task name').fill('Read the opening');
  await form.getByLabel('What it does').selectOption({ label: 'Scan for continuity problems' });
  await refuseSave(page, 'tasks', true);
  await form.getByRole('button', { name: 'Save task' }).click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'failed');
}

export async function openSaveSettings(page: Page): Promise<void> {
  if (await page.getByTestId('modern-stage').count()) {
    await page.getByTestId('modern-stage').getByRole('button', { name: /^(More|⋯)$/ }).first().click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  } else await page.getByRole('button', { name: 'Settings', exact: true }).click();
}

export async function makeFailingSettings(page: Page): Promise<void> {
  await openSaveSettings(page);
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Writing', exact: true }).click();
  await refuseSave(page, 'settings', true);
  await settings.getByLabel('Daily target, in words (0 for none)').fill('1234');
  await settings.getByRole('button', { name: 'Save writing settings' }).click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'failed');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
}
