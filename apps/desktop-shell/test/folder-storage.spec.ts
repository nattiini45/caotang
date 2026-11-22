import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { createEmptyManifest, createProjectState, exportProjectZip } from '@caotang/store';

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
    await closeShell(electron);
  }

  const onDisk = await readFile(manifest, 'utf8');
  await writeFile(manifest, onDisk.replace('Harbor Notebook', 'Folder Version'));
  await writeFile(join(dir, 'AGENTS.md'), 'Keep the existing chapter titles.');
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
    await closeShell(reopened);
  }
});

test('a recent-folder list that cannot be read costs the list, not the window', async () => {
  const profile = test.info().outputPath('profile');
  const dir = test.info().outputPath('Recovered folder');
  await mkdir(profile, { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(profile, 'native-project-folders.json'), '[{"id": "half a record"');
  const electron = await launch(profile);
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    await choose(electron, dir);
    await page.getByRole('textbox', { name: 'Project name' }).fill('Ash Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Ash Notebook', { exact: true })).toBeVisible();
    await expect.poll(() => readFile(join(dir, 'caotang.json'), 'utf8')).toContain('"name": "Ash Notebook"');
  } finally {
    await closeShell(electron);
  }
});

test('forgetting a recent folder leaves its folder writable for a closing session', async () => {
  const profile = test.info().outputPath('profile');
  const dir = test.info().outputPath('Wren folder');
  await mkdir(profile, { recursive: true });
  await mkdir(dir, { recursive: true });
  const electron = await launch(profile);
  try {
    const page = await electron.firstWindow();
    await choose(electron, dir);
    await page.getByRole('textbox', { name: 'Project name' }).fill('Wren Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Wren Notebook', { exact: true })).toBeVisible();
    const outcome = await page.evaluate(async () => {
      const api = window.caotangDesktop?.folders;
      if (!api) throw new Error('Native folder bridge missing');
      const folders = await api.recentFolders();
      if (!folders.ok || !folders.value[0]) throw new Error('No recent project folder');
      const id = folders.value[0].id;
      const forgotten = await api.forgetFolder(id);
      const write = await api.write(id, 'docs/note.md', new TextEncoder().encode('The closing save.'));
      const after = await api.recentFolders();
      return { forgotten, write, listed: after.ok ? after.value.map((folder) => folder.id) : null };
    });
    expect(outcome.forgotten).toEqual({ ok: true, value: null });
    expect(outcome.write).toEqual({ ok: true, value: null });
    expect(outcome.listed).toEqual([]);
    expect(await readFile(join(dir, 'docs', 'note.md'), 'utf8')).toBe('The closing save.');
  } finally {
    await closeShell(electron);
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
    await closeShell(electron);
  }
});

test('a recovery accepted in a native folder saves to that folder, not to a copy in the browser', async () => {
  const dir = test.info().outputPath('Recovered folder');
  const profile = test.info().outputPath('profile');
  const manifest = join(dir, 'caotang.json');
  await mkdir(dir, { recursive: true });
  const electron = await launch(profile);
  try {
    await choose(electron, dir);
    const page = await electron.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Kelp Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Kelp Notebook', { exact: true })).toBeVisible();
    // A chapter, so the folder holds a document the ladder can rebuild the project from.
    await page.getByRole('button', { name: 'New chapter', exact: true }).first().click();
    await expect.poll(() => readFile(manifest, 'utf8')).toContain('"title": "Untitled"');
  } finally {
    await closeShell(electron);
  }

  // The manifest another program broke: the folder's open offers the recovery ladder instead of refusing.
  await writeFile(manifest, '{"project": "not a manifest"');

  const reopened = await launch(profile);
  try {
    const page = await reopened.firstWindow();
    await page.getByRole('button', { name: 'Reopen folder', exact: true }).click();
    const dialog = page.getByTestId('recovery-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Rebuild the project|Open this copy/ }).click();
    // The recovered project is open, and the folder is its home: a save after the recovery reaches the folder (#744). A copy in the
    // browser would leave the manifest on disk as the recovery wrote it.
    const newChapter = page.getByRole('button', { name: 'New chapter', exact: true }).first();
    await expect(newChapter).toBeVisible();
    const recovered = await readFile(manifest, 'utf8');
    await newChapter.click();
    await expect.poll(async () => (await readFile(manifest, 'utf8')) !== recovered, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => readFile(manifest, 'utf8')).toContain('"title": "Untitled"');
  } finally {
    await closeShell(reopened);
  }
});

test('a recovery that pauses on a file that is not UTF-8 text still opens and saves in its folder', async () => {
  const dir = test.info().outputPath('Paused recovery folder');
  const profile = test.info().outputPath('profile');
  const manifest = join(dir, 'caotang.json');
  await mkdir(dir, { recursive: true });
  const electron = await launch(profile);
  try {
    await choose(electron, dir);
    const page = await electron.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Driftwood Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Driftwood Notebook', { exact: true })).toBeVisible();
    // A scene with text, so the folder holds a document the recovered project names and has to read.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Scene/ }).click();
    await page.getByRole('textbox', { name: 'Document text' }).fill('The ferry leaves at dusk.');
    await expect.poll(async () => (await readdir(join(dir, 'docs'))).filter((name) => name.endsWith('.md')).length).toBe(1);
  } finally {
    await closeShell(electron);
  }

  // The scene's document replaced by bytes that are not UTF-8 text, so the recovery pauses for the writer's answer before the
  // project opens, and a manifest another program broke, so the folder offers the ladder instead of refusing.
  const documents = (await readdir(join(dir, 'docs'))).filter((name) => name.endsWith('.md'));
  expect(documents).toHaveLength(1);
  await writeFile(join(dir, 'docs', documents[0] as string), Buffer.from([0x54, 0x68, 0x65, 0x20, 0xe9, 0x74, 0xe9, 0x0a]));
  await writeFile(manifest, '{"project": "not a manifest"');

  const reopened = await launch(profile);
  try {
    const page = await reopened.firstWindow();
    await page.getByRole('button', { name: 'Reopen folder', exact: true }).click();
    const recovery = page.getByTestId('recovery-dialog');
    await expect(recovery).toBeVisible();
    await recovery.getByRole('button', { name: /Rebuild the project|Open this copy/ }).click();
    // The answer about the unreadable file is what completes the recovery, and it must not leave the project in the browser.
    const encoding = page.getByTestId('encoding-dialog');
    await expect(encoding).toBeVisible();
    await encoding.getByRole('radio', { name: /^Leave it/ }).check();
    await encoding.getByRole('button', { name: 'Open the project', exact: true }).click();
    const newChapter = page.getByRole('button', { name: 'New chapter', exact: true }).first();
    await expect(newChapter).toBeVisible();
    const recovered = await readFile(manifest, 'utf8');
    await newChapter.click();
    await expect.poll(async () => (await readFile(manifest, 'utf8')) !== recovered, { timeout: 10_000 }).toBe(true);
  } finally {
    await closeShell(reopened);
  }
});
