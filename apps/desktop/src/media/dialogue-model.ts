/**
 * The dialogue view's model: the outline and the graph of one dialogue container, with each finding placed on the
 * node it is about (dialogue-narrative.md §3 and §5). Pure over the Ink body, so the view and the tests read the same thing.
 *
 * The graph is a projection of the Ink text and is never stored (codex-panels §2). The findings come from the
 * engine's `validateContainer`, which runs the inkjs compile, so a loose end is the compiler's own warning. Nothing
 * here edits the body: a node is selected, and the writer edits the Ink text.
 */

import { t } from '@lingui/core/macro';
import type { CodexEntry } from '@caotang/store';

import {
  END_TARGET,
  ROOT_NODE_ID,
  layoutGraph,
  nodeAtOffset,
  unreachableNodes,
  validateContainer,
  type ChoiceRecord,
  type ContainerStats,
  type DialogueFinding,
  type DialogueGraph,
  type GraphLayout,
  type GraphNode,
} from './engines.js';


/* lingui-set comment="Ink diagnostics. Interpolated values: line is a line number; message is the engine's own message." */
/** One speakable line, or a choice label, as the outline lists it. */
export interface OutlineLine {
  readonly kind: 'line' | 'choice';
  readonly speaker: string | null;
  readonly text: string;
  readonly lineId: string | null;
  readonly line: number;
}

export interface OutlineChoice {
  readonly label: string;
  readonly target: string;
  readonly condition: string | null;
  readonly onceOnly: boolean;
  readonly line: number;
}

/** One knot, stitch or the top of the body, with what it holds and the findings about it. */
export interface OutlineNode {
  readonly id: string;
  readonly kind: GraphNode['kind'];
  readonly name: string;
  readonly line: number;
  /** Offset of the node's header line in the body: where the caret goes when the graph card is chosen (dialogue-narrative.md §3). */
  readonly from: number;
  /** 0 for the top of the body and a knot, 1 for a stitch under one. */
  readonly depth: number;
  /** False when no divert or choice names the node: the dead-end finding's subject (dialogue-narrative.md §5). */
  readonly reached: boolean;
  readonly lines: readonly OutlineLine[];
  readonly choices: readonly OutlineChoice[];
  readonly diverts: readonly string[];
  readonly findings: readonly DialogueFinding[];
}

/** One arrow of the graph: a choice label or a divert, between two nodes of the container. */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'choice' | 'divert';
  readonly label: string;
}

export interface DialogueModel {
  readonly docId: string;
  readonly entry: string;
  readonly outline: readonly OutlineNode[];
  readonly layout: GraphLayout;
  readonly edges: readonly GraphEdge[];
  /** Every finding the container raises, in the order the engine gives them. */
  readonly findings: readonly DialogueFinding[];
  readonly stats: ContainerStats;
  /** Compile errors, verbatim with their line. A non-empty list blocks the export. */
  readonly errors: readonly string[];
  /** Compile warnings that are not loose ends, shown as notes. */
  readonly notes: readonly string[];
  readonly parseWarnings: readonly string[];
  readonly variables: readonly string[];
  /** Every knot and stitch id a divert can name, for the Tab completion of a divert target (dialogue-narrative.md §3). */
  readonly targets: readonly string[];
}

/** The node a finding is about: the one its first passage sits in, or the top of the body when no passage places it. */
function nodeOfFinding(graph: DialogueGraph, finding: DialogueFinding): string {
  const offset = finding.evidence[0]?.from;
  if (offset === undefined) return graph.nodes[0]?.id ?? ROOT_NODE_ID;
  return nodeAtOffset(graph, offset)?.id ?? ROOT_NODE_ID;
}

/**
 * A compile error as the view shows it, with its line once. inkjs names the line in its own message ("ERROR: line 3: ..."), and compile.ts
 * keeps that message verbatim, so the prefix is dropped and the line reads in the writer's form, "line 3: ...".
 */
function errorTextOf(error: { readonly text: string; readonly line: number | null }): string {
  if (error.line === null) return error.text;
  const message = error.text.replace(/^(ERROR|WARNING|TODO):\s*/, '');
  const line = error.line;
  return new RegExp(`\\bline ${line}\\b`).test(message) ? message : t`line ${line}: ${message}`;
}

function choiceOf(choice: ChoiceRecord): OutlineChoice {
  return {
    label: choice.label,
    target: choice.target,
    condition: choice.condition ?? null,
    onceOnly: choice.onceOnly,
    line: choice.line,
  };
}

/** The dialogue model of one container body. Pure: the same body and codex always give the same model. */
export function dialogueModelOf(docId: string, body: string, entries: readonly CodexEntry[] = []): DialogueModel {
  const report = validateContainer(docId, body, { entries });
  const graph = report.parsed.graph;
  const unreachable = new Set(unreachableNodes(graph).map((node) => node.id));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  const findingsOf = new Map<string, DialogueFinding[]>();
  for (const finding of report.findings) {
    const id = nodeOfFinding(graph, finding);
    findingsOf.set(id, [...(findingsOf.get(id) ?? []), finding]);
  }

  const outline: OutlineNode[] = graph.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    name: node.kind === 'root' ? t`Top of the body` : node.name,
    line: node.line,
    from: node.from,
    depth: node.kind === 'stitch' ? 1 : 0,
    reached: !unreachable.has(node.id),
    lines: node.lines.map((line) => ({
      kind: line.kind,
      speaker: line.speaker,
      text: line.text,
      lineId: line.lineId,
      line: line.line,
    })),
    choices: node.choices.map(choiceOf),
    diverts: node.diverts.map((divert) => divert.target),
    findings: findingsOf.get(node.id) ?? [],
  }));

  // An edge is drawn only between two nodes of the container. END and the dynamic and fallthrough targets are not nodes.
  const edges: GraphEdge[] = [];
  for (const node of graph.nodes) {
    for (const choice of node.choices) {
      if (choice.target !== END_TARGET && nodeIds.has(choice.target)) {
        edges.push({ from: node.id, to: choice.target, kind: 'choice', label: choice.label });
      }
    }
    for (const divert of node.diverts) {
      if (divert.target !== END_TARGET && nodeIds.has(divert.target)) {
        edges.push({ from: node.id, to: divert.target, kind: 'divert', label: '' });
      }
    }
  }

  return {
    docId,
    entry: graph.entry,
    outline,
    layout: layoutGraph(graph),
    edges,
    findings: report.findings,
    stats: report.stats,
    errors: report.errors.map(errorTextOf),
    notes: report.notes,
    parseWarnings: graph.warnings.map((warning) => {
      const line = warning.line;
      const message = warning.message;
      return t`line ${line}: ${message}`;
    }),
    variables: graph.variables.map((variable) => (variable.default === '' ? `${variable.kind} ${variable.name}` : `${variable.kind} ${variable.name} = ${variable.default}`)),
    targets: graph.nodes.filter((node) => node.kind !== 'root').map((node) => node.id),
  };
}

/**
 * Where the caret goes for a node, read from the text as it is now. The graph is drawn from the text the writer paused on,
 * so its offsets can be behind the text on screen; the offset is read again here, from the header the node names. `null`
 * when the text no longer has that node.
 */
export function caretOfNode(docId: string, body: string, entries: readonly CodexEntry[], nodeId: string): number | null {
  const node = dialogueModelOf(docId, body, entries).outline.find((item) => item.id === nodeId);
  return node === undefined ? null : node.from;
}
