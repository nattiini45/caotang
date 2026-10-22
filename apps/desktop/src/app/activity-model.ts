/**
 * The activity panel's view model ([command-bus.md] §8 and §5). One row per executed command, in
 * the order a writer reads a history: newest first, with a title for the command, the digest the
 * apply wrote (`summary`), who issued it and where it came from. Each undo group carries one
 * affordance, on its newest row, while the group can still be undone.
 *
 * View events stay in the log, because §8 says the log holds every executed command. They are
 * hidden here unless asked for, since a writer asking "what changed" is not asking about the
 * selection.
 */

import type { ActivityEntry, CommandName, UndoGroup } from '@caotang/bus';
import { CHECKPOINT_LABEL, type TurnReport } from '@caotang/harness';

import { phaseLabel, type TurnView } from './agent-model.js';

/** A person's name for each command. Typed over the closed set, so a new command is a compile error here. */
export const COMMAND_TITLES: Readonly<Record<CommandName, string>> = {
  'binder.create': 'New item',
  'binder.move': 'Moved',
  'binder.rename': 'Renamed',
  'binder.setMeta': 'Status, label or keywords changed',
  'binder.setSynopsis': 'Synopsis changed',
  'notes.set': 'Notes changed',
  'notes.append': 'Notes added to',
  'doc.write': 'Text saved',
  'editor.insert': 'Text inserted',
  'editor.replaceRange': 'Text replaced',
  'codex.upsert': 'Codex entry saved',
  'codex.attach': 'Codex attachment changed',
  'export.compile': 'Manuscript exported',
  'export.compileSelection': 'Part of the manuscript exported',
  'project.deleteNode': 'Deleted',
  'view.setSelection': 'Selection changed',
  'view.setActiveDoc': 'Opened in the editor',
  'view.setScroll': 'Scrolled',
  'view.setExpanded': 'Expanded or collapsed',
  'view.setCorkboardScope': 'Corkboard scope changed',
  'coherence.setSceneMeta': 'Scene declarations changed',
  'coherence.setFindingStatus': 'Finding status changed',
  'coherence.discardRun': 'Check run discarded',
  // The external call, and the storyboard shot commands (command-bus §9, the closed set's additions).
  'mcp.invoke': 'External tool called',
  'mcp.readResource': 'External resource read',
  'storyboard.create': 'Storyboard created',
  'shot.create': 'Shot added',
  'shot.setMeta': 'Shot details changed',
  // The project block, the saved recipes, the vocabulary and the cover import (command-bus §9's additions).
  'project.rename': 'Project renamed',
  'project.setMetadata': 'Project details changed',
  'project.importAsset': 'Image imported',
  'vocabulary.upsert': 'Status or label saved',
  'vocabulary.remove': 'Status or label removed',
  'recipe.save': 'Export recipe saved',
  'recipe.delete': 'Export recipe deleted',
  'binder.saveFilter': 'Saved filter changed',
  'binder.deleteFilter': 'Saved filter deleted',
  'project.saveGoal': 'Goal changed',
  'project.deleteGoal': 'Goal deleted',
  'shot.importImage': 'Image added to shot',
  'screenplay.import': 'Script imported',
  'dialogue.importInk': 'Ink story imported',
  'dialogue.setMeta': 'Dialogue settings changed',
  // The project's skills (extensibility.md §10).
  'skill.import': 'Skill imported',
  'skill.write': 'Skill saved',
  'skill.delete': 'Skill deleted',
  'skill.setEnabled': 'Skill turned on or off',
};

export function titleOf(command: string): string {
  return COMMAND_TITLES[command as CommandName] ?? command;
}

export function isViewEvent(command: string): boolean {
  return command.startsWith('view.');
}

export function sourceBadge(source: ActivityEntry['source']): string {
  return source === 'mcp' ? 'MCP' : 'Native';
}

export function issuerLabel(issuedBy: ActivityEntry['issuedBy']): string {
  return issuedBy === 'agent' ? 'Agent' : 'You';
}

export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export interface ActivityRow {
  /** The row's position in the whole log, which is stable as the log grows: a key for the list. */
  readonly index: number;
  readonly entry: ActivityEntry;
  readonly title: string;
  /** The group this row can undo, on the newest row of a group that is still in the undo store. */
  readonly undo: UndoGroup | null;
}

/**
 * The rows to show, newest first. `groupOf` answers from the undo store, so a group that has been
 * undone (and so is gone from it) loses its affordance without any bookkeeping here.
 *
 * `limit` keeps the newest rows only, and builds no row for the ones behind them: the log holds a row
 * for every command of the sitting, and the panel renders on every change of the session
 * (activity-window.ts).
 */
export function activityRows(
  entries: readonly ActivityEntry[],
  options: {
    readonly showViews: boolean;
    readonly groupOf: (id: string) => UndoGroup | undefined;
    readonly limit?: number;
  },
): ActivityRow[] {
  const claimed = new Set<string>();
  const rows: ActivityRow[] = [];
  // A whole, non-negative count of rows: the check below runs before each push, so `0` builds nothing and a fractional limit is
  // floored rather than rounded up. Without this the signature would promise "the newest `limit` rows" and hand back one more.
  const limit = limitOf(options.limit);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (rows.length >= limit) break;
    const entry = entries[index];
    if (entry === undefined || (!options.showViews && isViewEvent(entry.command))) continue;
    let undo: UndoGroup | null = null;
    const groupId = entry.undoGroupId;
    if (groupId !== undefined && !claimed.has(groupId)) {
      claimed.add(groupId);
      undo = options.groupOf(groupId) ?? null;
    }
    rows.push({ index, entry, title: titleOf(entry.command), undo });
  }
  return rows;
}

/**
 * The number of rows a window holds.
 *
 * A whole, non-negative count: `0` holds none, and a fractional count is floored rather than rounded
 * up. A count that is not a number is not a count at all, and a check against one never ends — so the
 * window would hold every row of the log, which is the cost it exists to prevent. It holds none
 * instead. A count of infinity is the one that says "all of them", and it is kept.
 */
function limitOf(requested: number | undefined): number {
  if (requested === undefined) return Number.POSITIVE_INFINITY;
  if (Number.isNaN(requested)) return 0;
  return Math.max(0, Math.floor(requested));
}

/**
 * How many rows the panel shows: the log's rows, without the view events unless the writer asks for
 * them. The count is a walk over the log and builds nothing, so the panel knows how many rows it
 * keeps back without building the rows behind its window (activity-window.ts).
 */
export function visibleActivityCount(entries: readonly ActivityEntry[], showViews: boolean): number {
  let count = 0;
  // The same walk `activityRows` makes, guarding a hole the same way, so the count and the rows the panel builds agree: a row
  // `activityRows` refuses to build is a row this does not count, and "Show older" can always reach zero.
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (showViews || !isViewEvent(entry.command)) count += 1;
  }
  return count;
}

export interface ActivityMarkdownInput {
  readonly title: string;
  readonly entries: readonly ActivityEntry[];
  readonly turns: readonly TurnView[];
  /** The export's time, as a pure input so the file is the same for the same history. Defaults to now. */
  readonly now?: number;
}

/**
 * The activity log and the agent's turns as one Markdown file (agent-harness §5: the Markdown export carries the whole
 * log). Every executed
 * command is a row, in the order it ran, with who issued it and where it came from. Each agent turn is a section: its intent,
 * how it ended, what it wrote, and the checkpoint that takes it back. View events are left out, as the panel leaves them out
 * unless asked for.
 */
export function activityMarkdown(input: ActivityMarkdownInput): string {
  const at = new Date(input.now ?? Date.now()).toISOString();
  const lines: string[] = [];
  lines.push(`# Activity: ${input.title}`, '', `Exported ${at}.`, '');

  if (input.turns.length > 0) {
    lines.push('## Agent turns', '');
    for (const turn of input.turns) {
      lines.push(`### ${oneLine(turn.intent)}`, '');
      lines.push(`- Turn: \`${turn.turnId}\``);
      lines.push(`- Ended: ${turn.report === null ? phaseLabel(turn.phase) : endedWord(turn.report)}`);
      if (turn.report !== null) {
        lines.push(`- Summary: ${oneLine(turn.report.summary)}`);
        lines.push(`- Model calls: ${turn.report.modelCalls}; tokens in ${turn.report.tokens.promptTokens}, out ${turn.report.tokens.completionTokens}`);
      }
      if (turn.checkpoint !== null) lines.push(`- Checkpoint: ${CHECKPOINT_LABEL} (undo group \`${turn.checkpoint.undoGroupId}\`)`);
      for (const card of turn.cards) {
        const detail = card.summary ?? card.error;
        lines.push(`- Call \`${card.tool}\`: ${card.status}${detail === undefined ? '' : ` — ${oneLine(detail)}`}`);
      }
      lines.push('');
    }
  }

  const rows = input.entries.filter((entry) => !entry.command.startsWith('view.'));
  lines.push('## Changes', '');
  if (rows.length === 0) {
    lines.push('Nothing has changed in this project yet.', '');
  } else {
    lines.push('| # | Time | Command | Summary | Issued by | Source | Undo group |', '| --- | --- | --- | --- | --- | --- | --- |');
    rows.forEach((entry, index) => {
      const cells = [
        String(index + 1),
        new Date(entry.at).toISOString(),
        titleOf(entry.command),
        // Backslash first: a summary ending in `\` would otherwise escape the pipe that closes its cell.
        oneLine(entry.summary).replace(/\\/g, '\\\\').replace(/\|/g, '\\|'),
        issuerLabel(entry.issuedBy),
        sourceBadge(entry.source),
        entry.undoGroupId ?? '',
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    });
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function endedWord(report: TurnReport): string {
  switch (report.status) {
    case 'applied':
      return 'applied';
    case 'replied':
      return 'answered';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'stopped';
  }
}
