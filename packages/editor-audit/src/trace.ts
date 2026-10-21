/**
 * The preflight's measuring instrument.
 *
 * A preflight that only asserts "it worked" measures nothing (the
 * library's own suite is 5 shapes). What the preflight asks
 * for is a **per-construct result table**, so this module records, for one
 * corpus entry: the mdast types the parse actually saw, the PM node/mark
 * types it produced, the round-trip bytes, and whether the outcome was stable.
 *
 * The important property: this reports what happened, it does not assert what
 * should have happened. The assertions live in the test, where a deviation is
 * a finding to be written into §2 — not an exception to be caught here.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { fromProseMirror, remarkProseMirror } from '@handlewithcare/remark-prosemirror';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Nodes, Root as MdastRoot } from 'mdast';
import { caotangSchema } from './schema.js';
import {
  CANONICAL_STRINGIFY_OPTIONS,
  createParseHandlers,
  createSerializeHandlers,
} from './handlers.js';

/** §3.3's loss classes, in the order the spec states them. */
export type Class = 'exact' | 'degrade' | 'lost';

export interface ConstructResult {
  name: string;
  group: string;
  /** The mdast types remark-parse actually produced for this input. */
  mdastTypes: string[];
  /** The PM node type names the parse produced. */
  pmNodes: string[];
  /** The PM mark type names present anywhere in the resulting doc. */
  pmMarks: string[];
  /** `serialize(parse(input))`. */
  output: string;
  /** §3.3's bar, measured against the newline-terminated body projection. */
  byteIdentical: boolean;
  /** The same comparison without the trailing-newline allowance. */
  byteIdenticalRaw: boolean;
  /** §3.3's real bar: same input → same bytes, always. */
  deterministic: boolean;
  /** The construct's fate, derived from the round-trip — not declared. */
  outcome: Class;
  /** A human-readable note for §2's table. Empty when nothing is notable. */
  note: string;
  /** The error the library threw, if it threw instead of degrading. */
  threw: string | null;
}

/**
 * A minimal mdast walker. Written here rather than taken from `unist-util-visit`
 * because that package is not in §2's pin table, and the install criterion is
 * "the §2 pin table exact" — the preflight must not widen the dependency
 * surface it is auditing. The corpus trees are small and this is the only walk.
 */
const collectTypes = (node: unknown, into: Set<string>): void => {
  if (!node || typeof node !== 'object') return;
  const typed = node as { type?: unknown; children?: unknown };
  if (typeof typed.type === 'string') into.add(typed.type);
  if (Array.isArray(typed.children)) {
    for (const child of typed.children) collectTypes(child, into);
  }
};

const mdastTypesOf = (tree: MdastRoot): string[] => {
  const types = new Set<string>();
  collectTypes(tree, types);
  return [...types].sort();
};

const pmShapeOf = (pm: PmNode): { nodes: string[]; marks: string[] } => {
  const nodes = new Set<string>();
  const marks = new Set<string>();
  pm.descendants((node) => {
    nodes.add(node.type.name);
    for (const mark of node.marks) marks.add(mark.type.name);
  });
  return { nodes: [...nodes].sort(), marks: [...marks].sort() };
};

/**
 * §5 **Save**: PM → mdast (`fromProseMirror`, sync) → body projection through
 * remark-stringify with §5's dialect options.
 *
 * `remarkGfm` is on the **serialize** chain as well as the parse chain, and
 * that is a finding rather than a detail: §5 step 2 names only `remarkStringify`.
 * Measured without it, `fromPmMark('delete')` produces a well-formed
 * `delete` mdast node and remark-stringify then throws
 * `Cannot handle unknown node `delete`` — so §3.2's `strike` mark cannot be
 * written without it. `remark-gfm` registers the `delete` *serializer*; the
 * parse side alone is not enough. See §2 finding F2.
 */
export const serialize = (pm: PmNode): string => {
  const handlers = createSerializeHandlers();
  const tree = fromProseMirror(pm, {
    schema: caotangSchema,
    nodeHandlers: handlers as never,
    markHandlers: handlers as never,
  });
  return String(
    unified()
      .use(remarkGfm)
      .use(remarkStringify, { ...CANONICAL_STRINGIFY_OPTIONS })
      .stringify(tree),
  );
};

/** §5 **Load**: remark-parse + remark-gfm + the §3.3 handler table → PM doc. */
export const parse = async (body: string): Promise<PmNode> => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkProseMirror, {
      schema: caotangSchema,
      handlers: createParseHandlers(caotangSchema) as never,
    });
  // `remarkProseMirror` installs a **compiler** (`this.compiler = …`), not a
  // transformer. `run()` applies transformers only, so `run(parse(body))`
  // returns the mdast tree unchanged and any code written that way silently
  // gets mdast back where a PM doc was expected. The compiler is reached
  // through `stringify()`; `run()` first is what makes this correct if a
  // future transformer is ever added to the chain.
  // `run()` is typed as returning unist's base `Node`; with no transformers
  // installed it hands back the very `Root` that `parse` produced, which is
  // what `stringify` takes. The cast is at that one boundary.
  const tree = (await processor.run(processor.parse(body))) as MdastRoot;
  return processor.stringify(tree) as unknown as PmNode;
};

/**
 * The body projection is newline-terminated — every real `doc.<id>.md` body is,
 * and remark-stringify always emits a trailing `\n`. Comparing a fixture that
 * has no trailing newline against output that does would make **every** corpus
 * entry "not byte-identical" and the flag would carry no information, so the
 * comparison is made against the newline-terminated form. The *un*normalized
 * comparison is still reported, as `byteIdenticalRaw`.
 */
const newlineTerminated = (s: string): string => (s.endsWith('\n') ? s : `${s}\n`);

/**
 * One mdast node's entry in a tree's **shape**: its type, with the attributes
 * §3.1 declares folded into it — plus, for a fence, the info-string `meta`.
 *
 * The attributes are the point of the fold. A task list item that comes back
 * without its `checked` is the same *kind* of node as the one that went in, so
 * a shape that counted node types alone would call that round trip exact when
 * §3.3's own table calls it a degrade. The same is true of a heading that
 * changed depth and of a link that changed its URL.
 *
 * `meta` is folded in for the same reason even though §3.1 declares no
 * attribute for it: the loader keeps only `lang` and the serializer writes
 * only `lang`, so a round trip of `` ```js title=x `` deletes `title=x` from
 * the document. A shape that did not carry `meta` would measure that deletion
 * exact — the false-exact class this comparison exists to catch.
 */
const shapeEntry = (node: Nodes): string => {
  switch (node.type) {
    case 'heading':
      return `heading:${node.depth}`;
    case 'list':
      return `list:${node.ordered ? 'ordered' : 'bullet'}:${node.start ?? 1}`;
    case 'listItem':
      return `listItem:${node.checked === null || node.checked === undefined ? '' : String(node.checked)}`;
    case 'link':
      return `link:${node.url}:${node.title ?? ''}`;
    case 'image':
      return `image:${node.url}:${node.alt ?? ''}:${node.title ?? ''}`;
    case 'code':
      return `code:${node.lang ?? ''}:${node.meta ?? ''}`;
    case 'inlineCode':
      return 'inlineCode';
    case 'text':
      return 'text';
    case 'html':
      return `html:${node.value}`;
    default:
      return node.type;
  }
};

/**
 * A tree's shape: **the things a round trip must not change**.
 *
 * Two parts, and the second is the one a stripped string cannot see:
 *
 * - the **nodes**, one entry per node in document order, so a mark that was
 *   lost shows up as a missing entry and a mark that was invented shows up as
 *   an extra one;
 * - the **text**, concatenated in document order, so a construct whose
 *   *characters* were dropped is caught even when its nodes are all still
 *   there.
 *
 * The comparison is on the shape and not on the bytes, because the bytes are
 * allowed to change: §3.3's exact-content row says *"content lossless; syntax
 * normalization per §5"*, and §5's own line says *"a loss is not a
 * re-spelling, and the two are counted separately"*. A `*` bullet list and a
 * `-` bullet list are the same shape; the second is the first written the way
 * Caotang writes it.
 */
interface TreeShape {
  readonly entries: string[];
  readonly text: string;
}

const treeShape = (tree: MdastRoot): TreeShape => {
  const entries: string[] = [];
  const text: string[] = [];
  const walk = (node: Nodes): void => {
    entries.push(shapeEntry(node));
    if (node.type === 'text') {
      // **A soft break is a space, not a character.** CommonMark says a line
      // break inside a paragraph is whitespace, so `> first\ncontinued lazily`
      // and `> first continued lazily` are the same sentence and the one that
      // comes back from a round trip is the other spelling of it. A *hard*
      // break is not a text node's newline — it is a `break` node — so it is
      // not folded here, and a line break the writer asked for is still a line
      // break. The fold is for text nodes only: a newline inside a code
      // block's value is content.
      text.push(node.value.replace(/\n/g, ' '));
    } else if (
      node.type === 'inlineCode' ||
      node.type === 'code' ||
      node.type === 'html'
    ) {
      text.push(node.value);
    }
    if ('children' in node) {
      for (const child of node.children) walk(child as Nodes);
    }
  };
  for (const child of tree.children) walk(child);
  return { entries, text: text.join('') };
};

/** Whether the two trees hold the same nodes, in the same order. */
const sameStructure = (left: TreeShape, right: TreeShape): boolean =>
  left.entries.length === right.entries.length &&
  left.entries.every((entry, at) => entry === right.entries[at]);

/** Whether the two trees hold the same text. */
const sameText = (left: TreeShape, right: TreeShape): boolean => left.text === right.text;

/**
 * Round-trip one corpus entry and report what happened.
 *
 * `outcome` is DERIVED from the round trip, never declared by the fixture — so a
 * handler-table bug surfaces as a downgrade in the result table instead of
 * being papered over by a fixture that claims a class it did not achieve.
 *
 * **The classes are measured on the construct's shape, not on its letters.**
 * The comparison this replaces stripped both sides down to `[a-z0-9]`, which
 * cannot see a mark that was lost — `_gone and _struck_ together_` and
 * `_gone and struck together_` reduce to the same letters, so a nested
 * emphasis that §3.3 calls a degrade read as an exact round trip. The same
 * stripping made a CJK sentence reduce to the empty string, and an empty
 * string is the "the round-trip produced no content" reading of *lost*.
 */
export const measure = async (entry: {
  name: string;
  group: string;
  input: string;
}): Promise<ConstructResult> => {
  // A separate processor for the mdast tree: the one above has
  // `remarkProseMirror` installed, whose compiler returns a PM doc, so asking
  // it for the raw tree would be asking the wrong question.
  const tree = unified().use(remarkParse).use(remarkGfm).parse(entry.input) as MdastRoot;
  const inputShape = treeShape(tree);

  let pm: PmNode | null = null;
  let threw: string | null = null;
  let determinismFailed: string | null = null;
  let outputUnreadable: string | null = null;
  let output = '';
  let deterministic = false;
  let outputShape: TreeShape | null = null;
  // The round trip itself, in a try of its own: a failure here is **the
  // library throwing**, and it is the only thing that is.
  try {
    pm = await parse(entry.input);
    output = serialize(pm);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  // **The two re-checks get their own tries, because their failures are
  // different facts.** Neither of them is the library throwing: the round trip
  // has already succeeded by the time they run, and what failed is the
  // instrument's second reading of it. A `threw` on either would put a
  // self-contradictory row on the table — a row that says the library threw
  // *and* that the round trip was deterministic — and would force
  // `byteIdentical` to false on bytes that are identical.
  //
  // **The contract of the table is unchanged by the split**: a failure in any
  // of the three surfaces as a result — a row that says what happened — rather
  // than as a rejection that kills the batch.
  if (threw === null) {
    try {
      deterministic = output === serialize(await parse(entry.input));
    } catch (error) {
      determinismFailed = error instanceof Error ? error.message : String(error);
    }
    try {
      // The output's shape, read back from the bytes a save would write. This is
      // the comparison that matters: the question is not what the serializer wrote
      // but what a reader — or the next parse — gets back.
      outputShape = treeShape(
        unified().use(remarkParse).use(remarkGfm).parse(output) as MdastRoot,
      );
    } catch (error) {
      outputUnreadable = error instanceof Error ? error.message : String(error);
    }
  }

  const shape = pm ? pmShapeOf(pm) : { nodes: [], marks: [] };
  const byteIdenticalRaw = threw === null && output === entry.input;
  const byteIdentical = threw === null && output === newlineTerminated(entry.input);

  let outcome: Class;
  let note: string;
  if (threw !== null) {
    outcome = 'lost';
    note = 'library threw instead of degrading';
  } else if (outputUnreadable !== null) {
    // The bytes a save would write cannot be read back, so there is no shape to
    // compare and nothing a reader would get. That is a loss, and it is **not**
    // the library throwing — the round trip itself succeeded, and what failed
    // is the reading of its own output.
    outcome = 'lost';
    note = `the round-trip output could not be read back: ${outputUnreadable}`;
  } else if (
    outputShape !== null &&
    outputShape.text.trim() === '' &&
    inputShape.text.trim() !== ''
  ) {
    // **"No content" means no content**, and the emptiness is measured on the
    // text itself: a sentence in a script that is not Latin-alphabet is not
    // the empty string, and calling it a loss would report a round trip that
    // returned every character as one that returned none.
    outcome = 'lost';
    note = 'round-trip produced no content';
  } else if (
    outputShape !== null &&
    sameStructure(inputShape, outputShape) &&
    sameText(inputShape, outputShape)
  ) {
    outcome = 'exact';
    // The spelling may still have been normalized — §5's dialect owns that,
    // and §3.3 says a re-spelling is not a loss — so the note says so rather
    // than leaving the reader to wonder why the bytes moved.
    note = byteIdentical ? '' : 'byte-normalized to the canonical dialect spelling';
  } else {
    outcome = 'degrade';
    note =
      outputShape !== null && !sameStructure(inputShape, outputShape)
        ? 'the round-trip changed the construct’s structure'
        : 'content changed across the round-trip';
  }
  // The determinism re-check is the instrument's own second reading, so its
  // failure is a **note** and not a class: the round trip's own result stands,
  // and the row says that the stability claim could not be checked.
  if (determinismFailed !== null) {
    note =
      note === ''
        ? `the determinism re-check could not be completed: ${determinismFailed}`
        : `${note}; the determinism re-check could not be completed: ${determinismFailed}`;
  }

  return {
    name: entry.name,
    group: entry.group,
    mdastTypes: mdastTypesOf(tree),
    pmNodes: shape.nodes,
    pmMarks: shape.marks,
    output,
    byteIdentical,
    byteIdenticalRaw,
    deterministic,
    outcome,
    note,
    threw,
  };
};
