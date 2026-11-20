/**
 * The open folder is watched by the main process, and a change another program makes reaches the renderer within the detection
 * budget (#403, desktop.md §External folder changes): the path is project-relative, and the temp writes an artifact save makes on
 * its way to a rename never arrive as changes.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

/** The detection budget the issue names: from the write in another program to the renderer hearing about it. */
const BUDGET_MS = 500;
/** How long the temp-write spec keeps listening after the target arrives, so a later batch is still seen. */
const SETTLE_MS = 400;

interface Received {
  readonly paths: readonly string[];
  readonly at: number;
}

declare global {
  interface Window {
    folderChange?: Promise<Received>;
  }
}

async function launch(profile: string): Promise<ElectronApplication> {
  await mkdir(profile, { recursive: true });
  const electron = await _electron.launch({ executablePath, args: [shell, `--user-data-dir=${profile}`], chromiumSandbox: true });
  // A session with words still to write warns before its window unloads, and Playwright's own handling of that dialog races the
  // window going away. Dismissing from here keeps a teardown from being the thing that fails (dialogs.ts).
  dismissDialogs(electron);
  return electron;
}

async function choose(electron: ElectronApplication, path: string): Promise<void> {
  await electron.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, path);
}

test('a change another program makes reaches the renderer within the detection budget', async () => {
  const dir = test.info().outputPath('Watched folder');
  await mkdir(dir, { recursive: true });
  const electron = await launch(test.info().outputPath('profile'));
  try {
    await choose(electron, dir);
    const page = await electron.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Fen Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Fen Notebook', { exact: true })).toBeVisible();

    await page.evaluate(async () => {
      const api = window.caotangDesktop?.folders;
      if (!api) throw new Error('Native folder bridge missing');
      const folders = await api.recentFolders();
      if (!folders.ok || !folders.value[0]) throw new Error('No recent project folder');
      const watched = await api.watch(folders.value[0].id);
      if (!watched.ok) throw new Error(`The folder could not be watched: ${watched.error}`);
      window.folderChange = new Promise<Received>((resolve) => {
        api.onChanged((change) => resolve({ paths: change.paths, at: Date.now() }));
      });
    });

    const before = await page.evaluate(() => Date.now());
    await writeFile(join(dir, 'docs', 'written-elsewhere.md'), 'Drafted in another program.');
    const received = await page.evaluate(() => window.folderChange);

    expect(received?.paths).toContain('docs/written-elsewhere.md');
    expect(received!.at - before).toBeLessThan(BUDGET_MS);
  } finally {
    await closeShell(electron);
  }
});

test('the temp file of an artifact write never arrives as a change', async () => {
  const dir = test.info().outputPath('Quiet folder');
  await mkdir(dir, { recursive: true });
  const electron = await launch(test.info().outputPath('profile'));
  try {
    await choose(electron, dir);
    const page = await electron.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Lark Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Lark Notebook', { exact: true })).toBeVisible();
    const paths = await page.evaluate(async (settleMs) => {
      const api = window.caotangDesktop?.folders;
      if (!api) throw new Error('Native folder bridge missing');
      const folders = await api.recentFolders();
      if (!folders.ok || !folders.value[0]) throw new Error('No recent project folder');
      const id = folders.value[0].id;
      const watched = await api.watch(id);
      if (!watched.ok) throw new Error(`The folder could not be watched: ${watched.error}`);
      const seen: string[] = [];
      // The listener stays open through the burst after the target arrives: a temp path that lands in a later batch is exactly
      // what this test is about, so stopping at the first batch would prove less than it claims.
      const done = new Promise<void>((resolve) => {
        let settling = false;
        const stop = api.onChanged((change) => {
          seen.push(...change.paths);
          if (!settling && seen.some((path) => path === 'docs/written-here.md')) {
            settling = true;
            setTimeout(() => {
              stop();
              resolve();
            }, settleMs);
          }
        });
      });
      await api.write(id, 'docs/written-here.md', new TextEncoder().encode('Saved by Caotang.'));
      await done;
      return seen;
    }, SETTLE_MS);
    expect(paths).toContain('docs/written-here.md');
    expect(paths.filter((path) => path.endsWith('.tmp'))).toEqual([]);
  } finally {
    await closeShell(electron);
  }
});

test('an external edit is offered, and the writer reopening loads the folder’s version', async () => {
  const dir = test.info().outputPath('Offered folder');
  await mkdir(dir, { recursive: true });
  const electron = await launch(test.info().outputPath('profile'));
  try {
    await choose(electron, dir);
    const page = await electron.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Wren Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Wren Notebook', { exact: true })).toBeVisible();

    // The app starts its watch without waiting for it, so the test waits for the subscription the main process hands out
    // before it writes: an edit made before the watcher exists is an edit nothing reports (pawcommit F5).
    await page.evaluate(async () => {
      const api = window.caotangDesktop?.folders;
      if (!api) throw new Error('Native folder bridge missing');
      const folders = await api.recentFolders();
      if (!folders.ok || !folders.value[0]) throw new Error('No recent project folder');
      const watched = await api.watch(folders.value[0].id);
      if (!watched.ok) throw new Error(`The folder could not be watched: ${watched.error}`);
    });

    const manifest = join(dir, 'caotang.json');
    const onDisk = await readFile(manifest, 'utf8');
    await writeFile(manifest, onDisk.replace('Wren Notebook', 'Folder Version'));

    const offer = page.getByTestId('folder-change');
    await expect(offer).toBeVisible();
    await expect(offer).toContainText('changed outside Caotang');
    await expect(offer).toContainText('caotang.json');
    await offer.getByRole('button', { name: 'Reopen the folder’s version', exact: true }).click();
    await expect(page.getByText('Folder Version', { exact: true })).toBeVisible();
  } finally {
    await closeShell(electron);
  }
});

test('a watch released after a later one arrived leaves the later watch running', async () => {
  const dir = test.info().outputPath('Shared folder');
  await mkdir(dir, { recursive: true });
  const electron = await launch(test.info().outputPath('profile'));
  try {
    await choose(electron, dir);
    const page = await electron.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Kestrel Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Kestrel Notebook', { exact: true })).toBeVisible();

    // A reload is two holds in a row: the first is released after the second has already asked for its own subscription. Both get
    // their own id, so the release of the first takes nothing with it (pawcommit F1).
    const ids = await page.evaluate(async () => {
      const api = window.caotangDesktop?.folders;
      if (!api) throw new Error('Native folder bridge missing');
      const folders = await api.recentFolders();
      if (!folders.ok || !folders.value[0]) throw new Error('No recent project folder');
      const first = await api.watch(folders.value[0].id);
      const second = await api.watch(folders.value[0].id);
      if (!first.ok || !second.ok) throw new Error('The folder could not be watched');
      const watching = new Promise<string>((resolve) => {
        api.onChanged((change) => resolve(change.paths.join(',')));
      });
      await api.unwatch(first.value);
      window.folderChange = new Promise<Received>((resolve) => {
        void watching.then((paths) => resolve({ paths: paths.split(','), at: Date.now() }));
      });
      return [first.value, second.value];
    });
    expect(ids[0]).not.toBe(ids[1]);

    await writeFile(join(dir, 'docs', 'still-watched.md'), 'Written after the release.');
    const received = await page.evaluate(() => window.folderChange);
    expect(received?.paths).toContain('docs/still-watched.md');
  } finally {
    await closeShell(electron);
  }
});
