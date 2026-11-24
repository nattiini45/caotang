/* lingui-set comment="The desktop app's native menu and tray. {project} is the open project's own name." */
/**
 * What only the desktop shell can do, from the page's side (desktop.md §Native menus, §Deep links and folder handoff,
 * §The system timezone, §The tray and scheduled task runs).
 *
 * Defensive by construction: on the web build there is no bridge, so every call here is a no-op or `undefined` and the studio is
 * exactly the browser studio. The shell's words come from here too — the page owns the catalogue (i18n.md), so the native menu and
 * the tray are translated like everything else, and the shell itself never writes a sentence.
 */
import { t } from '@lingui/core/macro';

import type { NativeCommand, NativeLabels, NativeOsBridge, NativeRefusal, NativeShellState, NativeWindowState } from '../../../desktop-shell/src/os-contract.cjs';

/** The `os` namespace, or `undefined` on the web build and in any shell older than version 3. */
export function osBridge(): NativeOsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = window.caotangDesktop;
  return bridge !== undefined && bridge.version >= 3 ? bridge.os : undefined;
}

/** The commands the shell has sent since this page started: a native menu item, a link, or a folder the system handed over. */
export function onNativeCommand(listener: (command: NativeCommand) => void): () => void {
  const bridge = osBridge();
  return bridge === undefined ? () => undefined : bridge.onCommand(listener);
}

/** The commands that arrived before this page was listening, once: what a link that launched the app waits as. */
export async function takeNativeCommands(): Promise<readonly NativeCommand[]> {
  const bridge = osBridge();
  if (bridge === undefined) return [];
  const waiting = await bridge.takeCommands().catch(() => []);
  return Array.isArray(waiting) ? waiting : [];
}

/**
 * Whether the studio's own timers are still the studio's (desktop.md §The tray and scheduled task runs). A hidden tab is a tab
 * nobody is looking at; a window closed to the tray is a window whose timers still fire, because the shell does not throttle it,
 * so the recurring tasks may carry on there. Pure, so the rule is one line to read and one line to test.
 */
export function ticksCount(state: { readonly documentHidden: boolean; readonly hiddenToTray: boolean }): boolean {
  return !state.documentHidden || state.hiddenToTray;
}

let trayHidden = false;
const windowListeners = new Set<() => void>();
let watching = false;

function announceWindow(state: NativeWindowState): void {
  const hidden = state === 'hidden-to-tray';
  if (hidden === trayHidden) return;
  trayHidden = hidden;
  for (const listener of [...windowListeners]) listener();
}

/** Subscribes to the shell's window state once, wherever the studio first needs it. Idempotent. */
export function watchNativeWindow(): void {
  if (watching) return;
  const bridge = osBridge();
  if (bridge === undefined) return;
  watching = true;
  void bridge.windowState().then(announceWindow, () => undefined);
  bridge.onWindowState(announceWindow);
}

/** Whether the window is closed to the tray right now. `false` on the web build, where nothing hides it. */
export function nativeTrayHidden(): boolean {
  return trayHidden;
}

export function subscribeNativeWindow(listener: () => void): () => void {
  windowListeners.add(listener);
  return () => {
    windowListeners.delete(listener);
  };
}

/** Whether scheduled task runs may go on: the page's own visibility, or the tray holding the window. */
export function studioTicks(taskWindow: { readonly documentHidden?: boolean } = {}): boolean {
  const hidden = taskWindow.documentHidden ?? (typeof document !== 'undefined' && document.visibilityState === 'hidden');
  return ticksCount({ documentHidden: hidden, hiddenToTray: trayHidden });
}

/** The zone the operating system reports, read once at start-up; `undefined` on the web build. */
let osZone: string | undefined;

export async function readNativeTimeZone(): Promise<void> {
  const bridge = osBridge();
  if (bridge === undefined) return;
  const zone = await bridge.timeZone().catch(() => undefined);
  osZone = typeof zone === 'string' && zone !== '' ? zone : undefined;
}

/** The operating system's zone when the shell reported one, for "today" (goals-progress A3). */
export function deviceTimeZone(): string | undefined {
  return osZone;
}

/**
 * The label the shell puts on its own menu and tray. Each is a catalogue message: the native menu is the writer's interface too.
 */
export function nativeLabels(): NativeLabels {
  return {
    file: t`File`,
    edit: t`Edit`,
    view: t`View`,
    window: t`Window`,
    help: t`Help`,
    newProject: t`New project…`,
    openFolder: t`Open folder…`,
    compile: t`Compile…`,
    exportBundle: t`Export bundle…`,
    undo: t`Undo`,
    settings: t`Settings…`,
    focusMode: t`Focus mode`,
    fullScreen: t`Toggle full screen`,
    minimize: t`Minimize`,
    closeWindow: t`Close window`,
    quit: t`Quit Caotang`,
    about: t`About Caotang`,
    trayOpen: t`Open Caotang`,
    trayQuit: t`Quit Caotang`,
  };
}

/** A sentence for something outside the studio asked for and did not get. */
export function nativeRefusalSentence(reason: NativeRefusal): string {
  switch (reason) {
    case 'link-route':
      return t`That link is not a Caotang project link, so nothing was opened. A Caotang link names a project you have opened before.`;
    case 'link-unknown':
      return t`That link names a project this copy of Caotang does not have. Open the folder once, and the link will work.`;
    case 'folder-not-a-project':
      return t`That folder does not hold a Caotang project, so nothing was opened.`;
    case 'folder-unreadable':
      return t`Caotang could not read that folder, so nothing was opened. Check that the folder still exists and that you can open it.`;
  }
}

/**
 * The tray's one line of fact about the studio (desktop.md §The tray and scheduled task runs): whether a project is open, and
 * whether its scheduled task runs are carrying on where the window is. It says what is happening, never what might.
 */
export function nativeTrayStatus(facts: { readonly project: string | null; readonly hiddenToTray: boolean }): string {
  if (facts.project === null) return t`No project is open, so scheduled tasks are paused.`;
  return facts.hiddenToTray
    ? t`${{ project: facts.project }} is open. Scheduled tasks keep running while Caotang is in the tray.`
    : t`${{ project: facts.project }} is open. Scheduled tasks run while this window is open.`;
}

/** What the shell needs from the page: the words, the tray's line, and whether a project is open. */
export function nativeShellState(facts: { readonly project: string | null }): NativeShellState {
  return {
    labels: nativeLabels(),
    status: nativeTrayStatus({ project: facts.project, hiddenToTray: trayHidden }),
    project: facts.project !== null,
  };
}

/** Publishes that state, and says nothing when it cannot: a shell that fails to hear it still works, with the menu it had. */
export function publishNativeState(facts: { readonly project: string | null }): void {
  const bridge = osBridge();
  if (bridge === undefined) return;
  void bridge.publish(nativeShellState(facts)).catch(() => undefined);
}
