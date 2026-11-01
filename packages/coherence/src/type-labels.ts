/**
 * The writer's words for a finding's `type` and a run's `kind` (coherence.md §3, §8). The file keeps the stable keys; the
 * Findings tab and the report show these. A model-judged finding's subtype is a string the model proposes (§5.3), so it has no
 * row here and is shown in plain words by its own spelling.
 */

import type { RunKind } from './model.js';

/** One row per subtype a deterministic check or the dialogue module writes. */
export const FINDING_TYPE_LABELS: Readonly<Record<string, string>> = {
  'alias-collision': 'Shared name',
  'never-mentioned': 'Never named',
  'order-drift': 'Out of order',
  'strand-order-drift': 'Out of order in its strand',
  'after-violated': 'Placed before a scene it follows',
  'outside-span': 'Outside the folder’s days',
  'sibling-overlap': 'Overlapping scenes',
  'time-gap': 'A gap in time',
  'knows-before-learns': 'Knows before learning',
  'never-learns': 'Never learns it',
  'pov-unresolved': 'Unknown point of view',
  'pov-not-named': 'Point of view not named',
  'expected-absent': 'Expected character missing',
  'cue-unmatched': 'Cue matches no codex entry',
  'cue-spelling': 'Cue spelled two ways',
  'duration-missing': 'Shot without a duration',
  uncovered: 'Not covered by a shot',
  'anchor-drift': 'Shot anchor moved',
  'loose-end': 'Loose end',
  unreachable: 'Unreachable knot',
  'unresolved-speaker': 'Unknown speaker',
  'ambiguous-speaker': 'Speaker matches two entries',
  'speaker-differs': 'Speaker spelled differently',
  'speaker-screenplay-only': 'Only the screenplay has this speaker',
  'speaker-dialogue-only': 'Only the dialogue has this speaker',
  balloon: 'Balloon over the word limit',
  panel: 'Panel over the word limit',
  emDash: 'Em dash in the lettering',
  esszettBecomesSS: 'ß lettered as SS',
  unletteredLine: 'Script line without a balloon',
  staleAnchor: 'Balloon’s script text changed',
  brokenBalloon: 'Balloon missing from its panel',
  staleDocument: 'Lettered from another script',
};

/** A finding's type in the writer's words: its row, or the key itself with its dashes as spaces and a capital first letter. */
export function findingTypeLabel(type: string): string {
  const row = FINDING_TYPE_LABELS[type];
  if (row !== undefined) return row;
  const words = type.replace(/[-_.:]+/g, ' ').trim();
  return words === '' ? 'Finding' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** A run's kind as the run history and the report name it. */
export const RUN_KIND_LABELS: Readonly<Record<RunKind, string>> = {
  deterministic: 'Quick scan',
  llm: 'Model review',
};
