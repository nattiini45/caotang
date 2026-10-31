/**
 * The interface (modern-interface.md §2, §3; ui-modules.md §5.1): **Classic**, the interface Caotang has had so far, or **Modern**.
 * The theme (theme.ts) chooses light or dark inside either one. The choice is put on the page as `data-shell` on `<html>`.
 *
 * Like the theme, it lives in this browser's local storage under one key (`caotang.interface`), read before the first render,
 * and every access is guarded (§3.1). Modern's stylesheet is a chunk of its own (`modern/modern.css`), loaded only while Modern is
 * on, so Classic's first load never carries it (§12).
 *
 * The default is {@link resolveInterface} (§3.2). Local storage answers before the first paint when it holds a choice or another
 * Caotang key; otherwise the page waits behind "Opening your projects…" until the stores have opened and {@link settleInterface}
 * answers. Either answer is stored at once, so it never flips on a later visit.
 */

export type Interface = 'classic' | 'modern';

export const INTERFACE_KEY = 'caotang.interface';

/**
 * The parity gate (modern-interface.md D4): whether a new writer starts in Modern. Off until Modern is complete (#313 turns it
 * on); until then a new writer starts in Classic and Settings labels Modern "Preview". Existing writers stay on Classic either way.
 */
export const MODERN_DEFAULT_FOR_NEW_USERS = false;

/** What the default rule reads (§3.2). A fact that is not known yet is `null`. */
export interface InterfaceFacts {
  /** The value stored under `caotang.interface`, whatever it is, or `null` when there is none. */
  readonly stored: string | null;
  /** Whether local storage holds another `caotang.*` key, which only an earlier visit can have left. */
  readonly otherKeys: boolean;
  /** Whether the runtime store holds a project; `null` before it has opened. */
  readonly projects: boolean | null;
  /** Whether the app database held a settings record before this page load wrote one; `null` before it has opened. */
  readonly settingsRecord: boolean | null;
}

/**
 * The default rule, in the spec's order: a stored `'classic'` or `'modern'` wins; another `caotang.*` key means Classic; then,
 * once the stores have opened, a project or a settings record means Classic, and neither means Modern, if the parity gate allows
 * it, else Classic. `null` while the stores have not answered.
 */
export function resolveInterface(facts: InterfaceFacts, modernForNewUsers: boolean = MODERN_DEFAULT_FOR_NEW_USERS): Interface | null {
  if (facts.stored === 'classic' || facts.stored === 'modern') return facts.stored;
  if (facts.otherKeys) return 'classic';
  if (facts.projects === null || facts.settingsRecord === null) return null;
  if (facts.projects || facts.settingsRecord) return 'classic';
  return modernForNewUsers ? 'modern' : 'classic';
}

/** The part of `Storage` the rule reads. */
export type KeyList = Pick<Storage, 'length' | 'key'>;

/** Whether local storage holds a Caotang key (every one starts `caotang.`) other than the interface's own. */
export function otherCaotangKeys(storage: KeyList | null): boolean {
  if (storage === null) return false;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key !== INTERFACE_KEY && key.startsWith('caotang.')) return true;
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

function storedValue(): string | null {
  try {
    return local()?.getItem(INTERFACE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Remember an interface for the next visit. A failed store only loses the memory. */
export function rememberInterface(value: Interface): void {
  try {
    local()?.setItem(INTERFACE_KEY, value);
  } catch {
    // Not kept: the next visit decides again.
  }
}

/** Puts an interface on the page. The promise settles once Modern's stylesheet is in (at once for Classic). */
export function applyInterface(value: Interface): Promise<unknown> {
  document.documentElement.dataset['shell'] = value;
  return value === 'modern' ? import('../modern/modern.css') : Promise.resolve();
}

let pending = false;

/** Whether the default still waits for the stores (the page shows no workspace until {@link settleInterface}). */
export function interfacePending(): boolean {
  return pending;
}

/** Decides what local storage can, before the first render (main.tsx waits for it, so Modern paints with its stylesheet in). */
export function initInterface(): Promise<unknown> {
  const stored = storedValue();
  const value = resolveInterface({ stored, otherKeys: otherCaotangKeys(local()), projects: null, settingsRecord: null });
  pending = value === null;
  if (value !== null && value !== stored) rememberInterface(value);
  // Nothing renders but the loading line while pending, so Classic's attribute meanwhile shows no shell.
  return applyInterface(value ?? 'classic');
}

/** Answers a pending default from the stores, and stores the answer. Does nothing once decided. */
export function settleInterface(projects: boolean, settingsRecord: boolean): Promise<unknown> {
  if (!pending) return Promise.resolve();
  pending = false;
  const value = resolveInterface({ stored: null, otherKeys: false, projects, settingsRecord }) ?? 'classic';
  rememberInterface(value);
  return applyInterface(value);
}
