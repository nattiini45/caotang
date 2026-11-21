/**
 * Which studio the app's named stores belong to.
 *
 * A folder app has one writer at one origin, so its stores are the fixed names the specs give them: `caotang-app`, the
 * provider key vault, the runtime store. A hosted shell serves several accounts from one origin instead, so it names the
 * account before the app opens anything, and every store the app opens by name gets that name appended. With no scope —
 * the folder app's case — the names are exactly what they were, so a writer's existing data keeps opening.
 *
 * Only names the app opens for itself are scoped. A project folder, an export and a bundle are the writer's, not the
 * account's, and nothing here renames them.
 */
let scope: string | null = null;

/** Names the account this document's studio belongs to, or `null` for the folder app. Called before the app opens a store. */
export function setStorageScope(next: string | null): void {
  scope = next === null || next === '' ? null : next;
}

/** What named the stores, so a store that memoizes its connection can notice a change (`runtime.ts`). */
export function storageScope(): string | null {
  return scope;
}

/** `name` for this scope: the fixed name when there is none, else the fixed name and the scope beside it. */
export function scopedStoreName(name: string): string {
  return scope === null ? name : `${name}--${scope}`;
}
