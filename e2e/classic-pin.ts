/**
 * The Classic pin (modern-interface.md §3.4): every existing spec was written against Classic and keeps running against it, so
 * every browser context the suite opens starts with `caotang.interface` set to `'classic'` in local storage, for each origin the
 * suite serves (the dev server and the production preview). playwright.config.ts sets it as the default `storageState`, so no
 * spec needs to import anything for it.
 *
 * A spec that checks the default itself, or that runs Modern, starts without the pin: `test.use({ storageState: NO_PIN })`.
 *
 * The key alone is not "another caotang.* key" to the default rule (app/interface.ts), so a pinned context still counts as a
 * fresh profile wherever a spec looks at the stores.
 */

export interface PinnedState {
  readonly cookies: [];
  readonly origins: { readonly origin: string; readonly localStorage: { readonly name: string; readonly value: string }[] }[];
}

/** The pinned state for the origins the suite serves. */
export function classicPin(origins: readonly string[]): PinnedState {
  return { cookies: [], origins: origins.map((origin) => ({ origin, localStorage: [{ name: 'caotang.interface', value: 'classic' }] })) };
}

/** No pin: a fresh profile, for the specs that check the default rule or run Modern. */
export const NO_PIN: PinnedState = { cookies: [], origins: [] };
