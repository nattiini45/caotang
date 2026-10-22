/**
 * L6 — conversation memory — [context-assembly.md §2](../../../../docs/architecture/context-assembly.md).
 *
 * The last two agent turns, each as an intent line and an outcome line with its undo group.
 * It is a compression, not a transcript: the outcome is the activity rows' own digests, and
 * the intent is clipped. Older turns are not sent. The model reads them back through the
 * tools when it needs them (§2: "not context").
 *
 * Rank is newest first. Display is oldest first, the order the turns happened in.
 */

import type { ActivityEntry } from '@caotang/bus';

import { newBlock, type Block, type BlockItem } from '../block.js';
import { TURN_LIMIT } from '../profiles.js';
import { clip, unique } from '../text.js';
import { LAYER_NAMES, type RecentTurn } from '../types.js';

/** The intent and outcome line lengths. A line over its limit is clipped with an ellipsis. */
const INTENT_CHARS = 160;
const OUTCOME_CHARS = 240;

export interface TurnsPlan {
  readonly block: Block;
  readonly notes: readonly string[];
}

function turnBody(turn: RecentTurn, activity: readonly ActivityEntry[]): string {
  const rows = activity.filter((entry) => entry.turnId === turn.turnId);
  // The activity rows are the record. A turn with none (a reply writes none, and a reload empties the log) reads the turn's own fields.
  const fromRows = unique(rows.map((row) => row.summary.trim()).filter((text) => text !== '')).join('; ');
  const outcome = fromRows !== '' ? fromRows : (turn.outcome ?? '').trim();
  const rowGroups = unique(rows.map((row) => row.undoGroupId).filter((id): id is string => id !== undefined));
  const groups = rowGroups.length > 0 || turn.undoGroupId === undefined ? rowGroups : [turn.undoGroupId];
  return [
    `- Turn ${turn.turnId}`,
    `  Intent: ${clip(turn.intent, INTENT_CHARS)}`,
    `  Outcome: ${outcome === '' ? 'no recorded changes' : clip(outcome, OUTCOME_CHARS)}`,
    `  Undo group: ${groups.length === 0 ? 'none' : groups.join(', ')}`,
  ].join('\n');
}

export function turnsBlock(turns: readonly RecentTurn[], activity: readonly ActivityEntry[]): TurnsPlan {
  const recent = turns.slice(-TURN_LIMIT);
  const older = turns.length - recent.length;

  const items: BlockItem[] = [...recent].reverse().map((turn) => ({
    label: `turn ${turn.turnId}`,
    reason: 'one of the last two agent turns',
    body: turnBody(turn, activity),
    protected: false,
    group: 'turn',
  }));
  // Rank 0 is the newest. Reading the display oldest first reverses the rank order.
  const display = recent.map((_, index) => recent.length - 1 - index);

  const notes =
    older > 0
      ? [`${older} earlier ${older === 1 ? 'turn is' : 'turns are'} not sent; the agent's tools can read them back.`]
      : [];
  return {
    block: newBlock({
      id: 'L6',
      header: `# ${LAYER_NAMES.L6}`,
      empty: '(no earlier agent turns in this session)',
      cut: '(older turns were not sent)',
      items,
      display,
    }),
    notes,
  };
}
