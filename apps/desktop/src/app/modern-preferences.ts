/**
 * Modern's two view preferences (modern-interface.md §5.3, §9.4): **Reduce transparency** and **Reduce motion**, switches in
 * Settings › Appearance for systems that do not expose `prefers-reduced-transparency` or `prefers-reduced-motion`. They apply to the
 * Modern interface only (Q7): Classic has no glass and almost no motion.
 *
 * Each is kept in this browser's local storage (`caotang.modern.transparency`, `caotang.modern.motion`, the value `'reduced'` or no key),
 * read before the first paint with the interface (interface.ts calls {@link applyModernPreferences}), and put on `<html>` as
 * `data-transparency='reduced'` and `data-motion='reduced'`. Only Modern's stylesheets read the attributes, under
 * `:root[data-shell='modern']`. Every storage access is guarded: a failed store only loses the memory, not the switch.
 */

export const TRANSPARENCY_KEY = 'caotang.modern.transparency';
export const MOTION_KEY = 'caotang.modern.motion';

export interface ModernPreferences {
  readonly reduceTransparency: boolean;
  readonly reduceMotion: boolean;
}

/** The part of `Storage` the preferences use. */
export type PreferenceStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): PreferenceStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function reduced(store: PreferenceStore | null, key: string): boolean {
  try {
    return store?.getItem(key) === 'reduced';
  } catch {
    return false;
  }
}

/** The stored preferences; both off when nothing is stored or the store cannot be read. */
export function readModernPreferences(store: PreferenceStore | null = local()): ModernPreferences {
  return { reduceTransparency: reduced(store, TRANSPARENCY_KEY), reduceMotion: reduced(store, MOTION_KEY) };
}

/** The `<html>` attributes the preferences stand for: present only for a reduction. */
export function preferenceAttributes(preferences: ModernPreferences): { transparency: 'reduced' | null; motion: 'reduced' | null } {
  return { transparency: preferences.reduceTransparency ? 'reduced' : null, motion: preferences.reduceMotion ? 'reduced' : null };
}

/** Puts the preferences on `<html>`: the stored ones, or the ones given. */
export function applyModernPreferences(preferences: ModernPreferences = readModernPreferences()): void {
  const root = document.documentElement;
  const attributes = preferenceAttributes(preferences);
  if (attributes.transparency === null) delete root.dataset['transparency'];
  else root.dataset['transparency'] = attributes.transparency;
  if (attributes.motion === null) delete root.dataset['motion'];
  else root.dataset['motion'] = attributes.motion;
}

function remember(store: PreferenceStore | null, key: string, on: boolean): void {
  try {
    if (on) store?.setItem(key, 'reduced');
    else store?.removeItem(key);
  } catch {
    // Not kept: the switch applies to this visit only.
  }
}

/** Turns one preference on or off, keeps it, and applies both at once. Returns the preferences now in force. */
export function setModernPreference(
  name: keyof ModernPreferences,
  on: boolean,
  store: PreferenceStore | null = local(),
): ModernPreferences {
  remember(store, name === 'reduceTransparency' ? TRANSPARENCY_KEY : MOTION_KEY, on);
  const next = { ...readModernPreferences(store), [name]: on };
  applyModernPreferences(next);
  return next;
}
