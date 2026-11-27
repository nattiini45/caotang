import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron, expect, test } from '@playwright/test';
import { closeShell } from './teardown.js';

const executablePath = createRequire(import.meta.url)('electron') as string;
const shell = fileURLToPath(new URL('..', import.meta.url));

test('account projects opens a packaged window without the local studio bridge', async () => {
  const profile = test.info().outputPath('profile');
  await mkdir(profile, { recursive: true });
  const electron = await _electron.launch({ executablePath, args: [shell, `--user-data-dir=${profile}`, '--lang=en-US'], chromiumSandbox: true });
  try {
    const local = await electron.firstWindow();
    await expect(local.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    await expect.poll(() => electron.evaluate(({ Menu }) => Boolean(Menu.getApplicationMenu()?.getMenuItemById('account-projects')))).toBe(true);
    const opening = electron.waitForEvent('window');
    await electron.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('account-projects');
      if (!item) throw new Error('Account projects menu is missing.');
      item.click();
    });
    const account = await opening;
    await expect(account).toHaveURL('app://account/account/index.html');
    await expect(account.getByRole('heading', { name: 'Account projects' })).toBeVisible();
    expect(await account.evaluate(() => ({
      secure: isSecureContext, account: 'caotangAccount' in window, desktop: 'caotangDesktop' in window, node: 'require' in window,
    }))).toEqual({ secure: true, account: true, desktop: false, node: false });
    expect(await local.evaluate(() => 'caotangAccount' in window)).toBe(false);
    expect(await account.evaluate(() => window.open('https://example.invalid/') === null)).toBe(true);
    const address = account.getByRole('textbox', { name: 'Account server address' });
    await address.fill('http://account.example');
    await account.getByRole('button', { name: 'Connect in your browser' }).click();
    await expect(account.getByRole('alert')).toContainText('HTTPS address without a path');
    await account.screenshot({ path: test.info().outputPath('account-connect.png') });
  } finally {
    await closeShell(electron);
  }
});
