/**
 * The drop-reason taxonomy's text — [context-assembly.md](../../../docs/architecture/context-assembly.md)
 * §4 and D8. A drop is recorded once, as structure, and the preview and the `dropped`
 * lines are both read from that record. Nothing re-derives the wording.
 */

import { formatCount } from './text.js';
import type { ContextRef, DropReason, DropRecord } from './types.js';

export function describeDrop(reason: DropReason): string {
  switch (reason.kind) {
    case 'writer-excluded':
      return 'excluded by the writer for this request';
    case 'pin-limit':
      return `beyond the ${reason.limit}-document pin limit`;
    case 'never':
      return 'disabled by include policy (never)';
    case 'empty-description':
      return 'empty description';
    case 'manual-unattached':
      return 'manual policy, not attached to the focus';
    case 'withheld':
      return 'withheld by a read rule, so the agent never sees it';
    case 'forward-outline':
      return 'forward outline withheld (includeForwardOutline is off)';
    case 'scope-limit':
      return `beyond the ${reason.limit}-document scope limit; split the scope`;
    case 'budget':
      return `dropped budget (${reason.layer}, ${reason.budget} tokens, rank ${reason.rank})`;
    case 'total-budget':
      return `dropped total budget (${reason.total} tokens, ${reason.layer}, rank ${reason.rank})`;
    case 'instructions-cap':
      return `${reason.file} is ${formatCount(reason.totalTokens)} tokens; the first ${formatCount(reason.sentTokens)} were sent`;
    case 'reserve-overflow':
      return `the codex's ${reason.pinned === true ? 'always and pinned' : 'always'} entries need ${formatCount(reason.need)} tokens; the layer's budget is ${formatCount(reason.budget)}`;
  }
}

/** A drop record for one item. The text is derived from the reason, so the two cannot disagree. */
export function dropRecord(label: string, reason: DropReason, group?: string, ref?: ContextRef): DropRecord {
  return { label, reason, text: describeDrop(reason), ...(group === undefined ? {} : { group }), ...(ref === undefined ? {} : { ref }) };
}

/** The `dropped` line for a record: `label: reason`. */
export function dropLine(record: DropRecord): string {
  return `${record.label}: ${record.text}`;
}
