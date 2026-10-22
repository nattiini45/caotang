/**
 * Assembles what the deterministic checks read from a project — the one place a
 * snapshot, the codex and the mention counts meet. Runs and status re-checks
 * both start here, so they cannot disagree about what the manuscript says.
 */

import type { ProjectState } from '@caotang/store';

import type { CheckInput, DialogueFacts } from './checks/common.js';
import { resolveMentions, type MentionCacheSource, type MentionDetector } from './mentions.js';
import { entriesOf, snapshotManuscript, type ManuscriptSnapshot, type SnapshotOptions } from './scope.js';
import type { CoherenceFile } from './model.js';

export interface AssembleOptions extends SnapshotOptions {
  readonly mentions?: MentionCacheSource;
  readonly detector?: MentionDetector;
  /** The dialogue module's validation for the containers a run reads, when the app has one (dialogue-narrative.md §5). */
  readonly dialogue?: DialogueFacts;
}

export interface AssembledInput {
  readonly snapshot: ManuscriptSnapshot;
  readonly input: CheckInput;
  /** Scanned documents whose counts could not be used. Their presence and coverage checks are skipped. */
  readonly unavailable: readonly string[];
  /** Scanned documents whose stale cache was recomputed. */
  readonly rebuilt: readonly string[];
}

export function assembleInput(state: ProjectState, file: CoherenceFile, options: AssembleOptions = {}): AssembledInput {
  const snapshot = snapshotManuscript(state, file, options);
  const entries = entriesOf(state);
  const resolved = resolveMentions(snapshot.scanned, entries, options.mentions, options.detector);
  return {
    snapshot,
    input: {
      scenes: snapshot.scanned,
      folders: snapshot.folders,
      entries,
      // A screenplay's cues are counted by the detector with its body (mentions.ts), so the counts are used as they come.
      hits: resolved.hits,
      shots: snapshot.shots,
      treeDocuments: new Map(state.manifest.tree.filter((node) => node.type === 'document').map((node) => [node.id, node.title || node.id])),
      ...(options.dialogue !== undefined ? { dialogue: options.dialogue } : {}),
    },
    unavailable: resolved.unavailable,
    rebuilt: resolved.rebuilt,
  };
}
