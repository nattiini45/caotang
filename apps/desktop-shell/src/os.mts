import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron';

import type { FolderRegistry } from './folders.mjs';
import { fromStudioFrame } from './ipc-guard.mjs';
import { commandOf, menuTemplate } from './menu.mjs';
import { describeDelivery } from './links.mjs';
import type { NativeCommand, NativeShellState, NativeWindowState, SaveReply, SaveRequest } from './os-contract.cjs';
import { installTray, type TrayHandle } from './tray.mjs';

/**
 * What the operating system can ask the studio to do, and what it needs back from it (desktop.md §Native menus, §Deep links and
 * folder handoff, §Native save, §The system timezone, §The tray and scheduled task runs).
 *
 * Every call is answered only for the studio's own top frame (`ipc-guard.mts`), and every answer is the shape the bridge promises
 * whatever went wrong. The page's own words are what the menu and the tray show. A command that arrives before the page asks for
 * them waits in `queue` and is handed over on the page's first `os:commands`, so a link that launched the app lands in the same
 * place as one that arrives while it runs.
 */

/** The largest file the Save dialog is allowed to write: an export is a document, and a document is never this big. */
const SAVE_LIMIT = 256 * 1024 * 1024;

/** A name the Save dialog can start from: one path segment, no separator or control character, and not a dot name. */
const SAVE_NAME = /^[^\\/:*?"<>|\p{Cc}]{1,120}$/u;

/** The zone the operating system reports (goals-progress A3). Node reads it from the platform; `UTC` is the honest fallback. */
function systemTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The extension a suggested name ends with, for the dialog's own filter; `undefined` when there is none. */
function filterFor(name: string): { readonly name: string; readonly extensions: readonly string[] } | undefined {
  const extension = extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/u.test(extension) ? { name: extension.toUpperCase(), extensions: [extension] } : undefined;
}

/**
 * One write of the bytes the writer chose a place for: a temporary name in the same folder and a rename over the target, so the
 * file appears whole or not at all.
 *
 * Windows will not rename over an existing file, so there the file already at the target is first moved aside to its own name — the
 * dialog has already asked about replacing it — and only then replaced: if that second rename fails, the file the writer had is put
 * back where it was, so a failed save cannot cost the copy that was there before it.
 */
async function writeOnce(target: string, bytes: Uint8Array): Promise<void> {
  const stem = `${basename(target)}.${randomUUID().slice(0, 8)}`;
  const temporary = join(dirname(target), `.${stem}.tmp`);
  await writeFile(temporary, bytes);
  try {
    await rename(temporary, target);
    return;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes(String(code))) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  const replaced = join(dirname(target), `.${stem}.replaced`);
  let aside = false;
  try {
    await rename(target, replaced);
    aside = true;
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    if (aside) await rename(replaced, target).catch(() => undefined);
    throw error;
  }
  await rm(replaced, { force: true });
}

/** The Save dialog, once: the writer's choice, then one whole write. Cancelling writes nothing and is not a failure. */
async function save(event: IpcMainInvokeEvent, request: unknown): Promise<SaveReply> {
  if (request === null || typeof request !== 'object') return { ok: false, error: 'invalid' };
  const { name, bytes } = request as Partial<SaveRequest>;
  if (typeof name !== 'string' || !SAVE_NAME.test(name) || name === '.' || name === '..') return { ok: false, error: 'invalid' };
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > SAVE_LIMIT) return { ok: false, error: 'invalid' };
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null) return { ok: false, error: 'invalid' };
  const filter = filterFor(name);
  let chosen: Awaited<ReturnType<typeof dialog.showSaveDialog>>;
  try {
    chosen = await dialog.showSaveDialog(window, {
      defaultPath: join(app.getPath('documents'), name),
      ...(filter === undefined ? {} : { filters: [{ name: filter.name, extensions: [...filter.extensions] }] }),
    });
  } catch (error) {
    console.warn('Caotang could not open the Save dialog.', error);
    return { ok: false, error: 'unavailable' };
  }
  if (chosen.canceled || !chosen.filePath) return { ok: true, value: { saved: false } };
  try {
    await writeOnce(chosen.filePath, bytes);
    return { ok: true, value: { saved: true } };
  } catch (error) {
    console.warn('Caotang could not save the file the writer chose.', error);
    return { ok: false, error: 'unavailable' };
  }
}

export interface OsOptions {
  readonly entryUrl: string;
  /** The app's own paths — its executable and the directory a launcher was given — which are never a folder someone opened. */
  readonly own: readonly string[];
  readonly folders: FolderRegistry;
  /** The window commands go to, or `null` before one is open. */
  readonly window: () => BrowserWindow | null;
  /** Shows the one window, opening it if the writer closed it to the tray. */
  readonly show: () => void;
  readonly quit: () => void;
}

export interface OsIntegration {
  /** Hands over one argument the system delivered: a `caotang://` link or a folder. */
  deliver(argument: string): Promise<void>;
  /** The page's published state: the menu, the tray and what its items are enabled for. */
  publish(state: NativeShellState): void;
  /** Tells the page the window was hidden to the tray, or is in front again. */
  setWindowState(state: NativeWindowState): void;
  /** Whether the app can hide its window: a tray exists to bring it back, so closing must not end it. */
  staysInTray(): boolean;
}

export function registerOsIpc(options: OsOptions): OsIntegration {
  /** Commands that arrived before the page asked for them. */
  let queue: NativeCommand[] = [];
  /** Whether the page has asked once: from then on a command is sent rather than queued. */
  let listening = false;
  let published: NativeShellState | null = null;
  let tray: TrayHandle | null = null;
  let windowState: NativeWindowState = 'visible';

  const page = (): BrowserWindow | null => {
    const window = options.window();
    return window !== null && !window.isDestroyed() ? window : null;
  };

  const send = (command: NativeCommand): void => {
    const window = page();
    if (!listening || window === null) {
      queue.push(command);
      return;
    }
    window.webContents.send('os:command', command);
  };

  /** One click per command item, at any depth, asking the page for the action the page itself names. */
  const hang = (items: readonly MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      const command = commandOf(item);
      if (command !== null) item.click = () => send({ kind: command });
      if (Array.isArray(item.submenu)) hang(item.submenu);
    }
  };

  function handle<T>(channel: string, refusal: T, run: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>): void {
    ipcMain.handle(`os:${channel}`, async (event, ...args: unknown[]): Promise<T> => {
      if (!fromStudioFrame(event, options.entryUrl)) return refusal;
      return run(event, ...args);
    });
  }

  const publish = (state: NativeShellState): void => {
    const next: NativeShellState = { labels: state.labels, status: state.status, project: state.project === true };
    const first = published === null;
    // Rebuilt when the words change or when a project opening changes what the items can do; not for the tray's status line,
    // which would rebuild the menu under the writer's cursor.
    const redraw = first || published?.project !== next.project || JSON.stringify(published?.labels) !== JSON.stringify(next.labels);
    published = next;
    if (redraw) {
      const template = menuTemplate({ platform: process.platform, labels: next.labels, appName: app.name, project: next.project });
      hang(template);
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    }
    if (first) {
      // The tray is made on the page's first publish, because its words are the page's: until then closing the window ends the
      // app, as it did before there was a tray.
      tray = installTray({ open: options.show, quit: options.quit });
    }
    tray?.update({ labels: next.labels, status: next.status });
  };

  handle('timezone', systemTimeZone(), () => systemTimeZone());
  handle<readonly NativeCommand[]>('commands', [], () => {
    listening = true;
    const waiting = queue;
    queue = [];
    return waiting;
  });
  handle('window-state', windowState, () => windowState);
  handle<undefined>('publish', undefined, (_event, state) => {
    publish(state as NativeShellState);
    return undefined;
  });
  handle<SaveReply>('save', { ok: false, error: 'invalid' }, (event, request) => save(event, request));

  return {
    async deliver(argument: string): Promise<void> {
      const delivery = describeDelivery(argument, options.own);
      if (delivery === null) return;
      if (delivery.kind === 'link') {
        if (delivery.decision.kind === 'refused') {
          send({ kind: 'refused', reason: 'link-route' });
          return;
        }
        const folder = options.folders.find(delivery.decision.id);
        send(folder === null ? { kind: 'refused', reason: 'link-unknown' } : { kind: 'open-project', folder });
        return;
      }
      const granted = await options.folders.grantPath(delivery.path);
      send(granted.ok
        ? { kind: 'open-project', folder: granted.value }
        : { kind: 'refused', reason: granted.error === 'not-a-project' ? 'folder-not-a-project' : 'folder-unreadable' });
    },
    publish,
    setWindowState(state: NativeWindowState): void {
      windowState = state;
      page()?.webContents.send('os:window-state', state);
    },
    staysInTray: () => tray !== null,
  };
}
