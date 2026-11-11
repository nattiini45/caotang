import { expect, test } from '@playwright/test';
import type * as SessionModule from '../apps/desktop/src/app/session.js';
import { createProject, waitForSaved } from './support.js';

for (const shell of ['classic', 'modern'] as const) {
  test(`${shell}: a rejected close settle reports the failure and lets another tab open the project`, async ({ page, context }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((value) => localStorage.setItem('caotang.interface', value), shell);
    await createProject(page, 'A released project');
    await waitForSaved(page);
    await page.evaluate(async () => {
      const path = '/src/app/session.ts';
      const { ProjectSession } = await import(path) as typeof SessionModule;
      const close = ProjectSession.prototype.closeSafely;
      ProjectSession.prototype.closeSafely = function () {
        this.settle = () => Promise.reject(new Error('The final asset check failed.'));
        return close.call(this);
      };
    });
    if (shell === 'modern') {
      await page.getByRole('toolbar', { name: 'Scene' }).getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Projects', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
    }
    await expect(page.locator('.home')).toHaveAttribute('data-state', 'idle');
    await expect(page.getByRole('status').filter({ hasText: 'The writing session could not be recorded:' })).toContainText('The final asset check failed.');
    const other = await context.newPage();
    try {
      await other.goto('/');
      await expect(other.locator('.home')).toHaveAttribute('data-state', 'idle');
      await other.getByRole('listitem').filter({ hasText: 'A released project' }).getByRole('button', { name: 'Open', exact: true }).click();
      await expect(other.getByRole('tree', { name: 'Binder' }).or(other.getByTestId('modern-binder-bar')).first()).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await other.close();
    }
  });
}

test('demo opening keeps one intent and blocks competing project actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toHaveAttribute('data-demo-state', 'idle');
  await page.evaluate(async () => {
    const path = '/src/app/session.ts';
    const { ProjectSession } = await import(path) as typeof SessionModule;
    const settle = ProjectSession.prototype.settle;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(window, { releaseB5Demo: release });
    ProjectSession.prototype.settle = async function () { await held; return settle.call(this); };
  });
  const demoButtons = page.getByRole('group', { name: 'Demo intents' }).getByRole('button');
  await demoButtons.first().evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.locator('.home')).toHaveAttribute('data-demo-state', 'opening');
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Import bundle (.caotang)', exact: true })).toBeDisabled();
  for (const button of await demoButtons.all()) await expect(button).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Opening the project' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseB5Demo(): void }).releaseB5Demo());
  await expect(page.getByTestId('ghost-bar')).toBeVisible();
  await page.reload();
  await expect(page.locator('.project-list > li')).toHaveCount(1);
});
