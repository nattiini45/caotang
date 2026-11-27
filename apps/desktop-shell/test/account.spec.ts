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

    expect(await account.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.src = './studio.html';
      await new Promise<void>((resolve) => {
        frame.addEventListener('load', () => resolve(), { once: true });
        document.body.append(frame);
      });
      const target = frame.contentWindow;
      if (!target) throw new Error('Account studio frame is missing.');
      const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'HKDF', false, ['deriveBits']);
      const algorithm = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new Uint8Array() };
      const expected = new Uint8Array(await crypto.subtle.deriveBits(algorithm, key, 256));
      const delivered = new Promise<MessageEvent<CryptoKey>>((resolve, reject) => {
        target.addEventListener('message', resolve, { once: true });
        target.addEventListener('messageerror', () => reject(new Error('Account studio could not deserialize the key.')), { once: true });
      });
      target.postMessage(key, location.origin);
      const event = await delivered;
      const actual = await target.crypto.subtle.deriveBits(algorithm, event.data, 256);
      return {
        origin: event.origin,
        fromAccountWindow: event.source === window,
        extractable: event.data.extractable,
        derivesSameBits: new Uint8Array(actual).every((byte, index) => byte === expected[index]),
      };
    })).toEqual({ origin: 'app://account', fromAccountWindow: true, extractable: false, derivesSameBits: true });
  } finally {
    await closeShell(electron);
  }
});
