/**
 * The coherence file as the store holds it in memory — [coherence.md §3](../../../docs/architecture/coherence.md).
 *
 * **Why a structural type and not the coherence module's `CoherenceFile`.** The dependency
 * runs coherence → store, so the store cannot name that type. This one is the part of it the
 * store's applies read and write (`coherence.setSceneMeta` and `coherence.setFindingStatus`),
 * and the rest is carried as the type it is declared as. The coherence module's `CoherenceFile`
 * is assignable to this type, so the module hands its loaded file to the state without a
 * conversion, and reads it back the same way (a checked downcast, in the harness's port).
 *
 * **Where the file is read and written.** The applies are synchronous (command-bus A2) and
 * `ArtifactFs` is asynchronous, so an apply cannot read or write the file itself. The coherence
 * module loads it through `ArtifactFs` (`loadCoherence`) and saves it through `ArtifactFs`
 * (`saveCoherence`); an apply changes the in-memory copy the state holds, and a save after it
 * persists that copy. That is the same split the manifest and the documents already use.
 *
 * **Where it is kept.** The project's row in the runtime store holds the file's artifact set (`ProjectRow.coherenceFiles`,
 * read and written by `readCoherenceFiles` and `writeCoherenceFiles`). The app loads the file when a project opens and saves
 * it after each coherence change (apps/desktop coherence-io.ts and session.ts), and the bundle carries the live file at its
 * root (zip.ts). A change to the file therefore outlives the session.
 *
 * **Optional on the state.** A project opened without a coherence file has none. The coherence
 * commands refuse that case in `validate` rather than creating a file as a side effect.
 */

import type { KnowledgeFactRecord, SceneMetaRecord } from '@caotang/bus';
import type { MessageRef } from '@caotang/i18n';

/**
 * The part of one finding the store's applies touch, the evidence an `affected` row names (§8), and the fields the
 * coherence report and the run discard read (coherence.md §3, §7.1). The rest of a finding is the module's, and an
 * optional field here is one the module's `Finding` already carries, so the module's file is assignable to this.
 */
export interface CoherenceFindingState {
  readonly id: string;
  status: string;
  dismissedReason?: string;
  note?: string;
  updatedAt: string;
  touchedAt?: string;
  /** The documents the finding quotes, for the activity row's titles. Empty for a codex-level finding. */
  readonly evidence?: readonly { readonly docId: string; readonly quote?: string; readonly from?: number; readonly to?: number }[];
  readonly createdAt?: string;
  /** The run that created the finding. Discard run (§7.1) removes what that run made and nobody touched. */
  readonly createdByRunId?: string;
  readonly runId?: string;
  readonly class?: string;
  readonly checkId?: string;
  readonly type?: string;
  readonly severity?: string;
  readonly factGroup?: string;
  readonly message?: string;
  /** I7: the deterministic finding's message reference, carried through the store's structural copy. */
  readonly messageRef?: MessageRef;
  readonly expected?: string;
}

/**
 * One run of the run history (coherence.md §4.1), as far as the store reads it: the id a discard names, and the fields
 * the coherence report prints. The module's `CoherenceRun` is assignable to this.
 */
export interface CoherenceRunState {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly checkIds: readonly string[];
  /** `mode` is the scan's scope (`full` or `doc`) and is absent on a model review, whose scope is its documents alone. */
  readonly scope: { readonly docIds: readonly string[]; readonly mode?: string };
  readonly findingsUpserted: readonly string[];
  readonly status: string;
  readonly notes?: readonly string[];
  readonly model?: string;
  readonly tokens?: { readonly promptTokens: number; readonly completionTokens: number };
}

/** coherence.md §3's `CoherenceFile`, as far as the store needs it. */
export interface CoherenceState {
  formatVersion: 1;
  findings: CoherenceFindingState[];
  /** §4.1's run history, oldest first. Discard run (§7.1) removes one. */
  runs: CoherenceRunState[];
  /** §5.2's declarations, by document id. A document with none has no key. */
  sceneMeta: Record<string, SceneMetaRecord>;
  /** Held as the coherence module declares them. The store reads only the ids, which a knowledge fact's `ruleId` names. */
  worldRules: { readonly id: string }[];
  /** §4.4's knowledge facts. The bus's record is the module's `KnowledgeFact`; the three knowledge commands change this list and the scenes' `learns` and `knows`. */
  knowledge: KnowledgeFactRecord[];
  /** Held as the coherence module declares them; the store does not read them. */
  reviewState: Record<string, unknown>;
}

/** The empty file a project with no coherence yet starts from (coherence.md §3). */
export function emptyCoherenceState(): CoherenceState {
  return { formatVersion: 1, findings: [], runs: [], sceneMeta: {}, worldRules: [], knowledge: [], reviewState: {} };
}
