/**
 * LI — the writer's instructions — [context-assembly.md §2](../../../../docs/architecture/context-assembly.md).
 *
 * `CAOTANG.md` (or the `AGENTS.md` it falls back to), then the memory index, each under its own heading, in the user message and
 * labelled as the writer's. Both are plain files in the project (store `agent-files.ts`). The layer carries no date and no `modified`
 * value, so the same files give the same bytes on any day.
 *
 * Each file's lines sit in an untrusted envelope (`untrusted.ts`): the files are not what the writer typed this turn, and a memory note was written
 * by an earlier turn. The envelope tells the model where the text came from, shows hidden characters, and defuses any marker the text carries.
 * It does not take the files' authority away: they still guide style and process (`UNTRUSTED_RULE`).
 *
 * It is never cut silently. Over its cap it sends whole lines up to the cap, and it says so three times: a drop record per file, a
 * layer note, and the sentence both use ("CAOTANG.md is 3,240 tokens; the first 1,500 were sent"). It is not in the total-budget
 * pass's order, so a writer's rules do not vanish because a codex grew. A project with neither file has no such layer.
 */

import { dropRecord, describeDrop } from '../drops.js';
import { charsFor, estimateTokens, tokensForChars } from '../tokens.js';
import type { AppSnapshot, DropReason, DropRecord, LayerItemReport } from '../types.js';
import { STATIC_NONCE, closingOf, neutralise, openingOf } from '../untrusted.js';

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

/**
 * The target of the first `](target)` in a line, where the target is one or more characters that are neither `)` nor white space.
 * Found in one pass: the stop after a target is looked for only past the last one found, so a long line of `](` costs its length once.
 */
function firstLinkTarget(line: string): string | undefined {
  let stop = -1;
  for (let at = line.indexOf(']('); at !== -1; at = line.indexOf('](', at + 1)) {
    const start = at + 2;
    if (stop < start) {
      stop = start;
      while (stop < line.length && line[stop] !== ')' && !/\s/.test(line[stop] as string)) stop += 1;
    }
    if (stop === line.length) return undefined;
    if (stop > start && line[stop] === ')') return line.slice(start, stop);
  }
  return undefined;
}

/**
 * The index lines that do not point at a note the load kept as declined or could not read. The index is rebuilt only when a note is written
 * or forgotten, so a note whose front matter was broken by hand still has its line there; the agent does not see that note, so it does not see
 * its title or first line either. A line is kept when its first link names no such note, so the writer's own lines stay.
 */
function withoutUnseenNotes(lines: readonly string[], app: AppSnapshot): string[] {
  const { declined, unreadable } = app.state.agentFiles;
  if (declined.size === 0 && unreadable.length === 0) return [...lines];
  return lines.filter((line) => {
    const target = firstLinkTarget(line);
    if (target === undefined) return true;
    const path = `memory/${target}`;
    return !declined.has(path) && !unreadable.includes(path);
  });
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
  const indexLines = index === undefined ? [] : withoutUnseenNotes(linesOf(index), app);
  if (indexLines.length > 0) out.push({ file: 'memory/MEMORY.md', heading: '## Memory index', intro: INDEX_INTRO, lines: indexLines });
  return out;
}

/** The layer for a call, held to `budgetTokens`, or `undefined` when the project has no instructions and no memory index. */
export function instructionsLayer(app: AppSnapshot, budgetTokens: number): InstructionsLayer | undefined {
  const sources = sourcesOf(app);
  if (sources.length === 0) return undefined;
  const limit = charsFor(budgetTokens);
  const nonce = app.nonce ?? STATIC_NONCE;
  const close = closingOf(nonce);
  const out: string[] = [HEADING, INTRO];
  let used = HEADING.length + 1 + INTRO.length;
  // The closing marker is part of what a line has to leave room for, so an envelope is never left open.
  const fits = (line: string): boolean => used + 1 + line.length + 1 + close.length <= limit;
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
    const preface = [
      ...(out.length > 0 ? [''] : []),
      source.heading,
      ...(source.intro === undefined ? [] : [source.intro]),
      openingOf({ kind: 'project-file', file: source.file }, nonce),
    ];
    const cost = preface.reduce((sum, line) => sum + 1 + line.length, 0);
    const lines = source.lines.map(neutralise);
    const first = lines[0] as string;
    if (used + cost + 1 + first.length + 1 + close.length <= limit) {
      for (const line of preface) push(line);
      for (const line of lines) {
        if (!fits(line)) break;
        push(line);
        sent.push(line);
      }
      push(close);
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
