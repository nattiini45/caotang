/**
 * The interface languages the Appearance picker has already listed on this device (D5 hysteresis). A language that was listed keeps its
 * row down to 55 % completion, so a release that adds messages does not remove a language a writer relies on. It is device state, never a
 * project or a setting that syncs.
 */

const KEY = 'caotang.listedLanguages';

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The tags the picker has listed before, or none when the browser keeps no storage. */
export function readListedLanguages(): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

/** Remembers the tags the picker listed now, keeping the ones it listed before. */
export function recordListedLanguages(tags: readonly string[]): void {
  const next = [...new Set([...readListedLanguages(), ...tags])].sort();
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store only loses the hysteresis; the gate still applies.
  }
}
