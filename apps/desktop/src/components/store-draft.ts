/**
 * A field's draft of a value the store holds.
 *
 * A field that edits a value the project holds shows the writer's own text while it is being
 * edited, and the store's value otherwise. The rule this file keeps is the one the shell's fields
 * follow: **the field shows what the project holds, not what it held before**.
 *
 * So when the store's value moves — an undo, a change made elsewhere — the draft follows it,
 * unless the writer has typed something of their own that the store does not hold yet. That text
 * is theirs, and it is kept until it is committed or the field is left.
 *
 * Without this a field keeps the text it was given: a number field that committed a value and was
 * then undone still showed the committed number, and leaving the field wrote that number back —
 * a value the project no longer held, put there again by a blur.
 */

import { useState } from 'react';

/**
 * The draft a field keeps when the store's value moved under it.
 *
 * `draft` is the text the field shows, `null` when the field shows the store's value. `base` is the
 * store's value the draft was made against: a draft that is the base is the store's own text, and
 * follows the store when the store moves; a draft that is not the base is the writer's own, and is
 * kept.
 */
export function syncDraft(draft: string | null, base: string, storeValue: string): string | null {
  if (base === storeValue) return draft;
  return draft !== null && draft !== base ? draft : null;
}

/** The text a field shows, and what the writer has typed. */
export interface StoreDraft {
  /** The text the field shows: the writer's own text, or the store's value. */
  readonly value: string;
  /** The writer has typed something the store does not hold. */
  readonly dirty: boolean;
  /** The writer typed this. */
  readonly change: (text: string) => void;
  /** The field goes back to the store's value. */
  readonly reset: () => void;
}

/**
 * The draft of a field that edits a value the store holds.
 *
 * The draft is compared with the store's value while rendering, so the field agrees with the store
 * before the first paint that shows either — the filter bar keeps its held list the same way.
 */
export function useStoreDraft(storeValue: string): StoreDraft {
  const [held, setHeld] = useState<{ readonly key: string; readonly draft: string | null }>(() => ({
    key: storeValue,
    draft: null,
  }));
  let current = held;
  if (held.key !== storeValue) {
    current = { key: storeValue, draft: syncDraft(held.draft, held.key, storeValue) };
    setHeld(current);
  }
  return {
    value: current.draft ?? storeValue,
    dirty: current.draft !== null && current.draft !== storeValue,
    change: (text: string) => setHeld((now) => ({ key: now.key, draft: text })),
    reset: () => setHeld((now) => ({ key: now.key, draft: null })),
  };
}
