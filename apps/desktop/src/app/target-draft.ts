/**
 * The daily target a writer types into the editor's quick-set (goals-progress §4): a whole number of words, from 0 to the maximum,
 * where 0 means no target. It is the rule the Settings field states (ui-modules §5.2), read here too, so the two cannot disagree.
 */

import { TARGET_MAX_WORDS } from './settings.js';
import { formatCount } from '../i18n/locale.js';

export type TargetDraft = { readonly ok: true; readonly words: number } | { readonly ok: false; readonly message: string };

/** What the quick-set's field says about the typed target: the words to save, or the sentence that says why they cannot be saved. */
export function targetDraftOf(text: string): TargetDraft {
  const trimmed = text.trim();
  const words = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(words) || words < 0 || words > TARGET_MAX_WORDS) {
    return {
      ok: false,
      message: `The daily target is a whole number of words from 0 to ${formatCount(TARGET_MAX_WORDS)}; 0 means no target.`,
    };
  }
  return { ok: true, words };
}
