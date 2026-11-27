import type { MenuItemConstructorOptions } from 'electron';

import type { NativeLabels } from './os-contract.cjs';

/**
 * The native menu, as a plain template (desktop.md §Native menus). Pure: it reads the platform, the page's labels and whether a
 * project is open, and it decides nothing else. The main process builds it into a `Menu` and hangs one click on each item whose
 * id is `command:<id>`; a spec can read the same template without a window.
 *
 * ## No menu item is given a shortcut the page owns
 *
 * The page's keymap is the one authority for its chords (keymap.ts), and a registered menu accelerator is delivered **before**
 * the page: a writer pressing Ctrl+Z inside a field would lose the field's own undo to the app-wide one. So a chord the page
 * handles is never registered. On Windows and Linux the chord is still *shown* beside the item, because Electron can display an
 * accelerator it does not register (`registerAccelerator: false`); on macOS a key equivalent cannot be displayed without being
 * registered, so those items carry no chord there and the toolbar's hint stays the place the chord is named.
 *
 * A menu item is given a registered accelerator only for a chord the page does not claim at all: Ctrl+O for a folder, Ctrl+, for
 * Settings, and the window's own Ctrl+W, Ctrl+Q.
 */

/** The actions a menu item can ask for. One per `NativeCommand` the menu sends. */
export const MENU_COMMANDS = ['new-project', 'open-folder', 'compile', 'export-bundle', 'settings', 'undo', 'focus-mode'] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

/** The id a command item carries: `command:<id>`. The main process reads it back to hang the click on. */
export const COMMAND_PREFIX = 'command:';

export function commandOf(item: { readonly id?: string }): MenuCommand | null {
  const id = item.id;
  if (id === undefined || !id.startsWith(COMMAND_PREFIX)) return null;
  const command = id.slice(COMMAND_PREFIX.length);
  return (MENU_COMMANDS as readonly string[]).includes(command) ? (command as MenuCommand) : null;
}

export interface MenuFacts {
  readonly platform: NodeJS.Platform;
  readonly labels: NativeLabels;
  /** The application's own name, for the macOS application menu, which is titled with it. */
  readonly appName: string;
  /** Whether a project is open: the project's own actions are offered only then, and the projects' only when none is. */
  readonly project: boolean;
  readonly openAccount?: () => void;
  readonly accountLabel?: string;
}

/** An item that sends a command. It has no label of its own: the page's label is put on it, so the words are the page's. */
function command(id: MenuCommand, label: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions {
  return { id: `${COMMAND_PREFIX}${id}`, label, ...extra };
}

/**
 * A chord the page owns, displayed but not registered. On macOS neither is possible, so the item carries nothing: `undefined`
 * keys are dropped by Electron, and the object is kept free of them here so a template read in a spec says the same thing the
 * menu does.
 */
function shownChord(platform: NodeJS.Platform, accelerator: string): Partial<MenuItemConstructorOptions> {
  return platform === 'darwin' ? {} : { accelerator, registerAccelerator: false };
}

export function menuTemplate({ platform, labels, appName, project, openAccount, accountLabel }: MenuFacts): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const file: MenuItemConstructorOptions = {
    label: labels.file,
    submenu: [
      // Not Ctrl+N: the page's Ctrl+N makes a new document, and this makes a new project (keymap.ts).
      command('new-project', labels.newProject, { enabled: !project }),
      command('open-folder', labels.openFolder, { accelerator: 'CmdOrCtrl+O', enabled: !project }),
      ...(openAccount && accountLabel ? [{ id: 'account-projects', label: accountLabel, click: openAccount }] : []),
      { type: 'separator' },
      command('compile', labels.compile, { enabled: project }),
      command('export-bundle', labels.exportBundle, { enabled: project }),
      { type: 'separator' },
      // Settings lives in the application menu on macOS, where Cmd+, belongs.
      ...(mac ? [] : [command('settings', labels.settings, { accelerator: 'CmdOrCtrl+,' })]),
      ...(mac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: labels.quit, accelerator: 'Ctrl+Q' }]),
    ],
  };
  // macOS needs an Edit menu for the clipboard's own chords; Windows and Linux take them from Chromium without one, so the only
  // app action there is Undo, which the toolbar already offers.
  const edit: MenuItemConstructorOptions[] = mac
    ? [{
        label: labels.edit,
        submenu: [
          // A command rather than the `undo` role: the page's undo is the app's, and the role would undo the web contents.
          command('undo', labels.undo, { enabled: project }),
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      }]
    : [];
  // macOS's application menu, written out rather than taken from the `appMenu` role: the role carries Electron's English items and no
  // Settings, while Cmd+, is exactly where a Mac user looks for it.
  const app: MenuItemConstructorOptions[] = mac
    ? [{
        label: appName,
        submenu: [
          { role: 'about', label: labels.about },
          { type: 'separator' },
          command('settings', labels.settings, { accelerator: 'CmdOrCtrl+,' }),
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: labels.quit },
        ],
      }]
    : [];
  return [
    ...app,
    file,
    ...edit,
    {
      label: labels.view,
      submenu: [
        command('focus-mode', labels.focusMode, shownChord(platform, 'CmdOrCtrl+Shift+F')),
        { type: 'separator' },
        { role: 'togglefullscreen', label: labels.fullScreen },
      ],
    },
    {
      label: labels.window,
      submenu: [
        { role: 'minimize', label: labels.minimize },
        { role: 'close', label: labels.closeWindow },
      ],
    },
    ...(mac ? [] : [{ label: labels.help, submenu: [{ role: 'about' as const, label: labels.about }] }]),
  ];
}
