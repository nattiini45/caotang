/**
 * The media views' rules for a store change, as plain functions (editor-engine §9). A view reads the store's body and
 * revision on each render and asks two questions of them: was the change its own write, and where does the caret go when
 * the idle mint rewrites the text under it. Nothing here touches the store, the session or the DOM, so the unit spec calls
 * it without a browser.
 */

/** The body and revision a session last stored for one document (`ProjectSession.lastWritten`). */
export type { StoredMark } from '../app/store-rebase.js';

/**
 * Whether a store change is the view's own write. The revision names a write, because it only moves up: an undo is a write of
 * its own and raises it (command-bus §5). The body is compared as well, so a change this view did not make cannot pass as its own
 * by sharing the number. A change that is not the view's own is adopted as the store's text.
 */
export { isOwnWrite } from '../app/store-rebase.js';

/**
 * Where the caret sits after the text changes from `before` to `after`. It keeps its place in the text: a change before it
 * moves it by the difference in length, a change after it leaves it where it is, and a caret inside the changed span goes to
 * the end of that span in the new text.
 */
export function caretAfterEdit(before: string, after: string, caret: number): number {
  if (before === after) return caret;
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (caret <= prefix) return caret;
  if (caret >= before.length - suffix) return caret + (after.length - before.length);
  return after.length - suffix;
}
