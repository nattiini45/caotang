/**
 * `timeline.apply` ([timeline.md §4.3](docs/architecture/timeline.md)): one approval of a timeline proposal, applied as one command and so one undo group.
 * The shape check and the whole-batch projection are `timeline.ts`; the apply is the store's (`packages/store/src/commands-timeline.ts`).
 *
 * `validate` runs the same projection the apply installs, so a batch that validates cannot fail in its apply for a validation reason, and a rejected
 * batch has changed nothing. The projection reads the snapshot and never writes it.
 *
 * **Undo is `compensable`.** An undo has to put back the exact sibling orders a move or its renormalisation rewrote, and the exact order of an `after`
 * list; the scene patch's inverse restores a list by membership only, and a move's inverse is a position, not the orders around it. So the apply
 * captures one before-image of the nodes and declarations it touched, and the restore writes them back.
 */

import type { CommandDescriptor, ValidationSnapshot } from './command.js';
import { invalid, limitExceeded, requireDeclaredParams, showValue } from './params.js';
import { ok, type CommandError, type Result } from './result.js';
import { TIMELINE_LABEL_MAX, parseTimelineOps, projectTimelineBatch, type TimelineApplyParams } from './timeline.js';

export const timelineApply: CommandDescriptor<TimelineApplyParams> = {
  mutates: 'project',
  agentRisk: 'write-confirm',
  undo: 'compensable',
  validate: (params: unknown, snapshot: ValidationSnapshot): Result<TimelineApplyParams, CommandError> => {
    const p = requireDeclaredParams('timeline.apply', params);
    if (!p.ok) return p;
    const label = p.value['label'];
    if (label !== undefined) {
      if (typeof label !== 'string') return invalid(`params.label must be a string, got ${showValue(label)}`, 'pass label as text, or leave it out', 'label');
      if ([...label].length > TIMELINE_LABEL_MAX) {
        return limitExceeded(`params.label is ${[...label].length} characters, limit ${TIMELINE_LABEL_MAX}`, `shorten label to ${TIMELINE_LABEL_MAX} characters`, 'label');
      }
    }
    const ops = parseTimelineOps(p.value['ops']);
    if (!ops.ok) return ops;
    const projection = projectTimelineBatch(snapshot, ops.value);
    if (!projection.ok) return projection;
    return ok({ ops: ops.value, ...(label === undefined ? {} : { label }) });
  },
};
