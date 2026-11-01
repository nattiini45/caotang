/// <reference types="vite/client" />
/**
 * The skin hook (modern-interface.md §2.1, §2.2, D9): a **skin** restyles Classic by token values alone, one CSS file per skin in
 * `tokens/skins/<name>.css` (tokens/skins/README.md). No skin ships and no setting offers one; this is the hook later skins plug into.
 *
 * The choice is `caotang.skin` in this browser's local storage, read before the first paint with the interface (interface.ts), and put
 * on the page as `data-skin` on `<html>`. It is ignored, and the attribute absent, while the key is absent, names `default` or a skin
 * that is not in the build, or while Modern is on (Modern has no skin axis). A chosen skin's stylesheet is a lazily loaded chunk of its
 * own, so Classic's first load never carries it.
 */
import type { Interface } from './interface.js';

export const SKIN_KEY = 'caotang.skin';

/** The default skin, Classic's look today: no attribute and no stylesheet. */
export const DEFAULT_SKIN = 'default';

/** A skin's name is its file's name: lowercase letters, digits and hyphens, starting with a letter. */
const SKIN_NAME = /^[a-z][a-z0-9-]*$/;

/** Each skin in the build, by name, with the import that loads its stylesheet. */
export type SkinSheets = Readonly<Record<string, () => Promise<unknown>>>;

/** The skins in this build: every `tokens/skins/*.css`, as a lazy chunk each. None today. */
export function builtSkins(): SkinSheets {
  let sheets: Record<string, () => Promise<unknown>>;
  try {
    sheets = import.meta.glob('../tokens/skins/*.css');
  } catch {
    // A bare Node host (the unit specs) has no Vite to expand the glob, and so no skins.
    return {};
  }
  const skins: Record<string, () => Promise<unknown>> = {};
  for (const [path, load] of Object.entries(sheets)) {
    const name = /\/([^/]+)\.css$/.exec(path)?.[1];
    if (name !== undefined && name !== DEFAULT_SKIN && SKIN_NAME.test(name)) skins[name] = load;
  }
  return skins;
}

/** The skin the page wears: the stored one when it is a skin in the build and the interface is Classic, else `null` (the default). */
export function resolveSkin(stored: string | null, shell: Interface, available: readonly string[]): string | null {
  if (shell !== 'classic' || stored === null || stored === DEFAULT_SKIN) return null;
  return available.includes(stored) ? stored : null;
}

function storedSkin(): string | null {
  try {
    return window.localStorage.getItem(SKIN_KEY);
  } catch {
    // An unreadable store means the default skin.
    return null;
  }
}

/** Puts the skin for this interface on the page, or takes it off. The promise settles once its stylesheet is in (at once for none). */
export function applySkin(shell: Interface, sheets: SkinSheets = builtSkins()): Promise<unknown> {
  const root = document.documentElement;
  const skin = resolveSkin(storedSkin(), shell, Object.keys(sheets));
  const load = skin === null ? undefined : sheets[skin];
  if (skin === null || load === undefined) {
    delete root.dataset['skin'];
    return Promise.resolve();
  }
  root.dataset['skin'] = skin;
  return load();
}
