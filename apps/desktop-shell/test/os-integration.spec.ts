import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

import type {} from '../src/folder-contract.cjs';

import { dismissDialogs } from './dialogs.js';
import { closeShell } from './teardown.js';

/**
 * The operating system's side of the shell: the native menu, `caotang://` links and the folder a file manager hands over, the Save
 * dialog, and the tray that keeps the studio running with its window closed (docs/architecture/desktop.md §Native menus, §Deep links
 * and folder handoff, §Native save, §The tray and scheduled task runs).
 *
 * The native dialogs are answered by the spec, the way `folder-storage.spec.ts` answers the folder picker: everything else is the
 * shell's own code, the page's own code, and a file on disk.
 */

const executablePath = createRequire(import.meta.url)('electron') as string;
const shell = fileURLToPath(new URL('..', import.meta.url));

async function launch(profile: string, extra: readonly string[] = []): Promise<ElectronApplication> {
  await mkdir(profile, { recursive: true });
  const electron = await _electron.launch({
    executablePath,
    args: [shell, `--user-data-dir=${profile}`, ...extra],
    chromiumSandbox: true,
  });
  dismissDialogs(electron);
  return electron;
}

async function choose(electron: ElectronApplication, path: string): Promise<void> {
  await electron.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, path);
}

/** The application menu as the writer sees it: one row per item, by id. */
async function menuItems(electron: ElectronApplication) {
  return electron.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const rows: { id: string; label: string; enabled: boolean; accelerator: string | null; registered: boolean | null; type: string }[] = [];
    const walk = (items: readonly Electron.MenuItem[]): void => {
      for (const item of items) {
        rows.push({
          id: item.id,
          label: item.label,
          enabled: item.enabled,
          accelerator: item.accelerator === undefined || item.accelerator === null ? null : String(item.accelerator),
          registered: typeof item.registerAccelerator === 'boolean' ? item.registerAccelerator : null,
          type: item.type,
        });
        if (Array.isArray(item.submenu?.items)) walk(item.submenu.items);
      }
    };
    if (menu !== null) walk(menu.items);
    return rows;
  });
}

test('the native menu is the page\'s words, and its items do what the page does', async () => {
  const profile = test.info().outputPath('profile');
  const folder = test.info().outputPath('Harbor folder');
  await mkdir(folder, { recursive: true });
  const electron = await launch(profile);
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    // The page published the words, so the menu is there and it is the page's language.
    await expect.poll(async () => (await menuItems(electron)).length).toBeGreaterThan(4);
    const projects = await menuItems(electron);
    expect(projects.find((item) => item.id === 'command:new-project')).toMatchObject({ label: 'New project…', enabled: true, accelerator: null });
    expect(projects.find((item) => item.id === 'command:open-folder')).toMatchObject({ label: 'Open folder…', enabled: true, accelerator: 'CmdOrCtrl+O' });
    expect(projects.find((item) => item.id === 'command:compile')).toMatchObject({ label: 'Compile…', enabled: false });
    expect(projects.find((item) => item.id === 'command:export-bundle')).toMatchObject({ enabled: false });
    // A chord the page owns is shown and never registered, so a text field keeps its own undo and the keymap stays the page's.
    const focus = projects.find((item) => item.id === 'command:focus-mode');
    expect(focus?.label).toBe('Focus mode');
    if (process.platform === 'darwin') expect(focus?.accelerator).toBeNull();
    else expect(focus).toMatchObject({ accelerator: 'CmdOrCtrl+Shift+F', registered: false });

    // Choosing New project puts the cursor where the writer would type it.
    await electron.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('command:new-project')?.click());
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeFocused();

    // With a project open, the project's own actions are the ones enabled, and choosing Compile opens the export dialog the
    // toolbar opens.
    await choose(electron, folder);
    await page.getByRole('textbox', { name: 'Project name' }).fill('Harbor Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Harbor Notebook', { exact: true })).toBeVisible();
    await expect.poll(async () => (await menuItems(electron)).find((item) => item.id === 'command:compile')?.enabled).toBe(true);
    const open = await menuItems(electron);
    expect(open.find((item) => item.id === 'command:new-project')).toMatchObject({ enabled: false });
    expect(open.find((item) => item.id === 'command:compile')).toMatchObject({ label: 'Compile…', enabled: true });
    await electron.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('command:compile')?.click());
    await expect(page.getByRole('dialog', { name: 'Export', exact: true })).toBeVisible();
  } finally {
    await closeShell(electron);
  }
});

test('a caotang:// link opens the project folder it names, and one that names nothing opens nothing', async () => {
  const profile = test.info().outputPath('profile');
  const folder = test.info().outputPath('Wren folder');
  await mkdir(folder, { recursive: true });
  const first = await launch(profile);
  let id: string;
  try {
    await choose(first, folder);
    const page = await first.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Wren Ledger');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Wren Ledger', { exact: true })).toBeVisible();
    id = await page.evaluate(async () => {
      const api = window.caotangDesktop?.folders;
      const folders = await api?.recentFolders();
      if (!folders?.ok || folders.value[0] === undefined) throw new Error('No recent project folder');
      return folders.value[0].id;
    });
  } finally {
    await closeShell(first);
  }

  const linked = await launch(profile, [`caotang://project/${id}`]);
  try {
    const page = await linked.firstWindow();
    await expect(page.getByText('Wren Ledger', { exact: true })).toBeVisible();
  } finally {
    await closeShell(linked);
  }

  const unknown = await launch(profile, ['caotang://project/00000000-0000-4000-8000-000000000000']);
  try {
    const page = await unknown.firstWindow();
    await expect(page.getByRole('status').filter({ hasText: 'That link names a project this copy of Caotang does not have.' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
  } finally {
    await closeShell(unknown);
  }

  const nonsense = await launch(profile, ['caotang://print/the-harbor']);
  try {
    const page = await nonsense.firstWindow();
    await expect(page.getByRole('status').filter({ hasText: 'not a Caotang project link' })).toBeVisible();
  } finally {
    await closeShell(nonsense);
  }
});

test('the folder a file manager hands over opens, and a folder that is not a project does not', async () => {
  const profile = test.info().outputPath('profile');
  const folder = test.info().outputPath('Ash folder');
  await mkdir(folder, { recursive: true });
  const first = await launch(profile);
  try {
    await choose(first, folder);
    const page = await first.firstWindow();
    await page.getByRole('textbox', { name: 'Project name' }).fill('Ash Notebook');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByText('Ash Notebook', { exact: true })).toBeVisible();
  } finally {
    await closeShell(first);
  }

  const handed = await launch(profile, [folder]);
  try {
    const page = await handed.firstWindow();
    await expect(page.getByText('Ash Notebook', { exact: true })).toBeVisible();
  } finally {
    await closeShell(handed);
  }

  const empty = test.info().outputPath('Empty folder');
  await mkdir(empty, { recursive: true });
  const refused = await launch(profile, [empty]);
  try {
    const page = await refused.firstWindow();
    await expect(page.getByRole('status').filter({ hasText: 'That folder does not hold a Caotang project' })).toBeVisible();
  } finally {
    await closeShell(refused);
  }
});

test('the Save dialog writes the bytes once, and cancelling writes nothing', async () => {
  const profile = test.info().outputPath('profile');
  const target = test.info().outputPath('Harbor.md');
  const electron = await launch(profile);
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    await electron.evaluate(({ dialog }, chosen) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: chosen });
    }, target);
    const written = await page.evaluate(async () => {
      const os = window.caotangDesktop?.os;
      if (!os) throw new Error('Native OS bridge missing');
      return os.saveFile({ name: 'Harbor.md', bytes: new TextEncoder().encode('# Harbor\n\nThe tide turned.\n') });
    });
    expect(written).toEqual({ ok: true, value: { saved: true } });
    expect(await readFile(target, 'utf8')).toBe('# Harbor\n\nThe tide turned.\n');
    // One whole write: the temporary name the handler writes through is not left behind.
    const leftovers = (await readdir(test.info().outputPath())).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);

    await electron.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
    });
    const cancelled = await page.evaluate(async () => {
      const os = window.caotangDesktop?.os;
      if (!os) throw new Error('Native OS bridge missing');
      return os.saveFile({ name: 'Cancelled.md', bytes: new TextEncoder().encode('never written') });
    });
    expect(cancelled).toEqual({ ok: true, value: { saved: false } });
    expect(await stat(test.info().outputPath('Cancelled.md')).then(() => true, () => false)).toBe(false);

    // A name that is a path is refused before any dialog opens.
    const refused = await page.evaluate(async () => {
      const os = window.caotangDesktop?.os;
      if (!os) throw new Error('Native OS bridge missing');
      return os.saveFile({ name: '../escape.md', bytes: new Uint8Array([1]) });
    });
    expect(refused).toEqual({ ok: false, error: 'invalid' });
  } finally {
    await closeShell(electron);
  }
});

test('closing the window quits after the studio is ready, unless the writer opts into the system tray', async () => {
  const electron = await launch(test.info().outputPath('profile'));
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    await expect.poll(async () => menuItems(electron).then((items) => items.length)).toBeGreaterThan(4);
    const process = electron.process();
    const closed = electron.waitForEvent('close');
    void electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
    await closed;
    expect(process.exitCode).toBe(0);
  } finally {
    await closeShell(electron);
  }
});

test('an opt-in tray shows a notice only on the first hide and keeps the renderer running', async () => {
  const profile = test.info().outputPath('profile');
  const electron = await launch(profile);
  try {
    const page = await electron.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Project name' })).toBeVisible();
    await electron.evaluate(({ dialog }) => {
      const notices: string[] = [];
      dialog.showMessageBoxSync = (_window, options?: Electron.MessageBoxSyncOptions) => {
        if (options !== undefined) notices.push(options.message);
        return 0;
      };
      Reflect.set(process, 'caotangTrayNotices', notices);
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByTestId('settings');
    await settings.locator('[data-section="appearance"]').click();
    const preference = settings.getByRole('checkbox', { name: /keep Caotang in the system tray/i });
    await expect(preference).not.toBeChecked();
    await preference.click();
    await expect(preference).toBeChecked();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const survived = await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window === undefined ? null : {
        visible: window.isVisible(),
        destroyed: window.isDestroyed(),
        count: BrowserWindow.getAllWindows().length,
        throttled: window.webContents.getBackgroundThrottling(),
      };
    });
    // Hidden, not gone: the renderer is still there for the timers a scheduled task runs on, and it is not throttled.
    expect(survived).toEqual({ visible: false, destroyed: false, count: 1, throttled: false });
    // The renderer is still live and answering, which is what a scheduled run needs; it reports itself visible or hidden depending on
    // the platform's occlusion tracking, and either way the page's own rule (`ticksCount`) lets a tray-held window carry on.
    expect(['visible', 'hidden']).toContain(await page.evaluate(() => document.visibilityState));
    expect(await page.evaluate(() => 2 + 2)).toBe(4);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await expect.poll(async () => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    expect(await electron.evaluate(() => Reflect.get(process, 'caotangTrayNotices'))).toEqual([
      'Caotang is still running in the system tray. Use Open Caotang to bring it back, or Quit Caotang to stop it.',
    ]);
    expect(JSON.parse(await readFile(join(profile, 'window.json'), 'utf8'))).toMatchObject({ trayNoticeSeen: true });
  } finally {
    await closeShell(electron);
  }
});
