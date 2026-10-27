/** The sentences the review bar, the turn card and the reload notice say (editor-engine §15). Words only, so any view may import them. */

/** How many suggestions wait, as the review bar and the turn card say it. */
export function pendingLabel(count: number): string {
  return `${count} ${count === 1 ? 'suggestion' : 'suggestions'} pending review`;
}

/** The sentence the notice says (editor-engine §15). */
export function pendingNotice(count: number): string {
  const noun = count === 1 ? '1 suggestion' : `${count} suggestions`;
  return `${noun} from the last agent turn ${count === 1 ? 'was' : 'were'} kept as written on reload — ‘restore to before this turn’ is available in the activity log.`;
}
