/**
 * The store's apply for `timeline.apply` ([timeline.md §4.3](docs/architecture/timeline.md)): one approval of a timeline proposal, as one command.
 *
 * **The whole result is built before anything is written.** The apply runs the bus's projection (`projectTimelineBatch`, the one `validate` ran) on the
 * held state, and installs its answer only when every op passed: a rejected batch, or one the project moved under between validate and apply, writes
 * nothing. The projection reads the same canonical sibling-order algorithm the real `binder.move` uses (`siblingOrderAt` delegates to it), so the orders
 * installed here are the ones the same moves made one at a time would have left.
 *
 * **Undo is one before-image, not N inverse commands.** A scene patch's inverse restores an `after` list by membership, and a move's inverse is a
 * position, so neither can put back the exact order of a list or the exact orders of a renormalised sibling set. The apply captures, once, the
 * declarations and the `(parentId, order)` of exactly the nodes it changes; the restore writes those back and touches nothing else, so a body edit,
 * a rename or a scene declaration made after the batch on another node survives the undo, and no document revision is lowered. Documents are not
 * read or written here: a structure change does not bump a body revision, and a declaration is not a body.
 */

import { ApplyRefusal, projectTimelineBatch, timelineBatchSummary, type ApplyContext, type CommandApply, type SceneMetaRecord, type TimelineApplyParams } from '@caotang/bus';

import type { ProjectState } from './state.js';

type ProjectApply<P> = CommandApply<P, ProjectState>;

export interface TimelineApplies {
  readonly 'timeline.apply': ProjectApply<TimelineApplyParams>;
}

export function timelineApplies(): TimelineApplies {
  const timelineApply: ProjectApply<TimelineApplyParams> = (state, params, context: ApplyContext) => {
    const projection = projectTimelineBatch(state, params.ops);
    if (!projection.ok) throw new ApplyRefusal(projection.error);
    const { nodeChanges, metaChanges, linkChanges, counts } = projection.value;

    const nodes = new Map(state.manifest.tree.map((node) => [node.id, node]));
    const titleOf = (id: string): string => nodes.get(id)?.title ?? id;
    if (metaChanges.length > 0 && state.coherence === undefined) throw new Error('no coherence file is open for this project');

    // The before-image, taken before the first write. The records are copied because nothing promises a later command leaves them unmutated.
    const places = nodeChanges.map((change) => ({ nodeId: change.nodeId, parentId: change.before.parentId, order: change.before.order }));
    const metas = metaChanges.map((change) => ({ nodeId: change.nodeId, before: change.before === undefined ? undefined : structuredClone(change.before) }));
    // A pin lives on the placement (pictures.md §2.1), so its before-image is the `when` alone: the rest of the link is not this
    // batch's to capture, and restoring the whole link would put back a note or a role another command changed after it.
    const pins = linkChanges.map((change) => ({ linkId: change.linkId, before: change.before }));

    for (const change of nodeChanges) {
      const node = nodes.get(change.nodeId)!;
      node.parentId = change.after.parentId;
      node.order = change.after.order;
    }
    for (const change of metaChanges) {
      const file = state.coherence!;
      if (change.after === undefined) delete file.sceneMeta[change.nodeId];
      else file.sceneMeta[change.nodeId] = structuredClone(change.after);
    }
    for (const change of linkChanges) {
      const link = (state.manifest.assetLinks ?? []).find((candidate) => candidate.id === change.linkId);
      if (link === undefined) continue;
      if (change.after === null) delete link.when;
      else link.when = { ...change.after };
    }

    const summary = timelineBatchSummary(projection.value, titleOf, params.label);
    context.undo.compensate(`undo ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`, () => {
      const held = new Map(state.manifest.tree.map((node) => [node.id, node]));
      for (const place of places) {
        const node = held.get(place.nodeId);
        if (node === undefined) continue;
        node.parentId = place.parentId;
        node.order = place.order;
      }
      const file = state.coherence;
      for (const meta of metas) {
        if (!held.has(meta.nodeId)) continue;
        if (file === undefined) continue;
        if (meta.before === undefined) delete file.sceneMeta[meta.nodeId];
        else file.sceneMeta[meta.nodeId] = structuredClone(meta.before) as SceneMetaRecord;
      }
      for (const pin of pins) {
        const link = (state.manifest.assetLinks ?? []).find((candidate) => candidate.id === pin.linkId);
        if (link === undefined) continue;
        if (pin.before === null) delete link.when;
        else link.when = { ...pin.before };
      }
    });

    // Every node the ops named, in the order they first did, and not just the ones whose result differs: the row says what was proposed.
    const affected = projection.value.touchedIds.map((nodeId) => ({ nodeId, title: titleOf(nodeId) }));
    context.report({ affected, summary });
    return {
      changes: counts.total,
      counts,
      moved: nodeChanges.map((change) => change.nodeId),
      declarations: metaChanges.map((change) => change.nodeId),
    };
  };

  return { 'timeline.apply': timelineApply };
}
