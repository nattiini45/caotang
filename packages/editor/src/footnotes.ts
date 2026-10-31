/**
 * GFM footnotes (#270): the one rule for **where the notes go and what they are
 * called**, applied to an mdast tree on load and to a ProseMirror document while it
 * is edited.
 *
 * ## The canonical spelling
 *
 * GFM lets a writer put a definition anywhere and call it anything. Caotang writes
 * one spelling, the one remark-stringify already produces for a definition:
 *
 * - every definition is at the end of the document, after the last block of text;
 * - the definitions are in the order their footnotes are first referenced, then the
 *   definitions nothing references, in the order the writer had them;
 * - a **numeric** label is the footnote's position in that order (`[^1]`, `[^2]`, …),
 *   so numbering re-flows when a footnote is added, moved or removed;
 * - a **named** label (`[^note]`) is kept as the writer spelled it, because a name is
 *   a choice and a number is only a count.
 *
 * A body that is already spelled this way loads and saves byte for byte. A body that
 * is not is re-spelled once, and §5's dialect channel says so in one notice
 * (`dialect.ts`); no character of a note is lost.
 *
 * ## Two edge cases the rule settles
 *
 * - **A second definition for the same label.** GFM renders the first and ignores
 *   the rest. Dropping the rest would lose the writer's text, so each is kept as an
 *   unreferenced note under a new name (`<label>-2`), which is not numeric and so is
 *   never re-numbered into a collision.
 * - **A reference with no definition.** Markdown cannot spell one: remark-parse reads
 *   `[^1]` with no `[^1]:` as plain text, so it never reaches the document. Inside the
 *   editor one can appear (a note deleted while its marker stays), and the document
 *   then gains an empty definition for it, so the marker survives the save.
 *
 * The planner below is shared by both representations, so the mdast rule and the
 * editor rule cannot drift apart.
 */
import type { Node as PmNode, Schema } from '@tiptap/pm/model';
import { Fragment } from '@tiptap/pm/model';
import type { FootnoteDefinition, Nodes, Parent, Root, RootContent } from 'mdast';

/**
 * The key two labels share when they name the same footnote — micromark's own
 * normalisation (`micromark-util-normalize-identifier`): runs of whitespace collapse to
 * one space, the ends are trimmed, and case is folded.
 */
export const footnoteKey = (label: string): string =>
  label.replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '').toLowerCase().toUpperCase();

/** A label that is a count rather than a name, and so re-flows. */
export const isNumericLabel = (label: string): boolean => /^[0-9]+$/.test(label);

/** One definition as the planner sees it. */
export interface PlannedDefinition {
  label: string;
  /** The labels of the references inside the definition, in order. */
  innerRefs: readonly string[];
}

/** One footnote of the canonical tail, in order. */
export interface PlannedNote {
  /** Index into the definitions given to the planner, or `null` when one must be created. */
  def: number | null;
  /** The label the note is written with. */
  label: string;
}

export interface FootnotePlan {
  notes: PlannedNote[];
  /** For a reference: its key (`footnoteKey` of its label) → the label it is written with. */
  refLabel: Map<string, string>;
}

/**
 * The canonical tail for a document whose text references `mainRefs` (in order) and
 * whose definitions are `defs` (in order). Pure, and the only place the rule lives.
 */
export const planFootnotes = (mainRefs: readonly string[], defs: readonly PlannedDefinition[]): FootnotePlan => {
  const firstDefByKey = new Map<string, number>();
  defs.forEach((def, index) => {
    const key = footnoteKey(def.label);
    if (!firstDefByKey.has(key)) firstDefByKey.set(key, index);
  });
  const order: Array<{ def: number | null; label: string; key: string | null }> = [];
  const seenKeys = new Set<string>();
  const usedDefs = new Set<number>();
  const visit = (label: string): void => {
    const key = footnoteKey(label);
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const def = firstDefByKey.get(key) ?? null;
    if (def !== null) usedDefs.add(def);
    order.push({ def, label: def !== null ? defs[def]!.label : label, key });
  };
  mainRefs.forEach(visit);
  // A note's own references come after the text's: GFM numbers a footnote inside a
  // footnote by the order the notes are read.
  for (let i = 0; i < order.length; i++) {
    const def = order[i]!.def;
    if (def !== null) defs[def]!.innerRefs.forEach(visit);
  }
  // The notes nothing references, in the writer's order. A second definition for a
  // label is one of them, under a name of its own.
  const takenKeys = new Set(defs.map((def) => footnoteKey(def.label)));
  for (let index = 0; index < defs.length; index++) {
    if (usedDefs.has(index)) continue;
    const def = defs[index]!;
    const key = footnoteKey(def.label);
    if (firstDefByKey.get(key) === index && !seenKeys.has(key)) {
      seenKeys.add(key);
      usedDefs.add(index);
      order.push({ def: index, label: def.label, key });
    } else {
      let n = 2;
      let label = `${def.label}-${n}`;
      while (takenKeys.has(footnoteKey(label))) label = `${def.label}-${++n}`;
      takenKeys.add(footnoteKey(label));
      usedDefs.add(index);
      order.push({ def: index, label, key: null });
    }
    // Its own references may name notes not yet placed.
    const start = order.length - 1;
    for (let i = start; i < order.length; i++) {
      const inner = order[i]!.def;
      if (inner !== null) defs[inner]!.innerRefs.forEach(visit);
    }
  }
  const refLabel = new Map<string, string>();
  const notes = order.map((entry, index) => {
    const label = isNumericLabel(entry.label) ? String(index + 1) : entry.label;
    if (entry.key !== null) refLabel.set(entry.key, label);
    return { def: entry.def, label };
  });
  return { notes, refLabel };
};

// ---------------------------------------------------------------------------
// mdast
// ---------------------------------------------------------------------------

/** What the load-side rule did to a tree, for §5's dialect notice. */
export interface TreeFootnoteResult {
  /** Whether a save writes the footnotes differently from the source. */
  changed: boolean;
  /** Old label → new label, for every label that changed. */
  relabelled: Map<string, string>;
}

const childrenOf = (node: Nodes): Nodes[] | null =>
  'children' in node && Array.isArray(node.children) ? (node.children as Nodes[]) : null;

/** The references inside `node`, in document order, skipping nested definitions. */
const refsIn = (node: Nodes, out: string[]): string[] => {
  for (const child of childrenOf(node) ?? []) {
    if (child.type === 'footnoteReference') out.push(child.label ?? child.identifier);
    else if (child.type !== 'footnoteDefinition') refsIn(child, out);
  }
  return out;
};

/**
 * Removes every `footnoteDefinition` below the root's own children, in document
 * order, and drops a container the removal leaves empty (a block quote that held only
 * a definition). Returns the removed definitions.
 */
const hoistNested = (parent: Parent, out: FootnoteDefinition[], isRoot: boolean): void => {
  const kept: Nodes[] = [];
  for (const child of parent.children as Nodes[]) {
    if (child.type === 'footnoteDefinition') {
      if (isRoot) {
        kept.push(child);
      } else {
        out.push(child);
      }
      // A definition's own nested definitions are not GFM; they stay where they are.
      continue;
    }
    const grand = childrenOf(child);
    if (grand !== null && child.type !== 'paragraph' && child.type !== 'heading') {
      hoistNested(child as Parent, out, false);
      if ((child as Parent).children.length === 0) continue;
    }
    kept.push(child);
  }
  (parent as { children: Nodes[] }).children = kept;
};

/**
 * The load-side rule: rewrites `tree` in place so its footnotes are in the canonical
 * spelling, and reports what changed. A tree with no footnotes is untouched.
 */
export const canonicalizeFootnoteTree = (tree: Root): TreeFootnoteResult => {
  const result: TreeFootnoteResult = { changed: false, relabelled: new Map() };
  const hasAny = (node: Nodes): boolean =>
    node.type === 'footnoteDefinition' || node.type === 'footnoteReference' || (childrenOf(node) ?? []).some(hasAny);
  if (!hasAny(tree)) return result;

  const nested: FootnoteDefinition[] = [];
  hoistNested(tree, nested, true);
  if (nested.length > 0) result.changed = true;

  const body: RootContent[] = [];
  const defs: FootnoteDefinition[] = [];
  let sawDefinition = false;
  for (const child of tree.children) {
    if (child.type === 'footnoteDefinition') {
      defs.push(child);
      sawDefinition = true;
    } else {
      // A block after a definition: the definition moves to the end.
      if (sawDefinition) result.changed = true;
      body.push(child);
    }
  }
  // Nested definitions join the others in document order of their start.
  const allDefs = [...defs, ...nested].sort(
    (a, b) => (a.position?.start.offset ?? 0) - (b.position?.start.offset ?? 0),
  );
  const mainRefs: string[] = [];
  for (const block of body) refsIn(block, mainRefs);
  const plan = planFootnotes(
    mainRefs,
    allDefs.map((def) => ({ label: def.label ?? def.identifier, innerRefs: refsIn(def, []) })),
  );

  const relabel = (node: Nodes): void => {
    for (const child of childrenOf(node) ?? []) {
      if (child.type === 'footnoteReference') {
        const before = child.label ?? child.identifier;
        const after = plan.refLabel.get(footnoteKey(before)) ?? before;
        if (after !== before) {
          result.changed = true;
          result.relabelled.set(before, after);
          child.label = after;
        }
        child.identifier = footnoteKey(after).toLowerCase();
      } else {
        relabel(child);
      }
    }
  };
  for (const block of body) relabel(block);

  const tail: FootnoteDefinition[] = [];
  plan.notes.forEach((note, index) => {
    if (note.def === null) {
      // Unreachable from a parse (an undefined reference is text), kept total anyway.
      tail.push({ type: 'footnoteDefinition', identifier: footnoteKey(note.label).toLowerCase(), label: note.label, children: [] });
      return;
    }
    const def = allDefs[note.def]!;
    if (def !== defs[index]) result.changed = true;
    const before = def.label ?? def.identifier;
    if (before !== note.label) {
      result.changed = true;
      result.relabelled.set(before, note.label);
    }
    def.label = note.label;
    def.identifier = footnoteKey(note.label).toLowerCase();
    relabel(def);
    tail.push(def);
  });
  tree.children = [...body, ...tail];
  return result;
};

// ---------------------------------------------------------------------------
// ProseMirror
// ---------------------------------------------------------------------------

/** The references inside a PM node, in document order. */
const pmRefsIn = (node: PmNode): string[] => {
  const out: string[] = [];
  node.descendants((child) => {
    if (child.type.name === 'footnote_reference') out.push(child.attrs.label as string);
    return child.type.name !== 'footnote_definition';
  });
  return out;
};

/** The doc's definitions (its tail) and the position the tail starts at. */
export const footnoteTail = (doc: PmNode): { start: number; defs: PmNode[] } => {
  const defs: PmNode[] = [];
  let start = doc.content.size;
  let pos = 0;
  doc.forEach((child) => {
    if (child.type.name === 'footnote_definition') {
      if (defs.length === 0) start = pos;
      defs.push(child);
    }
    pos += child.nodeSize;
  });
  return { start, defs };
};

/** Every footnote label the document defines, as keys. */
export const definedFootnoteKeys = (doc: PmNode): Set<string> =>
  new Set(footnoteTail(doc).defs.map((def) => footnoteKey(def.attrs.label as string)));

/** The keys of every footnote the document references (text and notes). */
export const referencedFootnoteKeys = (doc: PmNode): Set<string> => {
  const keys = new Set<string>();
  doc.descendants((child) => {
    if (child.type.name === 'footnote_reference') keys.add(footnoteKey(child.attrs.label as string));
    return true;
  });
  return keys;
};

/**
 * The canonical form of a document's footnotes, as the edits that reach it: a new
 * label per reference that changes, and the tail as it should be. `null` when the
 * document is already canonical.
 */
export interface PmFootnoteFix {
  /** Absolute position of each reference whose label changes, with its new label. */
  relabel: Array<{ pos: number; label: string }>;
  /** The canonical tail, or `null` when the tail itself is already canonical. */
  tail: PmNode[] | null;
  tailStart: number;
  /** Old key → new label, for every note that changed its label. */
  mapping: Map<string, string>;
}

export const planPmFootnotes = (doc: PmNode, schema: Schema = doc.type.schema): PmFootnoteFix | null => {
  const { start, defs } = footnoteTail(doc);
  const mainRefs: string[] = [];
  doc.forEach((child) => {
    if (child.type.name !== 'footnote_definition') mainRefs.push(...pmRefsIn(child));
  });
  if (mainRefs.length === 0 && defs.length === 0) return null;
  const plan = planFootnotes(
    mainRefs,
    defs.map((def) => ({ label: def.attrs.label as string, innerRefs: pmRefsIn(def) })),
  );
  const relabel: Array<{ pos: number; label: string }> = [];
  doc.descendants((child, pos) => {
    if (child.type.name === 'footnote_reference') {
      const before = child.attrs.label as string;
      const after = plan.refLabel.get(footnoteKey(before)) ?? before;
      if (after !== before) relabel.push({ pos, label: after });
    }
    return true;
  });
  const mapping = new Map<string, string>();
  const placedKeys = new Set<string>();
  let tailChanged = plan.notes.length !== defs.length;
  const tail = plan.notes.map((note, index) => {
    if (note.def === null) {
      tailChanged = true;
      return schema.nodes.footnote_definition!.createAndFill({ label: note.label }) as PmNode;
    }
    const def = defs[note.def]!;
    if (note.def !== index) tailChanged = true;
    const before = def.attrs.label as string;
    // The first note for a key is the one its markers name; a second definition is a
    // note of its own under a new name, and its rename says nothing about the markers.
    const first = !placedKeys.has(footnoteKey(before));
    placedKeys.add(footnoteKey(before));
    if (before !== note.label) {
      tailChanged = true;
      if (first) mapping.set(footnoteKey(before), note.label);
    }
    // The references inside a note re-label with the rest.
    const content = relabelFragment(def.content, plan.refLabel, schema);
    if (content !== def.content) tailChanged = true;
    return def.type.create({ ...def.attrs, label: note.label }, content, def.marks);
  });
  // A reference inside a note is relabelled by rebuilding the tail, not twice.
  const tailFrom = start;
  const mainRelabel = relabel.filter((entry) => entry.pos < tailFrom);
  if (mainRelabel.length === 0 && !tailChanged) return null;
  return { relabel: mainRelabel, tail: tailChanged ? tail : null, tailStart: start, mapping };
};

/** `fragment` with every reference relabelled by `refLabel`; the same object when nothing changes. */
const relabelFragment = (fragment: Fragment, refLabel: Map<string, string>, schema: Schema): Fragment => {
  let changed = false;
  const children: PmNode[] = [];
  fragment.forEach((child) => {
    if (child.type.name === 'footnote_reference') {
      const before = child.attrs.label as string;
      const after = refLabel.get(footnoteKey(before)) ?? before;
      if (after !== before) {
        changed = true;
        children.push(child.type.create({ ...child.attrs, label: after }, null, child.marks));
        return;
      }
      children.push(child);
      return;
    }
    if (child.isText || child.isLeaf) {
      children.push(child);
      return;
    }
    const inner = relabelFragment(child.content, refLabel, schema);
    if (inner !== child.content) {
      changed = true;
      children.push(child.copy(inner));
      return;
    }
    children.push(child);
  });
  return changed ? Fragment.fromArray(children) : fragment;
};

/** The next numeric label a new footnote would take before re-flow: one past the count. */
export const nextFootnoteLabel = (doc: PmNode): string => String(footnoteTail(doc).defs.length + 1);
