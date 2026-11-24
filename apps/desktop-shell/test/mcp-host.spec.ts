/**
 * The project's own MCP server in the app (#406, desktop.md §The project's own MCP server): the bridge the page is given, a start over
 * the folder the writer opened, a save that still lands while the server runs, and the pause that turns a host's write into a refusal
 * instead of a lost one.
 *
 * What the server itself does with a pause, with a token and with a write tool is this package's own suite
 * (`packages/mcp-server/test/control.test.ts`). What this proves is the wiring: the page reaches the shell, the shell forks the bundle,
 * the endpoint answers, and the two writers leave each other's work alone.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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

async function choose(electron: ElectronApplication, path: string): Promise<void> {
  await electron.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, path);
}

/** A project opened from a folder, and the grant id the page calls the server with. */
async function openFolderProject(electron: ElectronApplication, dir: string, name: string): Promise<{ page: Awaited<ReturnType<ElectronApplication['firstWindow']>>; folderId: string }> {
  await choose(electron, dir);
  const page = await electron.firstWindow();
  await page.getByRole('textbox', { name: 'Project name' }).fill(name);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  const folderId = await page.evaluate(async () => {
    const folders = await window.caotangDesktop?.folders.recentFolders();
    if (folders === undefined || !folders.ok || !folders.value[0]) throw new Error('No recent project folder');
    return folders.value[0].id;
  });
  return { page, folderId };
}

/** One JSON-RPC call on the server's own endpoint, as a host makes it: the token, and a write tool. */
async function callWriteTool(url: string, token: string): Promise<{ isError?: boolean; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'meta.set', arguments: { targets: [], status: 'final' } } }),
  });
  const body = await response.text();
  const result = /"isError":true/u.test(body);
  return { isError: result ? true : undefined, text: body };
}

test('the page is given the six server calls and nothing else', async () => {
  const electron = await launch(test.info().outputPath('profile'));
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    const surface = await page.evaluate(() => {
      const mcp = window.caotangDesktop?.mcp;
      return mcp === undefined ? null : Object.keys(mcp).sort();
    });
    // A new channel here is a new power the page has over the writer's folder, so the list is the contract.
    expect(surface).toEqual(['onStatus', 'pause', 'resume', 'start', 'status', 'stop']);
  } finally {
    await closeShell(electron);
  }
});

test('starting over the folder the writer opened serves it, and a save still lands while it runs', async () => {
  const dir = test.info().outputPath('Served folder');
  await mkdir(dir, { recursive: true });
  const manifest = join(dir, 'caotang.json');
  const electron = await launch(test.info().outputPath('profile'));
  try {
    const { page, folderId } = await openFolderProject(electron, dir, 'Kestrel Notebook');
    const started = await page.evaluate((id) => window.caotangDesktop!.mcp.start(id, false), folderId);
    expect(started.ok).toBe(true);
    expect(started.ok && started.value.state).toBe('running');
    const url = started.ok ? String(started.value.url) : '';
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    expect(started.ok && String(started.value.token).length).toBeGreaterThanOrEqual(16);
    // The same run, read back: the page's status is the main process's, not a copy it keeps.
    const status = await page.evaluate(() => window.caotangDesktop!.mcp.status());
    expect(status.ok && status.value.url).toBe(url);

    // The server holds the folder's lock for its whole run, so a save landing here proves the app recognises its own server's lock
    // and still writes: without that, every save would be refused with "could not access the project folder".
    const before = await readFile(manifest, 'utf8');
    await page.getByRole('button', { name: 'New chapter', exact: true }).first().click();
    await expect.poll(() => readFile(manifest, 'utf8'), { timeout: 15_000 }).not.toBe(before);
    await expect(page.getByText('All changes saved to the project folder', { exact: true }).first()).toBeVisible();
  } finally {
    await closeShell(electron);
  }
});

test('a paused server refuses a write tool and takes it again after the resume', async () => {
  const dir = test.info().outputPath('Paused folder');
  await mkdir(dir, { recursive: true });
  const electron = await launch(test.info().outputPath('profile'));
  try {
    const { page, folderId } = await openFolderProject(electron, dir, 'Petrel Notebook');
    // Writes on, so the refusal the pause earns is the pause's and not the read-only server's.
    const started = await page.evaluate((id) => window.caotangDesktop!.mcp.start(id, true), folderId);
    expect(started.ok && started.value.state).toBe('running');
    const url = started.ok ? String(started.value.url) : '';
    const token = started.ok ? String(started.value.token) : '';

    // The app's own pause, over the same endpoint a save uses.
    expect(await page.evaluate(() => window.caotangDesktop!.mcp.pause())).toMatchObject({ ok: true });
    const refused = await callWriteTool(url, token);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Caotang for desktop is saving to this folder');

    expect(await page.evaluate(() => window.caotangDesktop!.mcp.resume())).toMatchObject({ ok: true });
    const taken = await callWriteTool(url, token);
    expect(taken.text).not.toContain('Caotang for desktop is saving to this folder');

    const stopped = await page.evaluate(() => window.caotangDesktop!.mcp.stop());
    expect(stopped.ok && stopped.value.state).toBe('stopped');
  } finally {
    await closeShell(electron);
  }
});
