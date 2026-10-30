/**
 * The plain words the coherence changes are named with (coherence.md §7.1 and §8). The Undo tooltip, the activity log and the
 * Markdown report show these, so a declaration, a reason, a check or a run is named as a writer reads it: never a field name,
 * a reason id, a check id or a run id.
 *
 * The store cannot import the coherence module (the dependency runs the other way), so the labels are copied here. The
 * coherence module's tests pin each copy to its own table (`DISMISSAL_REASONS`, `DETERMINISTIC_CHECK_LABELS`).
 */

/** The writer's word for each scene-declaration field the patch names. A `_add` or `_remove` key names the same field. */
const DECLARATION_WORDS: Readonly<Record<string, string>> = {
  pov: 'point of view',
  dayOffset: 'day',
  durationDays: 'duration',
  after: 'dependencies',
  expectedPresent: 'expected presence',
  timelineMode: 'timeline mode',
  threads: 'threads',
  dialogueContainer: 'dialogue container',
  storyPart: 'story part',
};

/** Joins words the way a sentence does: `a`, `a and b`, `a, b and c`. */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The words for a list of scene-declaration patch keys, each field named once, in the order the patch gave them. */
export function declarationChangeWords(patchKeys: readonly string[]): string {
  const words = patchKeys.map((key) => {
    const field = key.replace(/_(add|remove)$/, '');
    return DECLARATION_WORDS[field] ?? field;
  });
  return joinWords([...new Set(words)]);
}

/** The label each dismissal reason carries on the picker (coherence `DISMISSAL_REASONS`). */
const DISMISSAL_LABELS: Readonly<Record<string, string>> = {
  flashback: 'Flashback',
  'in-world-lie': 'In-world lie',
  'unreliable-narrator': 'Unreliable narrator',
  intentional: 'Intentional',
  'false-positive': 'False positive',
};

/** The reason's label as the picker shows it. A reason the table does not hold is returned as written. */
export function dismissalLabelOf(reason: string): string {
  return DISMISSAL_LABELS[reason] ?? reason;
}

/** The reason in a sentence: its label with a lower-case first letter (`dismissed … as in-world lie`). */
export function dismissalWordsOf(reason: string): string {
  const label = dismissalLabelOf(reason);
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** The plain-words name of each deterministic check (coherence `DETERMINISTIC_CHECK_LABELS`), so a writer reads the check, not its id. */
const CHECK_LABELS: Readonly<Record<string, string>> = {
  'codex.alias-collisions': 'Two codex entries share a name or alias',
  'codex.never-mentioned': 'A codex entry is never named in the manuscript',
  'timeline.order-drift': 'Scenes run out of chronological order',
  'timeline.relation': 'A scene is placed before a scene it must follow',
  'timeline.window': 'A scene falls outside its folder’s declared days',
  'timeline.overlap': 'Sibling scenes overlap in time',
  'pov.coverage': 'A declared point of view is never named in its scene',
  'presence.expected': 'A character expected in a scene is never named there',
  'script.cue-collision': 'A screenplay character cue matches no codex entry',
  'script.cue-consistency': 'One screenplay character is cued with two spellings',
  'script.shot-coverage': 'Storyboard shots miss dialogue, a duration or an anchor',
  'branch.loose-end': 'A dialogue branch runs out without an ending',
  'branch.dead-end': 'A dialogue knot can never be reached',
  'dialogue.speaker-unknown': 'A dialogue speaker matches no codex entry',
  'timeline.gap': 'A scene is days after the scene before it',
  'plot.unresolved-thread': 'A thread’s declared payoff is not in the manuscript',
  'knowledge.leak': 'A character knows something before they learn it',
  'medium.speaker-parity': 'The screenplay and its dialogue name different speakers',
};

/**
 * A check, in words. A model review's check is `llm:<category>`, which reads as the review and its category. A check id the
 * table does not hold is returned as written, which the registry should not produce.
 */
export function checkWordsOf(checkId: string): string {
  const label = CHECK_LABELS[checkId];
  if (label !== undefined) return label;
  if (checkId.startsWith('llm:')) return `model review, ${checkId.slice('llm:'.length).replace(/-/g, ' ')}`;
  return checkId;
}

/** The run a discard removes, as the writer knows it: its kind, its scope in words and how many checks or categories it ran. */
export interface RunWordsInput {
  readonly kind: string;
  readonly checkIds: readonly string[];
  readonly scope: { readonly docIds: readonly string[]; readonly mode?: string };
}

/** `a scan of the whole manuscript (14 checks)`, or `a model review of 3 documents (5 categories)`. */
export function runWordsOf(run: RunWordsInput): string {
  const isReview = run.kind === 'llm';
  const kind = isReview ? 'model review' : 'scan';
  const documents = run.scope.mode === 'full' ? 'the whole manuscript' : `${run.scope.docIds.length} document${run.scope.docIds.length === 1 ? '' : 's'}`;
  const count = run.checkIds.length;
  const parts = isReview ? `${count} categor${count === 1 ? 'y' : 'ies'}` : `${count} check${count === 1 ? '' : 's'}`;
  return `a ${kind} of ${documents} (${parts})`;
}
