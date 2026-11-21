/** The sentences the review bar, the turn card and the reload notice say (editor-engine §15). Words only, so any view may import them. */
/* lingui-set comment="Review-bar sentences. Interpolated values: count and noun are the suggestion count and its plural phrase." */

import { plural, t } from '@lingui/core/macro';

import type { AgentEditOutcome } from '@caotang/editor';

/** How many suggestions wait, as the review bar and the turn card say it. */
export function pendingLabel(count: number): string {
  return plural(count, { one: '# suggestion pending review', other: '# suggestions pending review' });
}

/** The sentence the notice says (editor-engine §15). */
export function pendingNotice(count: number): string {
  const noun = plural(count, { one: '# suggestion', other: '# suggestions' });
  return count === 1
    ? t`${noun} from the last agent turn was kept as written on reload — ‘Restore to before this turn’ is on that turn’s card in the agent panel.`
    : t`${noun} from the last agent turn were kept as written on reload — ‘Restore to before this turn’ is on that turn’s card in the agent panel.`;
}

/** What a resolution that settled nothing says (editor-engine §15). The marks are still there, and these are the ways back. */
export const unresolvedNotice = (): string =>
  t`That change could not be resolved. Ctrl+Z still undoes what you did here, and ‘Restore to before this turn’ is on that turn’s card in the agent panel.`;

/**
 * What to tell the writer when an agent edit replaced the text instead of being marked, or `null` when no notice is owed: `off` (the
 * editor was not in review mode) and `superseded` (the newer load reports itself) stay silent (editor-engine §15).
 */
export function landingNotice(outcome: AgentEditOutcome): string | null {
  if (outcome.landed !== 'replaced') return null;
  switch (outcome.reason) {
    case 'off':
    case 'superseded':
      return null;
    case 'unsaved':
      return t`The agent’s edit replaced the text instead of marking it, because this scene had typing that was not saved yet.`;
    case 'no-layer':
      return t`The review marks could not be loaded, so the agent’s edit replaced the text. Try again after reloading Caotang.`;
    case 'diff':
    case 'mismatch':
      return t`The agent’s edit could not be marked for review, so it replaced the text. Nothing was lost: ‘Restore to before this turn’ is on that turn’s card in the agent panel.`;
  }
}
