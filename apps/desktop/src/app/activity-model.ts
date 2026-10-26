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
/* lingui-set comment="Interpolated values: at, calls, completion, detail, ended, id, intent, label, prompt, status, summary, title, tool" */

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import type { ActivityEntry, CommandName, UndoGroup } from '@caotang/bus';
import { CHECKPOINT_LABEL, type TurnReport } from '@caotang/harness';
import { timeFormat } from '@caotang/i18n';

import { formatterLocale } from '../i18n/format-locale.js';
import { phaseLabel, type TurnView } from './agent-model.js';

/**
 * A person's name for each command, as a message descriptor (I5). The descriptor is translated when the
 * row is built, not when the module loads, so a live interface switch re-reads the label with everything
 * else. Typed over the closed set, so a new command is a compile error here.
 */
export const COMMAND_TITLES: Readonly<Record<CommandName, MessageDescriptor>> = {
  'binder.create': msg`New item`,
  'binder.move': msg`Moved`,
  'binder.rename': msg`Renamed`,
  'binder.setMeta': msg`Status, label or keywords changed`,
  'binder.setSynopsis': msg`Synopsis changed`,
  'notes.set': msg`Notes changed`,
  'notes.append': msg`Notes added to`,
  'doc.write': msg`Text saved`,
  'editor.insert': msg`Text inserted`,
  'editor.replaceRange': msg`Text replaced`,
  'codex.upsert': msg`Codex entry saved`,
  'codex.attach': msg`Codex attachment changed`,
  'export.compile': msg`Manuscript exported`,
  'export.compileSelection': msg`Part of the manuscript exported`,
  'project.deleteNode': msg`Deleted`,
  'view.setSelection': msg`Selection changed`,
  'view.setActiveDoc': msg`Opened in the editor`,
  'view.setScroll': msg`Scrolled`,
  'view.setExpanded': msg`Expanded or collapsed`,
  'view.setCorkboardScope': msg`Corkboard scope changed`,
  'coherence.setSceneMeta': msg`Scene declarations changed`,
  'coherence.setFindingStatus': msg`Finding status changed`,
  'coherence.discardRun': msg`Check run discarded`,
  'coherence.addKnowledgeFact': msg`Knowledge fact added`,
  'coherence.editKnowledgeFact': msg`Knowledge fact changed`,
  'coherence.removeKnowledgeFact': msg`Knowledge fact removed`,
  // The external call, and the storyboard shot commands (command-bus §9, the closed set's additions).
  'mcp.invoke': msg`External tool called`,
  'mcp.readResource': msg`External resource read`,
  'storyboard.create': msg`Storyboard created`,
  'shot.create': msg`Shot added`,
  'shot.setMeta': msg`Shot details changed`,
  // The project block, the saved recipes, the vocabulary and the cover import (command-bus §9's additions).
  'project.rename': msg`Project renamed`,
  'project.setMetadata': msg`Project details changed`,
  'project.importAsset': msg`Image imported`,
  'vocabulary.upsert': msg`Status or label saved`,
  'vocabulary.remove': msg`Status or label removed`,
  'recipe.save': msg`Export recipe saved`,
  'recipe.delete': msg`Export recipe deleted`,
  'binder.saveFilter': msg`Saved filter changed`,
  'binder.deleteFilter': msg`Saved filter deleted`,
  'project.saveGoal': msg`Goal changed`,
  'project.deleteGoal': msg`Goal deleted`,
  'shot.importImage': msg`Image added to shot`,
  'shot.importImages': msg`Images added to shots`,
  'screenplay.import': msg`Script imported`,
  'dialogue.importInk': msg`Ink story imported`,
  'dialogue.setMeta': msg`Dialogue settings changed`,
  // The project's skills (extensibility.md §10).
  'skill.import': msg`Skill imported`,
  'skill.write': msg`Skill saved`,
  'skill.delete': msg`Skill deleted`,
  'skill.setEnabled': msg`Skill turned on or off`,
};

export function titleOf(command: string): string {
  const known = COMMAND_TITLES[command as CommandName];
  return known === undefined ? command : i18n._(known);
}

/** The command-id prefix of a view event. A pattern rather than a string, so it is not mistaken for interface copy. */
const VIEW_COMMAND = /^view\./;

export function isViewEvent(command: string): boolean {
  return VIEW_COMMAND.test(command);
}

export function sourceBadge(source: ActivityEntry['source']): string {
  return source === 'mcp' ? 'MCP' : t`Native`;
}

export function issuerLabel(issuedBy: ActivityEntry['issuedBy']): string {
  return issuedBy === 'agent' ? t`Agent` : t`You`;
}

/** The row's time, as a clock time in the formatter locale (i18n.md §4.2), never the system locale by accident. */
export function timeLabel(at: number, locale: string = formatterLocale()): string {
  return timeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(at));
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
  lines.push(t`# Activity: ${{ title: input.title }}`, '', t`Exported ${{ at }}.`, '');

  if (input.turns.length > 0) {
    lines.push(t`## Agent turns`, '');
    for (const turn of input.turns) {
      lines.push(t`### ${{ intent: oneLine(turn.intent) }}`, '');
      lines.push(t`- Turn: \`${{ id: turn.turnId }}\``);
      lines.push(t`- Ended: ${{ ended: turn.report === null ? phaseLabel(turn.phase) : endedWord(turn.report) }}`);
      if (turn.report !== null) {
        lines.push(t`- Summary: ${{ summary: oneLine(turn.report.summary) }}`);
        lines.push(
          t`- Model calls: ${{ calls: turn.report.modelCalls }}; tokens in ${{ prompt: turn.report.tokens.promptTokens }}, out ${{ completion: turn.report.tokens.completionTokens }}`,
        );
      }
      if (turn.checkpoint !== null) {
        lines.push(t`- Checkpoint: ${{ label: CHECKPOINT_LABEL }} (undo group \`${{ id: turn.checkpoint.undoGroupId }}\`)`);
      }
      for (const card of turn.cards) {
        const detail = card.summary ?? card.error;
        lines.push(
          detail === undefined
            ? t`- Call \`${{ tool: card.tool }}\`: ${{ status: card.status }}`
            : t`- Call \`${{ tool: card.tool }}\`: ${{ status: card.status }} — ${{ detail: oneLine(detail) }}`,
        );
      }
      lines.push('');
    }
  }

  const rows = input.entries.filter((entry) => !isViewEvent(entry.command));
  lines.push(t`## Changes`, '');
  if (rows.length === 0) {
    lines.push(t`Nothing has changed in this project yet.`, '');
  } else {
    lines.push(t`| # | Time | Command | Summary | Issued by | Source | Undo group |`, '| --- | --- | --- | --- | --- | --- | --- |');
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
      return t`applied`;
    case 'replied':
      return t`answered`;
    case 'cancelled':
      return t`cancelled`;
    default:
      return t`stopped`;
  }
}
