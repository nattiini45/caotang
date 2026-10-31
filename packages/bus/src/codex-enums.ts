/**
 * codex.md §2's two closed enums as the bus refuses them: the entry types and the include policies.
 *
 * One record inside this package, read by `codex.upsert`'s validator (`descriptors.ts`) and by `codex.importBatch`'s
 * (`descriptors-codex-import.ts`). The package index does not export them: the store keeps its own copy, because an unknown
 * member is refused at the command boundary and coerced on load (the reason given in `descriptors.ts`), and
 * the enum test in `packages/store/test/commands-codex-import.test.ts` holds the two member lists together through both validators.
 */

export const CODEX_TYPES: readonly string[] = ['character', 'location', 'object', 'lore', 'subplot', 'other'];
export const CODEX_POLICIES: readonly string[] = ['always', 'detected', 'manual', 'never'];
