/**
 * Whole-story `.ink` import — [dialogue-narrative.md §4 (Import, v0.2-of-track)](../../../docs/architecture/dialogue-narrative.md).
 *
 * A whole Ink story becomes containers, one per knot-cluster. A cluster is a set of top-level
 * knots (with their stitches) that divert to one another, or that call one shared function,
 * joined by union. A container therefore compiles on its own: nothing in it names a knot that
 * lives in another container. Global declarations (`VAR`, `CONST`, `LIST`) are global wherever
 * they are written, even under a knot. Each stays where it is written, and every other container
 * that uses it gets a copy at its head. A declaration whose divert names a knot pulls that knot
 * into the same cluster. Content outside every knot is the preamble, the story's entry; it is not
 * a container, and the plan says where it sends the story.
 *
 * This is a plan, not a write. The integration decides the containers' ids and writes them.
 */

import { parseInk, ROOT_NODE_ID, type DialogueGraph, type GraphNode, type VariableDecl } from './ink-parse.js';
import { ensureLineIds, lineIdsOf, type MintOptions } from './line-ids.js';

export interface ImportedContainer {
  /** The first knot's name, which is what the binder shows. */
  readonly title: string;
  /** The top-level knots and functions the container holds, in body order. */
  readonly knots: readonly string[];
  /** The container's Ink body: the global declarations it uses and does not hold, then its sections. */
  readonly body: string;
}

export interface InkImportPlan {
  readonly containers: readonly ImportedContainer[];
  /**
   * The text outside every section, minus the declarations a container copied. Not a container.
   * A declaration no container copies stays where it is written.
   */
  readonly preamble: string;
  /** Every global declaration line, in body order, wherever it is written. */
  readonly globals: readonly string[];
  /** The top-level names the root sends the story to. Empty when the root only declares. */
  readonly entryDiverts: readonly string[];
  readonly notes: readonly string[];
}

interface Section {
  readonly name: string;
  readonly kind: 'knot' | 'function';
  readonly from: number;
  readonly to: number;
  /** Top-level names this section reaches: diverts into other knots, and calls to functions. */
  readonly reaches: readonly string[];
}

class Union {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root] ?? root;
    return root;
  }

  join(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** The top-level knot a node belongs to: a knot is its own, a stitch is its knot's. */
function topLevelOf(graph: DialogueGraph, id: string): string | undefined {
  const node: GraphNode | undefined = graph.nodes.find((n) => n.id === id);
  if (node === undefined || node.kind === 'root') return undefined;
  return node.knot === '' ? node.id : node.knot;
}

function callsFunction(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(text);
}

function usesGlobal(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

/** The divert targets written in a declaration: `VAR dest = -> vault` names `vault`. */
const DECLARED_DIVERT = /->\s*([A-Za-z_][A-Za-z0-9_]*)/g;

/** Plans the import of one whole-story Ink file. Pure: the same source gives the same plan. */
export function planInkImport(source: string): InkImportPlan {
  const parsed = parseInk(source);
  const graph = parsed.graph;
  const notes: string[] = [];
  const declLine = (decl: VariableDecl): string => source.slice(decl.from, decl.to).trim();
  const globals = graph.variables.map(declLine);

  const sections: Section[] = [
    ...graph.nodes
      .filter((n) => n.kind === 'knot')
      .map((knot): Section => ({
        name: knot.id,
        kind: 'knot',
        from: knot.from,
        to: knot.subtreeTo,
        reaches: graph.nodes
          .filter((n) => n.kind !== 'root' && (n.knot === knot.id || n.id === knot.id))
          .flatMap((n) => [...n.diverts.map((d) => d.target), ...n.choices.map((c) => c.target)])
          .map((target) => topLevelOf(graph, target))
          .filter((name): name is string => name !== undefined && name !== knot.id),
      })),
    ...graph.functions.map((fn): Section => ({ name: fn.name, kind: 'function', from: fn.from, to: fn.to, reaches: [] })),
  ].sort((a, b) => a.from - b.from);

  if (sections.length === 0) {
    notes.push('The body has no knots: it is one flow, imported as a single container.');
    return { containers: [{ title: 'Imported story', knots: [], body: source }], preamble: '', globals, entryDiverts: [], notes };
  }

  const texts = sections.map((s) => source.slice(s.from, s.to));
  const index = new Map(sections.map((s, i) => [s.name, i]));
  const decls = graph.variables;
  // The section each declaration sits in, or -1 when it sits outside every section.
  const homeOf = decls.map((v) => sections.findIndex((s) => v.from >= s.from && v.from < s.to));
  const targetsOf = decls.map((v) => [...source.slice(v.from, v.to).matchAll(DECLARED_DIVERT)].map((m) => m[1] ?? ''));

  const union = new Union(sections.length);
  sections.forEach((section, i) => {
    for (const name of section.reaches) {
      const other = index.get(name);
      if (other !== undefined) union.join(i, other);
    }
    sections.forEach((callee, j) => {
      if (callee.kind === 'function' && callsFunction(texts[i] ?? '', callee.name)) union.join(i, j);
    });
    // A declaration a section uses travels with it, so the knots its own divert names travel too.
    decls.forEach((v, d) => {
      if (!usesGlobal(texts[i] ?? '', v.name)) return;
      for (const target of targetsOf[d] ?? []) {
        const other = index.get(target);
        if (other !== undefined) union.join(i, other);
      }
    });
  });

  const groups = new Map<number, number[]>();
  sections.forEach((_, i) => {
    const root = union.find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });

  const copied = new Set<number>();
  const containers: ImportedContainer[] = [...groups.values()]
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
    .map((members) => {
      const text = members.map((i) => texts[i] ?? '').join('\n\n');
      // A declaration the container already holds, because it sits in one of the container's own sections, is not copied.
      const headLines: string[] = [];
      decls.forEach((v, d) => {
        if (members.includes(homeOf[d] ?? -1) || !usesGlobal(text, v.name)) return;
        copied.add(d);
        headLines.push(declLine(v));
      });
      const head = headLines.length > 0 ? `${headLines.join('\n')}\n\n` : '';
      const memberSections = members.map((i) => sections[i]).filter((s): s is Section => s !== undefined);
      const title = memberSections.find((s) => s.kind === 'knot')?.name ?? memberSections[0]?.name ?? 'Imported dialogue';
      return {
        title,
        knots: memberSections.map((s) => s.name),
        body: `${head}${text.trimEnd()}\n`,
      };
    });

  const preamble = preambleOf(source, sections, decls.filter((_, d) => copied.has(d)));
  const entryDiverts = graph.nodes
    .filter((n) => n.id === ROOT_NODE_ID)
    .flatMap((n) => n.diverts.map((d) => d.target))
    .map((target) => topLevelOf(graph, target))
    .filter((name): name is string => name !== undefined);
  if (entryDiverts.length > 0) {
    notes.push(`The story starts at the top of the body and sends the reader to ${entryDiverts.join(', ')}. That entry is not a container: recreate it in the project.`);
  }
  for (const warning of graph.warnings) notes.push(`line ${warning.line}: ${warning.message}`);
  return { containers, preamble, globals, entryDiverts, notes };
}

/**
 * The text outside every section, with the declarations that a container copied taken out. A
 * declaration no container copied stays in the text where it is written.
 */
function preambleOf(source: string, sections: readonly Section[], decls: readonly { from: number; to: number }[]): string {
  const cuts = [...sections.map((s) => ({ from: s.from, to: s.to })), ...decls.map((d) => ({ from: d.from, to: d.to }))].sort((a, b) => a.from - b.from);
  let out = '';
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.from > cursor) out += source.slice(cursor, cut.from);
    cursor = Math.max(cursor, cut.to);
  }
  return out.trim();
}

export interface ImportIdOptions {
  /** Randomness, injectable so a fixture mints the same ids every run. */
  readonly randomBytes?: MintOptions['randomBytes'];
  /** Ids held elsewhere in the project, avoided on top of every id already in the plan. */
  readonly taken?: ReadonlySet<string>;
  /** The compile gate. A container whose body compiled before minting and does not after keeps its text as written. */
  readonly compiles?: (body: string) => boolean;
}

export interface ImportIdResult {
  readonly containers: readonly ImportedContainer[];
  /** Ids written across every container. */
  readonly minted: number;
  /** Lines that need an id and cannot take one, with the container that holds them. */
  readonly unplaceable: readonly { readonly title: string; readonly line: number; readonly text: string }[];
  /** Ids the source already wrote in more than one place. They are kept as written, never renamed. */
  readonly duplicatesInSource: readonly string[];
  /** Containers left as written because the minted text did not compile. */
  readonly kept: readonly string[];
}

/**
 * The one-shot mint of an import (dialogue-narrative.md A3): every container's lines that have no id get one, from one set
 * of taken ids shared by the whole plan, so no two containers hold the same id. The ids already in the source are kept.
 * Pure: the caller dispatches the result, so the ids and the containers land in one undo step.
 */
export function mintImportIds(containers: readonly ImportedContainer[], options: ImportIdOptions = {}): ImportIdResult {
  const taken = new Set<string>(options.taken ?? []);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const container of containers) {
    for (const { lineId } of lineIdsOf(container.body)) {
      if (seen.has(lineId)) duplicates.add(lineId);
      seen.add(lineId);
      taken.add(lineId);
    }
  }

  let minted = 0;
  const unplaceable: { title: string; line: number; text: string }[] = [];
  const kept: string[] = [];
  const next = containers.map((container): ImportedContainer => {
    const result = ensureLineIds(container.body, { taken, ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }) });
    for (const line of result.unplaceable) unplaceable.push({ title: container.title, line: line.line, text: line.text });
    if (result.minted.length === 0) return container;
    if (options.compiles !== undefined && options.compiles(container.body) && !options.compiles(result.body)) {
      kept.push(container.title);
      return container;
    }
    for (const { lineId } of result.minted) taken.add(lineId);
    minted += result.minted.length;
    return { ...container, body: result.body };
  });
  return { containers: next, minted, unplaceable, duplicatesInSource: [...duplicates], kept };
}
