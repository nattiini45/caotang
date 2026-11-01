/**
 * The §3.3 mdast handler table — **the editor's own**, transcribed from
 * [editor-engine.md] §3.3, the exact class and the degrade class.
 *
 * §3.3 classifies *every* mdast type. This table registers handlers for the
 * **exact class** and for the **degrade rows §3.3 assigns a code to**, and lets
 * the library's own defaults handle the rest. The product and the audit keep
 * **separate** tables — the audit registers the
 * exact class only so its measured diff would be a diff against the *library*,
 * and a degrade handler written there would replace the behaviour under test
 * with Caotang's intent, which measures nothing. The gap between the two tables
 * is what makes the audit's 59-construct result table evidence about the
 * product rather than a description of it, so `test/degrade.test.ts` asserts the
 * gap exists in both directions.
 *
 * ## The one shape the exported factories cannot express — in BOTH directions
 *
 * `toPmNode` / `toPmMark` build from `state.all(node)` (i.e. `children`), and
 * `fromPmNode` / `fromPmMark` emit `children`. The two mdast types that carry
 * **`value`** instead of `children` — `inlineCode` and `code` — therefore
 * cannot be expressed with any of the four factories. Measured consequence on
 * the serialize side: a table built with `fromPmMark('inlineCode')` produces
 * `` `` `` for the input `` `code` `` — the content is silently lost, because
 * remark-stringify reads `node.value`, finds it absent, and emits an empty
 * span. Both leaves are hand-written below. This is a property of the
 * library's API surface, not a Caotang workaround; `test/pipeline.test.ts` pins
 * it in this package too, on the two constructs it applies to.
 *
 * ## The degrade class is where the library stops working, so it is hand-written
 *
 * Measured on 0.1.5, and each of these is a **failed load** without a handler
 * in this table — `unknown()` throws `unknown markdown node: <type>`, and the
 * default `html` handler returns a *text* node where `doc` requires `block+`,
 * so the document's own `check()` throws instead:
 *
 * | mdast type | without a handler |
 * |---|---|
 * | `table` | throws `unknown markdown node: table` |
 * | `imageReference` | throws `unknown markdown node: imageReference` |
 * | `html` (block) | throws `Invalid content for node doc: <"<div>raw</div>">` |
 *
 * `definition` is in the same table for a different reason: it does not throw,
 * so nothing forces it to be written, but §3.3's declared behaviour is not
 * reachable without it. The resolved URL of a reference lives in the
 * `definition` node, so an `imageReference` cannot be "expanded to a direct
 * image" while its definition is silently dropped.
 *
 * ## Footnotes left the degrade class (#270)
 *
 * `footnoteReference` (which the library throws on) and `footnoteDefinition`
 * (which it drops with `ignore`) were degrade rows until decision 3 of the
 * imports wave: they are now §3.1 nodes (`footnote_reference`,
 * `footnote_definition`) with exact handlers in both directions, and
 * `footnotes.ts` holds the one rule for where the notes go and what they are
 * called.
 */
import type { Node as PmNode, NodeType, Schema } from '@tiptap/pm/model';
import type {
  Code,
  Definition,
  Delete,
  Emphasis,
  FootnoteDefinition,
  FootnoteReference,
  Heading,
  Html,
  Image,
  ImageReference,
  InlineCode,
  Link,
  LinkReference,
  List,
  ListItem,
  Nodes,
  Strong,
  Table,
  TableCell,
  TableRow,
} from 'mdast';
import { fromPmMark, fromPmNode, toPmMark, toPmNode } from '@handlewithcare/remark-prosemirror';
import { footnoteKey } from './footnotes.js';

/** mdast's `identifier` for a label: its normalised key, lower-cased (remark-parse's own form). */
const footnoteIdentifier = (label: string): string => footnoteKey(label).toLowerCase();

/**
 * §3.3's `LossWarning`, verbatim — all five fields, and 0.1.5 emits no warning
 * of any kind, so every field here is Caotang-side.
 *
 * `position` is optional **because mdast's own `position` is optional** (a
 * synthesised node has none), and it is written only when the source node
 * carried a start: the two are the same fact, and a warning claiming a line
 * number the source did not have would be a warning about a location rather
 * than about a loss. The library's own `Position` also carries an `offset`,
 * which is dropped here — §3.3's shape is line and column, and an offset is
 * measured against a body projection the caller may not have.
 */
export interface LossWarning {
  code: 'unsupported-node' | 'lossy-attribute' | 'lossy-structure';
  mdastType: string;
  position?: { line: number; column: number };
  detail: string;
}

/**
 * §3.3's degrade rows this product implements, as data — the shape the parity
 * guard compares against the audit's table.
 *
 * It is a **subset** of §3.3's degrade rows, and deliberately so. Two of §3.3's
 * degrade rows are absent by a *different* reason than `listItem`, and the
 * difference is load-bearing:
 *
 * - `linkReference` **was** absent. 0.1.5 resolves a
 *   `linkReference` through its own default without throwing, so it is not one of
 *   the load-fatal constructs and nothing forced it to be written — but §3.3's row
 *   declares `lossy-attribute` for it, and the 08:0x decision settled the case. A
 *   handler that emits no warning where §3.3 declares one is not a smaller
 *   degrade, it is an undeclared one. It is registered here now, and
 *   `test/degrade.test.ts` asserts the subset relationship against §3.3 itself,
 *   so this list cannot quietly become a second spec.
 * - `listItem` is **not** a degrade type and is not here, even though it carries a
 *   warning. §3.3's exact-content row says a `listItem` is lossless, and for a
 *   plain list item it is: the *content* survives. What a GFM task item loses is
 *   the `checked` attribute, which §3.1's `list_item` has no attr slot for, and
 *   §3.3 carries a separate row for that (`listItem` (GFM task item) →
 *   `lossy-attribute`) rather than contradicting the exact-content row above it.
 *   The type is exact; the attribute is lost; the warning says so.
 * - `emphasis` / `strong` / `delete` are **not** degrade types and are not here,
 *   for the same reason under a **condition** rather than a type. §3.3's
 *   merged-inline-run row classifies them degrade, but only when one is nested
 *   inside another of the same mark — a single `_x_` is exact, and §3.3's
 *   exact-content row above still holds for it. **A per-type list cannot express
 *   "degrade only when nested in yourself", so putting these three in here would
 *   be worse than leaving them out twice over**: it would register no handler
 *   (§3.3's rows are per-type, and these three keep their exact-class factories),
 *   and `dialect.ts` reads this list as the *skip* set for its channel, so the
 *   emphasis blocks would go unreported for re-spelling as well. The condition is
 *   checked by `warnMergedInlineRuns` instead, and `test/degrade.test.ts` asserts
 *   the subset relationship in the direction that would catch it drifting.
 */
export const DEGRADE_MDAST_TYPES = [
  'html',
  'table',
  'definition',
  'imageReference',
  'linkReference',
] as const;

/**
 * How many **top-level blocks** an mdast node compiles into — the one fact about
 * this table that the dialect sniffer cannot see for itself.
 *
 * The sniffer compares the *parse tree*'s blocks with the *compiled document*'s
 * blocks, and the two are not the same list: a degrade can turn one mdast block
 * into several compiled blocks or into none. Pairing the two by index alone is
 * what made a table shift every later block's comparison by the number of its
 * rows — a shift that is invisible, because the notice it produced was about a
 * block that had not changed at all.
 *
 * **The rule is this table's own behaviour, read back:**
 *
 * - `table` → §3.3's row-per-paragraph degrade. `rowAsParagraph` answers with a
 *   single paragraph per row, so the span is the row count.
 * - `footnoteDefinition` → one `footnote_definition` block (#270). The load moves
 *   every definition to the end of the tree before the compile
 *   (`canonicalizeFootnoteTree`), so the parse tree and the document stay in step.
 * - `definition` → the URL an `imageReference` resolves against, consumed by the
 *   reference rather than represented in the document: no compiled block at all.
 * - everything else → one block, which is what the exact-class handlers produce.
 *
 * `test/dialect.test.ts` asserts the rule against the corpus: a document whose
 * blocks do not add up to the compiled document's blocks is a document this
 * table has not been taught about, and the sniffer refuses it rather than
 * comparing misaligned pairs.
 */
export const compiledBlockSpan = (node: Nodes): number => {
  switch (node.type) {
    case 'table':
      return node.children.length;
    case 'definition':
      return 0;
    default:
      return 1;
  }
};


/**
 * §5 step 2's stringify options — **as §5 writes them**.
 *
 * Kept verbatim, and asserted to throw, because two of the five values are not
 * legal inputs. `mdast-util-to-markdown` takes a single *character* for
 * `rule` (`*`, `-`, `_`) and for `fence` (`` ` ``, `~`) and expands it to the
 * three-character form itself: `rule: '*'` already serializes to `***`, and
 * `fence: '`'` already serializes to ` ``` `. Passing the *output* spelling
 * `'***'` / `'```'` throws. See `CANONICAL_STRINGIFY_OPTIONS` below for the
 * values the pipeline actually runs, and §2's findings F1.
 */
export const SPEC_STRINGIFY_OPTIONS = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  rule: '***',
  fence: '```',
  listItemIndent: 'one',
} as const;

/**
 * The options the pipeline runs: §5's *intent* — output spellings `-`, ` ``` `,
 * `***` — expressed as the single characters the library accepts.
 *
 * Every value is §5's own, with the three-character rule/fence spellings
 * reduced to the one character remark expands them from. `bullet`,
 * `emphasis`, `strong` and `listItemIndent` are already single tokens and are
 * byte-for-byte §5's..
 */
export const CANONICAL_STRINGIFY_OPTIONS = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  rule: '*',
  fence: '`',
  listItemIndent: 'one',
} as const;

/** Alias kept for the pipeline import sites. */
export const STRINGIFY_OPTIONS = CANONICAL_STRINGIFY_OPTIONS;

/**
 * §3.3's `break` row's spelling, as the two characters remark-stringify wants.
 *
 * The library cannot produce it. `mdast-util-to-markdown@2.1.3`'s `hardBreak`
 * returns the two-character string `"\\\n"` unconditionally, and this version has
 * **no** `hardBreakEscape` option to change it — so without an override every line
 * break Caotang writes came out as a backslash break, and the Tiptap preflight recorded
 * that spelling as the canonical dialect rather than as a divergence (§2.1's
 * result table, `hard-break-two-space` → *"byte-normalized to the canonical
 * dialect spelling"*). Measured: a two-space input came back as a backslash, and
 * a backslash input came back as a backslash, so the preflight's two rows were
 * the same row seen from both sides.
 *
 * The handler carries its own line ending for the same reason the default does:
 * the paragraph `join` does not add one between a text node and a `break` —
 * measured, returning the two spaces alone produced `line one  line two`, a
 * single run-on line. The override is one line because
 * `mdast-util-to-markdown` **merges** `options.handlers` into its defaults rather
 * than replacing them (`configure.js`, `case 'handlers': map(…)` → `Object.assign`),
 * so it adds the §3.3 spelling without touching the other **19** of the library's
 * **20** default handlers. Measured: `Object.keys(defaultHandlers)`
 * on 2.1.3 returns 20 — `blockquote, break, code, definition, emphasis, hardBreak,
 * heading, html, image, imageReference, inlineCode, link, linkReference, list, listItem,
 * paragraph, root, strong, text, thematicBreak`. The merge itself was also confirmed
 * end-to-end rather than by grep: with only `break` overridden, a heading, a break and
 * a list all still serialize (`"## H\n\none  \ntwo\n\n* item\n"`).
 */
export const TWO_SPACE_HARD_BREAK = '  \n';

/**
 * **The options a save actually runs**, and the single definition of them.
 *
 * `CANONICAL_STRINGIFY_OPTIONS` is §5's five values; this adds the one handler
 * override §3.3's `break` row requires. It lives here, beside the options, and
 * not in `pipeline.ts` because **two modules have to render with it and they must
 * not be able to disagree**: the save, and §5's dialect sniffer, which compares a
 * block's source spelling against what a save would write. A sniffer using the
 * five bare options while the save uses these reports a two-space line break as
 * foreign — measured, a *canonical* document produces one notice while its bytes
 * never change. A notice is a statement about this
 * product's dialect, so a second chain with different options is not a
 * simplification, it is a false positive waiting for a reader to act on.
 *
 * **What holds the coupling, measured — and it is not a test that reads either
 * call site.** `test/dialect.test.ts` asserts the *contents* of this object (that
 * it carries §5's five values and §3.3's `break` override), which every chain
 * passes whether it is handed this object or another one with the same values.
 * The disagreement itself is caught by four behavioural tests: pointing the sniffer's chain at the five bare
 * `CANONICAL_STRINGIFY_OPTIONS` fails **2** (§5's line-break test and the §13
 * sweep), and pointing the *save*'s chain at them fails **4** (those two plus
 * `pipeline.test.ts`'s two hard-break tests).
 *
 * **What is *not* held is the identity, and it cannot be: a copy with identical
 * contents leaves all 187 tests green** (measured — `{ ...SAVE_STRINGIFY_OPTIONS }`),
 * because a copy cannot disagree, which is the only disagreement this object
 * exists to prevent. So the reachability half — both call sites naming this one
 * constant rather than a second copy of its values — is a source guard in
 * `test/dialect.test.ts`, since it is a claim about the source that no behavioural
 * test can see.
 */
export const SAVE_STRINGIFY_OPTIONS = {
  ...CANONICAL_STRINGIFY_OPTIONS,
  handlers: { break: () => TWO_SPACE_HARD_BREAK },
} as const;

/**
 * The exact-class mdast types §3.3 maps, as data. `test/pipeline.test.ts`
 * reads §3.3's exact-class rows **out of the spec** and asserts this list is
 * exactly that set, and that every name here is registered in both handler
 * tables — so a type added to §3.3 and forgotten here is a red test rather
 * than a silent degrade.
 */
export const EXACT_CLASS_MDAST_TYPES = [
  'paragraph',
  'text',
  'blockquote',
  'heading',
  'list',
  'listItem',
  'emphasis',
  'strong',
  'inlineCode',
  'delete',
  'link',
  'image',
  'break',
  'thematicBreak',
  'code',
  'footnoteReference',
  'footnoteDefinition',
] as const;

/**
 * §3.3's `listItem`, plus the one thing a task item loses.
 *
 * The type is exact-content — a list item's children survive byte-for-byte — so
 * this handler stays in the exact class and is **not** in `DEGRADE_MDAST_TYPES`.
 * What a GFM task item carries is an extra `checked` attribute, and §3.1's
 * `list_item` has no attr slot for it: the `toPmNode` factory would drop it
 * without a word, and §3.3's *"anything unknown"* catch-all cannot see it either,
 * because `listItem` is a **known** type. Measured, that is the whole failure: a
 * document of `- [ ] undone\n- [x] done` loads, saves as `- undone\n- done`, and
 * says nothing at all — the two states that make a checklist a checklist are
 * gone, and §3 says out loud that v0.1 has no task lists.
 *
 * So the loss is made **visible** rather than stored: `checked !== null` is a
 * `lossy-attribute` at the item's own position. This is the 08:0x decision's
 * reading — a lost attribute is a loss, and `checked` is an attribute — and it is
 * why this row needs no §3.1 schema edit: `list_item` keeps no `checked`, the
 * item's *content* is untouched, and §3's "no task lists in v0.1" is honoured by
 * degrading rather than by adding an attribute the rest of the schema would then
 * have to round-trip.
 */
const listItemHandler =
  (schema: Schema, sink: LossWarning[]) => {
    const build = toPmNode(schema.nodes.list_item!);
    return (node: ListItem, parent: never, state: never) => {
      if (node.checked !== null && node.checked !== undefined) {
        warn(
          sink,
          node,
          'lossy-attribute',
          'A task item was kept as a plain list item; v0.1 stores no task lists, so whether it was ticked is lost.',
        );
      }
      return build(node, parent, state);
    };
  };

/** A `list` is one mdast type and two PM nodes, so it needs a real handler. */
const listHandler =
  (schema: Schema) =>
  (node: List, _parent: never, state: PmState) => {
    const type: NodeType = node.ordered ? schema.nodes.ordered_list! : schema.nodes.bullet_list!;
    const attrs = node.ordered ? { start: node.start ?? 1 } : null;
    return type.createAndFill(attrs, state.all(node) as never);
  };

/**
 * Parse handlers — the exact class only.
 *
 * Node names are §3.1's, not Tiptap's: §3.1 names them `bullet_list` /
 * `ordered_list` / `horizontal_rule` / `hard_break` / `code_block`, and
 * `schema.ts` uses those names. The mdast side keeps its own vocabulary
 * (`list` with an `ordered` flag, `thematicBreak`, `break`, `code`). The two
 * namespaces differ; §3.1 is the contract and the schema follows it.
 *
 * The return type is spelled out rather than left as `ReturnType<…>`: the
 * library's handler signature mentions a `State` type it does not export, so an
 * inferred return type would make this module's own declarations unnamed
 * (TS4023). Declaring the shape here is also the honest statement of the
 * contract — every key is an mdast type, and `state` is only used by the two
 * hand-written handlers.
 */
export interface ParseHandlers {
  paragraph: (node: never, parent: never, state: never) => unknown;
  heading: (node: Heading, parent: never, state: never) => unknown;
  blockquote: (node: never, parent: never, state: never) => unknown;
  list: (node: List, parent: never, state: PmState) => unknown;
  listItem: (node: ListItem, parent: never, state: never) => unknown;
  image: (node: Image, parent: never, state: never) => unknown;
  break: (node: never, parent: never, state: never) => unknown;
  thematicBreak: (node: never, parent: never, state: never) => unknown;
  emphasis: (node: Emphasis, parent: never, state: never) => unknown;
  strong: (node: Strong, parent: never, state: never) => unknown;
  delete: (node: Delete, parent: never, state: never) => unknown;
  link: (node: Link, parent: never, state: never) => unknown;
  inlineCode: (node: InlineCode) => unknown;
  code: (node: Code) => unknown;
  footnoteReference: (node: FootnoteReference) => unknown;
  footnoteDefinition: (node: FootnoteDefinition, parent: MdastParent, state: PmState) => unknown;

  // --- the degrade class. Every one of these is a construct §3.3 names, with
  // the behaviour and the warning code its own row declares. The parameter
  // shapes differ from the exact class because the degrade class needs `parent`
  // (to tell a block `html` from an inline one) and `state` (to resolve a
  // reference against the definitions 0.1.5 collects in `createState`).
  html: (node: Html, parent: MdastParent, state: PmState) => unknown;
  table: (node: Table, parent: MdastParent, state: PmState) => unknown;
  definition: (node: Definition, parent: MdastParent, state: PmState) => unknown;
  imageReference: (node: ImageReference, parent: MdastParent, state: PmState) => unknown;
  linkReference: (node: LinkReference, parent: MdastParent, state: PmState) => unknown;
}

/** The mdast container a handler is called with, as far as this file reads it. */
export interface MdastParent {
  type: string;
  children?: unknown[];
}

/**
 * The slice of the library's `State` this file actually uses. The real type is
 * not exported by 0.1.5, so it is described rather than imported.
 *
 * Three members, and each was added by a handler that could not be written
 * without it: `all` for the exact class's factories, `one` for a table row's
 * cells (`state.all(row)` would dispatch on `tableRow`, which has no handler
 * and would throw the same `unknown markdown node` the table itself does), and
 * `definitionById` for reference expansion. The map is built by the library's
 * own `createState` before any handler runs, keyed by the identifier
 * upper-cased — `mdast-util-to-prosemirror.js:18-29`, deliberately mimicking
 * CodeMirror's link definitions — so a Caotang-side pre-scan of the tree would
 * be a second implementation of a rule the library already applies, and would
 * have to be kept in step with it.
 */
export interface PmState {
  all: (parent: MdastParent) => unknown[];
  one: (node: unknown, parent: MdastParent) => PmNode | PmNode[] | null | undefined;
  definitionById: Map<string, { url: string; title?: string | null }>;
}


/**
 * Append one `LossWarning` for one degraded mdast node.
 *
 * Written as a function rather than inlined per handler because the *shape* is
 * the contract: `code` and `mdastType` are §3.3's own names, `position` is
 * copied from the source node's start when it has one and omitted when it does
 * not, and `detail` is the last field so a banner can render the human sentence
 * without reaching past the machine parts.
 */
const warn = (
  sink: LossWarning[],
  node: { type: string; position?: { start?: { line: number; column: number } } },
  code: LossWarning['code'],
  detail: string,
): void => {
  const start = node.position?.start;
  sink.push({
    code,
    mdastType: node.type,
    ...(start ? { position: { line: start.line, column: start.column } } : {}),
    detail,
  });
};

/**
 * The mdast types that map to **exactly one** PM mark each, so nesting one inside
 * another of the same type adds nothing to the mark set it is already inside.
 *
 * `emphasis` → `em`, `strong` → `strong`, `delete` → `strike`, per §3.2 and §3.3's
 * `delete` row.
 *
 * **Why `link` is not here.** One reason is *"`link` carries `href`/`title`, so two links
 * are interchangeable only when their attributes are equal"*, and that is a real
 * property of the mark and **not the operative one**: **CommonMark does not let
 * a link contain a link**, so the hypothetical it rules out cannot be written.
 * Measured — `[a [b](u) c][x]` does not nest at all: the inner link's brackets
 * break the outer reference, and the mdast is `text, link, text, linkReference`.
 * Both exclusions are kept (the attribute one describes the mark, the CommonMark
 * one is what actually holds) and the *effect* is what this row's audit needed:
 * **there is no fourth type to add.**
 *
 * `linkReference` reaches the same `link` mark through §3.3's degrade row, and it
 * **does** coalesce — measured, `[a][x][a][x]` becomes one `link` run holding
 * `aa` and saves as `[aa](u)`, carrying only the `lossy-attribute` warnings the
 * reference expansion already declares. It is left undeclared for the reason
 * docs/decisions.md records: nothing visible changes and the
 * target is unchanged, so it is not this row's loss. **That judgement is
 * narrower than §3.3's own text for this row**, which defines the loss as *"a
 * save re-parses as a different document"* rather than as a visible change, and
 * the narrower reading is a decision rather than a measurement.
 *
 * `inlineCode` is not here because CommonMark code spans cannot nest.
 *
 * The property that makes the set correct rather than convenient: a name is in it
 * only if *the same type* always produces *the same mark*. That is what lets the
 * ancestry test below be a comparison of type names with no mark construction and
 * no schema — measured for all three, and asserted for all three in
 * `test/merged-runs.test.ts`.
 */
const SINGLE_MARK_MDAST_TYPES: ReadonlySet<string> = new Set([
  'emphasis',
  'strong',
  'delete',
]);

/**
 * §3.3's **merged inline run** row: one `LossWarning` per mark node that an
 * ancestor already marks identically, so its run boundary is lost on the way into
 * the document.
 *
 * ## Why this is a pre-compile walk and not a handler
 *
 * The row's own first draft said *"sibling same-mark inline nodes"*, and that is
 * wrong in a way that changes the implementation. Measured on the §13 corpus
 * entry `strike-in-emphasis`, input `_gone and _struck_ together_`, the mdast is
 * **nested**, not siblinged:
 *
 * ```
 * paragraph
 *   emphasis            <- outer
 *     text("gone and ")
 *     emphasis          <- inner, a CHILD of the outer one
 *       text("struck")
 *     text(" together")
 * ```
 *
 * The two runs' boundaries are the *inner* node's edges, and it is inside the
 * outer one — so `_a_ _b_` (two `emphasis` **siblings**, separated by a text node)
 * does **not** merge, while `_a *b* c_` (nested) does. A sibling test would fire
 * on the one case that is safe and stay silent on the one that loses.
 *
 * It also has to reach past the direct parent, and that is what rules the handler
 * out rather than taste. `_a [b _c_ d](u) e_` puts the inner `emphasis` under a
 * `link`, which puts a whole `link` mark on its text — so the inner run merges
 * with its neighbours anyway, and the inner emphasis is **erased outright** from
 * the save (`_a [b c d](u) e_`). A check on `parent.type` alone misses it. The
 * library's handler signature is `(node, parent, state)`: `parent` is the real
 * mdast node with its `children` intact (measured — the inner `emphasis` is
 * called with `parent.type === "emphasis"` and three children), but mdast is a
 * tree with no back-pointer, so there is **no route from a mark handler to its own
 * ancestors**. `dialect.ts` already walks this same tree for the same reason, and
 * this is its sibling on the loss side.
 *
 * ## Why one warning and not one per merged run
 *
 * The outer node is the one that survives into the document and the inner one is
 * the one that is erased, so the warning is attached to the **inner** node and
 * there is exactly one of them per lost boundary. `_gone and _struck_ together_`
 * has one inner node and warns once; a document with two separate erasures warns
 * twice, which is the honest count.
 *
 * **Exported, and nothing outside this package calls it — measured
 * (2026-10-06 02:0x).** `index.ts` re-exports it, `pipeline.ts` is its only
 * caller, and no test imports it directly either: every assertion about this walk
 * goes through `parseWithDiagnostics`, which is the right way to test it. The
 * export is kept rather than dropped (removing it is an API decision, not a
 * correction), so this line is here so the next reader does not assume a public
 * surface is a used one.
 */
export const warnMergedInlineRuns = (tree: unknown, sink: LossWarning[]): void => {
  const walk = (node: { type: string; children?: unknown[] }, inherited: ReadonlySet<string>): void => {
    const isSingleMark = SINGLE_MARK_MDAST_TYPES.has(node.type);
    if (isSingleMark && inherited.has(node.type)) {
      warn(
        sink,
        node,
        'lossy-structure',
        `A nested ${node.type} run was merged into the ${node.type} around it; the inner run's boundary is not stored in v0.1.`,
      );
    }
    // The mark is in scope for the *children*, never for the node itself — the
    // node's own check above is against what its ancestors already applied, which
    // is the whole distinction between the outer node (no warning) and the inner
    // one (this warning).
    const next = isSingleMark ? new Set([...inherited, node.type]) : inherited;
    for (const child of node.children ?? []) {
      walk(child as { type: string; children?: unknown[] }, next);
    }
  };
  walk(tree as { type: string; children?: unknown[] }, new Set());
};

/**
 * The mdast containers whose children are **phrasing** content, i.e. the parents
 * a raw HTML node has to stay inline for.
 *
 * A `html` node is one mdast type in two positions, and §3.3 has one row for
 * both: *"rendered as literal text paragraph"*. A block `html` node is a child
 * of a block container, so a bare text node there is what makes the library
 * throw `Invalid content for node doc`; an inline one is a child of phrasing
 * content, where a paragraph would be invalid. The discriminator is the parent's
 * type rather than `parent.type === 'root'`, because a raw HTML block inside a
 * blockquote or a list item has a block parent that is not the root — and that
 * construct is real, not hypothetical.
 */
const PHRASING_CONTAINERS: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'imageReference',
  'footnoteReference',
  'tableCell',
]);

/**
 * A **link** reference as literal text, in the spelling CommonMark gives it.
 *
 * The spelling is 0.1.5's own `revert` (`mdast-util-to-prosemirror.js:76-105`),
 * transcribed because it is not exported. A link reference's visible text is its
 * identifier, so the shortcut is `[docs]`, the collapsed `[docs][]` and the full
 * `[docs][label]` — with a `[^]` prefix it would be a footnote marker, which is
 * a different construct entirely and would re-parse as one.
 *
 * `identifier` is the visible text rather than the concatenation of the children
 * because CommonMark *defines* it that way: in `[text][ref]` the label's own
 * content is what is displayed, and remark-parse has already resolved a resolvable
 * reference into children before this is reachable. Only the unresolvable
 * degrade uses it, and that path is unreachable through the parse chain (measured:
 * remark-parse leaves an undefined reference as literal text and never emits a
 * `linkReference` node), so it is called directly in the test.
 */
const linkReferenceText = (node: {
  identifier: string;
  label?: string | null;
  referenceType?: string | null;
}): string => {
  const suffix =
    node.referenceType === 'collapsed'
      ? '][]'
      : node.referenceType === 'full'
        ? `][${node.label || node.identifier}]`
        : ']';
  return `[${node.identifier}${suffix}`;
};

/**
 * One GFM table row as one paragraph — §3.3's *"each row serialized as one
 * paragraph line"*.
 *
 * The cell contents go through the library (`state.one` per child) rather than
 * being flattened to a string, so `_em_` and `**strong**` inside a cell survive
 * as marks. §3.3 degrades the table's *structure* — `lossy-structure` — and
 * flattening inline content to plain text would add a second, undeclared loss on
 * top of it.
 *
 * The cells are joined with a single space, and that is the one thing §3.3 does
 * not spell out. The space is chosen
 * because it is the only join that makes the row a **paragraph** on the next
 * load: a join that kept the `|` would re-parse as a GFM table, so the degraded
 * form would never become the paragraph §3.3 says it is, and the fixture's own
 * round-trip would be a second degrade.
 */
const rowAsParagraph = (schema: Schema, row: TableRow, state: PmState): PmNode => {
  const content: PmNode[] = [];
  row.children.forEach((cell: TableCell, index) => {
    if (index > 0) content.push(schema.text(CELL_JOIN));
    for (const child of cell.children) {
      const built = state.one(child, cell);
      if (!built) continue;
      // `state.one` may answer with a single node or with an array (the mark
      // factories return arrays), and the library's own `all` flattens both —
      // so this handler has to do the same rather than assume one shape.
      if (Array.isArray(built)) content.push(...built);
      else content.push(built);
    }
  });
  return schema.nodes.paragraph!.create(null, content);
};

/** The one separator §3.3 leaves open. See `rowAsParagraph` and docs/decisions.md. */
const CELL_JOIN = ' ';

/**
 * §3.3's degrade rows, as handlers.
 *
 * Each one's `detail` is the sentence a load banner shows a writer, so it says
 * what was kept and what was not — §3.3's own framing is that the user is told
 * at load that "save will normalize these constructs", and a warning that only
 * named the construct would leave the reader to guess which half survived.
 */
const createDegradeHandlers = (schema: Schema, sink: LossWarning[]) => ({
  // `html` — one row, two positions. The whole raw value is kept, including
  // both tags, which is what §3.3's "literal text" means and what the library's
  // default does not do (its handler parses the value as HTML and keeps only
  // the text inside, so `<span>x</span>` came back as `<span>x`).
  html: (node: Html, parent: MdastParent) => {
    warn(
      sink,
      node,
      'unsupported-node',
      'Raw HTML is kept as literal text; v0.1 stores no HTML nodes, so it will be saved escaped.',
    );
    const text = schema.text(node.value);
    return PHRASING_CONTAINERS.has(parent?.type ?? '') ? text : schema.nodes.paragraph!.create(null, text);
  },

  // `table` — the only degrade that turns one node into several. The library
  // flattens an array answer into the parent, so a row-per-paragraph answer
  // lands in `doc` as siblings.
  table: (node: Table, _parent: MdastParent, state: PmState) => {
    warn(
      sink,
      node,
      'lossy-structure',
      'A GFM table was flattened to one paragraph per row; the table structure is not stored in v0.1.',
    );
    return node.children.map((row: TableRow) => rowAsParagraph(schema, row, state));
  },

  // `definition` — the URL an `imageReference` resolves against, so this node is
  // consumed by the reference rather than represented in the document. It is
  // still a degrade row in §3.3 and it still gets its code: the definition is
  // what a save drops, and `linkReference` still resolves through 0.1.5's own
  // default, so this warning is how a writer learns their reference style is
  // not kept. Returns nothing, which is what the library's `ignore` did and
  // what the resolved document needs.
  definition: (node: Definition) => {
    warn(
      sink,
      node,
      'lossy-attribute',
      'A link/image definition was expanded into its reference; the definition is not kept in v0.1.',
    );
    return undefined;
  },

  // `imageReference` — §3.3's "expanded to direct image with resolved URL".
  // An unresolvable reference degrades to literal text rather than throwing:
  // §3.3's rule is that behaviour is never silent, and a *failed* load is the
  // one outcome the degrade class exists to prevent. The literal spelling is
  // 0.1.5's own (`revert`, `mdast-util-to-prosemirror.js:76-105`).
  imageReference: (node: ImageReference, _parent: MdastParent, state: PmState) => {
    const definition = state.definitionById.get(String(node.identifier).toUpperCase());
    warn(
      sink,
      node,
      'lossy-attribute',
      definition
        ? 'An image reference was expanded to a direct image; the reference form is not kept in v0.1.'
        : 'An image reference could not be resolved, so it was kept as literal text.',
    );
    if (!definition) return [schema.text(`![${node.alt ?? ''}]`)];
    return schema.nodes.image!.create({
      src: definition.url,
      alt: node.alt ?? null,
      title: definition.title ?? null,
    });
  },

  // `linkReference` — §3.3's row groups this with `definition` and
  // `imageReference`: "expanded to direct link/image with resolved URL; warning
  // `lossy-attribute`". 0.1.5 already *resolves* it (its own default walks
  // `definitionById` and applies the `link` mark), so the expansion half of the row
  // is not what is missing — the **warning** is. A document of
  // `[text][ref]\n\n[ref]: https://example.com` resolved correctly and said
  // nothing, and §3.3's promise is that a writer is *told* their reference style
  // is not kept. The definition's own warning covers the dropped definition; this
  // one covers the reference the writer actually typed.
  //
  // The children are built through `state.all` and then marked, rather than
  // reused from 0.1.5, because a handler that cannot be seen cannot be trusted
  // with the one thing §3.3 declares about it. The mark goes **last**, which is
  // the order 0.1.5 produces and the order the serializer reads: measured, the
  // mark set on `*em*` inside a link reference is `[em, link]`, and an `em` mark
  // outside the link is what comes out.
  //
  // A child that already carries a `link` mark is left alone rather than marked
  // twice. CommonMark does not nest links, so the chain cannot produce that case —
  // but `mark()` would happily stack a second identical link mark, and a document
  // whose serialization then depends on a case the dialect forbids is a defect
  // waiting for a permissive parser.
  linkReference: (node: LinkReference, _parent: MdastParent, state: PmState) => {
    const definition = state.definitionById.get(String(node.identifier).toUpperCase());
    warn(
      sink,
      node,
      'lossy-attribute',
      definition
        ? 'A link reference was expanded to a direct link; the reference form is not kept in v0.1.'
        : 'A link reference could not be resolved, so it was kept as literal text.',
    );
    if (!definition) return [schema.text(linkReferenceText(node))];
    const link = schema.marks.link!.create({
      href: definition.url,
      title: definition.title ?? null,
    });
    return state.all(node).map((child) => {
      const built = child as PmNode;
      return built.marks.some((mark) => mark.type.name === 'link')
        ? built
        : built.mark([...built.marks, link]);
    });
  },
});

/**
 * The parse handler table: §3.3's exact class and its degrade rows, in one
 * object, because the library dispatches a single table.
 *
 * ## Why `sink` is required and is an array
 *
 * The warnings are appended to an array **the caller owns**, and the handlers
 * hold no state of their own. That is what makes §3.3's stability claim true by
 * construction rather than by discipline: there is no module-level collector to
 * clear between loads, so a second `parse` of the same body returns the same
 * warnings in the same order and a parse of a *different* body in between
 * cannot leak into it. `test/degrade.test.ts` asserts that ordering against a
 * load of the same body either side of an unrelated one, because the version
 * that would break it — a shared array — is the version that still passes a
 * single-parse test.
 */
export const createParseHandlers = (schema: Schema, sink: LossWarning[]): ParseHandlers => ({

  // --- container nodes: the exported factories do the work ----------------
  paragraph: toPmNode(schema.nodes.paragraph!),
  heading: toPmNode(schema.nodes.heading!, (node: Heading) => ({ level: node.depth })),
  blockquote: toPmNode(schema.nodes.blockquote!),
  list: listHandler(schema),
  listItem: listItemHandler(schema, sink),
  image: toPmNode(schema.nodes.image!, (node: Image) => ({
    src: node.url,
    alt: node.alt ?? null,
    title: node.title ?? null,
  })),
  break: toPmNode(schema.nodes.hard_break!),
  thematicBreak: toPmNode(schema.nodes.horizontal_rule!),

  // --- marks ---------------------------------------------------------------
  emphasis: toPmMark(schema.marks.em!),
  strong: toPmMark(schema.marks.strong!),
  delete: toPmMark(schema.marks.strike!),
  link: toPmMark(schema.marks.link!, (node: Link) => ({
    href: node.url,
    title: node.title ?? null,
  })),

  // --- the two `value`-carrying leaves, hand-written ------------------------
  // `inlineCode` is a text node carrying the `code` MARK (§3.2 makes inline
  // code a mark, not a node).
  inlineCode: (node: InlineCode) => [schema.text(node.value, [schema.marks.code!.create()])],
  // A fence's info string is `language meta` — remark parses `js title=x` as
  // `lang: 'js', meta: 'title=x'` — and §3.1's `code_block` has a slot for the
  // language and **none** for the rest, so the loader keeps the language and
  // drops `title=x`. That is the same shape as a task item's `checked`: the
  // *type* is exact-content and the *attribute* is lost, so §3.3 carries its
  // own row for it and the loss is **warned** rather than silent. A fence with
  // only a language warns nothing — the warning is about the part that is
  // dropped, not about fences.
  code: (node: Code) => {
    if (node.meta) {
      warn(
        sink,
        node,
        'lossy-attribute',
        "A fenced code block's info string carried more than its language; v0.1 stores no info-string meta, so that part of the fence is lost.",
      );
    }
    return schema.nodes.code_block!.create(
      { language: node.lang ?? null },
      node.value ? schema.text(node.value) : undefined,
    );
  },

  // --- footnotes (#270): exact. The label is the writer's spelling; mdast's
  // `label` is optional and the `identifier` is its case-folded form, so the
  // label falls back to the identifier.
  footnoteReference: (node: FootnoteReference) =>
    schema.nodes.footnote_reference!.create({ label: node.label ?? node.identifier }),
  // An empty definition (`[^1]:`) has no children, and §3.1's `block+` fills it
  // with one empty paragraph, which the serializer writes back as `[^1]:`.
  footnoteDefinition: (node: FootnoteDefinition, _parent: MdastParent, state: PmState) =>
    schema.nodes.footnote_definition!.createAndFill(
      { label: node.label ?? node.identifier },
      state.all(node) as never,
    ),

  // --- the degrade class, spread last so every name above is still §3.3's ----
  ...createDegradeHandlers(schema, sink),
});

/**
 * Serialize handlers, keyed on the same §3.1/§3.2 PM names.
 *
 * Takes no schema, unlike `createParseHandlers` — the serialize side never
 * constructs a node, it only reads one, so a `schema` parameter here would be
 * an unused argument pretending to be a dependency.
 */
export const createSerializeHandlers = () => ({
  paragraph: fromPmNode('paragraph'),
  heading: fromPmNode('heading', (node) => ({
    // mdast types `depth` as the literal union 1–6; §3.1's `level` attr is a
    // plain number. The cast is at the boundary between the two, not a blanket
    // `any`, and remark-parse only ever produces 1–6 from a `#`×N run.
    depth: node.attrs.level as Heading['depth'],
  })),
  blockquote: fromPmNode('blockquote'),
  bullet_list: fromPmNode('list', () => ({ ordered: false, spread: false })),
  ordered_list: fromPmNode('list', (node) => ({
    ordered: true,
    start: (node.attrs.start as number | null) ?? 1,
    spread: false,
  })),
  list_item: fromPmNode('listItem'),
  horizontal_rule: fromPmNode('thematicBreak'),
  hard_break: fromPmNode('break'),
  image: fromPmNode('image', (node) => ({
    url: node.attrs.src as string,
    alt: (node.attrs.alt as string | null) ?? undefined,
    title: (node.attrs.title as string | null) ?? undefined,
  })),

  // The two `value`-carrying leaves again, on the way out. `fromPmMark` and
  // `fromPmNode` both emit `children`, which remark-stringify does not read for
  // these two types — it reads `value`.
  code_block: (node: { textContent: string; attrs: Record<string, unknown> }) => ({
    type: 'code' as const,
    value: node.textContent,
    lang: (node.attrs.language as string | null) ?? undefined,
  }),
  code: (_mark: unknown, _parent: unknown, children: Array<{ value?: string }>) => ({
    type: 'inlineCode' as const,
    value: children.map((child) => child.value ?? '').join(''),
  }),

  // --- footnotes (#270). The identifier is the label's case-folded key, as
  // remark-parse writes it. A reference is a leaf, so it carries no children.
  footnote_reference: (node: { attrs: Record<string, unknown> }) => ({
    type: 'footnoteReference' as const,
    identifier: footnoteIdentifier(node.attrs.label as string),
    label: node.attrs.label as string,
  }),
  // A note that is one empty paragraph is written `[^n]:`, the spelling an empty
  // definition loads from, so an empty note round-trips byte for byte.
  footnote_definition: (node: PmNode, _parent: unknown, state: { all: (node: PmNode) => unknown[] }) => ({
    type: 'footnoteDefinition' as const,
    identifier: footnoteIdentifier(node.attrs.label as string),
    label: node.attrs.label as string,
    children:
      node.childCount === 1 && node.firstChild!.type.name === 'paragraph' && node.firstChild!.childCount === 0
        ? []
        : state.all(node),
  }),

  // --- marks ---------------------------------------------------------------
  em: fromPmMark('emphasis'),
  strong: fromPmMark('strong'),
  strike: fromPmMark('delete'),
  link: fromPmMark('link', (mark) => ({
    url: mark.attrs.href as string,
    title: (mark.attrs.title as string | null) ?? undefined,
  })),
});

export type SerializeHandlers = ReturnType<typeof createSerializeHandlers>;
export { fromPmMark, fromPmNode, toPmMark, toPmNode };
export type { Delete, Emphasis, Strong };
