/**
 * §3.3's **degrade** class: the four load-fatal constructs and the
 * `LossWarning[]` they emit.
 *
 * ## What this slice had to prove, and why it is four fixtures and not one
 *
 * remark-prosemirror 0.1.5 has no degrade path at all. Its `unknown()` throws
 * `unknown markdown node: <type>`, and its default `html` handler returns a
 * *text* node where `doc` requires `block+`, so the document's own `check()`
 * throws instead. Measured, on the four §13 corpus entries this file uses:
 * `table`, `footnoteReference` and `imageReference` throw by name, and
 * `html-raw-block` throws `Invalid content for node doc: <"<div>raw</div>">`.
 * **So a manuscript with a table in it does not open**, and §3's one sentence
 * — *"No tables, no task lists, no footnotes, no HTML nodes in v0.1"* — is
 * satisfied by degrading rather than by refusing.
 *
 * Four fixtures, because "a warning was emitted" passes on all four and is the
 * assertion that lets a code drift. §3.3 gives `table` a different code from
 * the other three, so each test below asserts **its own** code and its own
 * `mdastType`; a handler that emitted `unsupported-node` for a table would
 * leave three of these four green.
 *
 * ## Why the fixtures are read from the audit's corpus and not re-typed
 *
 * The four §13 degrade entries
 * (`table-gfm`, `footnote-reference`, `image-reference`, `html-raw-block`), and
 * the corpus is the authoritative list. Copying four strings into this file
 * would make a corpus edit leave the product testing a construct that no longer
 * exists, and the lookup below fails loudly instead.
 *
 * ## The controls, and what each one would have caught
 *
 * - **Every fixture has a "remove the handler and it throws" control.** A
 *   degrade suite that only asserts the passing case cannot tell a handler from
 *   a library improvement, and each control asserts the *exact* message the
 *   0.1.5 table is documented to produce — so if a future pin makes the library
 *   degrade on its own, the control fails and says the table is no longer
 *   load-bearing.
 * - **The determinism test interleaves an unrelated load.** A module-level
 *   collector — the obvious way to write this — passes every single-parse
 *   assertion and fails this one, which is why it exists.
 * - **The separation test asserts the audit still throws.** Asserting only that
 *   the audit lacks the product's handlers would also pass if the audit had
 *   stopped being able to parse at all.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkProseMirror } from '@handlewithcare/remark-prosemirror';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Root as MdastRoot } from 'mdast';
import { describe, expect, it } from 'vitest';
import { CORPUS, createParseHandlers as createAuditParseHandlers, caotangSchema as auditSchema } from '@caotang/editor-audit';

import {
  DEGRADE_MDAST_TYPES,
  EXACT_CLASS_MDAST_TYPES,
  createParseHandlers,
  parse,
  parseWithDiagnostics,
  caotangSchema,
  serialize,
} from '../src/index.js';
import type { LossWarning } from '../src/index.js';

/** §13's own entry, by name. A rename fails here rather than testing nothing. */
const corpusInput = (name: string): string => {
  const entry = CORPUS.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no §13 corpus entry named ${name}`);
  return entry.input;
};

/** The document as data, so an assertion cannot pass on the wrong shape. */
const shapeOf = (node: PmNode): unknown =>
  [
    node.type.name,
    node.attrs,
    node.marks.map((m) => [m.type.name, m.attrs]).sort(),
    node.text,
    node.children.map(shapeOf),
  ].filter((part) => part !== null && part !== undefined);

/**
 * A local load through a **hand-picked** handler table, so a control can remove
 * one key. The shipped `parse` binds the shipped table and cannot be edited
 * from a test — which is the point of it, and also why the controls are written
 * this way rather than by mutating the module.
 */
const loadWith = async (handlers: Record<string, unknown>, body: string): Promise<PmNode> => {
  const load = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkProseMirror, { schema: caotangSchema, handlers: handlers as never });
  const tree = (await load.run(load.parse(body))) as MdastRoot;
  return load.stringify(tree) as unknown as PmNode;
};

/**
 * The same local load, but keeping the warning sink **and** the document.
 *
 * `loadWith` discards the sink, which is why a control for a *handler the
 * library already satisfies* cannot be written with it: the construct expands
 * correctly either way, so the only thing a control can distinguish is the
 * warning, and a helper that throws the warnings away cannot state the
 * difference. This returns both, so the control reads as a number.
 */
const diagnoseWith = async (
  drop: string | null,
  body: string,
): Promise<{ doc: PmNode; warnings: LossWarning[] }> => {
  const warnings: LossWarning[] = [];
  const table = createParseHandlers(caotangSchema, warnings) as unknown as Record<string, unknown>;
  if (drop !== null) delete table[drop];
  const load = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkProseMirror, { schema: caotangSchema, handlers: table as never });
  const tree = (await load.run(load.parse(body))) as MdastRoot;
  return { doc: load.stringify(tree) as unknown as PmNode, warnings };
};

const without = (drop: string): Record<string, unknown> => {
  const table = createParseHandlers(caotangSchema, []) as unknown as Record<string, unknown>;
  const copy = { ...table };
  delete copy[drop];
  return copy;
};

const TABLE = corpusInput('table-gfm');
const FOOTNOTE = corpusInput('footnote-reference');
const IMAGE_REF = corpusInput('image-reference');
const LINK_REF = corpusInput('link-reference');
const TASK_ITEM = corpusInput('list-task-item');
const HTML_BLOCK = corpusInput('html-raw-block');
const HTML_INLINE = corpusInput('html-raw-inline');

describe('§3.3 degrade class — a GFM table', () => {
  it('parses, warns `lossy-structure`, and becomes one paragraph per row', async () => {
    const { doc, warnings } = await parseWithDiagnostics(TABLE);
    // §3.3: "each row serialized as one paragraph line; warning lossy-structure".
    // The header row is a row, so `| a | b |` is the first paragraph.
    expect(warnings).toEqual([
      {
        code: 'lossy-structure',
        mdastType: 'table',
        position: { line: 1, column: 1 },
        detail: expect.stringContaining('one paragraph per row'),
      },
    ]);
    expect(shapeOf(doc)).toEqual([
      'doc',
      {},
      [],
      [
        ['paragraph', {}, [], [['text', {}, [], 'a b', []]]],
        ['paragraph', {}, [], [['text', {}, [], '1 2', []]]],
      ],
    ]);
  });

  it('CONTROL: without the handler the same fixture throws the library message', async () => {
    await expect(loadWith(without('table'), TABLE)).rejects.toThrow(
      'unknown markdown node: table',
    );
  });

  it('the join is a space, and a row of dashes stays a paragraph — the two facts that hold the choice', async () => {
    // docs/decisions.md settled the cell separator on the ground
    // that *"a `|` join re-parses as a GFM table"*. **Measured, that is false**,
    // and false for a structural reason worth writing down: the product emits
    // **one paragraph per row**, and a paragraph boundary is a *blank line*, so
    // pipe-joined rows are never on adjacent lines and never re-form a table.
    // The claimed outcome needs `a | b\n--- | ---\n` — rows sharing lines — and
    // this shape cannot produce it, not even for a delimiter-shaped row
    // (measured: `a | b\n\n\--- | ---\n` is two paragraphs).
    //
    // **So the logged argument holds nothing, and what actually holds the choice
    // is the bytes**: a `|` join leaves the delimiter in the saved text — `a | b`
    // instead of `a b`, and a one-column table saves as `\| a | b |` with the
    // leading pipe escaped. That is the difference, and it is a *content*
    // difference rather than a structural one. Asserted here so the choice is
    // held by a stated fact instead of by an argument that measures false.
    const src = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n';
    const out = serialize(await parse(src));
    expect(out).toBe('a b\n\n1 2\n\n3 4\n');
    expect(out).not.toContain('|');

    // **The space join's own sharp edge, and the one nothing tested.** A row
    // whose cells are all dashes saves as `--- ---`, which is a `thematicBreak` —
    // §5's scene separator — unless the canonical escaping carries it. Measured
    // both ways: bare `--- ---` parses as a thematicBreak, escaped as a
    // paragraph. Without the escape a degraded table row would silently become a
    // scene separator on the next load, which is a construct a writer never wrote.
    const tricky = serialize(await parse('| a | b |\n| --- | --- |\n| --- | --- |\n'));
    const load = unified().use(remarkParse).use(remarkGfm);
    const blocks = ((load.parse(tricky) as MdastRoot).children ?? []).map((c) => c.type);
    expect(blocks).toEqual(['paragraph', 'paragraph']);
    // And §3.3's invariant is a fixed point, not a shape.
    expect(serialize(await parse(tricky))).toBe(tricky);
  });
});

describe('§3.3 degrade class — a footnote', () => {
  it('parses, warns `unsupported-node` twice, and keeps the marker as text', async () => {
    const { doc, warnings } = await parseWithDiagnostics(FOOTNOTE);
    // Two warnings for one fixture, and both are `unsupported-node`: the inline
    // reference and the definition. The definition is in §3.3's same row, and it
    // is a *second* warning rather than a silent extra loss — the library drops
    // it with `ignore`, and a definition that vanishes without a word is the
    // failure mode this class exists to stop.
    expect(warnings.map((w) => [w.code, w.mdastType, w.position])).toEqual([
      ['unsupported-node', 'footnoteReference', { line: 1, column: 5 }],
      ['unsupported-node', 'footnoteDefinition', { line: 3, column: 1 }],
    ]);
    // §3.3: "inline `[^n]` text kept, definition appended as paragraph". The
    // `[^1]` is *text*, so the bracket is escaped on the way out and unescaped
    // on the way back — §5's "parse is lenient, serialize is canonical".
    expect(shapeOf(doc)).toEqual([
      'doc',
      {},
      [],
      [
        ['paragraph', {}, [], [['text', {}, [], 'Text[^1]', []]]],
        ['paragraph', {}, [], [['text', {}, [], 'The note.', []]]],
      ],
    ]);
    expect(serialize(doc)).toBe('Text\\[^1]\n\nThe note.\n');
  });

  it('CONTROL: without the handler the reference throws the library message', async () => {
    await expect(loadWith(without('footnoteReference'), FOOTNOTE)).rejects.toThrow(
      'unknown markdown node: footnoteReference',
    );
  });

  it('CONTROL: without the definition handler the note is dropped with no warning', async () => {
    // The other direction, and the one the fixture alone would have missed: the
    // library's `ignore` default does not throw, so a *missing* definition
    // handler is invisible unless the note's text is looked for.
    const doc = await loadWith(without('footnoteDefinition'), FOOTNOTE);
    expect(serialize(doc)).toBe('Text\\[^1]\n');
  });
});

describe('§3.3 degrade class — an image reference', () => {
  it('parses without a warning, shows a direct image, and saves the reference as it was written', async () => {
    const { doc, warnings } = await parseWithDiagnostics(IMAGE_REF);
    // The reference and its definition are kept in the document's source provenance (source-provenance.ts), so nothing is lost
    // and nothing is warned.
    expect(warnings).toEqual([]);
    // §3.3: the image shows with the resolved URL, and carries the id of its written source.
    expect(shapeOf(doc)).toEqual([
      'doc',
      { provenance: expect.anything() },
      [],
      [['paragraph', {}, [], [['image', { src: 'img.png', alt: 'alt', title: null, prov: 'r1' }, [], []]]]],
    ]);
    expect(serialize(doc)).toBe(IMAGE_REF.replace(/\n*$/, '\n'));
  });

  it('a reference whose spelling cannot be kept expands to a direct image and warns', async () => {
    // A label with a line break cannot be sliced back out as one line.
    const { warnings } = await parseWithDiagnostics('![al\nt][d]\n\n[d]: img.png\n');
    expect(warnings.map((w) => [w.code, w.mdastType])).toEqual([['lossy-attribute', 'imageReference']]);
  });

  it('CONTROL: without the handler the same fixture throws the library message', async () => {
    await expect(loadWith(without('imageReference'), IMAGE_REF)).rejects.toThrow(
      'unknown markdown node: imageReference',
    );
  });

  it('an undefined reference never reaches a handler at all — measured, not assumed', async () => {
    // This is the finding that shaped the test below it, and it is the reason the
    // fallback is not covered by a fixture: **remark-parse resolves references
    // itself**, so `![alt][nowhere]` arrives as one literal *text* node and the
    // degrade class is never entered. Nothing is lost and nothing is warned
    // about, because nothing was a reference. A fixture-based test of the
    // fallback would have passed by never reaching it.
    const { doc, warnings } = await parseWithDiagnostics('![alt][nowhere]\n');
    expect(warnings).toEqual([]);
    expect(shapeOf(doc)).toEqual(['doc', {}, [], [['paragraph', {}, [], [['text', {}, [], '![alt][nowhere]', []]]]]]);
  });

  it('the unresolvable-reference fallback degrades to literal text, called directly', async () => {
    // The branch itself, exercised at the handler rather than through the parse
    // chain, because the parse chain cannot produce the state that reaches it.
    // §3.3's rule is that behaviour is never silent and a *failed load* is the
    // one outcome the degrade class exists to prevent — so if a state this
    // library version ever does produce arrives, the answer is literal text and
    // a warning, not a throw.
    const sink: LossWarning[] = [];
    const handler = createParseHandlers(caotangSchema, sink).imageReference as (
      node: unknown,
      parent: unknown,
      state: unknown,
    ) => PmNode[];
    const built = handler(
      { type: 'imageReference', identifier: 'nowhere', alt: 'alt', referenceType: 'shortcut' },
      { type: 'paragraph' },
      { definitionById: new Map(), one: () => null, all: () => [] },
    );
    expect(built.map((node) => node.text)).toEqual(['![alt]']);
    expect(sink.map((w) => [w.code, w.mdastType])).toEqual([['lossy-attribute', 'imageReference']]);
    expect(sink[0]!.detail).toContain('could not be resolved');
  });
});

describe('§3.3 degrade class — a GFM task item', () => {
  it('warns `lossy-attribute` per item and keeps the item as a plain list item', async () => {
    const { doc, warnings } = await parseWithDiagnostics(TASK_ITEM);
    // §3's "No tables, no task lists … in v0.1", satisfied by degrading. The
    // fixture is two items — one ticked, one not — so this asserts **two**
    // warnings and both positions, which is what a `checked` *attribute* on every
    // task item means. A handler that warned once per list would pass the
    // single-item spelling of this fixture and be wrong here.
    expect(warnings.map((w) => [w.code, w.mdastType, w.position])).toEqual([
      ['lossy-attribute', 'listItem', { line: 1, column: 1 }],
      ['lossy-attribute', 'listItem', { line: 2, column: 1 }],
    ]);
    // The item's *content* is exact-content per §3.3's `listItem` row, and the
    // shape says so: the same two paragraphs, under a `list_item`, with no attrs
    // invented for the checkbox.
    expect(shapeOf(doc)).toEqual([
      'doc',
      {},
      [],
      [[
        'bullet_list',
        {},
        [],
        [
          ['list_item', {}, [], [['paragraph', {}, [], [['text', {}, [], 'undone', []]]]]],
          ['list_item', {}, [], [['paragraph', {}, [], [['text', {}, [], 'done', []]]]]],
        ],
      ]],
    ]);
    // §5's canonical spelling of what survives, asserted as **bytes** because the
    // two items are the whole point: `[ ]` and `[x]` both go, and neither leaves
    // a trace that the other did not.
    expect(serialize(doc)).toBe('- undone\n- done\n');
  });

  it('CONTROL: a plain list item of the same shape is not a degrade', async () => {
    // The direction that makes the two warnings above a claim rather than a
    // constant. `listItem` is §3.3's *exact-content* row, so a warning on every
    // list item would train a writer to ignore the banner — and this is the
    // 08:0x decision's rejected option, one level down: a code that fires on
    // every list is a code that fires on every checklist.
    const { warnings } = await parseWithDiagnostics('- undone\n- done\n');
    expect(warnings).toEqual([]);
  });

  it('CONTROL: the degraded bytes predate the warning, because the schema has nowhere to put a checkbox', async () => {
    // The regression this slice exists to prevent, stated as the thing that makes
    // it a *visibility* fix rather than a schema fix. §3.3's row for a task item
    // says the checkbox is lost, and the way to tell a declared loss from a
    // silent one is to show that the bytes were already lossy before any warning
    // existed: a document built by hand out of §3.1's `list_item` — which has no
    // `checked` attr to set — serializes to exactly what the fixture degrades to.
    //
    // A document with nowhere to store the checkbox cannot preserve it, so adding
    // a warning cannot change the output. That is also why this control builds the
    // document rather than removing the handler: 0.1.5 has **no** default for
    // `listItem` (measured — removing the key throws `unknown markdown node:
    // listItem`, not a silent pass), so "the library without our handler" is not a
    // state that exists for this construct.
    const hand = caotangSchema.nodes.doc!.create(null, [
      caotangSchema.nodes.bullet_list!.create(null, [
        caotangSchema.nodes.list_item!.create(null, [
          caotangSchema.nodes.paragraph!.create(null, caotangSchema.text('undone')),
        ]),
        caotangSchema.nodes.list_item!.create(null, [
          caotangSchema.nodes.paragraph!.create(null, caotangSchema.text('done')),
        ]),
      ]),
    ]);
    expect(serialize(hand)).toBe('- undone\n- done\n');
    expect(serialize(await parse(TASK_ITEM))).toBe(serialize(hand));
  });

  it('CONTROL: the handler itself is silent for a `checked` of null', async () => {
    // The branch, at the boundary. `checked: null` is what remark-parse sets on
    // every *plain* list item, so a test written as `if (node.checked)` would be
    // green here and wrong for the document that matters — and a test written as
    // `if ('checked' in node)` would warn on every list in every document, which
    // is the 08:0x decision's rejected option one level down.
    const sink: LossWarning[] = [];
    const handler = createParseHandlers(caotangSchema, sink).listItem as (
      node: unknown,
      parent: unknown,
      state: unknown,
    ) => PmNode;
    handler(
      { type: 'listItem', checked: null, children: [] },
      { type: 'bullet_list' },
      { all: () => [], one: () => null, definitionById: new Map() },
    );
    expect(sink).toEqual([]);
  });

  it('a nested task item warns at its own position, not the list\'s', async () => {
    // The position field is the difference between a banner a writer can act on
    // and one they cannot, and a nested item is the case where a handler that
    // reported the parent's position would look right in the two-item fixture.
    const { warnings } = await parseWithDiagnostics('- parent\n  - [x] child\n');
    expect(warnings.map((w) => [w.code, w.mdastType, w.position])).toEqual([
      ['lossy-attribute', 'listItem', { line: 2, column: 3 }],
    ]);
  });
});

describe('§3.3 degrade class — a fence info string', () => {
  it('warns `lossy-attribute` when the fence carries more than its language', async () => {
    // The same shape as the task item's row, one row over. A fence's info
    // string is `language meta` — remark parses `js title=x` as
    // `lang: 'js', meta: 'title=x'` — and §3.1's `code_block` has a slot for
    // the language and none for the rest, so `title=x` is dropped on load.
    //
    // The *code* survives byte for byte: the loss is the attribute, and the
    // warning says which. It is the same row shape as the task item's, and
    // the preflight measures the same deletion from the other side — a round
    // trip of this fence reads `degrade`, because the shape it compares
    // carries the meta and the shape that comes back does not.
    const { doc, warnings } = await parseWithDiagnostics('```js title=x\nconst a = 1;\n```\n');
    expect(warnings.map((w) => [w.code, w.mdastType, w.position])).toEqual([
      ['lossy-attribute', 'code', { line: 1, column: 1 }],
    ]);
    // The language is kept and the meta is not — which is what §3.1's
    // `code_block` has a slot for, and what the warning is about.
    expect(serialize(doc)).toBe('```js\nconst a = 1;\n```\n');
  });

  it('CONTROL: a fence with only a language warns nothing', async () => {
    // The other direction, and the one that keeps the warning from crying
    // wolf: a code fence is §3.3's *exact-content* row, so a warning on every
    // fence would train a writer to ignore the banner — which is the 08:0x
    // decision's rejected option one level down. The warning is about the
    // part that is dropped, not about fences.
    const { warnings } = await parseWithDiagnostics('```js\nconst a = 1;\n```\n');
    expect(warnings).toEqual([]);
  });
});

describe('§3.3 degrade class — a link reference', () => {
  it('parses without a warning, shows a direct link, and saves the reference and its definition as written', async () => {
    const { doc, warnings } = await parseWithDiagnostics(LINK_REF);
    // The reference and the definition are kept in the document's source provenance (source-provenance.ts), so nothing is lost
    // and nothing is warned. Before that, the reference loss was one warning and the definition loss another.
    expect(warnings).toEqual([]);
    expect(shapeOf(doc)).toEqual([
      'doc',
      { provenance: expect.anything() },
      [],
      [
        [
          'paragraph',
          {},
          [],
          [
            ['text', {}, [['link', { href: 'https://example.com', title: null, prov: 'r1' }]], 'text', []],
          ],
        ],
      ],
    ]);
    expect(serialize(doc)).toBe('[text][ref]\n\n[ref]: https://example.com\n');
  });
  it('CONTROL: without the handler the reference still resolves, and silently', async () => {
    // Not a throw. This is the control that matters for this row, because the
    // library's default is *correct* here: it expands the reference and applies
    // the `link` mark. A test that only asserted the expansion would have been
    // green, and §3.3's row would still be unimplemented. So the
    // control pins what 0.1.5 does on its own, and states the difference as the
    // number it is: the same document, the same bytes, one warning missing.
    const withoutHandler = await diagnoseWith('linkReference', LINK_REF);
    expect(serialize(withoutHandler.doc)).toBe('[text](https://example.com)\n');
    // Only the definition — which the handler owns — is left.
    expect(withoutHandler.warnings.map((w) => [w.code, w.mdastType])).toEqual([
      ['lossy-attribute', 'definition'],
    ]);
    // The handler without a provenance capture (the primitive path, `insertionOf`) still expands and still warns twice.
    const withHandler = await diagnoseWith(null, LINK_REF);
    expect(serialize(withHandler.doc)).toBe(serialize(withoutHandler.doc));
    expect(withHandler.warnings).toHaveLength(2);
  });

  it('a reference with a title carries the title through', async () => {
    // The `title` half of §3.3's "with resolved URL" — the definition's title is
    // the one piece of the definition that survives into the direct link, and a
    // handler that read only `url` would drop it silently.
    const { doc } = await parseWithDiagnostics('[text][ref]\n\n[ref]: https://e.com "T"\n');
    const marks: Array<Record<string, unknown>> = [];
    doc.descendants((node) => {
      for (const mark of node.marks) marks.push(mark.attrs);
    });
    expect(marks).toEqual([{ href: 'https://e.com', title: 'T', prov: 'r1' }]);
    expect(serialize(doc)).toBe('[text][ref]\n\n[ref]: https://e.com "T"\n');
  });

  it('two references to one definition share it: both are kept, and neither warns', async () => {
    const body = 'see [a][d] and [b][d]\n\n[d]: https://e.com\n';
    const { doc, warnings } = await parseWithDiagnostics(body);
    expect(warnings).toEqual([]);
    expect(serialize(doc)).toBe(body);
  });

  it('a reference whose label carries a mark expands and warns, and keeps its definition', async () => {
    // The mark cannot be written back inside a reference's brackets without re-deriving the spelling, so the reference is the one
    // thing that degrades (source-provenance.ts, "What is not kept"). The definition is kept.
    const { warnings } = await parseWithDiagnostics('see [*em*][d]\n\n[d]: https://e.com\n');
    expect(warnings.map((w) => [w.code, w.mdastType])).toEqual([['lossy-attribute', 'linkReference']]);
  });

  it('marks the label, not the paragraph — and puts the link mark last', async () => {
    // Measured ordering, and it is observable in the bytes: `*em*` inside a link
    // reference serializes as `_[em](url)_`, because the `em` mark wraps the link
    // mark. A handler that prepended the link mark would produce the same text
    // with the marks swapped, and the swap is visible in the next round trip.
    const { doc } = await parseWithDiagnostics('see [*em*][d]\n\n[d]: https://e.com\n');
    expect(serialize(doc)).toBe('see _[em](https://e.com)_\n\n[d]: https://e.com\n');
    const marks: string[] = [];
    doc.descendants((node) => {
      marks.push(...node.marks.map((m) => m.type.name));
    });
    expect(marks).toEqual(['em', 'link']);
  });

  it('an undefined reference never reaches the handler — measured, not assumed', async () => {
    // The same finding as for `imageReference`, re-measured for this
    // construct rather than assumed from the sibling: remark-parse resolves
    // references itself, so `[text][nowhere]` arrives as literal text and no
    // `linkReference` node is ever created. Nothing was a reference, so nothing
    // is warned about. This is the measurement that makes the fallback below
    // honest — a fixture-driven test of it would pass without ever reaching it.
    const { doc, warnings } = await parseWithDiagnostics('see [text][nowhere]\n');
    expect(warnings).toEqual([]);
    expect(doc.textBetween(0, doc.content.size)).toBe('see [text][nowhere]');
  });

  it('the unresolvable-reference fallback degrades to the link spelling, called directly', async () => {
    // Called at the handler, for the same reason as the `imageReference` fallback: the parse
    // chain cannot reach this branch. The spelling matters — the footnote shape
    // `[^text][ref]` is a *different construct* and would re-parse as a footnote
    // reference, so a fallback that reused `referenceText` would be worse than
    // throwing: it would change what the document is.
    const sink: LossWarning[] = [];
    const handler = createParseHandlers(caotangSchema, sink).linkReference as (
      node: unknown,
      parent: unknown,
      state: unknown,
    ) => PmNode[];
    const state = { definitionById: new Map(), one: () => null, all: () => [] };
    for (const [referenceType, expected] of [
      ['shortcut', '[docs]'],
      ['collapsed', '[docs][]'],
      ['full', '[docs][label]'],
    ] as const) {
      sink.length = 0;
      const built = handler(
        { type: 'linkReference', identifier: 'docs', label: 'label', referenceType },
        { type: 'paragraph' },
        state,
      );
      expect(built.map((node) => node.text), referenceType).toEqual([expected]);
      expect(sink.map((w) => [w.code, w.mdastType]), referenceType).toEqual([
        ['lossy-attribute', 'linkReference'],
      ]);
      expect(sink[0]!.detail, referenceType).toContain('could not be resolved');
    }
  });
});

describe('§5 canonical dialect — the one option the pipeline does not pin', () => {
  it('a list directly after a list alternates its marker, and the round trip needs it', async () => {
    // §5 says remark-stringify emits "one canonical spelling per option setting"
    // and pins `bullet: '-'`. Measured, with two byte-identical `{list, list}`
    // mdast nodes and the shipped options, the *second* list is written `*` — and
    // that is not a bug this product can fix by overriding the `list` handler,
    // because the alternation is what makes the pair survive:
    //
    //   `- a\n\n* b`  re-parses as TWO lists (the document as it was)
    //   `- a\n\n- b`  re-parses as ONE loose list with two items (a different
    //                  document, and a `lossy-structure` nobody declared)
    //
    // So §5's sentence is true per list *position*, not per document, and this test records
    // the correction. This test exists so the correction cannot be reverted by
    // someone who finds `*` in a saved file and reads §5 as written.
    const { doc } = await parseWithDiagnostics('* a\n- b\n');
    expect(serialize(doc)).toBe('- a\n\n* b\n');

    const reparsesAsTwoLists = async (markdown: string): Promise<number> => {
      const tree = await unified().use(remarkParse).use(remarkGfm).run(
        unified().use(remarkParse).use(remarkGfm).parse(markdown),
      );
      return ((tree as MdastRoot).children ?? []).filter((node) => node.type === 'list').length;
    };
    // Non-vacuity: the assertion below is only meaningful while the alternation
    // still separates the two spellings, so the control is checked first.
    expect(await reparsesAsTwoLists('- a\n\n* b\n')).toBe(2);
    expect(await reparsesAsTwoLists('- a\n\n- b\n')).toBe(1);
  });

  it('an ordered list alternates its delimiter the same way', async () => {
    // The same line of the library, one construct over, because the ordered
    // variant is where the alternation is most visible: `1. a\n\n1) b`. A reader
    // who pinned `1.` here and pinned `-` in the bullet case would have a
    // half-fixed dialect.
    const { doc } = await parseWithDiagnostics('1. one\n\n1) two\n');
    expect(serialize(doc)).toBe('1. one\n\n1) two\n');
  });

  it('a single list, and a list that follows a paragraph, keep the pinned marker', async () => {
    // The complement, so the alternation cannot be confused with a general
    // failure to honour `bullet`. The trigger is a *preceding sibling list*, not
    // being a list.
    expect(serialize(await parse('- a\n'))).toBe('- a\n');
    expect(serialize(await parse('para\n\n- a\n'))).toBe('para\n\n- a\n');
    expect(serialize(await parse('> - a\n'))).toBe('> - a\n');
  });
});

describe('§3.3 degrade class — a raw HTML block', () => {
  it('parses, warns `unsupported-node`, and becomes a paragraph of literal text', async () => {
    const { doc, warnings } = await parseWithDiagnostics(HTML_BLOCK);
    // §3.3: "rendered as literal text paragraph; warning unsupported-node". The
    // *whole* value is kept, tags included — measured, because the library's own
    // default parses the value as HTML and keeps only the text inside.
    expect(warnings).toEqual([
      {
        code: 'unsupported-node',
        mdastType: 'html',
        position: { line: 1, column: 1 },
        detail: expect.stringContaining('literal text'),
      },
    ]);
    expect(shapeOf(doc)).toEqual([
      'doc',
      {},
      [],
      [['paragraph', {}, [], [['text', {}, [], '<div>raw</div>', []]]]],
    ]);
    expect(serialize(doc)).toBe('\\<div>raw\\</div>\n');
  });

  it('CONTROL: without the handler the document itself fails its content check', async () => {
    // Not `unknown markdown node: html` — the library *has* a default for `html`,
    // and it returns an inline text node where `doc` requires `block+`, so the
    // failure surfaces from `doc.check()` as a content error. The message is
    // asserted exactly because the two failure modes are different and a
    // control that only matched `/Invalid content/` would also pass if the
    // throw moved.
    await expect(loadWith(without('html'), HTML_BLOCK)).rejects.toThrow(
      'Invalid content for node doc',
    );
  });

  it('the inline case keeps BOTH tags, which the library default drops', async () => {
    // The finding the row names, measured: with the library's own `html`
    // handler this input is `text with <span>html inside` — the closing tag is
    // gone. This handler keeps the whole raw value, so the *text* is intact and
    // the escape is §5's canonical spelling. The row records the measurement
    // as a fact about 0.1.5's default, which is still true of the audit's
    // table and no longer true of the product.
    const { doc, warnings } = await parseWithDiagnostics(HTML_INLINE);
    expect(doc.textBetween(0, doc.content.size, '\n')).toBe('text with <span>html</span> inside');
    expect(serialize(doc)).toBe('text with \\<span>html\\</span> inside\n');
    // **One warning per mdast node, so inline HTML warns twice** — `<span>` and
    // `</span>` are two `html` nodes in the tree (measured; the corpus entry's
    // value is split by remark-parse), and §3.3's shape is per node: one
    // `mdastType`, one `position`. A writer sees one span and gets two entries,
    // which is a *presentation* question for §4's banner and not something this
    // slice decides; the alternative — collapsing them here — would mean a
    // taxonomy field that no longer says what happened..
    expect(warnings.map((w) => [w.code, w.mdastType, w.position])).toEqual([
      ['unsupported-node', 'html', { line: 1, column: 11 }],
      ['unsupported-node', 'html', { line: 1, column: 21 }],
    ]);
  });
});

describe('§3.3 degrade class — the invariant is stability, not byte-identity', () => {
  /**
   * All four classes in one body, one construct per block, **written out rather
   * than joined from the fixtures** — joining them makes the raw HTML block
   * swallow the line after it, so the inline case silently stops being its own
   * construct and the expected order below stops describing what it claims to.
   */
  const ALL = [
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'Text[^1]',
    '',
    '[^1]: The note.',
    '',
    '![alt][ref]',
    '',
    '[ref]: img.png',
    '',
    '<div>raw</div>',
    '',
    'text with <span>html</span> inside',
    '',
  ].join('\n');

  it('a no-op edit cycle never dirties the bytes (§3.3\'s own words)', async () => {
    for (const [name, body] of [
      ['table-gfm', TABLE],
      ['footnote-reference', FOOTNOTE],
      ['image-reference', IMAGE_REF],
      ['link-reference', LINK_REF],
      ['list-task-item', TASK_ITEM],
      ['html-raw-block', HTML_BLOCK],
      ['html-raw-inline', HTML_INLINE],
      ['all four classes', ALL],
    ] as const) {
      const once = serialize(await parse(body));
      const twice = serialize(await parse(once));
      expect(twice, `second cycle for ${name}`).toBe(once);
    }
  });

  it('two loads of one body yield the same warnings in the same order', async () => {
    const first = await parseWithDiagnostics(ALL);
    const second = await parseWithDiagnostics(ALL);
    expect(second.warnings).toEqual(first.warnings);
    // The dialect channel is held to the same stability claim, and for the same
    // reason: it is derived per load from the body, so a shared collector would
    // be a second way for one load's banner to show another load's spelling.
    expect(second.dialect).toEqual(first.dialect);
    expect(shapeOf(second.doc)).toEqual(shapeOf(first.doc));
    // **Document order, with every position** — not handler-registration order,
    // not type order. The image reference and its definition (lines 9 and 11) are kept in the provenance and warn nothing. The last
    // three are one block plus one inline span, which the inline case reports as two nodes.
    expect(first.warnings.map((w) => [w.code, w.mdastType, w.position])).toEqual([
      ['lossy-structure', 'table', { line: 1, column: 1 }],
      ['unsupported-node', 'footnoteReference', { line: 5, column: 5 }],
      ['unsupported-node', 'footnoteDefinition', { line: 7, column: 1 }],
      ['unsupported-node', 'html', { line: 13, column: 1 }],
      ['unsupported-node', 'html', { line: 15, column: 11 }],
      ['unsupported-node', 'html', { line: 15, column: 21 }],
    ]);
  });

  it('an unrelated load in between does not change a body\'s warnings', async () => {
    // The control for the determinism test above. A module-level collector — the
    // obvious implementation, and the one §3.3's stability claim forbids — passes
    // every single-parse assertion in this file and fails here.
    const before = await parseWithDiagnostics(FOOTNOTE);
    await parseWithDiagnostics(TABLE);
    await parseWithDiagnostics(ALL);
    const after = await parseWithDiagnostics(FOOTNOTE);
    expect(after.warnings).toEqual(before.warnings);
    expect(after.warnings).toHaveLength(2);
  });

  it('a body with nothing to degrade returns an empty list, not a missing one', async () => {
    // §4 surfaces the list in a banner, so "no warnings" has to be an empty
    // array: `undefined` would be a banner that cannot tell "nothing degraded"
    // from "the parse never reported".
    const { warnings } = await parseWithDiagnostics('plain paragraph\n');
    expect(warnings).toEqual([]);
  });

  it('`parse` is the same document as `parseWithDiagnostics(...).doc`', async () => {
    // The two cannot drift because one is a projection of the other, and this is
    // what holds them to it on every fixture rather than on one happy path.
    for (const body of [TABLE, FOOTNOTE, IMAGE_REF, LINK_REF, TASK_ITEM, HTML_BLOCK, HTML_INLINE]) {
      expect(shapeOf(await parse(body))).toEqual(shapeOf((await parseWithDiagnostics(body)).doc));
    }
  });
});

describe('the degrade table is §3.3\'s, and a subset of it', () => {
  const specDegradeTypes = (): string[] => {
    const spec = readFileSync(resolve(__dirname, '../../../docs/architecture/editor-engine.md'), 'utf8');
    const section = spec.slice(
      spec.indexOf('### 3.3 mdast handler table'),
      spec.indexOf('## 4. `EditorApi`'),
    );
    expect(section.length).toBeGreaterThan(0);
    const found = new Set<string>();
    for (const line of section.split('\n')) {
      if (!line.startsWith('|') || /^\|[\s|:-]+\|$/.test(line.trim())) continue;
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
      const classCell = (cells[2] ?? '').replace(/\*\*/g, '');
      if (!/^degrade$/.test(classCell)) continue;
      for (const m of (cells[0] ?? '').matchAll(/`([a-zA-Z]+)`/g)) found.add(m[1] as string);
    }
    return [...found].sort();
  };

  it('registers nothing §3.3 does not classify as degrade', () => {
    // The direction that stops this table from becoming a second spec: a handler
    // for a type §3.3 does not call a degrade is a design decision dressed as a
    // transcription, and this fails on it.
    const fromSpec = specDegradeTypes();
    expect(fromSpec.length).toBeGreaterThan(0);
    const invented = [...DEGRADE_MDAST_TYPES].filter((t) => !fromSpec.includes(t)).sort();
    expect(invented).toEqual([]);
  });

  it('registers all four load-fatal constructs', () => {
    for (const type of ['table', 'footnoteReference', 'imageReference', 'html']) {
      expect([...DEGRADE_MDAST_TYPES], `degrade handler for ${type}`).toContain(type);
    }
  });

  it('registers each of them as a function, and nothing else', () => {
    const table = createParseHandlers(caotangSchema, []) as unknown as Record<string, unknown>;
    for (const type of DEGRADE_MDAST_TYPES) {
      expect(table[type], `degrade handler for ${type}`).toBeTypeOf('function');
    }
    // And the list is not a filter over the table: every key in it is real. The
    // expectation is **derived** — the exact class minus `text`, which
    // `pipeline.test.ts` already pins against §3.3 read out of the spec — so a
    // handler added to either list without the other fails here.
    const listed = new Set<string>(DEGRADE_MDAST_TYPES);
    const notListed = Object.keys(table).filter((key) => !listed.has(key));
    expect(notListed.sort()).toEqual(
      EXACT_CLASS_MDAST_TYPES.filter((type) => type !== 'text').sort(),
    );
  });

  it('`linkReference` is registered now, and the reason it was absent is written down', () => {
    // This test used to assert the *absence* of `linkReference` — the row
    // was named in the message, and the guard was there to stop one change
    // taking a later one's subject. The later one has landed, so the guard has changed
    // rather than been deleted: it now asserts the *presence*, and keeps the
    // reason, because the absence had a reason and a reader who finds a
    // registered handler will not know that 0.1.5 already resolved this one.
    //
    // The reason, kept because it is the part that is easy to get wrong: nothing
    // *forced* this handler. 0.1.5's default expands a `linkReference` correctly,
    // so no test would have caught its absence by a throw — which is exactly why
    // §3.3's *warning* is the deliverable, and why "it works" was not the bar.
    expect([...DEGRADE_MDAST_TYPES]).toContain('linkReference');
    expect(specDegradeTypes()).toContain('linkReference');
    const table = createParseHandlers(caotangSchema, []) as unknown as Record<string, unknown>;
    expect(table.linkReference).toBeTypeOf('function');
  });
});

describe('the product and the audit keep separate handler tables', () => {
  it('the audit registers none of the product\'s degrade handlers', async () => {
    const audit = createAuditParseHandlers(auditSchema) as unknown as Record<string, unknown>;
    // Non-vacuity first: an audit table that had *stopped* registering anything
    // would satisfy "registers none of the degrade handlers" perfectly, so the
    // comparison is only meaningful while the audit's own exact class is
    // present. That is the state being protected, asserted before it is used.
    const registered = Object.keys(audit);
    expect(registered.length).toBeGreaterThan(0);
    for (const type of EXACT_CLASS_MDAST_TYPES) {
      if (type === 'text') continue;
      expect(audit[type], `audit exact-class handler for ${type}`).toBeTypeOf('function');
    }
    const shared = DEGRADE_MDAST_TYPES.filter((type) => audit[type] !== undefined);
    expect(shared).toEqual([]);
  });

  it('CONTROL: the audit still throws on all four — the separation is load-bearing', async () => {
    // If the audit grew a degrade handler, the test above would fail. This is the
    // other half: proof that the audit's table is still the *instrument* it was
    // built as, so the product's behaviour did not quietly become the thing being
    // measured. Each message is the 0.1.5 one the audit's own result table
    // records, and the fixture is the one §2.1 lists as `throws`.
    const { parse: auditParse } = await import('@caotang/editor-audit');
    await expect(auditParse(TABLE)).rejects.toThrow('unknown markdown node: table');
    await expect(auditParse(FOOTNOTE)).rejects.toThrow('unknown markdown node: footnoteReference');
    await expect(auditParse(IMAGE_REF)).rejects.toThrow('unknown markdown node: imageReference');
    await expect(auditParse(HTML_BLOCK)).rejects.toThrow('Invalid content for node doc');
  });

  it('CONTROL: the same document degrades under the product and fails under the audit', async () => {
    // The two halves above, on one input, as a claim rather than as two lists —
    // the property the delegated decision rests on.
    const { parse: auditParse } = await import('@caotang/editor-audit');
    const mine = await parse(TABLE);
    expect(shapeOf(mine)).toEqual([
      'doc',
      {},
      [],
      [
        ['paragraph', {}, [], [['text', {}, [], 'a b', []]]],
        ['paragraph', {}, [], [['text', {}, [], '1 2', []]]],
      ],
    ]);
    await expect(auditParse(TABLE)).rejects.toThrow();
  });
});

describe('the product\'s warnings are its own, not the audit\'s measurements', () => {
  it('every warning names a construct this product registered a handler for', async () => {
    const { warnings } = await parseWithDiagnostics(
      [TABLE, FOOTNOTE, IMAGE_REF, HTML_BLOCK, HTML_INLINE, LINK_REF, TASK_ITEM].join('\n'),
    );
    // The check is against the **handler table**, not `DEGRADE_MDAST_TYPES`, and
    // that change is the doing rather than a loosening: a GFM task item is
    // §3.3's *exact-content* row (the item's content survives) that nevertheless
    // carries a `lossy-attribute` for the one attribute §3.1 has no slot for, so
    // its warning names a type in the exact class. The claim being protected is
    // "no warning is emitted for something the product does not handle" — which is
    // what the table actually enumerates.
    const table = createParseHandlers(caotangSchema, []) as unknown as Record<string, unknown>;
    expect(Object.keys(table).length).toBeGreaterThan(0);
    for (const warning of warnings satisfies LossWarning[]) {
      expect(table[warning.mdastType], `handler for ${warning.mdastType}`).toBeTypeOf('function');
      expect(['unsupported-node', 'lossy-attribute', 'lossy-structure']).toContain(warning.code);
      expect(warning.detail.length).toBeGreaterThan(0);
    }
  });
});
