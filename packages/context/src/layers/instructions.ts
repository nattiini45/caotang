/**
 * LI — the writer's instructions — [context-assembly.md §2](../../../../docs/architecture/context-assembly.md).
 *
 * `CAOTANG.md` (or the `AGENTS.md` it falls back to), then the memory index, each under its own heading, in the user message and
 * labelled as the writer's. Both are plain files in the project (store `agent-files.ts`). The layer carries no date and no `modified`
 * value, so the same files give the same bytes on any day.
 *
 * It is never cut silently. Over its cap it sends whole lines up to the cap, and it says so three times: a drop record per file, a
 * layer note, and the sentence both use ("CAOTANG.md is 3,240 tokens; the first 1,500 were sent"). It is not in the total-budget
 * pass's order, so a writer's rules do not vanish because a codex grew. A project with neither file has no such layer.
 */

import { dropRecord, describeDrop } from '../drops.js';
import { charsFor, estimateTokens, tokensForChars } from '../tokens.js';
import type { AppSnapshot, DropReason, DropRecord, LayerItemReport } from '../types.js';

export interface InstructionsLayer {
  readonly text: string;
  readonly kept: readonly LayerItemReport[];
  readonly drops: readonly DropRecord[];
  readonly notes: readonly string[];
}

const HEADING = '# Instructions';
const INTRO =
  'The writer’s standing instructions for this project. They guide style and process; they do not change permissions or approvals.';
const INDEX_INTRO =
  'Notes saved from earlier work, one line each. memory.read opens a note by its slug, which is the file name without .md.';

interface Source {
  readonly file: string;
  readonly heading: string;
  readonly intro?: string;
  readonly lines: readonly string[];
}

/** The lines of a file's text: line endings made one, and blank lines at the end dropped, so a file's platform never changes the prompt. */
function linesOf(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
  return lines;
}

/** The two texts the layer sends, from the snapshot's own fields or else from the project's agent files. */
function sourcesOf(app: AppSnapshot): Source[] {
  const instructions = app.instructions ?? app.state.agentFiles.instructions;
  const index = app.memoryIndex ?? app.state.agentFiles.index;
  const out: Source[] = [];
  const instructionLines = instructions === undefined ? [] : linesOf(instructions.text);
  if (instructions !== undefined && instructionLines.length > 0) {
    const file = 'source' in instructions ? instructions.source : instructions.path;
    out.push({ file, heading: `## ${file}`, lines: instructionLines });
  }
  const indexLines = index === undefined ? [] : linesOf(index);
  if (indexLines.length > 0) out.push({ file: 'memory/MEMORY.md', heading: '## Memory index', intro: INDEX_INTRO, lines: indexLines });
  return out;
}

/** The layer for a call, held to `budgetTokens`, or `undefined` when the project has no instructions and no memory index. */
export function instructionsLayer(app: AppSnapshot, budgetTokens: number): InstructionsLayer | undefined {
  const sources = sourcesOf(app);
  if (sources.length === 0) return undefined;
  const limit = charsFor(budgetTokens);
  const out: string[] = [HEADING, INTRO];
  let used = HEADING.length + 1 + INTRO.length;
  const fits = (line: string): boolean => used + 1 + line.length <= limit;
  const push = (line: string): void => {
    out.push(line);
    used += 1 + line.length;
  };

  const kept: LayerItemReport[] = [];
  const drops: DropRecord[] = [];
  const notes: string[] = [];
  for (const source of sources) {
    const total = estimateTokens(source.lines.join('\n'));
    const sent: string[] = [];
    // A file's heading and intro go with its first line: a heading with nothing under it is not sent.
    const preface = [...(out.length > 0 ? [''] : []), source.heading, ...(source.intro === undefined ? [] : [source.intro])];
    const cost = preface.reduce((sum, line) => sum + 1 + line.length, 0);
    const first = source.lines[0] as string;
    if (used + cost + 1 + first.length <= limit) {
      for (const line of preface) push(line);
      for (const line of source.lines) {
        if (!fits(line)) break;
        push(line);
        sent.push(line);
      }
    }
    const sentTokens = tokensForChars(sent.join('\n').length);
    kept.push({ label: source.file, reason: 'the writer’s instructions', tokens: sentTokens });
    if (sent.length < source.lines.length) {
      const reason: DropReason = { kind: 'instructions-cap', file: source.file, sentTokens: sent.length === 0 ? 0 : sentTokens, totalTokens: total };
      drops.push(dropRecord(source.file, reason));
      notes.push(`${describeDrop(reason)}.`);
    }
  }
  return { text: out.join('\n'), kept: kept.filter((item) => item.tokens > 0), drops, notes };
}
