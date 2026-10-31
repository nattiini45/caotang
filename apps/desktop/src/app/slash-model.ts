/**
 * What the Intent box shows for a slash command (agent-harness §2, "Slash commands"; ui-modules §1): the note under the box, and the
 * pure rules that read a turn list and a context preview. The controller runs the command; this file holds what needs no session.
 */

import { BUILTIN_COMMANDS, usageOf, type BuiltinCommand, type ContextPreview, type TurnReport } from '@caotang/harness';
import { formatCount } from '../i18n/locale.js';

/** A result shown under the Intent box until the writer dismisses it or sends the next line. It is view state: never saved, never sent. */
export interface CommandNote {
  readonly kind: 'help' | 'ask' | 'context' | 'info';
  readonly title: string;
  readonly lines: readonly string[];
}

/** What the box does with the text after `sendLine`: clear it, or keep it for the writer to correct. */
export type LineOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'shown' }
  | { readonly kind: 'kept' }
  | { readonly kind: 'restore'; readonly turnId: string; readonly summary: string };

const lineOf = (command: BuiltinCommand): string => `${usageOf(command)}  ${command.description}`;

/** `/help`, or `/help draft`. */
export function helpNote(topic?: string): CommandNote {
  const one = topic === undefined ? undefined : BUILTIN_COMMANDS.find((command) => command.name === topic);
  if (one !== undefined) return { kind: 'help', title: `/${one.name}`, lines: [lineOf(one)] };
  const unknown = topic === undefined || topic === '' ? [] : [`There is no command /${topic}.`];
  return {
    kind: 'help',
    title: 'Commands',
    lines: [...unknown, ...BUILTIN_COMMANDS.map(lineOf), 'A title with spaces goes in quotes. Start a request with // to send a slash as text.'],
  };
}

/** `/context`: the layers of the next planner request. Nothing was sent to get it. */
export function contextNote(preview: ContextPreview): CommandNote {
  const lines = preview.layers.filter((layer) => layer.included).map((layer) => `${layer.id} ${layer.name}: ${formatCount(layer.tokens)} tokens${layer.budget === undefined ? '' : ` of ${formatCount(layer.budget)}`}`);
  return {
    kind: 'context',
    title: `The next request would send about ${formatCount(preview.promptTokens)} tokens`,
    lines: [...lines, ...(preview.dropped.length === 0 ? ['Nothing was left out.'] : preview.dropped.map((drop) => `Left out: ${drop}`)), 'No request was sent to work this out.'],
  };
}

/** A turn the panel lists, as `/restore` reads it. */
export interface RestorableTurn {
  readonly turnId: string;
  readonly report: TurnReport | null;
  /** The turn has a checkpoint row. */
  readonly checkpoint: boolean;
  /** The checkpoint's undo group is still on the undo stack. */
  readonly stands: boolean;
}

/**
 * The turn `/restore [last|n|id]` names: the newest turn whose checkpoint still stands, the nth turn in the panel (from 1), or a turn by its id.
 * A turn that cannot be restored is answered in words, so the writer is told why and nothing is offered.
 */
export function restoreTarget(turns: readonly RestorableTurn[], arg: string | undefined): { readonly turn: RestorableTurn } | { readonly says: string } {
  if (arg === undefined || arg === 'last') {
    const last = [...turns].reverse().find((turn) => turn.checkpoint && turn.stands);
    return last === undefined ? { says: 'No finished turn has a checkpoint to restore: nothing the agent did can be put back yet.' } : { turn: last };
  }
  const number = Number(arg);
  const picked = Number.isInteger(number) && number >= 1 ? turns[number - 1] : turns.find((turn) => turn.turnId === arg);
  const name = Number.isInteger(number) ? `Turn ${number}` : `Turn ${arg}`;
  if (picked === undefined) return { says: `${name} is not in this panel. Use /restore last, or the number of a turn listed here.` };
  if (!picked.checkpoint) return { says: `${name} wrote nothing, so there is nothing to restore.` };
  if (!picked.stands) return { says: `${name} was already restored, or the undo history has moved past it.` };
  return { turn: picked };
}
