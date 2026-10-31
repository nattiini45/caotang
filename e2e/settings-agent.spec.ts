import { expect, test } from '@playwright/test';

/**
 * Settings › Agent (agent-harness §3): "Load every tool on every request" is off until the writer turns it on, and what they chose
 * is still chosen after a reload. It is an app setting, so it needs no project.
 */

test('the Agent section offers Load every tool on every request, off by default, and keeps it after a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();

  const toggle = settings.getByRole('checkbox', { name: 'Load every tool on every request' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(settings.getByText('Saved. It applies to the agent’s next request.')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings').getByRole('button', { name: 'Agent', exact: true }).click();
  const again = page.getByTestId('settings').getByRole('checkbox', { name: 'Load every tool on every request' });
  await expect(again).toBeChecked();

  await again.uncheck();
  await expect(page.getByTestId('settings').getByText('Saved. It applies to the agent’s next request.')).toBeVisible();
});

test('when the browser refuses to save Keep agent traces, the Agent section says so beside the switch', async ({ page }) => {
  await page.addInitScript(() => {
    const refuse = { settings: false };
    (globalThis as unknown as { __caotangRefuseSettings: typeof refuse }).__caotangRefuseSettings = refuse;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>): IDBRequest<IDBValidKey> {
      const record = args[0] as { key?: unknown } | undefined;
      // A refused write fails the way a full disk does: its transaction aborts, so the app database rejects the save.
      const request = put.apply(this, args);
      if (refuse.settings && record?.key === 'settings') this.transaction.abort();
      return request;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();

  const toggle = settings.getByTestId('agent-keep-traces');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(settings.getByText('Saved. It applies to what the agent records next.')).toBeVisible();

  await page.evaluate(() => {
    (globalThis as unknown as { __caotangRefuseSettings: { settings: boolean } }).__caotangRefuseSettings.settings = true;
  });
  await toggle.check();
  await expect(settings.getByRole('alert')).toContainText('The settings could not be saved in this browser');
  // The switch itself follows the setting in memory, which is what the trace honours.
  await expect(toggle).toBeChecked();
});
