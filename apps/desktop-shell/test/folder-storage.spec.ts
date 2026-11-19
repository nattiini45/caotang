import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createEmptyManifest, createProjectState, exportProjectZip } from '@caotang/store';

import type {} from '../src/folder-contract.cjs';

const executablePath = createRequire(import.meta.url)('electron') as string;
const shell = fileURLToPath(new URL('..', import.meta.url));

async function launch(profile: string): Promise<ElectronApplication> {
  await mkdir(profile, { recursive: true });
  return _electron.launch({ executablePath, args: [shell, `--user-data-dir=${profile}`], chromiumSandbox: true });
}

async function choose(electron: ElectronApplication, path: string): Promise<void> {
  await electron.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, path);
}

test('folder saves land on disk, and a recent folder never opens a stale mirror', async () => {
  const dir = test.info().outputPath('Harbor folder');
  const profile = test.info().outputPath('profile');
  const manifest = join(dir, 'caotang.json');
  await mkdir(dir, { recursive: true });
  const electron = await launch(profile);
  try {
    await choose(electron, dir);
    const page = await electron.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Harbor Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Harbor Notebook', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New chapter', exact: true }).first().click();
    await expect.poll(() => readFile(manifest, 'utf8')).toContain('"title": "Untitled"');
    const boundary = await page.evaluate(async () => {
      const api = window.caotangDesktop?.folders;
      if (!api) throw new Error('Native folder bridge missing');
      const folders = await api.recentFolders();
      if (!folders.ok || !folders.value[0]) throw new Error('No recent project folder');
      const id = folders.value[0].id;
      return [
        Object.keys(folders.value[0]).sort(),
        await api.read(id, '../outside.txt'),
        await api.write(id, 'docs/../outside.txt', new Uint8Array([8])),
      ];
    });
    expect(boundary).toEqual([['id', 'name'], { ok: false, error: 'invalid' }, { ok: false, error: 'invalid' }]);
  } finally {
    await electron.close();
  }

  const onDisk = await readFile(manifest, 'utf8');
  await writeFile(manifest, onDisk.replace('Harbor Notebook', 'Folder Version'));
  const reopened = await launch(profile);
  const moved = test.info().outputPath('moved project');
  try {
    const page = await reopened.firstWindow();
    const recent = page.getByRole('button', { name: 'Reopen folder', exact: true });
    await expect(recent).toBeVisible();
    await expect(recent).toHaveAccessibleDescription('Harbor folder');
    if (process.platform !== 'win32') {
      await chmod(dir, 0o555);
      await recent.click();
      await expect(page.getByRole('alert')).toContainText('read-only');
      await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
      await chmod(dir, 0o755);
    }
    await rename(dir, moved);
    await recent.click();
    await expect(page.getByRole('alert')).toContainText('missing or was moved');
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    await rename(moved, dir);
    await recent.click();
    await expect(page.getByText('Folder Version', { exact: true })).toBeVisible();
  } finally {
    await chmod(dir, 0o755).catch(() => undefined);
    await reopened.close();
  }
});

test('explicit copy leaves an IndexedDB-only project available', async () => {
  const dir = test.info().outputPath('copy');
  await mkdir(dir, { recursive: true });
  const state = createProjectState(createEmptyManifest('Reed Notebook'));
  const bundle = await exportProjectZip(state);
  const electron = await launch(test.info().outputPath('profile'));
  try {
    const page = await electron.firstWindow();
    const bundleInput = page.locator('input[type=file][accept*=".caotang"]');
    await bundleInput.setInputFiles({ name: 'reed.caotang', mimeType: 'application/zip', buffer: Buffer.from(bundle.bytes) });
    await expect(page.getByText('Reed Notebook', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Reed Notebook', { exact: true })).toBeVisible();
    await choose(electron, dir);
    await page.getByRole('button', { name: 'Copy to a folder…', exact: true }).click();
    await expect(page.getByText('All changes saved to the project folder', { exact: true }).first()).toBeVisible();
    const copy = JSON.parse(await readFile(join(dir, 'caotang.json'), 'utf8')) as { project: { id: string; name: string } };
    expect(copy.project.name).toBe('Reed Notebook');
    expect(copy.project.id).not.toBe(state.manifest.project.id);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Copy to a folder…', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen folder', exact: true })).toBeVisible();
  } finally {
    await electron.close();
  }
});
