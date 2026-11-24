/**
 * The provider port (#405, desktop.md §Native provider and MCP calls): the main process answers a page's call only for an
 * address the app configured, and never for another one. The rule itself is tested by the repository's gate
 * (packages/gateway/test/native-egress.test.ts); this proves it is the rule the built app actually runs, through the
 * preload bridge and across IPC.
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

test('the page reaches an address the app configured, and nothing else', async () => {
  const electron = await launch(test.info().outputPath('profile'));
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();

    const surface = await page.evaluate(() => ({
      version: window.caotangDesktop?.version,
      net: window.caotangDesktop === undefined ? null : Object.keys(window.caotangDesktop.net).sort(),
    }));
    expect(surface).toEqual({ version: 6, net: ['abort', 'configure', 'onChunk', 'onEnd', 'start'] });

    const call = (url: string, headers: Record<string, string> = {}) => page.evaluate(
      async ({ url, headers }) => window.caotangDesktop!.net.start({ id: crypto.randomUUID(), url, method: 'POST', headers, body: '{}' }),
      { url, headers },
    );

    // Nothing is configured yet, so every address is refused: a page that has said nothing yet reaches nothing.
    expect(await call('https://api.example.com/v1/chat/completions')).toMatchObject({ ok: false, error: 'denied' });

    expect(await page.evaluate(() => window.caotangDesktop!.net.configure([{ origin: 'https://api.example.com' }]))).toEqual({ ok: true, value: null });

    // A key handle at an address that key was not configured for is refused rather than sent as a handle.
    expect(await call('https://api.example.com/v1/chat/completions', { authorization: 'Bearer caotang-key:prv_ABCDEFGHJK' }))
      .toMatchObject({ ok: false, error: 'denied' });

    // A key belongs to the address it was stored for. Stored for api.example.com, it is refused at another address the page is
    // free to reach: a page may widen what it reaches and cannot say where a key goes (#864). A machine whose keychain is not
    // usable holds no key at all, and the vault spec is where that is proved.
    const available = await page.evaluate(() => window.caotangDesktop!.vault.available());
    if (available.ok && available.value) {
      expect(await page.evaluate(() => window.caotangDesktop!.vault.put('prv_ABCDEFGHJK', { apiKey: 'sk-bound' }, 'https://api.example.com'))).toEqual({ ok: true, value: null });
      expect(await call('https://other.example/v1/chat/completions', { authorization: 'Bearer caotang-key:prv_ABCDEFGHJK' }))
        .toMatchObject({ ok: false, error: 'denied' });
    }

    // A configured address, but a shape the port refuses before any socket opens: a header that names the connection.
    expect(await call('https://api.example.com/v1/chat/completions', { host: 'evil.example' })).toMatchObject({ ok: false, error: 'invalid' });
    // Another host on the same port, and this computer, stay out whatever the allowlist says.
    expect(await call('https://other.example/v1')).toMatchObject({ ok: false, error: 'denied' });
    expect(await call('https://127.0.0.1:11434/v1/models')).toMatchObject({ ok: false, error: 'denied' });
    // A plain-http address is not a shape this port carries at all.
    expect(await call('http://api.example.com/v1')).toMatchObject({ ok: false, error: 'invalid' });

    // A refused call leaves no stream behind, and aborting an id that never started is not an error.
    expect(await page.evaluate(() => window.caotangDesktop!.net.abort('never-started'))).toEqual({ ok: true, value: null });
  } finally {
    await closeShell(electron);
  }
});
