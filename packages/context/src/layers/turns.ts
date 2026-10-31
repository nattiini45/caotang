/**
 * L6 — conversation memory — [context-assembly.md §2](../../../../docs/architecture/context-assembly.md).
 *
 * The last two agent turns, each as an intent line and an outcome line with its undo group.
 * It is a compression, not a transcript: the outcome is the activity rows' own digests, and
 * the intent is clipped. Older turns are not sent. The model reads them back through the
 * tools when it needs them (§2: "not context").
 *
 * A turn the writer rewound is not sent, and a turn whose project changes the writer restored says so in its outcome line, so the planner
 * does not assume that work is there. The restore time comes from `config.formatTime`.
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

function utcClock(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 16);
}

/** The note a restored turn's outcome carries: a fixed template and the clock time, never text from a model, a tool or a server. */
function restoredNote(turn: RecentTurn, formatTime: (epochMs: number) => string): string {
  if (turn.restoredAt === undefined) return '';
  const at = formatTime(turn.restoredAt);
  return turn.restoredFromStep === undefined
    ? ` - restored by the writer at ${at}; these changes are no longer in the project`
    : ` - steps ${turn.restoredFromStep} onward restored by the writer at ${at}; those changes are no longer in the project`;
}

function turnBody(turn: RecentTurn, activity: readonly ActivityEntry[], formatTime: (epochMs: number) => string): string {
  const rows = activity.filter((entry) => entry.turnId === turn.turnId);
  // The activity rows are the record. A turn with none (a reply writes none, and a reload empties the log) reads the turn's own fields.
  const fromRows = unique(rows.map((row) => row.summary.trim()).filter((text) => text !== '')).join('; ');
  const outcome = fromRows !== '' ? fromRows : (turn.outcome ?? '').trim();
  const rowGroups = unique(rows.map((row) => row.undoGroupId).filter((id): id is string => id !== undefined));
  const groups = rowGroups.length > 0 || turn.undoGroupId === undefined ? rowGroups : [turn.undoGroupId];
  return [
    `- Turn ${turn.turnId}`,
    `  Intent: ${clip(turn.intent, INTENT_CHARS)}`,
    `  Outcome: ${outcome === '' ? 'no recorded changes' : clip(outcome, OUTCOME_CHARS)}${restoredNote(turn, formatTime)}`,
    `  Undo group: ${groups.length === 0 ? 'none' : groups.join(', ')}`,
  ].join('\n');
}

export function turnsBlock(
  turns: readonly RecentTurn[],
  activity: readonly ActivityEntry[],
  formatTime: (epochMs: number) => string = utcClock,
): TurnsPlan {
  // A rewound or hidden turn leaves before the limit applies, so neither shrinks the two-turn window.
  const kept = turns.filter((turn) => turn.rewound !== true && turn.hidden !== true);
  const recent = kept.slice(-TURN_LIMIT);
  const older = kept.length - recent.length;

  const items: BlockItem[] = [...recent].reverse().map((turn) => ({
    label: `turn ${turn.turnId}`,
    reason: 'one of the last two agent turns',
    body: turnBody(turn, activity, formatTime),
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
