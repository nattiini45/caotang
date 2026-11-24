import type { NativeFolder } from './folder-contract.cjs';

/**
 * What the native menu, a `caotang://` link or the operating system can ask the studio to do (desktop.md §Native menus,
 * §Deep links and folder handoff). The shell decides what it is allowed to hand over; the page decides what the words are and
 * what the action does, so no sentence and no path crosses this boundary.
 */
export type NativeCommand =
  /** The projects list is showing: put the cursor in the new project's name. */
  | { readonly kind: 'new-project' }
  /** The projects list is showing: the studio's own folder picker, then that folder. */
  | { readonly kind: 'open-folder' }
  | { readonly kind: 'compile' }
  | { readonly kind: 'export-bundle' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'focus-mode' }
  /** A folder the shell has already granted, from a link or from the operating system. */
  | { readonly kind: 'open-project'; readonly folder: NativeFolder }
  /**
   * Something outside asked for a project this build will not open. The shell names what it refused and never why in its own
   * words: the page holds the sentence (i18n.md).
   */
  | { readonly kind: 'refused'; readonly reason: NativeRefusal };

/** The reasons a link or an operating-system folder is refused. Each is a sentence in the page's catalogue. */
export type NativeRefusal =
  /** A `caotang://` address that is not `caotang://project/<id>`. */
  | 'link-route'
  /** `caotang://project/<id>` naming a folder this profile does not have. */
  | 'link-unknown'
  /** A folder the operating system handed over that holds no `caotang.json`. */
  | 'folder-not-a-project'
  /** A folder the operating system handed over that cannot be read or is not a folder. */
  | 'folder-unreadable';

/** The window's own state, as the studio reads it: closed to the tray still counts as running for scheduled tasks. */
export type NativeWindowState = 'visible' | 'hidden-to-tray';

/** What the studio publishes so the shell can draw its menu and its tray in the writer's language. */
export interface NativeLabels {
  readonly file: string;
  readonly edit: string;
  readonly view: string;
  readonly window: string;
  readonly help: string;
  readonly newProject: string;
  readonly openFolder: string;
  readonly compile: string;
  readonly exportBundle: string;
  readonly undo: string;
  readonly settings: string;
  readonly focusMode: string;
  readonly fullScreen: string;
  readonly minimize: string;
  readonly closeWindow: string;
  readonly quit: string;
  readonly about: string;
  readonly trayOpen: string;
  readonly trayQuit: string;
}

/** The shell's state the page keeps current: the words on the menu and the tray, and the tray's one line about the studio. */
export interface NativeShellState {
  readonly labels: NativeLabels;
  /** What the tray's status line says: the project open and whether task runs carry on. Written by the page. */
  readonly status: string;
  /** Whether a project is open, so the menu offers the project's own actions only then. */
  readonly project: boolean;
}

export type SaveReply =
  | { readonly ok: true; readonly value: { readonly saved: boolean } }
  | { readonly ok: false; readonly error: 'invalid' | 'unavailable' };

/** A file the studio asks the operating system to save: the bytes exactly as the exporter made them, and the name to offer. */
export interface SaveRequest {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface NativeOsBridge {
  /** The zone the operating system reports, read-only (goals-progress A3). */
  timeZone(): Promise<string>;
  /** The native Save dialog, then one atomic write. `saved: false` means the writer cancelled and nothing was written. */
  saveFile(request: SaveRequest): Promise<SaveReply>;
  /** The commands that arrived before this page was listening, oldest first. Each is delivered once. */
  takeCommands(): Promise<readonly NativeCommand[]>;
  onCommand(listener: (command: NativeCommand) => void): () => void;
  publish(state: NativeShellState): Promise<void>;
  windowState(): Promise<NativeWindowState>;
  onWindowState(listener: (state: NativeWindowState) => void): () => void;
}
