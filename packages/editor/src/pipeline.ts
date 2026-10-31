/**
 * §5's Markdown pipeline — **load and save**, the two functions every other
 * editor module is built on.
 *
 * [editor-engine.md] §5 is four steps: (1) strip YAML front matter, (2) parse
 * the body projection to a PM doc, (3) the editing session, (4) serialize the
 * body projection back. This module is steps 2 and 4. The other two are not
 * here, and both omissions are deliberate rather than unfinished:
 *
 * - **Step 1, the front-matter strip, is `@caotang/store`'s.** The body
 *   projection is a store concept ([project-format.md] §3), and §2's Tiptap
 *   preflight already settled where the split is: *"§5's front-matter strip is
 * load-bearing (`@caotang/store`'s, not the library's)"* — the finding
 *   F3. A document store that cannot be read without first reaching into a
 *   Markdown library's concerns is a store with a hidden precondition, so the
 *   input here is a body projection and the caller owns the split. The type
 *   name says so: the parameter is `body`, never `file`.
 * - **Step 3, the editing session, is §4's `EditorApi` adapter** (`src/tiptap/`).
 *   This pipeline is deliberately headless and importable with no
 *   engine, no DOM element and no store, so the schema and the round-trip can
 *   be tested as what they are: pure functions over strings.
 *
 * ## remark-gfm is on BOTH chains, and the serialize side is not optional
 *
 * §5 step 2 names only `remarkParse` and `remarkProseMirror`; step 2's
 * serialize side names only `remarkStringify`. Adding `remarkGfm` to the parse
 * side is obvious — it is what makes `~~strike~~`, tables and task lists parse
 * at all. Adding it to the **serialize** side is a *finding*, and §2 records it
 * as F2: `remark-gfm` registers the `delete` **serializer**, so without it
 * `fromPmMark('delete')` produces a well-formed `delete` mdast node and
 * remark-stringify then throws `Cannot handle unknown node \`delete\`` — §3.2's
 * `strike` mark becomes unwritable while still readable. Reading and writing
 * the same document must not have different construct sets, so both chains
 * carry it. `test/pipeline.test.ts` pins this in the only form that survives a
 * regression: a strike round-trips through the shipped `serialize`, **and** a
 * control chain built *without* gfm is shown to throw the exact message, so a
 * passing test cannot be explained by the error being unreachable.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { remarkProseMirror } from '@handlewithcare/remark-prosemirror';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { Node as PmNode, Schema } from '@tiptap/pm/model';
import type { Root as MdastRoot } from 'mdast';
import { caotangSchema } from './schema.js';
import {
  SAVE_STRINGIFY_OPTIONS,
  compiledBlockSpan,
  createParseHandlers,
  warnMergedInlineRuns,
} from './handlers.js';
import type { LossWarning } from './handlers.js';
import { ProvenanceCapture, withProvenance } from './source-provenance.js';
import { toSaveTree } from './save-tree.js';
import { sniffDialect } from './dialect.js';
import type { DialectNotice } from './dialect.js';

/**
 * The save chain, built **once**.
 *
 * §5's options and §3.3's handlers are the same for every save, and a processor
 * is immutable once built — so one module-level instance is safe to reuse.
 * That is the rule `dialect.ts` already follows for its own chains, and the
 * reason it gives is the same one: *"A processor is immutable once built, so
 * one module-level instance is safe to reuse."*
 *
 * **Rebuilding it per call is not free.** Measured on a 15 kB document, 30
 * calls each: a fresh chain per `serialize()` costs 4.448 ms against 3.671 ms
 * for the shared one — **17.5 % of the cost of every keystroke's
 * serialization**, because `serialize` is what a keystroke calls (§9's dirty
 * pipeline hands the store a body on every user edit, and the body is the
 * serialized document). What is left is the document's own cost: the
 * `fromProseMirror` pass and the stringification, which are O(n) in the
 * document and cannot be avoided by a body that is written whole.
 *
 * The handler table is built on the same grounds: `createSerializeHandlers()`
 * returns a fresh object of fresh closures, and nothing in it depends on the
 * document being serialized.
 */
const SAVE_CHAIN = unified()
  .use(remarkGfm)
  .use(remarkStringify, SAVE_STRINGIFY_OPTIONS)
  .freeze();

/**
 * §5 **Save** (step 4): PM doc → mdast (`fromProseMirror`, synchronous) →
 * body projection, through remark-stringify with §5's dialect options.
 *
 * §5's *intent* is the three-character spellings `***` and ` ``` `; the library
 * takes one character and expands it. `CANONICAL_STRINGIFY_OPTIONS` is that
 * translation, and §5's literal spelling is kept alongside it as
 * `SPEC_STRINGIFY_OPTIONS` — asserted to throw, because two of its five values
 * are not legal inputs, and a spec value that is silently "corrected" in a
 * variable is a spec value nobody can check again.
 *
 * The options handed to the processor are `SAVE_STRINGIFY_OPTIONS` rather than
 * the five bare values, because the save carries one handler override (§3.3's
 * `break` row) — and the override is defined in `handlers.ts` next to the options
 * precisely so that `dialect.ts` renders its comparison with the same chain. See
 * `SAVE_STRINGIFY_OPTIONS` for the false positive that separation caused when the
 * two disagreed, and for the test that now holds them together.
 *
 * ## What is deliberately NOT overridden: the list marker
 *
 * The same `handlers` escape hatch could pin every list bullet to §5's `bullet:
 * '-'`, and doing so would be a bug. `mdast-util-to-markdown`'s `list` handler
 * alternates the marker when a list directly follows another list
 * (`handle/list.js:36-37`), and that alternation is what makes two sibling lists
 * survive a round trip. Measured, with two byte-identical `{list, list}` mdast
 * nodes and `bullet: '-'`: the output is `- a\n\n* b\n`, and re-parsing that
 * gives two lists back. Written as `- a\n\n- b\n` instead, the re-parse gives
 * **one** loose list with two items — a different document. Ordered lists behave
 * the same way (`1. a\n\n1) b`). So the marker alternation is required by the
 * round-trip and §5's "one canonical spelling per option setting" holds per list
 * position rather than per document. §5 says so, and
 * `test/degrade.test.ts` pins the measurement, because a future reader looking at
 * `* task` in a saved file and reading §5's sentence as written would be right to
 * call it a defect.
 */
export const serialize = (pm: PmNode): string => {
  return String(SAVE_CHAIN.stringify(toSaveTree(pm)));
};

/**
 * What §5 step 2 produces: the PM `doc`, the `LossWarning[]` the degrade class
 * emits, and the `DialectNotice[]` §5's dialect contract produces. §4 names the
 * carrier (`onLoadDiagnostics?`), and it is this object — a load that returns only
 * a document has thrown the warnings away between the parse and the banner that
 * is supposed to show them.
 *
 * The two arrays are separate because they answer different questions, and
 * merging them would make one of them a lie. `warnings` is *"you lost something"*
 * — a table flattened, a checkbox dropped, a footnote no longer a footnote. `dialect`
 * is *"your document is intact and your spelling is foreign"* — a `&amp;` that
 * saves as `&`, a `*` bullet that saves as `-`. §5 says the second is "specified,
 * documented behavior" and gives it its own banner sentence; the 08:0x decision
 * settled that a decoded entity is *not* a loss for exactly this reason. A caller
 * that wants "will saving change this?" needs both, and a caller that wants "what
 * did I lose?" must read only the first.
 */
export interface ParseResult {
  doc: PmNode;
  warnings: LossWarning[];
  dialect: DialectNotice[];
}

/**
 * §5 **Load** (step 2): a body projection → PM doc, plus §3.3's `LossWarning[]`
 * and §5's `DialectNotice[]`.
 *
 * Returns the `doc` node, not a document object: there is no view, no position
 * and no selection here, which is what lets §4's interface stay the only thing
 * that knows about an engine.
 *
 * `remarkProseMirror` installs a **compiler** (`this.compiler = …`), not a
 * transformer. `run()` applies transformers only, so `run(parse(body))` returns
 * the mdast tree unchanged and any code written that way silently gets mdast
 * back where a PM doc was expected. The compiler is reached through
 * `stringify()`; `run()` first is what makes this correct if a transformer is
 * ever added to this chain. `run()` is typed as returning unist's base `Node`,
 * and with no transformers installed it hands back the very `Root` that `parse`
 * produced — which is what `stringify` takes. The cast is at that one boundary.
 *
 * **Both diagnostic arrays are created here and derived per load**, so §3.3's
 * *"same input → same output"* holds by construction: there is no shared collector
 * for two loads to write into. The dialect sniff reads the same `tree` the
 * compiler consumes rather than re-parsing the body, so it cannot see a different
 * document than the one being loaded — the one thing a second parse pass would put
 * at risk. A body with nothing to degrade and nothing foreign returns `[]` for
 * both, which is the same answer as "the banner has nothing to show" — §4
 * surfaces both lists, and an empty list is a banner that is not drawn.
 */
/**
 * A body whose every block is a link definition. The schema has no node for a definition, so
 * such a body compiles to an empty `doc`, which the library refuses (`Invalid content for node
 * doc: <>`). A manuscript that holds only a reference's target therefore could not be opened.
 * It is handled like an empty body, one empty paragraph, and the definitions are kept in the document's
 * provenance (source-provenance.ts), so a save writes them back.
 */
const definitionsOnly = (tree: MdastRoot): boolean =>
  tree.children.length > 0 && tree.children.every((child) => child.type === 'definition');

export const parseWithDiagnostics = async (body: string): Promise<ParseResult> => {
  const warnings: LossWarning[] = [];
  const capture = new ProvenanceCapture(body);
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkProseMirror, {
      schema: caotangSchema,
      handlers: createParseHandlers(caotangSchema, warnings, capture) as never,
    });
  const tree = (await processor.run(processor.parse(body))) as MdastRoot;
  if (tree.children.length === 0 || definitionsOnly(tree)) {
    // An empty body projection compiles to an empty `doc`, and §3.1's `doc` is
    // `block+` — so the library's own `check()` throws
    // `Invalid content for node doc: <>` (measured while building §4's `mount`). §5 states load is total — *"parse cannot
    // fail (Markdown is total)"* — and **a brand-new empty document is the most
    // common document this product will ever open**, so the hole is in the one
    // path §5 promises cannot fail.
    //
    // Handled before the compiler rather than after it, because the throw happens
    // inside the library's `toProseMirror` and never returns a document to
    // repair. The filled doc is `createAndFill()`'s — one empty paragraph — and it
    // serializes back to `''`, so the round trip is the identity: `getContent()`
    // on a new document returns the empty body it was mounted with.
    //
    // **The policy is here, in `parse`** (`test/pipeline.test.ts` holds the test that pins
    // it). The alternative puts it in §4's `setContent`; the cost of that placement is a
    // precondition every caller has to remember, and no text is invented here —
    // an empty body has no blocks, so one empty paragraph is the only faithful
    // reading of it. docs/decisions.md records the alternative.
    const empty = caotangSchema.topNodeType.createAndFill() as PmNode;
    return { doc: withProvenance(empty, capture.finish(tree, empty, compiledBlockSpan)), warnings, dialect: [] };
  }
  const compiled = processor.stringify(tree) as unknown as PmNode;
  const doc = withProvenance(compiled, capture.finish(tree, compiled, compiledBlockSpan));
  // **After** the compile, on purpose. The handlers own the order of the list this
  // is appended to, and this row is the one warning whose producer does not
  // participate in the compile that produced the others — interleaving it by
  // document position would be a second ordering rule for one list, and §3.3's
  // stability claim is easier to keep when there is one.
  //
  // The walk needs the mdast's *nesting*, and the handler table cannot reach it:
  // the library passes `(node, parent, state)`, mdast has no parent back-pointer,
  // and the case that must be caught is two levels down (`_a [b _c_ d](u) e_`).
  // See `warnMergedInlineRuns` for the measurements and the sibling-shaped
  // premise this replaced. `sniffDialect` below is the same move on §5's channel.
  warnMergedInlineRuns(tree, warnings);
  return { doc, warnings, dialect: sniffDialect(body, tree, doc, warnings) };
};

/**
 * §5 step 2 for callers with nowhere to put a warning — the exact-class suite
 * and the schema parity check.
 *
 * It is a thin projection of `parseWithDiagnostics` rather than a second load
 * path, so the two cannot drift, and `test/degrade.test.ts` asserts that
 * equivalence on all four degrade fixtures. **What it does not do is refuse to
 * be used on a document that does have warnings** — a caller that ignores them
 * is the failure mode §4's carrier exists to prevent, and that is prevented at
 * the call site, in the adapter that has a banner to fill.
 */
export const parse = async (body: string): Promise<PmNode> =>
  (await parseWithDiagnostics(body)).doc;

/**
 * §5's load, **synchronously**, for the one caller that cannot await: the §4 primitives
 * (`replaceRange`, `insertAtSelection`) are synchronous by the seam's signature.
 *
 * It is the same chain as `parseWithDiagnostics` with the diagnostics dropped. A
 * fragment that degrades (a table, a footnote) therefore inserts its degraded form
 * without a banner entry; that is a known gap, recorded where the primitives are
 * documented in `tiptap/adapter.ts`, not something this function can report.
 */
export const parseFragment = (text: string): PmNode => {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkProseMirror, {
      schema: caotangSchema,
      handlers: createParseHandlers(caotangSchema, []) as never,
    });
  const tree = processor.runSync(processor.parse(text)) as MdastRoot;
  if (tree.children.length === 0 || definitionsOnly(tree)) {
    return caotangSchema.topNodeType.createAndFill() as PmNode;
  }
  return processor.stringify(tree) as unknown as PmNode;
};

/**
 * The content a §4 primitive inserts for `text`, read as **body Markdown**.
 *
 * The contract, stated here because the primitive's signature does not state it:
 *
 * - `text` is the body's own spelling. `*Howdy*` inserts emphasis, which saves as `_Howdy_`;
 *   it does not insert four literal characters that save as `\*Howdy\*`. An agent's
 *   rewrite is prose in this dialect, so the primitive reads it in this dialect.
 * - **Edge whitespace is kept.** CommonMark strips a paragraph's leading and trailing
 *   spaces, and an agent's `Ours ` replacing `Mine ` must not lose the space, so the
 *   parse runs on the trimmed text and the trimmed spaces go back in as plain text.
 * - One paragraph inserts its inline content, which fits into the text around the
 *   range. Several blocks, or one non-paragraph block, insert as blocks with open ends,
 *   so the first and last block join the text around the range, which is what a paste
 *   of several paragraphs into the middle of a paragraph does.
 * - Marks are the text's own. The replaced text's marks are not inherited, because an
 *   agent's text states its own emphasis; keeping the old marks would make the agent's
 *   plain `X` over bold text bold, which no spelling in the text asks for.
 *
 * The result is built in `schema`, because the primitive inserts into the live
 * document, which is a different schema instance from `caotangSchema` (the decision the
 * adapter file records as decision 1).
 */
export const insertionOf = (text: string, schema: Schema): Slice => {
  // Only spaces and tabs are the text's own edge whitespace. A newline at either end is a paragraph
  // boundary, and the parse must see it: kept as a character it saves as `&#xA;`.
  const leading = /^[ \t]*/.exec(text)![0];
  // Scanned from the end: `/[ \t]*$/` retries from every start in a run of tabs, which is quadratic.
  let trailingStart = text.length;
  while (trailingStart > 0 && (text[trailingStart - 1] === ' ' || text[trailingStart - 1] === '\t')) trailingStart--;
  const trailing = text.slice(trailingStart);
  const core = text.slice(leading.length, text.length - trailing.length);
  if (core.length === 0) return new Slice(Fragment.from(schema.text(text)), 0, 0);
  const parsed = schema.nodeFromJSON(parseFragment(core).toJSON());
  /** A textblock with the edge whitespace added to its inline content, at the start or the end. */
  const withEdge = (block: PmNode, start: string, end: string): PmNode => {
    const inline: PmNode[] = [];
    if (start.length > 0) inline.push(schema.text(start));
    block.forEach((child) => inline.push(child));
    if (end.length > 0) inline.push(schema.text(end));
    return block.type.create(block.attrs, Fragment.fromArray(inline), block.marks);
  };

  const only = parsed.childCount === 1 ? parsed.firstChild : null;
  if (only !== null && only.type.name === 'paragraph') {
    return new Slice(withEdge(only, leading, trailing).content, 0, 0);
  }
  // The first and last blocks are open, so their inline content joins the text around the
  // range, and the edge whitespace belongs to them. A leaf cannot be opened, so an open end
  // on a leaf would be an invalid slice, and a container's whitespace is between its blocks.
  const blocks: PmNode[] = [];
  parsed.forEach((block) => blocks.push(block));
  const first = blocks[0]!;
  const last = blocks[blocks.length - 1]!;
  const edited = blocks.slice();
  if (first.isTextblock) edited[0] = withEdge(first, leading, blocks.length === 1 ? trailing : '');
  if (blocks.length > 1 && last.isTextblock) edited[blocks.length - 1] = withEdge(last, '', trailing);
  return new Slice(Fragment.fromArray(edited), first.isLeaf ? 0 : 1, last.isLeaf ? 0 : 1);
};

