// i18n: package-refs
/**
 * Structural validation and the deterministic findings — [dialogue-narrative.md §2.3 and §5](../../../docs/architecture/dialogue-narrative.md).
 *
 * Three findings, all pure over the parse and the compile, with no model call: an Ink loose
 * end (the compiler's own warning, mapped to the node it sits in), an unreachable knot or
 * stitch (the graph's arithmetic), and a speaker that matches no codex character. Each is
 * shaped as coherence's `Finding` fields (`checkId`, `type`, `severity`, `factGroup`,
 * `evidence`), so the findings inbox reads them with zero new UX.
 *
 * Compile errors are not findings. §5's registry has no check id for an unknown divert or a
 * syntax error, and §2.2 adds no new check class, so they come back as `errors`: a blocking
 * list for the export and the draft gates. That is a spec gap.
 */

import type { Evidence, FindingSeverity } from '@caotang/coherence';
import type { MessageRef } from '@caotang/i18n';
import type { CodexEntry } from '@caotang/store';

import { compileInk, type InkCompileResult, type InkMessage } from './compile.js';
import { nodeAtOffset, parseInk, ROOT_NODE_ID, type DialogueGraph, type GraphNode, type ParsedInk, type PhysicalLine } from './ink-parse.js';
import { resolveSpeakerName } from './speakers.js';

/** §2.3 and §5: the three dialogue checks. Coherence adds them to its closed registry at integration. */
export const BRANCH_CHECK_IDS = ['branch.loose-end', 'branch.dead-end', 'dialogue.speaker-unknown'] as const;
export type BranchCheckId = (typeof BRANCH_CHECK_IDS)[number];

/** §5's severity column: loose ends are warnings; the other two are info. */
export const BRANCH_SEVERITY: Readonly<Record<BranchCheckId, FindingSeverity>> = {
  'branch.loose-end': 'warning',
  'branch.dead-end': 'info',
  'dialogue.speaker-unknown': 'info',
};

export interface DialogueFinding {
  readonly checkId: BranchCheckId;
  readonly type: string;
  readonly severity: FindingSeverity;
  /** coherence.md §4.2: `lower(entity + '|' + attribute)`. Findings that share it render as one group card. */
  readonly factGroup: string;
  /** One or two passages; a passage quotes the Ink line it names. */
  readonly evidence: readonly Evidence[];
  readonly message: string;
  /** I7: the same line as a stable id, values and English template. */
  readonly messageRef?: MessageRef;
  readonly expected?: string;
}

/** §3's inspector stats: parse-derived counts for a container, shown without a model call. */
export interface ContainerStats {
  readonly knots: number;
  readonly stitches: number;
  readonly choices: number;
  /** The findings in the inbox for this container (the warnings the inspector counts). */
  readonly warnings: number;
  /** The compile errors that block the export. */
  readonly errors: number;
}

export interface ValidationReport {
  readonly parsed: ParsedInk;
  readonly compile: InkCompileResult;
  readonly findings: readonly DialogueFinding[];
  /** The compile errors, verbatim. A non-empty list blocks the export and the draft gate. */
  readonly errors: readonly InkMessage[];
  /** Compile warnings that are not loose ends. Shown as notes; no check id covers them. */
  readonly notes: readonly string[];
  readonly stats: ContainerStats;
}

export interface ValidateOptions {
  /** The codex. Absent means the speaker check is not run: without a codex every cue would be "unknown". */
  readonly entries?: readonly CodexEntry[];
}

const LOOSE_END = /Apparent loose end/;
const QUOTE_LIMIT = 200;

/** coherence.md §4.2's key, lowercased as a whole. */
export function groupKey(entity: string, attribute: string): string {
  return `${entity}|${attribute}`.toLowerCase();
}

/**
 * The knots and stitches no divert or choice names. A knot counts as reached when one of its
 * stitches is named, since Ink enters a stitch directly by its name. The root is never unreachable.
 * The draft gate uses this too, so a new beat nothing names is reported the same way everywhere.
 */
export function unreachableNodes(graph: DialogueGraph): GraphNode[] {
  const incoming = new Map<string, number>();
  const count = (target: string): void => {
    incoming.set(target, (incoming.get(target) ?? 0) + 1);
  };
  for (const node of graph.nodes) {
    for (const divert of node.diverts) count(divert.target);
  }
  for (const choice of graph.choices) count(choice.target);
  const namedBy = (id: string): number => incoming.get(id) ?? 0;
  return graph.nodes.filter((node) => {
    if (node.kind === 'root') return false;
    const stitchNamed = node.kind === 'knot' && graph.nodes.some((s) => s.kind === 'stitch' && s.knot === node.id && namedBy(s.id) > 0);
    return namedBy(node.id) === 0 && !stitchNamed;
  });
}

function quoteOf(physical: PhysicalLine, body: string): Evidence {
  const raw = body.slice(physical.from, physical.to).trim();
  const quote = raw.length > QUOTE_LIMIT ? `${raw.slice(0, QUOTE_LIMIT - 1)}…` : raw;
  return { docId: '', quote, from: physical.from, to: physical.to };
}

function labelOf(node: GraphNode): string {
  return node.id === ROOT_NODE_ID ? 'the top of the body' : `"${node.id}"`;
}

/** Runs the three checks over one dialogue container's body. Pure: the same body gives the same findings. */
export function validateContainer(docId: string, body: string, options: ValidateOptions = {}): ValidationReport {
  const parsed = parseInk(body);
  const compile = compileInk(body);
  const findings: DialogueFinding[] = [];
  const withDoc = (evidence: Evidence): Evidence => ({ ...evidence, docId });

  // Loose ends: the compiler's warning, placed on the node its line sits in.
  for (const warning of compile.warnings) {
    if (!LOOSE_END.test(warning.text) || warning.line === null) continue;
    const physical = parsed.physical[warning.line - 1];
    if (physical === undefined) continue;
    const node = nodeAtOffset(parsed.graph, physical.from) ?? parsed.graph.nodes[0];
    if (node === undefined) continue;
    findings.push({
      checkId: 'branch.loose-end',
      type: 'loose-end',
      severity: BRANCH_SEVERITY['branch.loose-end'],
      factGroup: groupKey(node.id, 'loose-end'),
      evidence: [withDoc(quoteOf(physical, body))],
      message: `The flow in ${labelOf(node)} runs out at line ${warning.line}: add a divert, a choice, or -> END.`,
      messageRef: {
        id: 'coherence.branch.looseEnd',
        message: 'The flow in {where} runs out at line {line}: add a divert, a choice, or -> END.',
        values: { where: labelOf(node), line: warning.line },
      },
      expected: 'every path ends in a divert, a choice or END',
    });
  }

  // Unreachable nodes: no divert or choice names them. See unreachableNodes.
  for (const node of unreachableNodes(parsed.graph)) {
    const header = parsed.physical[node.line - 1];
    if (header === undefined) continue;
    findings.push({
      checkId: 'branch.dead-end',
      type: 'unreachable',
      severity: BRANCH_SEVERITY['branch.dead-end'],
      factGroup: groupKey(node.id, 'unreachable'),
      evidence: [withDoc(quoteOf(header, body))],
      message: `"${node.id}" is never diverted to, so no path in the story reaches it.`,
      messageRef: {
        id: 'coherence.branch.deadEnd',
        message: '"{knot}" is never diverted to, so no path in the story reaches it.',
        values: { knot: node.id },
      },
      expected: 'a divert or choice that names it',
    });
  }

  // Speakers: each typed cue name that matches no codex character, once per name.
  if (options.entries !== undefined) {
    const entries = options.entries;
    const seen = new Map<string, { name: string; lines: { physical: PhysicalLine; ambiguous: boolean }[] }>();
    for (const line of parsed.lines) {
      if (line.speaker === null) continue;
      const resolution = resolveSpeakerName(entries, line.speaker);
      if (resolution.kind === 'resolved') continue;
      const key = line.speaker.toLowerCase();
      const entry = seen.get(key) ?? { name: line.speaker, lines: [] };
      const physical = parsed.physical[line.line - 1];
      if (physical !== undefined && entry.lines.length < 2) entry.lines.push({ physical, ambiguous: resolution.kind === 'ambiguous' });
      seen.set(key, entry);
    }
    for (const entry of seen.values()) {
      const ambiguous = entry.lines.some((l) => l.ambiguous);
      findings.push({
        checkId: 'dialogue.speaker-unknown',
        type: ambiguous ? 'ambiguous-speaker' : 'unresolved-speaker',
        severity: BRANCH_SEVERITY['dialogue.speaker-unknown'],
        factGroup: groupKey(entry.name, 'speaker'),
        evidence: entry.lines.map((l) => withDoc(quoteOf(l.physical, body))),
        message: ambiguous
          ? `"${entry.name}" matches more than one codex character. Name the character exactly, or merge the entries.`
          : `"${entry.name}" matches no codex character. Add a character entry, or correct the cue.`,
        messageRef: ambiguous
          ? {
              id: 'coherence.dialogue.ambiguousSpeaker',
              message: '"{speaker}" matches more than one codex character. Name the character exactly, or merge the entries.',
              values: { speaker: entry.name },
            }
          : {
              id: 'coherence.dialogue.unknownSpeaker',
              message: '"{speaker}" matches no codex character. Add a character entry, or correct the cue.',
              values: { speaker: entry.name },
            },
        expected: 'a codex character named or aliased as the cue',
      });
    }
  }

  const knots = parsed.graph.nodes.filter((n) => n.kind === 'knot').length;
  const stitches = parsed.graph.nodes.filter((n) => n.kind === 'stitch').length;
  return {
    parsed,
    compile,
    findings,
    errors: compile.errors,
    notes: compile.warnings.filter((w) => !LOOSE_END.test(w.text)).map((w) => w.text),
    stats: { knots, stitches, choices: parsed.graph.choices.length, warnings: findings.length, errors: compile.errors.length },
  };
}
