/**
 * The keychain the page may reach (#404, desktop.md §The keychain): the shape of the channels, and the one rule that matters —
 * a page can put, check, revise, restore and remove a key, and there is no channel that reads one back.
 *
 * What the vault does with those calls is the repository's own test (`packages/gateway/test/os-vault.test.ts`), because it needs
 * no Electron. What this proves is that the built app exposes exactly those calls and nothing more, and that a call from a page
 * that is not the studio's own is refused.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { _electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

import type {} from '../src/folder-contract.cjs';
import { dismissDialogs } from './dialogs.js';
import { closeShell } from './teardown.js';

const executablePath = createRequire(import.meta.url)('electron') as string;
const shell = fileURLToPath(new URL('..', import.meta.url));

async function launch(profile: string): Promise<ElectronApplication> {
  await mkdir(profile, { recursive: true });
  const electron = await _electron.launch({ executablePath, args: [shell, `--user-data-dir=${profile}`], chromiumSandbox: true });
  dismissDialogs(electron);
  return electron;
}

test('the page can store a secret and can never read one back', async () => {
  const electron = await launch(test.info().outputPath('profile'));
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();

    const surface = await page.evaluate(() => {
      const vault = window.caotangDesktop?.vault;
      return vault === undefined ? null : Object.keys(vault).sort();
    });
    // There is no `read`, `get` or `reveal` here, and adding one is the change this test exists to refuse.
    expect(surface).toEqual(['available', 'has', 'headers', 'keyState', 'put', 'putHeaders', 'remove', 'restore', 'revision']);

    // A machine with a keychain stores and reports; a machine without one refuses, and says so rather than pretending.
    const available = await page.evaluate(() => window.caotangDesktop!.vault.available());
    expect(available.ok).toBe(true);
    if (available.ok && available.value) {
      const id = 'prv_ABCDEFGHJK';
      const put = await page.evaluate((id) => window.caotangDesktop!.vault.put(id, { apiKey: 'sk-live-0123456789abcdef' }), id);
      expect(put).toEqual({ ok: true, value: null });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.has(id), id)).toEqual({ ok: true, value: true });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.keyState(id), id)).toEqual({ ok: true, value: 'key' });
      const revision = await page.evaluate((id) => window.caotangDesktop!.vault.revision(id), id);
      expect(revision.ok && revision.value).toMatch(/^[0-9a-f]{64}$/);
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.headers(id), id)).toEqual({ ok: true, value: {} });
      // A headers-only edit keeps the key: the page read a handle, and handing that handle back as a secret would destroy the key
      // it was given for (#863). What changes is the headers, and the revision moves with them.
      const beforeHeaders = revision.ok ? revision.value : '';
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.putHeaders(id, { 'x-team': 'two' }), id)).toEqual({ ok: true, value: null });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.headers(id), id)).toEqual({ ok: true, value: { 'x-team': 'two' } });
      const afterHeaders = await page.evaluate((id) => window.caotangDesktop!.vault.revision(id), id);
      expect(afterHeaders.ok && afterHeaders.value).not.toBe(beforeHeaders);
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.restore(id), id)).toEqual({ ok: true, value: null });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.remove(id), id)).toEqual({ ok: true, value: null });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.has(id), id)).toEqual({ ok: true, value: false });
      // A profile that authenticates with its own headers alone stores an empty key (#868): the payload is accepted, and the
      // entry says so, so the page can answer it with `''` instead of a handle that would name a secret there is none of.
      const headersOnly = 'prv_HEADERSONE';
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.put(id, { apiKey: '', customHeaders: { 'x-team': 'made-up' } }), headersOnly))
        .toEqual({ ok: true, value: null });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.keyState(id), headersOnly)).toEqual({ ok: true, value: 'empty' });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.put(id, { apiKey: '' }), headersOnly)).toEqual({ ok: false, error: 'invalid' });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.remove(id), headersOnly)).toEqual({ ok: true, value: null });
    } else {
      expect(await page.evaluate(() => window.caotangDesktop!.vault.put('prv_ABCDEFGHJK', { apiKey: 'sk-live-x' })))
        .toEqual({ ok: false, error: 'unavailable' });
    }
  } finally {
    await closeShell(electron);
  }
});

/**
 * The seal and the open, end to end, on a machine that has a keychain: a key written by one run of the app is read back by the
 * next one, and the file it sits in holds no plain text. A runner without a keyring (CI) cannot run this and skips it, which is
 * the gap desktop.md names; on Windows, macOS and a Linux desktop with libsecret or KWallet it is the whole path.
 */
test('a key survives the app closing, and the file it sits in holds no plain text', async () => {
  const profile = test.info().outputPath('profile-relaunch');
  const first = await launch(profile);
  const id = 'prv_RELAUNCH01';
  try {
    const page = await first.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    const available = await page.evaluate(() => window.caotangDesktop!.vault.available());
    test.skip(!(available.ok && available.value), 'this machine has no keychain, so the fallback is the path it exercises');
    const stored = await page.evaluate((id) => window.caotangDesktop!.vault.put(id, { apiKey: 'sk-relaunch-secret', customHeaders: { 'x-workspace': 'w1' } }), id);
    expect(stored).toEqual({ ok: true, value: null });
    const file = await readFile(join(profile, 'native-key-vault.json'), 'utf8');
    expect(file).not.toContain('sk-relaunch-secret');
  } finally {
    await closeShell(first);
  }

  const second = await launch(profile);
  try {
    const page = await second.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    expect(await page.evaluate((id) => window.caotangDesktop!.vault.has(id), id)).toEqual({ ok: true, value: true });
    // The extra headers come back only if the next process could open what the first one sealed.
    expect(await page.evaluate((id) => window.caotangDesktop!.vault.headers(id), id)).toEqual({ ok: true, value: { 'x-workspace': 'w1' } });
    expect(await page.evaluate((id) => window.caotangDesktop!.vault.remove(id), id)).toEqual({ ok: true, value: null });
  } finally {
    await closeShell(second);
  }
});
