import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { _electron, expect, test } from '@playwright/test';

import type {} from '../src/folder-contract.cjs';

import { dismissDialogs } from './dialogs.js';
import { closeShell } from './teardown.js';

const executablePath = createRequire(import.meta.url)('electron') as string;
const shell = fileURLToPath(new URL('..', import.meta.url));

test('the sandboxed desktop window opens the built studio and its lazy Settings', async () => {
  const profile = test.info().outputPath('profile');
  await mkdir(profile, { recursive: true });
  const electron = await _electron.launch({
    executablePath,
    args: [shell, `--user-data-dir=${profile}`],
    chromiumSandbox: true,
  });
  dismissDialogs(electron);
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    await expect(page).toHaveURL('app://caotang/');
    expect(await electron.evaluate(({ app, BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents as { getLastWebPreferences(): object } | undefined;
      return { preferences: contents?.getLastWebPreferences(), noSandbox: app.commandLine.hasSwitch('no-sandbox') };
    })).toMatchObject({
      preferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
      noSandbox: false,
    });
    expect(await page.evaluate(() => ({
      secure: isSecureContext,
      bridge: window.caotangDesktop === undefined ? null : Object.keys(window.caotangDesktop).sort(),
      version: window.caotangDesktop?.version,
      node: ['require', 'process', 'Buffer'].filter((key) => key in window),
    }))).toEqual({ secure: true, bridge: ['folders', 'version'], version: 2, node: [] });

    const response = await page.reload();
    const policy = await response?.headerValue('content-security-policy');
    expect(policy?.split('; ')).toEqual(expect.arrayContaining([
      "script-src 'self'", "worker-src 'self'", "frame-ancestors 'none'", "object-src 'none'",
    ]));
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByTestId('settings')).toBeVisible();

    const blockedScript = await page.evaluate(() => new Promise((resolve) => {
      const url = 'https://example.invalid/probe.js';
      document.addEventListener('securitypolicyviolation', (event) => {
        if (event.blockedURI === url) resolve(event.effectiveDirective);
      });
      const script = document.createElement('script');
      script.src = url;
      document.head.append(script);
      script.addEventListener('error', () => setTimeout(() => resolve(null), 0));
    }));
    expect(blockedScript).toBe('script-src-elem');
    expect(await page.evaluate(() => window.open('https://example.invalid/') === null)).toBe(true);
    expect(electron.windows()).toHaveLength(1);
  } finally {
    await closeShell(electron);
  }
});

test('a teardown of an app that has already gone is not reported as a failure', async () => {
  const profile = test.info().outputPath('profile');
  await mkdir(profile, { recursive: true });
  const electron = await _electron.launch({
    executablePath,
    args: [shell, `--user-data-dir=${profile}`],
    chromiumSandbox: true,
  });
  dismissDialogs(electron);
  try {
    await electron.firstWindow();
    // An app that ended on its own — the shell's own `fail()` exits this way — has already emitted its close, so the teardown must
    // resolve instead of waiting for an event it can no longer hear (#792). The exit is asked for and its reply is not awaited: the
    // app goes before it can answer, so the process's own exit is what says it has gone.
    const child = electron.process();
    void electron.evaluate(({ app }) => { app.exit(0); }).catch(() => undefined);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // A spec reaches its `finally` after whatever it was doing, so the app it finds gone has been gone for a while: wait long enough
    // that the close the process emitted is behind us, which is the case that used to be reported as a teardown failure.
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(closeShell(electron)).resolves.toBeUndefined();
  } finally {
    await closeShell(electron);
  }
});
