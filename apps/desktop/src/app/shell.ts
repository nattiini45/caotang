/**
 * The interface shell (ui-modules.md §5.1, modern-interface.md): **Classic**, the layout Caotang has always had, or **Modern**.
 * The theme (theme.ts) chooses light or dark inside either one; the shell chooses which set of semantic tokens and, later, which
 * layout is on. It is put on the page as `data-shell` on `<html>`.
 *
 * Like the theme, the choice lives in this browser's local storage under one key, read before the first paint, and every access
 * is guarded. Modern's stylesheet is a chunk of its own (`modern/modern.css`), loaded only when Modern is on, so Classic's first
 * load does not grow.
 *
 * The default, when nothing is stored, is Modern for a new writer and Classic for one who has used Caotang before, so a returning
 * writer's interface never changes under them. Whether a writer is returning is not all known before the first paint: local
 * storage says so at once when an earlier visit left a key in it (a theme, a pending journal, unsent words), and otherwise the
 * page paints Classic and the app settles it once the stores have opened ({@link settleShell}): a settings record or a project
 * kept from before means returning. The settled default is stored, so making a first project does not switch a new writer back.
 */

export type Shell = 'classic' | 'modern';

export const SHELL_KEY = 'caotang.shell';

/** Every key Caotang keeps in local storage starts with this. */
const KEY_PREFIX = 'caotang.';

/** What the default rests on. `returning` is `null` while it is not known yet. */
export interface ShellSignals {
  /** The writer's stored choice, or `null` when there is none. */
  readonly stored: Shell | null;
  /** Whether this browser holds anything from an earlier visit: a key in local storage, the app's settings record, or a project. */
  readonly returning: boolean | null;
}

/** The shell to show: the stored choice, else Modern for a new writer and Classic for a returning one; `null` until that is known. */
export function shellFor({ stored, returning }: ShellSignals): Shell | null {
  if (stored !== null) return stored;
  if (returning === null) return null;
  return returning ? 'classic' : 'modern';
}

/** The part of `Storage` the rule reads. */
export type KeyList = Pick<Storage, 'length' | 'key'>;

/** Whether local storage holds a Caotang key other than the shell's own, which only an earlier visit can have left. */
export function keptFromEarlierVisit(storage: KeyList | null): boolean {
  if (storage === null) return false;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key !== SHELL_KEY && key.startsWith(KEY_PREFIX)) return true;
    }
  } catch {
    // An unreadable store says nothing; the stores the app opens next decide.
  }
  return false;
}

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The writer's stored choice, or `null` when there is none, or the store cannot be read. */
export function storedShell(): Shell | null {
  try {
    const value = local()?.getItem(SHELL_KEY);
    return value === 'classic' || value === 'modern' ? value : null;
  } catch {
    return null;
  }
}

/** Remember a shell for the next visit. A failed store only loses the memory. */
export function rememberShell(shell: Shell): void {
  try {
    local()?.setItem(SHELL_KEY, shell);
  } catch {
    // Not kept: the next visit decides again.
  }
}

/** The shell on the page now. */
export function activeShell(): Shell {
  return document.documentElement.dataset['shell'] === 'modern' ? 'modern' : 'classic';
}

/** Puts a shell on the page. The promise settles once Modern's stylesheet is in (at once for Classic). */
export function applyShell(shell: Shell): Promise<unknown> {
  document.documentElement.dataset['shell'] = shell;
  return shell === 'modern' ? import('../modern/modern.css') : Promise.resolve();
}

let undecided = false;

/** Whether the page is still on the provisional Classic, waiting for {@link settleShell}. */
export function shellUndecided(): boolean {
  return undecided;
}

/** Applied once, before the first render (main.tsx waits for it, so a Modern page paints with its stylesheet in). */
export function initShell(): Promise<unknown> {
  const stored = storedShell();
  const shell = shellFor({ stored, returning: keptFromEarlierVisit(local()) || null });
  undecided = shell === null;
  if (shell !== null && stored === null) rememberShell(shell);
  return applyShell(shell ?? 'classic');
}

/** Settles a provisional default once the stores have said whether this writer is returning. Does nothing once decided. */
export function settleShell(returning: boolean): Promise<unknown> {
  if (!undecided) return Promise.resolve();
  undecided = false;
  const shell: Shell = returning ? 'classic' : 'modern';
  rememberShell(shell);
  return applyShell(shell);
}
