import { expect, type Page } from '@playwright/test';
import type * as TaskStoreModule from '../apps/desktop/src/app/task-store.js';

import { fakeEndpoint, planThenAnswer, useFakeEndpoint as configureFakeEndpoint } from './endpoint.js';
import { createProject, firstChapter } from './support.js';

export async function holdCancellingTask(page: Page) {
  const steps = Array.from({ length: 5 }, () => ({ tool: 'scene.draft', params: { doc: 'Scene', instruction: 'Open.', mode: 'draft' }, expect: 'A draft' }));
  await fakeEndpoint(page, planThenAnswer({ steps }));
  await configureFakeEndpoint(page);
  await createProject(page, 'Cancellation Book');
  await firstChapter(page);
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  const title = page.getByRole('textbox', { name: 'Rename Untitled' });
  await title.fill('Scene');
  await page.keyboard.press('Enter');

  await page.evaluate(async () => {
    const path = '/src/app/task-store.ts';
    const { TaskStore } = await import(path) as typeof TaskStoreModule;
    const save = TaskStore.prototype.save;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const testWindow = window as unknown as { releaseTaskStartup: () => void };
    testWindow.releaseTaskStartup = release;
    TaskStore.prototype.save = async function (task) {
      if (task.status === 'running') {
        TaskStore.prototype.save = save;
        await gate;
      }
      await save.call(this, task);
    };
  });

  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('combobox', { name: 'Intent' }).fill('Draft five openings.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByTestId('plan-offer').getByRole('button', { name: 'Run in background' }).click();
  const task = page.getByTestId('background-tasks').locator('[data-task]');
  await expect(task).toHaveAttribute('data-state', 'starting');
  await task.getByRole('button', { name: /^Cancel/ }).click();
  await expect(task).toHaveAttribute('data-state', 'cancelling');
  await expect(task.getByTestId('task-status')).toHaveText('Cancelling…');
  await expect(task.getByRole('button')).toHaveCount(0);
  return task;
}

export async function releaseTaskStartup(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { releaseTaskStartup: () => void }).releaseTaskStartup());
}
