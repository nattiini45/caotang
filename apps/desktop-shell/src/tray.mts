import { Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import type { NativeLabels } from './os-contract.cjs';
import { TRAY_ICON_PNG } from './tray-icon.mjs';

/**
 * The tray (desktop.md §The tray and scheduled task runs). It does one honest thing: closing the window leaves the studio
 * running, and the tray is how the writer gets it back or ends it. It shows whether scheduled task runs are carrying on, in the
 * page's own sentence, and it says that quitting is what stops them — so a tray never claims work that is not happening.
 *
 * The menu is rebuilt whenever the page publishes a new state, and only when its words change: a status line that updated every
 * keystroke would recreate the menu under the writer's cursor.
 */
export interface TrayFacts {
  readonly labels: Pick<NativeLabels, 'trayOpen' | 'trayQuit'>;
  /** The page's sentence about scheduled task runs, already translated. */
  readonly status: string;
}

export function trayTemplate({ labels, status }: TrayFacts): MenuItemConstructorOptions[] {
  return [
    { id: 'tray:open', label: labels.trayOpen },
    { type: 'separator' },
    // Disabled, so it reads as the tray's one line of fact rather than something to click.
    { id: 'tray:status', label: status, enabled: false },
    { type: 'separator' },
    { id: 'tray:quit', label: labels.trayQuit },
  ];
}

export interface TrayActions {
  open(): void;
  quit(): void;
}

export interface TrayHandle {
  /** Applies a new state, rebuilding the menu only when its words changed. */
  update(facts: TrayFacts): void;
  destroy(): void;
}

/**
 * Puts the tray in the system's hands. A tray that cannot be made (a headless session, a desktop with no tray) returns `null`,
 * and the shell then lets its window close instead of hiding into nothing.
 */
export function installTray(actions: TrayActions): TrayHandle | null {
  let tray: Tray;
  try {
    const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64'));
    if (image.isEmpty()) throw new Error('The tray glyph did not decode.');
    if (process.platform === 'darwin') image.setTemplateImage(true);
    tray = new Tray(image);
  } catch (error) {
    console.warn('Caotang could not put its icon in the tray, so closing the window quits it.', error);
    return null;
  }
  let shown: TrayFacts | null = null;
  const apply = (facts: TrayFacts): void => {
    if (shown !== null && shown.status === facts.status && shown.labels.trayOpen === facts.labels.trayOpen
      && shown.labels.trayQuit === facts.labels.trayQuit) return;
    shown = facts;
    tray.setToolTip(facts.labels.trayOpen);
    const template = trayTemplate(facts);
    for (const item of template) {
      if (item.id === 'tray:open') item.click = actions.open;
      if (item.id === 'tray:quit') item.click = actions.quit;
    }
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };
  // A left click brings the window back where the platform reports one; the menu's own first item does it everywhere.
  tray.on('click', actions.open);
  return {
    update: apply,
    destroy: () => {
      tray.destroy();
    },
  };
}
