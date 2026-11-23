/**
 * The keychain the page may reach (#404, desktop.md §The keychain): the shape of the channels, and the one rule that matters —
 * a page can put, check, revise, restore and remove a key, and there is no channel that reads one back.
 *
 * What the vault does with those calls is the repository's own test (`packages/gateway/test/os-vault.test.ts`), because it needs
 * no Electron. What this proves is that the built app exposes exactly those calls and nothing more, and that a call from a page
 * that is not the studio's own is refused.
 */

import { mkdir } from 'node:fs/promises';
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
    expect(surface).toEqual(['available', 'has', 'headers', 'put', 'remove', 'restore', 'revision']);

    // A machine with a keychain stores and reports; a machine without one refuses, and says so rather than pretending.
    const available = await page.evaluate(() => window.caotangDesktop!.vault.available());
    expect(available.ok).toBe(true);
    if (available.ok && available.value) {
      const id = 'prv_ABCDEFGHJK';
      const put = await page.evaluate((id) => window.caotangDesktop!.vault.put(id, { apiKey: 'sk-live-0123456789abcdef' }), id);
      expect(put).toEqual({ ok: true, value: null });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.has(id), id)).toEqual({ ok: true, value: true });
      const revision = await page.evaluate((id) => window.caotangDesktop!.vault.revision(id), id);
      expect(revision.ok && revision.value).toMatch(/^[0-9a-f]{64}$/);
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.headers(id), id)).toEqual({ ok: true, value: {} });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.restore(id), id)).toEqual({ ok: true, value: null });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.remove(id), id)).toEqual({ ok: true, value: null });
      expect(await page.evaluate((id) => window.caotangDesktop!.vault.has(id), id)).toEqual({ ok: true, value: false });
    } else {
      expect(await page.evaluate(() => window.caotangDesktop!.vault.put('prv_ABCDEFGHJK', { apiKey: 'sk-live-x' })))
        .toEqual({ ok: false, error: 'unavailable' });
    }
  } finally {
    await closeShell(electron);
  }
});
