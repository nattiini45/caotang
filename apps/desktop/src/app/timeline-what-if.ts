/**
 * The what-if delta of a timeline proposal ([timeline.md §4.4](docs/architecture/timeline.md)): which open findings the proposed days
 * would resolve and which new ones they would raise, found by running the deterministic timeline, knowledge and thread checks on a
 * hypothetical copy of the project.
 *
 * **Nothing is upserted and nothing is written.** The copy shares every document body and every untouched record with the project;
 * only the tree's moved nodes and the scene declarations a batch touched are new objects. The comparison is by `checkId + factGroup`,
 * the key a finding keeps across scans, so a finding that survives the proposal is neither resolved nor new.
 *
 * Two small rules keep the delta honest about a project whose findings are out of date: a finding the unmodified project no longer
 * produces is not called resolved (the proposal did not fix it), and a problem the unmodified project already has, found or not by
 * the last scan, is not called new (the proposal did not cause it).
 */

import { projectedSceneMeta, type SceneMetaRecord, type TimelineProjection } from '@caotang/bus';
import {
  entriesOf,
  runChecks,
  snapshotManuscript,
  type CheckInput,
  type CoherenceFile,
  type DeterministicCheckId,
  type DraftFinding,
  type Finding,
} from '@caotang/coherence';
import type { MessageRef } from '@caotang/i18n';
import type { ProjectState } from '@caotang/store';

/** The checks a day, a part or a position can change: the five timeline checks, knowledge leaks and unresolved threads. */
export const WHAT_IF_CHECKS: readonly DeterministicCheckId[] = [
  'timeline.order-drift',
  'timeline.relation',
  'timeline.window',
  'timeline.overlap',
  'timeline.gap',
  'knowledge.leak',
  'plot.unresolved-thread',
];

export interface WhatIfFinding {
  /** `checkId|factGroup`. */
  readonly key: string;
  readonly checkId: string;
  readonly severity: Finding['severity'];
  readonly message: string;
  readonly messageRef?: MessageRef;
}

export interface WhatIfDelta {
  readonly resolved: readonly WhatIfFinding[];
  readonly added: readonly WhatIfFinding[];
}

const keyOf = (checkId: string, factGroup: string): string => `${checkId}|${factGroup}`;

function toFinding(draft: DraftFinding): WhatIfFinding {
  return {
    key: keyOf(draft.checkId, draft.factGroup),
    checkId: draft.checkId,
    severity: draft.severity,
    message: draft.message,
    ...(draft.messageRef !== undefined ? { messageRef: draft.messageRef } : {}),
  };
}

/** The drafts the what-if checks produce for a project and its scene declarations. Reads; never writes. */
export function draftsOf(state: ProjectState, file: CoherenceFile): DraftFinding[] {
  const snapshot = snapshotManuscript(state, file);
  const input: CheckInput = {
    scenes: snapshot.scanned,
    folders: snapshot.folders,
    entries: entriesOf(state),
    hits: new Map(),
    shots: snapshot.shots,
    knowledge: file.knowledge,
    treeDocuments: new Map(state.manifest.tree.filter((node) => node.type === 'document').map((node) => [node.id, node.title || node.id])),
  };
  return runChecks(input, WHAT_IF_CHECKS).drafts;
}

/** The keys of the problems the unmodified project has. Compute it once for a project version and pass it to every {@link whatIf}. */
export function baselineKeys(state: ProjectState, file: CoherenceFile): Set<string> {
  return new Set(draftsOf(state, file).map((draft) => keyOf(draft.checkId, draft.factGroup)));
}

/** The project and file as a projection would leave them, sharing everything the projection did not touch. */
export function hypothetical(state: ProjectState, file: CoherenceFile, projection: TimelineProjection): { state: ProjectState; file: CoherenceFile } {
  const places = new Map(projection.nodeChanges.map((change) => [change.nodeId, change.after] as const));
  const tree = places.size === 0 ? state.manifest.tree : state.manifest.tree.map((node) => {
    const after = places.get(node.id);
    return after === undefined ? node : { ...node, parentId: after.parentId, order: after.order };
  });
  const sceneMeta = projection.metaChanges.length === 0 ? file.sceneMeta : (projectedSceneMeta(file.sceneMeta as Record<string, SceneMetaRecord>, projection) as CoherenceFile['sceneMeta']);
  return { state: { ...state, manifest: { ...state.manifest, tree } }, file: { ...file, sceneMeta } };
}

/**
 * Resolved and new findings if `projection` were applied. `baseline` is {@link baselineKeys} of the unmodified project; without it the
 * open findings stand for it.
 */
export function whatIf(state: ProjectState, file: CoherenceFile, projection: TimelineProjection, baseline?: ReadonlySet<string>): WhatIfDelta {
  const open = file.findings.filter((finding) => finding.status === 'open' && (WHAT_IF_CHECKS as readonly string[]).includes(finding.checkId));
  const known = new Set(file.findings.filter((finding) => finding.status === 'open' || finding.status === 'dismissed').map((finding) => keyOf(finding.checkId, finding.factGroup)));
  const before = baseline ?? new Set(open.map((finding) => keyOf(finding.checkId, finding.factGroup)));
  const hypo = hypothetical(state, file, projection);
  const after = new Map<string, DraftFinding>();
  for (const draft of draftsOf(hypo.state, hypo.file)) after.set(keyOf(draft.checkId, draft.factGroup), draft);

  const resolved: WhatIfFinding[] = [];
  const seen = new Set<string>();
  for (const finding of open) {
    const key = keyOf(finding.checkId, finding.factGroup);
    if (after.has(key) || !before.has(key) || seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      key,
      checkId: finding.checkId,
      severity: finding.severity,
      message: finding.message,
      ...(finding.messageRef !== undefined ? { messageRef: finding.messageRef as MessageRef } : {}),
    });
  }
  const added: WhatIfFinding[] = [];
  for (const [key, draft] of after) {
    if (known.has(key) || before.has(key)) continue;
    added.push(toFinding(draft));
  }
  return { resolved, added };
}
