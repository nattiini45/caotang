/**
 * The what-if delta of a timeline proposal ([timeline.md §4.4](../../../../docs/architecture/timeline.md)), for the plan card of `timeline.edit`: which
 * open findings the proposed edits would resolve and which new ones they would raise, found by running the timeline, knowledge and thread checks
 * on a hypothetical copy of the project. It is the rule the app's proposed-changes tray applies (`apps/desktop/src/app/timeline-what-if.ts`), and
 * the two must agree, so a card and the tray never give a writer two answers for one batch.
 *
 * **Nothing is upserted and nothing is written.** The copy shares every document body and every untouched record with the project. The
 * comparison is by `checkId + factGroup`, the key a finding keeps across scans. Two rules keep the delta honest about a project whose findings are
 * out of date: a finding the unmodified project no longer produces is not called resolved, and a problem the unmodified project already has is not
 * called new.
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
} from '@caotang/coherence';
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

/** One finding in a delta: what a card lists. */
export interface DeltaFinding {
  readonly checkId: string;
  readonly severity: string;
  readonly message: string;
}

export interface FindingsDelta {
  readonly resolved: readonly DeltaFinding[];
  readonly added: readonly DeltaFinding[];
}

const keyOf = (checkId: string, factGroup: string): string => `${checkId}|${factGroup}`;

function draftsOf(state: ProjectState, file: CoherenceFile): DraftFinding[] {
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

/** The project and file as a projection would leave them, sharing everything the projection did not touch. */
function hypothetical(state: ProjectState, file: CoherenceFile, projection: TimelineProjection): { state: ProjectState; file: CoherenceFile } {
  const places = new Map(projection.nodeChanges.map((change) => [change.nodeId, change.after] as const));
  const tree =
    places.size === 0
      ? state.manifest.tree
      : state.manifest.tree.map((node) => {
          const after = places.get(node.id);
          return after === undefined ? node : { ...node, parentId: after.parentId, order: after.order };
        });
  const sceneMeta =
    projection.metaChanges.length === 0 ? file.sceneMeta : (projectedSceneMeta(file.sceneMeta as Record<string, SceneMetaRecord>, projection) as CoherenceFile['sceneMeta']);
  return { state: { ...state, manifest: { ...state.manifest, tree } }, file: { ...file, sceneMeta } };
}

/** The findings `projection` would resolve and raise, were it applied to `state` and its coherence file. */
export function findingsDeltaOf(state: ProjectState, file: CoherenceFile, projection: TimelineProjection): FindingsDelta {
  const open = file.findings.filter((finding) => finding.status === 'open' && (WHAT_IF_CHECKS as readonly string[]).includes(finding.checkId));
  const known = new Set(file.findings.filter((finding) => finding.status === 'open' || finding.status === 'dismissed').map((finding) => keyOf(finding.checkId, finding.factGroup)));
  const before = new Set(draftsOf(state, file).map((draft) => keyOf(draft.checkId, draft.factGroup)));
  const hypo = hypothetical(state, file, projection);
  const after = new Map<string, DraftFinding>();
  for (const draft of draftsOf(hypo.state, hypo.file)) after.set(keyOf(draft.checkId, draft.factGroup), draft);

  const resolved: DeltaFinding[] = [];
  const seen = new Set<string>();
  for (const finding of open) {
    const key = keyOf(finding.checkId, finding.factGroup);
    if (after.has(key) || !before.has(key) || seen.has(key)) continue;
    seen.add(key);
    resolved.push({ checkId: finding.checkId, severity: finding.severity, message: finding.message });
  }
  const added: DeltaFinding[] = [];
  for (const [key, draft] of after) {
    if (known.has(key) || before.has(key)) continue;
    added.push({ checkId: draft.checkId, severity: draft.severity, message: draft.message });
  }
  return { resolved, added };
}
