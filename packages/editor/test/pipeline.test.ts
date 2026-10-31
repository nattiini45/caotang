/**
 * §5's load/save pair, on the constructs §3.3 calls exact.
 *
 * ## What this file claims, and what it deliberately does not
 *
 * §3.3 states the invariant precisely: *"serialize(parse(body)) is byte-identical
 * for every **exact**-class construct, and for any doc it is **deterministic** —
 * same input → same output bytes, so a no-op edit cycle never dirties git
 * diffs."* Those are two different bars and this file holds both:
 *
 * - **Group 1 — byte-identical.** Restricted to §5's *canonical* spellings, so
 *   byte-identity is the right bar rather than a lucky one. `1) one` is an
 *   exact-**content** construct whose marker §5 re-spells to `1.`, so asserting
 *   byte-identity on it would be asserting a thing §3.3 never promised.
 * - **Group 2 — re-spelled.** Group 1's inverse: exact content, canonical
 *   output, determinism. This is where §5's dialect is actually tested, and
 *   these are the entries a byte-identity-only suite would miss.
 *
 * ## Why a named subset and not the whole corpus
 *
 * `packages/editor-audit` holds 59 corpus entries and is the authoritative
 * result table. Duplicating all 59 here would create a second place to update
 * when the dialect changes, and the audit's own suite already reports per
 * construct. What the product needs is a *shipped* claim — "these constructs
 * round-trip in the package the editor will import" — and that is criterion (d)
 * satisfied by the named subset below. The subset covers **every** node
 * in §3.1 and every mark in §3.2 at least once, plus the three
 * empty-container constructs the corpus has no entry for at all.
 *
 * ## The GFM control
 *
 * "remark-gfm is on both chains" is a claim about two lists, and a list that
 * nothing reads is a comment. The strike round-trip is the assertion that
 * `remarkGfm` is on the *serialize* chain (§2 finding F2), and the control
 * below proves the round-trip is not passing for an unrelated reason: a chain
 * built **without** gfm is shown to throw the exact message, and a parse chain
 * without gfm is shown to leave the `strike` mark out of the document.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { fromProseMirror, remarkProseMirror } from '@handlewithcare/remark-prosemirror';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Root as MdastRoot } from 'mdast';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CANONICAL_STRINGIFY_OPTIONS,
  EXACT_CLASS_MDAST_TYPES,
  SPEC_STRINGIFY_OPTIONS,
  createParseHandlers,
  createSerializeHandlers,
  insertionOf,
  parse,
  parseWithDiagnostics,
  caotangSchema,
  serialize,
} from '../src/index.js';

const roundTrip = async (body: string): Promise<string> => serialize(await parse(body));

/**
 * Group 1 — every §3.1 node and §3.2 mark, in §5's canonical spelling.
 *
 * The three empty containers are in here on purpose. The audit's 59 entries
 * contain no empty blockquote, no empty list item and no empty heading, which is
 * why a `paragraph`/`heading` content expression of `inline+` survived the
 * preflight: `createAndFill` satisfies the required slot with an empty *text*
 * node, and an empty text node inside a block container serializes as a hard
 * break. Under this schema they round-trip byte-identically; under `inline+`
 * they come back as `> \` + `>`, `- \` and `1. \`. `spec-parity.test.ts` pins
 * that counterexample, and this group pins the fix.
 *
 * **`empty-ordered-item` was added 2026-10-04 18:0x, and the
 * measurement is the reason it is here.** docs/decisions.md
 * prescribed *"one degenerate case per cell whose value is not obviously
 * implied (`>`, `-`, `1.`, a bare `#`)"* — four cases, and the suite shipped
 * three. Adding the fourth moved the count 802 → 803 and **nothing else in the
 * suite reacted**, which is the finding: the guard that looks like it would
 * notice (`the subset covers every §3.1 node and every §3.2 mark`, below)
 * compares a union of *type names*, and an empty ordered item produces names
 * the non-empty one already produced. So the absence was invisible in the
 * direction that mattered. The fixture is discriminating rather than
 * decorative, and that was controlled rather than assumed: with `1.` added
 * **and** the schema moved to `inline+`, it fails alongside `empty-blockquote`
 * and `empty-list-item` (3 failed). **`empty-heading` is the fourth prescribed
 * case and it is the one that cannot fail** — a bare `#` round-trips
 * identically under `inline*` and `inline+`, because the filled text node in a
 * heading does not serialize as a hard break the way it does in a blockquote or
 * a list item. So of the four cases the entry names, three discriminate and
 * one is inert; the entry's "four" was never a measurement.
 */
const EXACT: ReadonlyArray<{ name: string; body: string }> = [
  { name: 'paragraph', body: 'plain paragraph\n' },
  { name: 'atx-heading-1', body: '# Heading one\n' },
  { name: 'atx-heading-3', body: '### Heading three\n' },
  { name: 'empty-heading', body: '#\n' },
  { name: 'blockquote', body: '> quoted line\n' },
  { name: 'empty-blockquote', body: '>\n' },
  { name: 'bullet-dash', body: '- one\n- two\n' },
  { name: 'empty-list-item', body: '-\n' },
  { name: 'ordered-dot', body: '1. one\n2. two\n' },
  { name: 'empty-ordered-item', body: '1.\n' },
  { name: 'ordered-start-3', body: '3. three\n' },
  { name: 'scene-separator', body: '***\n' },
  { name: 'code-fenced', body: '```js\nconst a = 1;\n```\n' },
  { name: 'code-fence-no-lang', body: '```\nplain\n```\n' },
  { name: 'hard-break-two-space', body: 'line one  \nline two\n' },
  { name: 'image', body: '![alt text](img/scene.png)\n' },
  { name: 'emphasis-underscore', body: '_emphasis_\n' },
  { name: 'strong', body: '**strong**\n' },
  { name: 'strike-gfm', body: '~~struck~~\n' },
  { name: 'inline-code', body: '`inline code`\n' },
  { name: 'link-inline', body: '[link text](https://caotang.app)\n' },
  { name: 'link-title', body: '[link text](https://caotang.app "Title")\n' },
  // §3.4 (#270): footnotes in the canonical spelling — notes at the end in reading order,
  // numeric labels as positions, named labels kept.
  { name: 'footnote-numeric', body: 'Text[^1] and more[^2].\n\n[^1]: One.\n\n[^2]: Two.\n' },
  { name: 'footnote-named', body: 'A[^note] and B[^2].\n\n[^note]: Named.\n\n[^2]: Two.\n' },
  { name: 'footnote-multi-paragraph', body: 'Text[^1].\n\n[^1]: First paragraph.\n\n    Second paragraph.\n' },
  { name: 'footnote-empty-note', body: 'Text[^1].\n\n[^1]:\n' },
  { name: 'footnote-unreferenced', body: 'Text.\n\n[^1]: Nothing points here.\n' },
  { name: 'footnote-scene-separator', body: 'One[^1].\n\n***\n\nTwo[^2].\n\n[^1]: First.\n\n[^2]: Second.\n' },
  { name: 'footnote-in-note', body: 'Main[^a].\n\n[^a]: Note with a note[^b].\n\n[^b]: Inner.\n' },
];

/** Group 2 — exact content, §5 re-spells the syntax, output is canonical. */
const RESPELLED: ReadonlyArray<{ name: string; body: string; expected: string }> = [
  { name: 'bullet-star → dash', body: '* one\n* two\n', expected: '- one\n- two\n' },
  { name: 'ordered-paren → dot', body: '1) one\n', expected: '1. one\n' },
  { name: 'strong-underscore → asterisk', body: '__strong__\n', expected: '**strong**\n' },
  { name: 'emphasis-asterisk → underscore', body: '*em*\n', expected: '_em_\n' },
  { name: 'tilde-fence → backtick-fence', body: '~~~\nplain\n~~~\n', expected: '```\nplain\n```\n' },
  { name: 'dashes-rule → stars-rule', body: '---\n', expected: '***\n' },
  { name: 'backslash-break → two-space-break', body: 'line one\\\nline two\n', expected: 'line one  \nline two\n' },
  // §3.4 (#270): a foreign footnote layout is re-spelled once.
  { name: 'footnote numbering → reading order', body: 'X[^2] and Y[^1]\n\n[^1]: one\n\n[^2]: two\n', expected: 'X[^1] and Y[^2]\n\n[^1]: two\n\n[^2]: one\n' },
  { name: 'footnote definition mid-text → end', body: 'X[^1]\n\n[^1]: one\n\nMore text.\n', expected: 'X[^1]\n\nMore text.\n\n[^1]: one\n' },
  { name: 'footnote in a block quote → end', body: '> X[^1]\n>\n> [^1]: in quote\n', expected: '> X[^1]\n\n[^1]: in quote\n' },
  { name: 'footnote duplicate definition → its own note', body: 'X[^1]\n\n[^1]: one\n\n[^1]: dup\n', expected: 'X[^1]\n\n[^1]: one\n\n[^1-2]: dup\n' },
  { name: 'footnote reference without a note → escaped text', body: 'Text[^1] no note\n', expected: 'Text\\[^1] no note\n' },
];

describe('§5 · the exact class round-trips byte-identically', () => {
  for (const { name, body } of EXACT) {
    it(name, async () => {
      expect(await roundTrip(body)).toBe(body);
    });
  }

  it('the subset covers every §3.1 node and every §3.2 mark — measured on the docs it produces', async () => {
    // Not a hand-maintained list: this parses every entry in group 1, collects
    // the node and mark type names the schema actually produced, and requires
    // the union to be the whole schema. A node §3.1 gains shows up here as a
    // missing name rather than as a silent gap in the shipped claim.
    const nodes = new Set<string>();
    const marks = new Set<string>();
    for (const { body } of EXACT) {
      const pm = await parse(body);
      // `descendants` visits children, not the node itself, so `doc` has to be
      // added by hand or the check silently drops the one node §3.1 names that
      // no construct can nest inside.
      nodes.add(pm.type.name);
      pm.descendants((node) => {
        nodes.add(node.type.name);
        for (const mark of node.marks) marks.add(mark.type.name);
      });
    }
    expect([...nodes].sort()).toEqual(Object.keys(caotangSchema.nodes).sort());
    expect([...marks].sort()).toEqual(Object.keys(caotangSchema.marks).sort());
  });
});

describe('§5 · syntax normalization, which is the other half of §3.3', () => {
  for (const { name, body, expected } of RESPELLED) {
    it(name, async () => {
      expect(await roundTrip(body)).toBe(expected);
    });
  }

  it('the whole subset is deterministic — same input, same bytes, twice', async () => {
    for (const { name, body } of [...EXACT, ...RESPELLED]) {
      const first = await roundTrip(body);
      const second = await roundTrip(body);
      expect(second, name).toBe(first);
    }
  });
});

describe('§5 · remark-gfm is on both chains, and the failure is reachable', () => {
  it('a GFM strike round-trips through the shipped serialize', async () => {
    // The parse side alone is not enough and the serialize side alone is not
    // enough; this is the only assertion that says both are on.
    expect(await roundTrip('~~struck~~\n')).toBe('~~struck~~\n');
  });

  it('CONTROL: without gfm on the serialize chain the same document throws', () => {
    // Built here rather than by mutating `serialize`, so the control is a fact
    // about the library and not about a temporary edit nobody will read.
    const pm = caotangSchema.nodes.doc!.create(null, [
      caotangSchema.nodes.paragraph!.create(null, [
        caotangSchema.text('struck', [caotangSchema.marks.strike!.create()]),
      ]),
    ]);
    const handlers = createSerializeHandlers();
    const tree = fromProseMirror(pm, {
      schema: caotangSchema,
      nodeHandlers: handlers as never,
      markHandlers: handlers as never,
    });
    expect(() =>
      unified().use(remarkStringify, { ...CANONICAL_STRINGIFY_OPTIONS }).stringify(tree),
    ).toThrow(/Cannot handle unknown node/);
    // …and the shipped chain, which differs only by `use(remarkGfm)`, does not.
    expect(serialize(pm)).toBe('~~struck~~\n');
  });

  it('CONTROL: without gfm on the parse chain the strike mark is never created', async () => {
    const load = unified()
      .use(remarkParse)
      .use(remarkProseMirror, {
        schema: caotangSchema,
        // The sink is required (see `createParseHandlers`), and this probe has
        // no banner to fill — `[]` is the whole of what it needs.
        handlers: createParseHandlers(caotangSchema, []) as never,
      });
    const tree = (await load.run(load.parse('~~struck~~\n'))) as MdastRoot;
    const pm = load.stringify(tree) as unknown as PmNode;
    const marks = new Set<string>();
    pm.descendants((node) => {
      for (const mark of node.marks) marks.add(mark.type.name);
    });
    expect([...marks]).not.toContain('strike');
    expect([...marks]).not.toContain('em');
    // With gfm the same input produces the mark, so the difference above is
    // the plugin and not the input.
    const withGfm = await parse('~~struck~~\n');
    const marks2 = new Set<string>();
    withGfm.descendants((node) => {
      for (const mark of node.marks) marks2.add(mark.type.name);
    });
    expect([...marks2]).toContain('strike');
  });
});

describe('§5 · the dialect options, including the two §5 spells that are not legal inputs', () => {
  it("§5's literal `rule`/`fence` spellings throw — kept verbatim so they stay checkable", () => {
    const pm = caotangSchema.nodes.doc!.create(null, [
      caotangSchema.nodes.horizontal_rule!.create(),
    ]);
    const handlers = createSerializeHandlers();
    const tree = fromProseMirror(pm, {
      schema: caotangSchema,
      nodeHandlers: handlers as never,
      markHandlers: handlers as never,
    });
    // Typed as `Record<string, unknown>` and cast at the call: the whole point
    // of these values is that they are **not** legal `Options`, so the type
    // checker refusing them is the same fact the runtime is about to confirm.
    const illegal: Record<string, unknown> = { ...SPEC_STRINGIFY_OPTIONS };
    expect(() =>
      unified().use(remarkGfm).use(remarkStringify, illegal as never).stringify(tree),
    ).toThrow();
  });

  it("§5's intent holds: one character in, the three-character spelling out", () => {
    expect(CANONICAL_STRINGIFY_OPTIONS.rule).toBe('*');
    expect(CANONICAL_STRINGIFY_OPTIONS.fence).toBe('`');
    expect(CANONICAL_STRINGIFY_OPTIONS.emphasis).toBe('_');
    expect(CANONICAL_STRINGIFY_OPTIONS.strong).toBe('*');
    expect(CANONICAL_STRINGIFY_OPTIONS.bullet).toBe('-');
    expect(CANONICAL_STRINGIFY_OPTIONS.listItemIndent).toBe('one');
    // The two expansions §5 writes in prose, checked through the pipeline rather
    // than through the options object, so a library change cannot pass this.
    expect(serialize(caotangSchema.nodes.doc!.create(null, [caotangSchema.nodes.horizontal_rule!.create()]))).toBe('***\n');
    expect(
      serialize(
        caotangSchema.nodes.doc!.create(null, [
          caotangSchema.nodes.code_block!.create({ language: null }, caotangSchema.text('plain')),
        ]),
      ),
    ).toBe('```\nplain\n```\n');
  });
});

describe('§3.3 · the handler table registers every exact-class mdast type', () => {
  it('EXACT_CLASS_MDAST_TYPES is §3.3\'s exact-class set, read out of the spec', () => {
    const spec = readFileSync(resolve(__dirname, '../../../docs/architecture/editor-engine.md'), 'utf8');
    const section = spec.slice(spec.indexOf('### 3.3 mdast handler table'), spec.indexOf('## 4. `EditorApi`'));
    expect(section.length).toBeGreaterThan(0);
    const fromSpec = new Set<string>();
    for (const line of section.split('\n')) {
      if (!line.startsWith('|') || /^\|[\s|:-]+\|$/.test(line.trim())) continue;
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
      const typeCell = cells[0] ?? '';
      const classCell = (cells[2] ?? '').replace(/\*\*/g, '');
      if (!/^exact/.test(classCell)) continue;
      for (const m of typeCell.matchAll(/`([a-zA-Z]+)`/g)) fromSpec.add(m[1] as string);
    }
    expect([...fromSpec].sort()).toEqual([...EXACT_CLASS_MDAST_TYPES].sort());
  });

  it('every exact-class mdast type has a parse handler — except `text`', () => {
    const parse_ = createParseHandlers(caotangSchema, []) as unknown as Record<string, unknown>;
    // `text` is the one exact-class mdast type with **no** handler, on purpose:
    // a text node carries no attrs and no shape of its own, so the library's
    // default (`schema.text(value)`) is the whole contract and a handler would
    // be a second thing to keep in step with it. Asserted as exactly this
    // exception rather than skipped, so a table that quietly stops registering
    // something else cannot hide behind it.
    //
    // The table also carries §3.3's **degrade** rows, and this
    // assertion is deliberately blind to them: it asks about the exact class, so
    // a degrade handler appearing here cannot make an exact-class name stop
    // being registered. `degrade.test.ts` is where the degrade keys are the
    // subject, and where the two tables are held apart.
    const without = EXACT_CLASS_MDAST_TYPES.filter((t) => parse_[t] === undefined);
    expect([...without]).toEqual(['text']);
    for (const type of EXACT_CLASS_MDAST_TYPES) {
      if (type === 'text') continue;
      expect(parse_[type], `parse handler for ${type}`).toBeTypeOf('function');
    }
  });

  it('every node and mark the exact class produces has a serialize handler', async () => {
    // The serialize table is keyed on **§3.1/§3.2 names**, not mdast names, so
    // the completeness check is derived from the documents themselves rather
    // than from a hand-written list: parse the subset, collect what the schema
    // produced, and require a handler for each. A node added to §3.1 without a
    // serialize handler fails here rather than at the first save.
    const serialize_ = createSerializeHandlers() as Record<string, unknown>;
    const produced = new Set<string>();
    for (const { body } of EXACT) {
      const pm = await parse(body);
      produced.add(pm.type.name);
      pm.descendants((node) => {
        produced.add(node.type.name);
        for (const mark of node.marks) produced.add(mark.type.name);
      });
    }
    const missing = [...produced].filter((name) => serialize_[name] === undefined);
    // Two names are legitimately handler-free: `text` (the library's default
    // reads `node.text`) and `doc` (the root is the tree `fromProseMirror`
    // returns, not a child it has to convert). Asserted as exactly this pair, so
    // a third gap cannot slip in behind them.
    expect(missing.sort()).toEqual(['doc', 'text']);
  });

  it('the two `value`-carrying leaves keep their content in both directions', async () => {
    // A `fromPmMark('inlineCode')` table emits an empty `` `` `` for `` `x` ``
    // because remark-stringify reads `node.value`, which the factory does not
    // emit. Both leaves are hand-written in `handlers.ts`; this is the test
    // that says so for the shipped package rather than for the audit.
    expect(await roundTrip('`x`\n')).toBe('`x`\n');
    expect(await roundTrip('```\nconst a = 1;\n```\n')).toBe('```\nconst a = 1;\n```\n');
  });
});

describe('§4 · the total-parse claim, and the one body that breaks it', () => {
  it('every non-empty body loads — a load never throws', async () => {
    for (const { name, body } of [...EXACT, ...RESPELLED]) {
      await expect(parse(body), name).resolves.toBeTruthy();
    }
  });

  it('an empty body projection loads as one empty paragraph — the gap is CLOSED', async () => {
    // Both the rejected placement and the adopted one are kept here,
    // because the rejected half is the part a future reader needs:
    //
    // **The rejected placement.** §4 says `setContent`'s parse *"cannot fail (Markdown
    // is total)"*. It was false for the empty body: `doc: block+` (§3.1) means a
    // doc needs at least one block, and remark-parse produces none for `''`.
    // The placement call was that the fix is **not** in this package —
    // *"inventing a paragraph inside `parse` would make a load silently change
    // the document, and the policy belongs to §4's `setContent` (Tiptap's own
    // answer is to ensure one block at the editor level)"*.
    //
    // **Why it is in `parse` instead.** The cost of the other placement is a
    // **precondition on a function**: `parse('')` would keep throwing, and every
    // caller — the Tiptap adapter, and every future
    // consumer of `parseWithDiagnostics` — would have to remember to pre-normalise
    // an empty body. That is the defect class exactly (*"a check this function
    // can forget"*), and the argument against it does not survive the round trip:
    // an empty body projection has no blocks, so a document with one empty
    // paragraph is the **only** faithful representation of it, and
    // `serialize(parse('')) === ''` proves no text was invented. The alternative
    // and its cost are.
    for (const empty of ['', '\n', '   \n']) {
      const doc = await parse(empty);
      expect(doc.childCount, JSON.stringify(empty)).toBe(1);
      expect(serialize(doc), JSON.stringify(empty)).toBe('');
    }
  });
});

describe('a body that is only link definitions loads, and reports them (§5: parse is total)', () => {
  // Measured before this change: `parse('[a]: https://x')` threw `Invalid content for node doc: <>`.
  // The schema has no node for a definition, so the body compiles to nothing, and the library
  // refuses an empty `doc`. The load now treats it as the empty document, which is also what an
  // empty body is, and says what it dropped.
  it('loads as the empty document, with one lossy-attribute warning per definition, and does not throw', async () => {
    const result = await parseWithDiagnostics('[a]: https://example.test/\n[b]: https://example.test/b "Title"\n');
    expect(result.doc.childCount).toBe(1);
    expect(serialize(result.doc)).toBe('');
    expect(result.warnings.map((warning) => [warning.code, warning.mdastType])).toEqual([
      ['lossy-attribute', 'definition'],
      ['lossy-attribute', 'definition'],
    ]);
    expect(result.warnings[0]!.position).toEqual({ line: 1, column: 1 });
  });

  it('a definition next to text does not stop the text from loading', async () => {
    const result = await parseWithDiagnostics('[a]: https://example.test/\n\nHello.\n');
    expect(serialize(result.doc)).toBe('Hello.\n');
  });

  it('the primitive path reads a definition as nothing rather than throwing', async () => {
    expect(() => insertionOf('[a]: https://example.test/', caotangSchema)).not.toThrow();
    expect(insertionOf('[a]: https://example.test/', caotangSchema).content.size).toBe(0);
  });
});

describe('insertionOf edge whitespace', () => {
  const textOf = (text: string): string => {
    const { content } = insertionOf(text, caotangSchema);
    return content.textBetween(0, content.size, '\n');
  };

  it('keeps leading and trailing spaces and tabs as the text\'s own', () => {
    expect(textOf('Ours ')).toBe('Ours ');
    expect(textOf(' \tOurs\t ')).toBe(' \tOurs\t ');
    expect(textOf('é ')).toBe('é ');
  });

  it('reads a whitespace-only text as plain text, unchanged', () => {
    expect(textOf(' \t \t')).toBe(' \t \t');
  });

  it('does not treat a line ending as edge whitespace', () => {
    expect(textOf('Ours\r\n')).not.toContain('\r');
  });

  // Measured before this change: the trailing-whitespace regex took 8.9s on 1e5 tabs followed by `x`.
  it('stays linear on a long run of tabs that does not end the text', () => {
    const text = '\t'.repeat(50_000) + 'x';
    const started = performance.now();
    const slice = insertionOf(text, caotangSchema);
    expect(performance.now() - started).toBeLessThan(500);
    expect(slice.content.textBetween(0, slice.content.size)).toBe(text);
  });
});
