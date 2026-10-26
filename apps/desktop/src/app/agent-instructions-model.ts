/**
 * What the Agent instructions panel and the Settings page say about CAOTANG.md and the memory notes (context-assembly.md §2, layer LI).
 *
 * The sizes and the cap line are read from the assembly itself, on a metadata call of the open project (`instructionsReport`), so they cannot
 * disagree with the prompt: "CAOTANG.md is 3,240 tokens; the first 1,500 were sent" is the sentence the layer records when it cuts, and it
 * is shown as it is. Pure over the project and the budget.
 */

import { textDigest } from '@caotang/bus';
import { DEMO_INTENTS } from '@caotang/gateway/mock';
import { estimateTokens, instructionsReport } from '@caotang/harness';
import type { MemoryFile, ProjectState } from '@caotang/store';

/** What "Initialise from this project" asks the agent. The built-in demo provider answers these exact words with a canned draft. */
export const INITIALISE_INTENT = DEMO_INTENTS.instructions;

/** One memory note as the panel lists it. */
export interface NoteRow {
  readonly slug: string;
  readonly title: string;
  readonly type: MemoryFile['type'];
  readonly body: string;
  /** Who wrote it: the agent in a turn, or the writer. */
  readonly origin: 'agent' | 'writer';
  /** The note's own size, in tokens. */
  readonly tokens: number;
  /** The digest the panel's save carries for this note's body. */
  readonly digest: string;
}

/** A note file the load could not read: the panel names it and offers to forget it, and the agent does not see it. */
export interface UnreadableNote {
  readonly path: string;
  readonly slug: string;
}

export interface AgentInstructionsView {
  /** The file the instructions came from, or `null` when the project has none. `AGENTS.md` is read when `CAOTANG.md` is absent. */
  readonly file: 'CAOTANG.md' | 'AGENTS.md' | null;
  readonly text: string;
  /** The digest the panel's save carries, so a change made meanwhile is a conflict and not an overwrite. */
  readonly digest: string;
  /** The size of the instructions and of the memory index, each in tokens. */
  readonly instructionsTokens: number;
  readonly indexTokens: number;
  /** The layer's cap, in tokens: the writer's Settings value, or the default. */
  readonly budget: number;
  /** The tokens the layer sends, whole lines up to the cap. */
  readonly sentTokens: number;
  /** One sentence per file the cap cut. Empty when everything fits. */
  readonly capLines: readonly string[];
  readonly notes: readonly NoteRow[];
  readonly unreadable: readonly UnreadableNote[];
  /** Files the load held back because they are not UTF-8 text, by path. */
  readonly heldBack: readonly string[];
}

/** The panel's view of a project's agent files under the layer's cap. `budget` is the writer's Settings value, when they set one. */
export function agentInstructionsView(state: ProjectState, budget?: number): AgentInstructionsView {
  const files = state.agentFiles;
  const report = instructionsReport(state, budget);
  const text = files.instructions?.text ?? '';
  return {
    file: files.instructions?.path ?? null,
    text,
    digest: textDigest(text),
    instructionsTokens: estimateTokens(text),
    indexTokens: estimateTokens(files.index ?? ''),
    budget: report.budget,
    sentTokens: report.sentTokens,
    capLines: report.capLines,
    notes: files.memory.map((note) => ({
      slug: note.slug,
      title: note.title,
      type: note.type,
      body: note.body,
      origin: note.origin,
      tokens: estimateTokens(note.body),
      digest: textDigest(note.body),
    })),
    unreadable: [...files.declined.keys()].sort().map((path) => ({ path, slug: path.slice('memory/'.length, -'.md'.length) })),
    heldBack: [...files.unreadable],
  };
}

/** A count with its noun: `1 token`, `1,500 tokens`. */
export function tokensLabel(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'token' : 'tokens'}`;
}
