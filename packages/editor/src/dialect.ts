/**
 * §5's dialect contract, implemented: **"count computed by parse-side dialect
 * sniffing: any construct whose canonical form differs from its source
 * spelling"** — the mechanism §5 names for the *"saving will re-style N
 * paragraphs"* banner, and which until now existed only as a sentence.
 *
 * ## What this is not
 *
 * It is not a loss channel and it does not share one. A dialect notice says the
 * **document** is intact and the **spelling** is foreign: `&amp;` is decoded to
 * `&` by remark-parse, `* item` is re-written `- item`, a setext heading becomes
 * ATX, and none of them loses a character the writer typed. §5 calls that
 * "specified, documented behavior", and this module's whole job is to make it
 * *countable* without calling it a loss — the distinction the 08:0x decision drew
 * when it settled a task item's dropped checkbox as `lossy-attribute` and
 * refused to make a decoded `&amp;` one. A reader who is told "3 of your
 * paragraphs will be re-spelled" must not also be told they lost something.
 *
 * ## The rule, and why it is a comparison rather than a list
 *
 * The rule is one sentence: for each top-level block, serialize that block the
 * way a save would, and compare it with the block's own **source slice** (from
 * the mdast `position` offsets). Different means a save re-spells it. There is no
 * table of foreign constructs anywhere in this file, and that is the point — the
 * spec's rule is about *canonical form versus source spelling*, so a construct
 * nobody thought of (`\]`, `&notarealentity;`, a `&#x41;` hex reference) is
 * caught by the same comparison that catches `*em*`, and nothing has to be
 * added to a list to keep the banner honest.
 *
 * Two things were measured before this shape was chosen, and both decided it:
 *
 * 1. **Per-node comparison is unusable.** Applied to every node, it fires on
 *    *every* text node in *every* document: remark-stringify terminates a block
 *    with a newline the source slice does not have, and a text node at root
 *    scope escapes a leading space as `&#x20;`. A rule that reports one notice
 *    for a canonical document is worse than no rule — it is the 08:0x decision's
 *    own rejected option ("fires on every ampersand … trains the reader to
 *    ignore the table"), reached by a different road.
 * 2. **Top-level comparison does not over-count.** Canonical form is a function
 *    of the subtree, so a block's canonical form differs from its source spelling
 *    exactly when something inside it does — including something nested. One
 *    comparison per top-level block therefore reports each changed block once,
 *    which is what makes the count mean something: §5's banner says *N
 *    paragraphs*, and a count that read 4 for one `* item` list would be a
 *    number no reader could act on.
 *
 * 3. **A block has to be rendered in *document* context, or the count is wrong.**
 *    `mdast-util-to-markdown` alternates a list's marker when a list directly
 *    precedes it (`handle/list.js:36-37`), so `- a\n\n- b` saves as `- a\n\n* b`.
 *    Rendering each block in isolation says both blocks are already canonical and
 *    reports **zero** for a document that changes on save — a wrong zero, which is
 *    the one failure this channel cannot have.
 *
 * ## How the context is obtained, and why the obvious way costs a second and a half per load
 *
 * The obvious reading of "in context" is *the tail of the canonical form of the prefix that
 * ends with this block*: render blocks `1…i+1`, subtract blocks `1…i`, keep what is
 * left. That is correct, and it is `O(n²)` — every block re-converted the whole
 * document before it. **1 586 ms** for a 400-block / 19 kB document, measured.
 *
 * The same shape measured 763 ms for a whole `parseWithDiagnostics` on a
 * smaller fixture, and the quadratic was *inherited* rather than new. The fix is the
 * other of the two options: **the offsets come from the serializer.** The library already renders
 * the whole document in one pass and produces one string per top-level block on the
 * way out; `recordRootBlocks` below is a `join` rule — a documented option of
 * `remark-stringify` — that wraps its dispatcher and keeps those strings as they
 * are produced. One render, `O(n)`, **55 ms** on the same document.
 *
 * **A divide and conquer over the prefixes was built and measured first, and it is
 * not a fix.** It renders prefixes `1 … n` too, only in a different order, and a sum
 * does not care what order it is added up in. 955 ms against 1 586 ms looked like
 * a 23× win because the *arithmetic* says 23×; the arithmetic was wrong. Recorded
 * here because the number is the kind that survives into a commit as a result.
 *
 * **The derivation is kept honest three ways, and each is a named test:** the
 * prefix algorithm is still in this file as the fallback and is compared against
 * the recorded one block for block over the whole §13 corpus and over a 400-block
 * document; the recorder *refuses its own result* unless it captured every block
 * after the first and each capture is the very block it claims; and the return
 * value says which derivation produced it (`OwnTexts.via`), because both produce
 * the same numbers and a guard that cannot tell them apart is measuring the
 * fallback and calling it the mechanism.
 *
 * The prefix rendering is exact for *preceding*-sibling effects (which is the
 * class that forced it) and approximate for *following*-sibling effects, which
 * would show up as a false positive. The recorded rendering has no such edge — it
 * is the serializer's own output for that node — so this limit belongs to the
 * fallback alone, and the corpus sweep is what shows the class is empty there.
 * The guard exists because the approximation has a known edge, not because the
 * edge has been reasoned away.
 *
 * The newline trims are the one concession to the block context: a source slice
 * starts and ends at the block's own characters, while a serialized block is
 * wrapped in the separators its neighbours require. Trimming the leading and
 * trailing separators is the difference between "this block is foreign" and
 * "every block is foreign".
 *
 * ## Degrade blocks are skipped, and that is the load-bearing part
 *
 * A degrade construct changes the bytes too, and for a much worse reason, so
 * counting it here as well would report the same change twice — once as "will be
 * re-spelled" and once as "you lost the table". A block that contains a degrade
 * node is therefore left to `LossWarning`, which is the channel that says what
 * was lost. A GFM task item counts as a degrade here even though `listItem` is
 * not a degrade *type* (`handlers.ts` explains why), because its byte change is
 * the dropped checkbox and its warning already says so.
 *
 * ## The boundary, and the reason for it — both rewritten 2026-10-05
 *
 * The boundary is **real and the old reason for it was false**, and the two have
 * to be taken separately, because the note made the weaker one carry the
 * stronger one.
 *
 * **The boundary: what is compared is what a save writes.** Every block is
 * rendered through the *save* path — the ProseMirror document, sliced at that
 * block's boundary, converted back to mdast by `fromProseMirror` and stringified
 * with the save's own chain — and that is compared with the block's source slice.
 * This is a change from the earlier version of this file, which stringified the
 * **parse** tree instead. The parse tree is not a proxy for the save, and the
 * difference is not theoretical: a loose list survives the parse tree as
 * `spread: true`, so the old comparison called `- one\n\n- two` canonical while a
 * save writes `- one\n- two`. **`DialectNotice.canonical` is documented as "the
 * block as a save will write it", and for any block containing a list that was
 * not true** — the field told a writer one thing and the file on disk did
 * another. No test caught it because every notice the suite asserted was a
 * non-list construct, and for those the two renderings agree.
 *
 * **Not the reason: "declared by the pinned options".** §5's amendment
 * and the previous version of this file both exempted the serialize-side
 * normalizations because they are *"declared by §5's own pinned option list"* —
 * a loose list "because `fromPmNode('list')` hard-codes `spread: false`", nested
 * levels "because §5 pins `listItemIndent: 'one'`". Measured, 2026-10-05:
 *
 * 1. **`listItemIndent` is not a cause of anything here.** The nested blank line
 *    appears with the key **absent**, with `'one'` and with `'tab'` — the option
 *    changes the *indentation* and never the blank line. It is easy to name as
 *    the cause; it is not one.
 * 2. **The real cause is that the ProseMirror schema cannot carry Markdown list
 *    looseness.** `fromPmNode('list')` pins `spread: false`, and
 *    `fromPmNode('listItem')` emits no `spread` field at all — so a tight nested
 *    list gains the blank line that a loose item would have had. Both are
 *    Caotang's own handler table, not a dialect option.
 * 3. **The exemption was incoherent anyway.** The counted families are caused by
 *    pinned options *just as much*: `* item` → `- item` is `bullet: '-'`, `*em*` →
 *    `_em_` is `emphasis: '_'`, `---` → `***` is `rule: '***'`. The dialect **is**
 *    the option list, so "caused by a pinned option" cannot be the reason one
 *    re-spelling is reported and another is not. It would have exempted
 *    everything, which is a different channel than the one §5 specifies.
 *
 * **So they are counted, and the count is the spec's own word.** §2.1's measured
 * table already classifies `list-loose` in the **`normalized`** column — the same
 * column as `bullet-star` (`marker → -`), which is counted — and §5's banner
 * exists for "a doc authored in a foreign dialect … normalizes on first save".
 * §5's dialect contract also states the byte-identical bar holds *"iff input is
 * already written in the configured dialect"*; if a loose list is in the
 * configured dialect and the bar fails it, that sentence was false, and the
 * banner is what repairs it. `cause` (§ below) is how a notice says *which*
 * mechanism moved the bytes, because a source/canonical pair alone cannot tell a
 * writer "your spelling is foreign" from "the product writes lists this way".
 *
 * ## The cost, measured against this file's own baseline, and re-measured
 *
 * The prefix scheme was quadratic — every block re-rendered the whole prefix before
 * it. The recorder removes that: the
 * per-block text now comes out of **one** render of the document, with the
 * serializer's own per-block strings read off it. Same document, same machine, same
 * harness (`test/dialect.test.ts`'s `longManuscript`, 400 blocks / 19 007 bytes):
 *
 * | blocks | before (prefix) | after (recorded) | |
 * |---|---|---|---|
 * | 100 | 114 ms | 14 ms | 8.2× |
 * | 200 | 372 ms | 21 ms | 18× |
 * | 400 | **1 586 ms** | **55 ms** | 29× |
 * | 800 | 4 799 ms | 87 ms | 55× |
 *
 * Doubling the document cost **3–4×** before and **1.6–2.7×** now, which is the
 * whole claim: the shape changed, and the ratios are the evidence rather than the
 * absolute number. The 800-block load used to exceed vitest's own 5 s default
 * timeout, twice, in the run where the baseline was taken.
 *
 * **What is not covered by a test, stated rather than left out:** the newline trim
 * on the recorded path. Removing it leaves all 31 tests green, and it was measured
 * rather than assumed — across the whole §13 corpus and six hand-built shapes, a
 * block's recorded rendering *never* carries a leading or trailing newline, because
 * the separator between two blocks lives entirely in the join. The trim is kept
 * because it is what makes the two derivations identical **by construction** rather
 * than by coincidence on 57 fixtures, and because it costs two short replacements;
 * it is not a control, and no test should be cited as one.
 *
 * ## The two known limits, stated rather than hidden
 *
 * 1. An entity inside a block that also degrades is not counted. The banner
 *    under-reports for that block, and the loss warning beside it is the louder,
 *    more useful half.
 * 2. The *fallback's* prefix rendering is exact for *preceding*-sibling effects
 *    (which is the class that forced the mechanism at all) and approximate for
 *    *following*-sibling effects, which would show up as a false positive. The
 *    recorded path has no such edge, so this limit is now the fallback's alone and
 *    the corpus sweep is what shows the class is empty when it is taken.
 */
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { fromProseMirror } from '@handlewithcare/remark-prosemirror';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Nodes, Root, RootContent } from 'mdast';
import type { Root as MdastRoot } from 'mdast';
import { caotangSchema } from './schema.js';
import {
  DEGRADE_MDAST_TYPES,
  SAVE_STRINGIFY_OPTIONS,
  compiledBlockSpan,
  createSerializeHandlers,
} from './handlers.js';
import type { LossWarning } from './handlers.js';

/**
 * Which mechanism moved the bytes — **the third attribution** §5's banner needs
 * and that change added, because a `source`/`canonical` pair cannot carry it.
 *
 * A pair says *what changed*. It does not say *who did it*, and for a writer
 * those are different sentences: "your marker is not ours" is something they can
 * act on, and "the product writes every list tight" is something they have to be
 * told or they will read the diff as their own mistake. Worse, a banner that
 * cannot tell them apart trains the reader to ignore the table, which is the
 * failure the 08:0x decision rejected for a different reason.
 *
 * - **`parse-side`** — remark-parse normalised the source and the parse tree no
 *   longer carries the writer's spelling. `&amp;`, `* item`, a setext heading, a
 *   `+` marker, a backslash break. §5's own phrase is *"parse-side dialect
 *   sniffing"* and this is the half it names.
 * - **`list-spread`** — `fromPmNode('list')` pins `spread: false`, so a loose list
 *   saves tight. The ProseMirror schema has nowhere to keep the looseness.
 * - **`list-item-spread`** — `fromPmNode('listItem')` emits no `spread` at all, so
 *   a nested list gains the blank line a tight item did not have.
 * - **`save-side`** — the round trip changed the bytes and the responsible field is
 *   **not declared** in `SAVE_SIDE_CAUSES`. This value exists so an unattributed
 *   change is *visible* rather than mislabelled as something it is not: a
 *   fallback that is never exercised is a claim, and one that is exercised is a
 *   finding. The corpus sweep asserts it never appears there.
 */
export type DialectCause = 'parse-side' | 'list-spread' | 'list-item-spread' | 'save-side';

/**
 * The mdast types whose ProseMirror round trip drops a field the parse tree
 * carried, and which `cause` therefore names.
 *
 * **This is not the table of foreign constructs the header above refuses**, and
 * the difference is the point. A dialect table lists what *remark* decides to
 * re-spell — arbitrary, extensible by the library, and free to detect by
 * comparison. This lists what **Caotang's own handler table** fails to carry, which
 * is a property of this repository's code and of nothing else. It is also
 * checkable rather than merely assertable: `test/dialect.test.ts` reads
 * `handlers.ts` and fails if the two entries stop describing what the handlers
 * do, because a `cause` naming a mechanism the code does not have is a lie in
 * the one field a banner will put in front of a writer.
 */
const SAVE_SIDE_CAUSES: ReadonlyMap<string, Exclude<DialectCause, 'parse-side'>> = new Map([
  ['list', 'list-spread'],
  ['listItem', 'list-item-spread'],
]);

/**
 * One block whose canonical spelling differs from the spelling in the source.
 *
 * The fields are the ones §5's banner and §4's carrier can both use without
 * reaching for anything else: which construct, where it starts, the two
 * spellings, and **which mechanism produced the
 * canonical form**. `position` is optional for the same reason `LossWarning`'s is
 * — mdast `position` is optional, and inventing a line number for a node that had
 * none would be a claim about a location rather than about a spelling.
 */
export interface DialectNotice {
  /** The mdast type of the top-level block, e.g. `paragraph`, `list`. */
  mdastType: string;
  position?: { line: number; column: number };
  /** The block as the writer spelled it, sliced out of the body. */
  source: string;
  /** The block as a save will write it, in §5's canonical dialect. */
  canonical: string;
  /** Which mechanism produced `canonical` — see `DialectCause`. */
  cause: DialectCause;
  detail: string;
}

/**
 * The stringify chain a save uses, built once.
 *
 * `SAVE_STRINGIFY_OPTIONS` and not the five bare dialect values, and that is the
 * whole point: a dialect notice is a statement about *this* product's canonical
 * dialect, so it has to be rendered by the same chain a save uses — including
 * §3.3's `break` override. Rendering with a second chain produced a measured
 * false positive (a canonical two-space line break reported as foreign, on a
 * document whose bytes never changed), and no amount of care in the comparison
 * fixes a comparison against the wrong target. A processor is immutable once
 * built, so one module-level instance is safe to reuse.
 */
const CANONICAL = unified()
  .use(remarkGfm)
  .use(remarkStringify, SAVE_STRINGIFY_OPTIONS)
  .freeze();

/**
 * The canonical spelling of the first `count` top-level blocks, concatenated.
 *
 * The `count` is what makes this a *prefix* render rather than a per-block one:
 * a list's marker depends on whether a list came before it, so the same node
 * rendered alone and rendered in position are two different strings, and only the
 * second one is what a save writes. `0` renders as the empty string, which is what
 * subtracts cleanly for the first block.
 *
 * **This is the parse-tree chain**, so it answers "did remark forget the writer's
 * spelling" — the half `renderSave` below is not for. `ownTexts` is called with a
 * renderer built on each of them, and the two answers must not be swapped.
 */
const canonicalPrefix = (children: readonly RootContent[], count: number): string =>
  count === 0
    ? ''
    : CANONICAL.stringify({ type: 'root', children: children.slice(0, count) } as never);

/**
 * The whole parse tree through the **recording** chain — the parse side's one
 * full render, the counterpart of `renderSaveRecorded`.
 *
 * `RECORDING_CHAIN` is the save's chain and this renders the *parse* tree with
 * it, which is the same thing `CANONICAL` does with the save's chain swapped out:
 * the two module-level chains differ only in which tree they are handed, and the
 * recorder adds no options of its own. Rendering the parse tree with a chain that
 * has no recorder would leave the capture empty, the guard would decline, and the
 * parse side would silently run at the old quadratic cost forever.
 */
const canonicalWhole = (children: readonly RootContent[]): string =>
  children.length === 0
    ? ''
    : String(RECORDING_CHAIN.stringify({ type: 'root', children } as never));

/**
 * The parse side's one recorded render, exported for the same reason as
 * `renderSaveRecorded`: `test/dialect.test.ts` has to drive the real chain, and a
 * chain the test builds has no `join` hook on it.
 */
export { canonicalWhole as renderParseRecorded };

/**
 * The save's own chain, built once — the one this module renders *with*, and the
 * same `SAVE_STRINGIFY_OPTIONS` object `pipeline.ts` saves with.
 *
 * Two module-level instances, and the reason they are not interchangeable is the
 * whole: `CANONICAL` renders the **parse** tree and answers "did remark
 * forget the writer's spelling", while this one renders the **save** and answers
 * "what will the file say". Using the parse renderer as a proxy for the save is
 * what made `list-loose` invisible. `test/dialect.test.ts` pins that *every*
 * `remarkStringify` call in this file names the shared options object, so a third
 * chain cannot appear here either.
 */
const SAVE_HANDLERS = createSerializeHandlers();

const SAVE_CHAIN = unified()
  .use(remarkGfm)
  .use(remarkStringify, SAVE_STRINGIFY_OPTIONS)
  .freeze();

/**
 * One top-level block's own rendering, captured from the serializer as it emits it.
 */
interface CapturedBlock {
  node: unknown;
  text: string;
}

/**
 * The blocks captured by the render currently in flight, or `null`.
 *
 * **Module-level because the serializer's `State` is not reachable from outside
 * `toMarkdown`** — there is no argument to hand a caller and no option that runs
 * before the first node is rendered. What makes it safe is that a stringify is
 * synchronous and `sniffDialect` never re-enters itself, so there is exactly one
 * render in flight; the caller sets this before the render and reads it after, and
 * the two are the only writers besides the recorder below. A second capture
 * cannot overlap a first, so this cannot interleave.
 */
let captured: CapturedBlock[] | null = null;

/**
 * Marks a `State` whose dispatcher has already been wrapped. A `Symbol` on the
 * state object rather than a module flag, so two renders cannot see each other's
 * installation even if the module flag were stale.
 */
const RECORDER_INSTALLED = Symbol('caotang.dialect.blockRecorder');

/**
 * The three members of `mdast-util-to-markdown`'s `State` this file touches,
 * declared rather than imported: `mdast-util-to-markdown` is `remark-stringify`'s
 * dependency and is not a declared dependency of this package, so an import of it
 * would not resolve. `test/dialect.test.ts` reads the two library files this
 * recorder depends on and asserts these names are still the ones there.
 */
interface RecorderState {
  handle: unknown;
  [RECORDER_INSTALLED]?: boolean;
}

type RecorderDispatch = ((
  node: unknown,
  parent: unknown,
  state: RecorderState,
  info: unknown,
) => unknown) & { handlers: Record<string, unknown> };

/**
 * The serializer's own `join` hook, used for the one thing it can do that nothing
 * else can: **install a dispatcher wrapper before the second top-level block is
 * rendered.**
 *
 * A join is the first callback the library makes *between* two blocks, so it is
 * the earliest hook that still runs inside one stringify of a multi-block
 * document — and by then block 0 is already on the stack, which is why block 0 is
 * the one block this file renders separately. Returning `undefined` lets the
 * library's own `joinDefaults` decide the separator, so this rule **changes no
 * output**; its only effect is the wrapper it installs.
 *
 * The wrapper records the text of every render whose parent is the root, which is
 * exactly one per top-level block, and returns the library's string unchanged.
 * `container-phrasing.js:499` reads `state.handle.handlers` directly (for a
 * one-character lookahead that bypasses the dispatcher), so the replacement has to
 * carry zwitch's own properties or phrasing rendering throws — `Object.assign`
 * does that, and a missing one is a thrown `TypeError` rather than a silent gap.
 */
const recordRootBlocks = (
  _left: unknown,
  _right: unknown,
  _parent: unknown,
  state: RecorderState,
): undefined => {
  if (state[RECORDER_INSTALLED] !== true) {
    state[RECORDER_INSTALLED] = true;
    const dispatch = state.handle as RecorderDispatch;
    const recording = (
      node: unknown,
      parent: unknown,
      inner: RecorderState,
      info: unknown,
    ): string => {
      const text = dispatch(node, parent, inner, info) as string;
      if (captured !== null && (parent as { type?: string } | null)?.type === 'root') {
        captured.push({ node, text });
      }
      return text;
    };
    Object.assign(recording, dispatch);
    state.handle = recording as RecorderDispatch;
  }
  return undefined;
};

/**
 * `SAVE_STRINGIFY_OPTIONS` plus this file's one hook, and nothing else.
 *
 * **The spread is a copy, and the copy is the exact thing
 * `test/dialect.test.ts`'s reachability guard exists to catch** — so the guard is
 * extended rather than weakened: it accepts this name as a second allowed chain
 * and a new test asserts this object's entries are `SAVE_STRINGIFY_OPTIONS`'
 * *plus* exactly the `join` key. A second dialect definition would have to be
 * written somewhere other than this one line to get past it.
 */
const RECORDED_STRINGIFY_OPTIONS = {
  ...SAVE_STRINGIFY_OPTIONS,
  join: [recordRootBlocks],
};

/**
 * Exported for the two guards in `test/dialect.test.ts` and for nothing else —
 * the package's public contract (`index.ts`) is unchanged, because a dialect
 * option object is not part of what a caller of `@caotang/editor` needs. A guard
 * that reads an internal is a guard on that internal; widening the public surface
 * to host it would be a second decision about the contract, taken for a test.
 */
export { RECORDED_STRINGIFY_OPTIONS };

/**
 * The same save chain with the recorder attached, built once.
 *
 * It renders the *save*'s tree, and it is only ever used for the single
 * full-document render per load that the recorder reads. `SAVE_CHAIN` above stays
 * the chain every other render uses, so "the recorder changes the dialect" is
 * impossible by construction rather than by discipline: this object is the shared
 * options with a hook appended, and the hook returns `undefined`.
 */
const RECORDING_CHAIN = unified()
  .use(remarkGfm)
  .use(remarkStringify, RECORDED_STRINGIFY_OPTIONS)
  .freeze();

/** The bytes a save writes for one ProseMirror node, and the mdast it came from. */
const renderSave = (pm: PmNode): { text: string; tree: MdastRoot } => {
  const tree = fromProseMirror(pm, {
    schema: caotangSchema,
    nodeHandlers: SAVE_HANDLERS as never,
    markHandlers: SAVE_HANDLERS as never,
  }) as MdastRoot;
  return { text: String(SAVE_CHAIN.stringify(tree as never)), tree };
};

/**
 * One full-document render with the recorder attached, returning the save's mdast
 * so the per-block nodes the cause walk compares against come out of the *same*
 * render the recorded text did.
 *
 * **Exported so `test/dialect.test.ts` can drive the real recorder** rather than
 * a chain the test builds: a harness with its own `unified()` chain has no `join`
 * hook on it, so it would exercise a code path that cannot exist in production
 * and would report the fast path as "declined" for a reason that has nothing to
 * do with the fast path.
 */
export const renderSaveRecorded = (pm: PmNode): { text: string; tree: MdastRoot } => {
  const tree = fromProseMirror(pm, {
    schema: caotangSchema,
    nodeHandlers: SAVE_HANDLERS as never,
    markHandlers: SAVE_HANDLERS as never,
  }) as MdastRoot;
  return { text: String(RECORDING_CHAIN.stringify(tree as never)), tree };
};

/**
 * The ProseMirror offset at which each top-level block ends, so the save can be
 * rendered *as far as that block* without re-parsing the prefix.
 *
 * `doc.content.cut` is a structural slice and shares the nodes above the cut, so
 * this is a boundary computation rather than a copy. Cutting on a block boundary
 * matters: an offset in the middle of a child would return a half-open node and
 * render nonsense, which is a false positive of the worst kind — a document
 * reported as foreign that never changes on save.
 */
const blockBoundaries = (doc: PmNode): number[] => {
  const boundaries: number[] = [];
  let offset = 0;
  doc.forEach((node) => {
    offset += node.nodeSize;
    boundaries.push(offset);
  });
  return boundaries;
};

/**
 * Whether this block already has a loss reported against it.
 *
 * Two tests, and the second is the easy one to miss. A degrade node anywhere
 * inside is enough, and a task list item counts even though `listItem` is not a
 * degrade type — the warning for it is a loss, so its byte change is already
 * spoken for. `DEGRADE_MDAST_TYPES` is read from the handler table rather than
 * repeated here, so a construct that starts degrading cannot be counted in both
 * channels by accident of a stale copy.
 *
 * **The warning test, and why the type test alone stopped being enough.** The
 * save-path comparison is strictly *more* sensitive than the parse one — it sees
 * a change whenever the round trip loses a field, not only when remark forgot a
 * spelling — and its extra sensitivity lands on `strike-in-emphasis`, which is
 * The finding: a nested emphasis that collapses into the one around it. That
 * is a **loss**, `LossWarning` already reports it at `1:11`, and a dialect notice
 * about the same block would describe one change in two vocabularies and leave
 * the writer no way to tell which to act on. `emphasis` is not in
 * `DEGRADE_MDAST_TYPES`, so the type test cannot see it. Any warning positioned
 * inside the block's line range therefore suppresses the dialect notice, which is
 * the rule this file has always claimed in prose and now implements in both
 * directions: the *corpus sweep* is the control that the rule is not just "the
 * dialect channel is empty", and the sweep's own list is the control that it is
 * not "the dialect channel is everything".
 *
 * A warning with no position cannot be placed in a block, so it does not suppress
 * anything; the type test still covers the constructs that produce one. The
 * corpus sweep asserts that no warning in the corpus lacks a position, so this
 * limit is measured rather than assumed.
 */
const carriesLoss = (
  node: Nodes,
  warnings: readonly LossWarning[],
  fromLine: number | undefined,
  toLine: number | undefined,
): boolean => {
  if (hasDegrade(node)) return true;
  if (fromLine === undefined || toLine === undefined) return false;
  return warnings.some(
    (warning) =>
      warning.position !== undefined &&
      warning.position.line >= fromLine &&
      warning.position.line <= toLine,
  );
};

const hasDegrade = (node: Nodes): boolean => {
  if ((DEGRADE_MDAST_TYPES as readonly string[]).includes(node.type)) return true;
  if (node.type === 'listItem' && node.checked !== null && node.checked !== undefined) return true;
  // `Nodes` is a union whose leaves (`image`, `inlineCode`, `thematicBreak`, …)
  // carry no `children` at all, so the walk reads them structurally instead of
  // asking the union for a property nine of its members do not have.
  const children = 'children' in node ? (node.children as Nodes[]) : [];
  return children.some((child) => hasDegrade(child));
};

/**
 * Which construct's `spread` the round trip changed — the cause, derived from the
 * field rather than from the construct's position in the document.
 *
 * **The first version of this asked the wrong question** and it was caught by the
 * fixture that matters: *"the first mapped mdast type in document order"*. A
 * nested list is a `list`, so the walk returned `list-spread` before it ever
 * reached the `listItem` whose missing `spread` is the actual cause. Document
 * order cannot tell the two apart, because a loose list also contains
 * `listItem`s, so any positional rule picks one family and mislabels the other.
 *
 * What does tell them apart is the field itself. A cause is a claim that a
 * particular `spread` was not carried, so the claim is checked by comparing the
 * two trees' `spread` for the same node — the parse tree's against the save's. For
 * a loose list the `list` carries `true` and the save emits `false`; for a tight
 * nested list the `list` agrees on `false` and the `listItem` carries `false`
 * where the save emits nothing at all. The walk stops at the first node whose
 * field actually moved.
 *
 * The two trees are only walked in parallel while they still line up. A round
 * trip that *drops* a node — the merged-emphasis case — desynchronises them, and
 * a misaligned comparison would attribute a change to whatever node happened to
 * land at that index. A length mismatch gives up and returns the unattributed
 * `save-side`, which is the honest answer and is asserted to be unreachable across
 * the corpus.
 */
const saveSideCause = (parseNode: Nodes, savedNode: unknown): DialectCause => {
  const saved = savedNode as
    | { type?: string; spread?: unknown; children?: unknown[] }
    | undefined;
  const declared = SAVE_SIDE_CAUSES.get(parseNode.type);
  if (declared !== undefined && saved?.type === parseNode.type) {
    if ((parseNode as { spread?: unknown }).spread !== saved.spread) return declared;
  }
  const parseChildren = 'children' in parseNode ? (parseNode.children as Nodes[]) : [];
  const savedChildren = saved?.children;
  if (!Array.isArray(savedChildren) || savedChildren.length !== parseChildren.length) {
    return 'save-side';
  }
  for (let i = 0; i < parseChildren.length; i++) {
    const found = saveSideCause(parseChildren[i]!, savedChildren[i]);
    if (found !== 'save-side') return found;
  }
  return 'save-side';
};

/** The sentence a banner shows, which is the only place `cause` becomes prose. */
const detailFor = (type: string, cause: DialectCause): string => {
  switch (cause) {
    case 'parse-side':
      return `Saves will re-spell this ${type} in Caotang's canonical dialect.`;
    case 'list-spread':
      return 'Caotang writes every list tight, so this loose list saves without its blank lines.';
    case 'list-item-spread':
      return 'Caotang writes a blank line before a nested list, so this one saves with one.';
    case 'save-side':
      return `Saves will re-spell this ${type}, and the change is not attributed to a named mechanism.`;
  }
};

/**
 * One block's own text, cut out of the rendering of everything up to and
 * including it.
 *
 * The newline trims are the one concession to the block context: a source slice
 * starts and ends at the block's own characters, while a serialized block is
 * wrapped in the separators its neighbours require. Trimming the leading and
 * trailing separators is the difference between "this block is foreign" and
 * "every block is foreign".
 */
const blockOwnText = (throughThisBlock: string): string =>
  throughThisBlock.replace(/^\n+/, '').replace(/\n+$/, '');

/** What one render hands back: its text, and the blocks it rendered. */
export interface Rendered {
  text: string;
  children: readonly unknown[];
}

/**
 * Every top-level block's own text, from **one** render of the whole document
 * plus one render of the first block.
 *
 * ## Why this is linear, and what it replaced
 *
 * A block's canonical form is the *difference* of two prefix renderings, and
 * getting both meant rendering prefixes `1, 2, … n` — `1 + 2 + … + n = n²/2`
 * blocks' worth of tree per load. Measured on this row's own 400-block document,
 * that was **1 586 ms**, and it was quadratic rather than merely slow: doubling
 * the document multiplied the cost.
 *
 * The prefix render exists because a list's marker depends on whether a list came
 * before it, so a block rendered alone is not the block a save writes. **The
 * serializer already knows the right answer** — it produced the whole output in
 * one pass, one string per block, and threw the per-block boundaries away on the
 * way out. `recordRootBlocks` above is a `join` rule, which is a documented
 * option of the same library doing exactly this kind of work, and it recovers
 * those strings as they are produced. The cost becomes **one** render: O(n).
 *
 * A divide and conquer over the prefixes was tried first and is *not* a fix: it
 * renders prefixes `1 … n` too, just in a different order, and a sum does not
 * care what order it is summed in. Measured 955 ms against 1 586 ms, with 800
 * blocks barely moved — 23× less *work* on paper, and the arithmetic was simply
 * wrong. It is recorded here because the number looks like a result and is not.
 *
 * ## The two facts this returns, and the one that could be wrong
 *
 * `own` is each block's recorded rendering with its surrounding newlines trimmed.
 * `saved` is the mdast the save produced for that same block, for the cause walk.
 *
 * Block 0 is rendered separately rather than recorded, and that is not a
 * shortcut: it is the only block whose rendering cannot depend on a preceding
 * sibling, so a one-block render *is* its rendering — the same `prefix(1)` the
 * prefix algorithm subtracted from the empty string. Blocks 1…n−1 are recorded
 * from the full render.
 *
 * The recorded text is the whole string the serializer produced for that node, in
 * that document, in that order, and the function **refuses its own result** if the
 * captures do not line up with the blocks by identity. What is *not* checked at
 * runtime is that a recorded block's text equals the difference of the two prefix
 * renderings the old algorithm used — that is the library's left-to-right
 * property (`container-flow.js:43-45` resets `bulletLastUsed` after any non-list
 * child, so no construct's rendering depends on a later sibling), and
 * `test/dialect.test.ts` asserts the two agree block for block over the whole §13
 * corpus and over this row's 400-block document.
 */
/**
 * What one derivation produced, **and which derivation produced it.**
 *
 * `via` is not a diagnostic — it is the only thing that makes the equivalence
 * guard mean anything. Both derivations return the same numbers by construction
 * when the recorder declines, so a test comparing them is green whether the fast
 * path ran or not; a guard that cannot tell those apart measures the fallback and
 * calls it the mechanism. Every test below asserts `via` as well as the values.
 */
export interface OwnTexts {
  own: string[];
  saved: unknown[];
  /** `'recorded'` — one render. `'prefix'` — the recorder declined. */
  via: 'recorded' | 'prefix';
}

export const ownTextsRecorded = (
  count: number,
  renderFirst: () => Rendered,
  renderWhole: () => Rendered,
): OwnTexts | null => {
  const own: string[] = new Array<string>(count);
  const saved: unknown[] = new Array<unknown>(count);
  if (count === 0) return { own, saved, via: 'recorded' };
  const first = renderFirst();
  own[0] = blockOwnText(first.text);
  saved[0] = first.children[0];
  if (count === 1) return { own, saved, via: 'recorded' };
  captured = [];
  let whole: Rendered;
  try {
    whole = renderWhole();
  } catch (error) {
    captured = null;
    throw error;
  }
  const seen = captured;
  captured = null;
  if (seen === null || seen.length !== count - 1) {
    return null;
  }
  for (let i = 0; i < seen.length; i++) {
    // **Identity, not position.** A count that matches with the blocks in the
    // wrong order would be a recorder that drifted; a count alone cannot tell
    // the two apart, and this identity check is the whole of the guard. The
    // children it is checked against are the ones **this render** stringified —
    // on the save side that is the *save's* tree, not the parse tree, and
    // checking against the parse tree's children is a check that can never pass.
    if (seen[i]!.node !== whole.children[i + 1]) return null;
    own[i + 1] = blockOwnText(seen[i]!.text);
    saved[i + 1] = seen[i]!.node;
  }
  return { own, saved, via: 'recorded' };
};

/**
 * The same two facts, by the prefix algorithm, for when the recorder declines.
 *
 * **This is the original prefix algorithm, kept whole and named**, and it
 * is what makes the recorder's guard a real one rather than a claim: the fast path
 * is only allowed to answer when it has proved it captured every block, and this
 * is the answer it is proved against. It costs `O(n²)`, so it is a fallback and
 * not the mechanism — but a fallback nobody exercises is a claim, and
 * `test/dialect.test.ts` runs a document through it explicitly.
 */
export const ownTextsByPrefix = (
  count: number,
  renderPrefix: (blocks: number) => Rendered,
): OwnTexts => {
  const own: string[] = new Array<string>(count);
  const saved: unknown[] = new Array<unknown>(count);
  let previous = '';
  for (let index = 0; index < count; index++) {
    const throughThisBlock = renderPrefix(index + 1);
    own[index] = blockOwnText(throughThisBlock.text.slice(previous.length));
    saved[index] = throughThisBlock.children[index];
    previous = throughThisBlock.text;
  }
  return { own, saved, via: 'prefix' };
};

/**
 * Count the blocks a save will re-spell, in §5's own terms.
 *
 * `body` is the Markdown that produced `tree`; the mdast `position` offsets index
 * into it, which is why the two travel together. `doc` is the *compiled* document
 * for the same body — the save renders from it, not from `tree`, and the header
 * explains what that changes. `warnings` is the loss channel for the same load,
 * because "this block is already spoken for" is a question about this load's other
 * array and cannot be answered without it.
 *
 * A block with no offsets (a synthesised node) is skipped rather than guessed at —
 * a notice needs a source spelling to differ from a canonical one, and with no
 * slice there is nothing to compare.
 *
 * **Two passes, and the order is the reason the parse side is affordable.**
 * The save side is rendered first, for every block, because the comparison is
 * what decides whether a block is reported. The *parse*-side rendering is only
 * consulted to attribute a block the save side has already decided to report, so
 * it is built once, on demand, and only when there is at least one notice — a
 * document with nothing to report never pays for it. The alternative (the
 * per-block lazy memo this replaced) paid a fresh prefix pair per reported block,
 * so a document where *every* block re-spells cost `O(n²)` on the side that
 * exists only to label what the first pass already found.
 */
export const sniffDialect = (
  body: string,
  tree: Root,
  doc: PmNode,
  warnings: readonly LossWarning[],
): DialectNotice[] => {
  const notices: DialectNotice[] = [];
  const blocks = tree.children;
  const boundaries = blockBoundaries(doc);
  // **The pairing, and why it cannot be an index.**
  //
  // The two sides of the comparison are two different lists: `blocks` are the
  // *parse tree*'s top-level blocks and `boundaries` are the *compiled
  // document*'s. A degrade can turn one parse block into several compiled
  // blocks — a table becomes a paragraph per row — or into none at all, and a
  // pairing by index then compares every later block with the wrong bytes.
  // The failure is invisible rather than loud: the notice it produced was about
  // a block that had not changed, with a canonical form belonging to a
  // different block entirely.
  //
  // So the two sides are walked together, and the compiled index advances by the
  // number of blocks each parse block actually produced. The spans come from
  // the handler table (`compiledBlockSpan`), because that is where the rule
  // lives — a table's row-per-paragraph degrade is a fact about the handler,
  // not about this file.
  const spans: number[] = [];
  let spanTotal = 0;
  let untaughtZeroSpan: string | null = null;
  for (const node of blocks) {
    const span = compiledBlockSpan(node);
    // The per-block half of the rule: a zero span is only safe for a type the
    // comparison below skips as a degrade. A zero-span block of any other type
    // would leave the compiled index standing still while the walk moved on,
    // and every later pairing would compare a block with a neighbour's bytes.
    if (span === 0 && !(DEGRADE_MDAST_TYPES as readonly string[]).includes(node.type)) {
      untaughtZeroSpan ??= node.type;
    }
    spans.push(span);
    spanTotal += span;
  }
  // The totals have to add up, **and** no per-block span of a type the
  // comparison does not skip as a degrade may stall the walk at zero. The zero
  // half is the one that closes a hole the sum cannot see: such a block
  // compiles to zero blocks and the comparison pairs it anyway, so it would
  // leave the compiled index standing still while the walk moves on, and every
  // later pairing would compare a block with a neighbour's bytes.
  //
  // **A degrade type's zero is not that case.** A `definition` compiles to no
  // compiled block at all, and the comparison skips it as a degrade, so a
  // compiled index that stands still over it is the *right* count for it —
  // which is why the rule above refuses only the zeros it does not skip.
  //
  // **What the rule does not catch is stated rather than claimed.** Two
  // *offsetting non-zero* span errors satisfy the sum and neither lands on
  // zero, so the pairing still drifts — this rule refuses the zero-stall case,
  // not every possible drift. If either half fails, this document contains a
  // construct the handler table has not been taught about, and every pairing
  // after it would be a guess — so the channel answers "nothing to report"
  // rather than reporting a comparison it cannot make. A wrong zero is the
  // failure this channel cannot have (see the header), so the refusal is
  // deliberate: a false *notice* is worse than a missing one, because a notice
  // is a claim about a specific block and a reader acts on it. And the refusal
  // is **warned**, because a refusal nobody sees is a channel that has stopped
  // working.
  if (spanTotal !== boundaries.length || untaughtZeroSpan !== null) {
    console.warn(
      untaughtZeroSpan !== null
        ? `dialect sniffer refused the document: ${untaughtZeroSpan} compiles to zero blocks but is not a degrade type the comparison skips`
        : `dialect sniffer refused the document: the parse blocks claim ${spanTotal} compiled blocks and the document has ${boundaries.length}, so the handler table has not been taught a construct this document contains`,
    );
    return notices;
  }
  // Two renders, and the first one is a single block. The prefix algorithm is
  // reached only if the recorder declines to prove it saw every block.
  const { own, saved } = saveSideOwnTexts(doc, boundaries, boundaries.length);

  // Pass one: the comparison, which is §5's rule and nothing else.
  const reported: Array<{
    index: number;
    compiled: number;
    node: Nodes;
    start: { line: number | undefined; column: number | undefined };
    source: string;
  }> = [];
  let compiled = 0;
  for (let index = 0; index < blocks.length; index++) {
    const node = blocks[index] as Nodes;
    const span = spans[index]!;
    const start = node.position?.start;
    const end = node.position?.end;
    if (start?.offset === undefined || end?.offset === undefined) {
      compiled += span;
      continue;
    }
    if (carriesLoss(node, warnings, start.line, end.line)) {
      compiled += span;
      continue;
    }
    const source = body.slice(start.offset, end.offset);
    // A block that compiled into several blocks has several canonical texts,
    // and its canonical form is all of them — the separator is the blank line
    // the save writes between two blocks. Every construct that expands this
    // way is a degrade and is skipped above, so this join is the shape rather
    // than a path anything reaches today.
    const canonical =
      span === 1 ? own[compiled]! : own.slice(compiled, compiled + span).join('\n\n');
    if (source === canonical) {
      compiled += span;
      continue;
    }
    reported.push({ index, compiled, node, start, source });
    compiled += span;
  }
  if (reported.length === 0) return notices;

  // Pass two: attribution, for the blocks pass one kept. Parse-side or not — if
  // re-stringifying the *parse* tree also disagrees with the source, remark-parse
  // is what normalised it. If the parse tree re-serialises back to the source
  // verbatim, the parse tree kept the writer's spelling and Caotang's own round
  // trip is what lost it.
  const parseOwn = parseSideOwnTexts(blocks.length, blocks).own;
  for (const { index, compiled: compiledIndex, node, start, source } of reported) {
    const cause: DialectCause =
      source === parseOwn[index] ? saveSideCause(node, saved[compiledIndex]) : 'parse-side';
    notices.push({
      mdastType: node.type,
      ...(start.line !== undefined
        ? { position: { line: start.line, column: start.column as number } }
        : {}),
      source,
      canonical:
        spans[index] === 1
          ? own[compiledIndex]!
          : own.slice(compiledIndex, compiledIndex + spans[index]!).join('\n\n'),
      cause,
      detail: detailFor(node.type, cause),
    });
  }
  return notices;
};

/**
 * The save side's per-block canonical text: what a save writes for each block, and
 * the mdast it wrote it from.
 *
 * **One named function per side, and that is the point of them.** The first cut
 * inlined both wirings into `sniffDialect`, and the guard in
 * `test/dialect.test.ts` then drove its *own* copies of the two chains — so a
 * mutation that pointed the parse side back at the non-recording chain passed
 * every value assertion and was caught only by two tests **timing out**. A guard
 * that can only fail by being slow is a guard that fails on the machine's mood.
 * Both sides are named, exported and called from here *and* from the guard, so
 * the thing under test and the thing asserted about it are the same wiring.
 */
export const saveSideOwnTexts = (
  doc: PmNode,
  boundaries: readonly number[],
  count: number,
): OwnTexts => {
  const saveTree = (upTo: number): Rendered => {
    const { text, tree: savedTree } = renderSave(
      caotangSchema.topNodeType.create(null, doc.content.cut(0, boundaries[upTo - 1]!)) as PmNode,
    );
    return { text, children: savedTree.children };
  };
  return (
    ownTextsRecorded(count, () => saveTree(1), () => {
      const { text, tree: savedTree } = renderSaveRecorded(doc);
      return { text, children: savedTree.children };
    }) ?? ownTextsByPrefix(count, saveTree)
  );
};

/**
 * The parse side's per-block canonical text — the channel's *labelling* input, so
 * it is built only once there is at least one block to label.
 *
 * `children` is the **parse** tree's, and the recorded render stringifies exactly
 * those objects, which is what the identity half of the guard checks. Pointing
 * this at `canonicalPrefix` instead — the chain with no recorder on it — produces
 * the *same numbers* by falling back to the prefix algorithm, which is why the
 * mutation is a timing failure and not a value failure, and why the guard has to
 * call this function rather than re-derive it.
 */
export const parseSideOwnTexts = (count: number, children: readonly RootContent[]): OwnTexts => {
  const parseTree = (upTo: number): Rendered => ({
    text: canonicalPrefix(children, upTo),
    children: children.slice(0, upTo),
  });
  return (
    ownTextsRecorded(count, () => parseTree(1), () => ({
      text: canonicalWhole(children),
      children,
    })) ?? ownTextsByPrefix(count, parseTree)
  );
};
