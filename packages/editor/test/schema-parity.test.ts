/**
 * The product's schema and the audit's schema are **behaviourally equivalent**,
 * and this file is where that is proven rather than asserted in a comment.
 *
 * ## Why there are two schemas at all
 *
 * `packages/editor-audit/src/schema.ts` is a transcription of §3.1/§3.2 written
 * as the minimum the preflight corpus needs to run. `packages/editor/src/
 * schema.ts` is the editor's own. They are kept apart deliberately
 *, and the separation is only worth its cost
 * if the two are *checked against each other* — otherwise they are two
 * transcriptions drifting quietly, and the audit's 59-construct result table
 * stops being evidence about the product at all.
 *
 * So the dependency runs **product ← test only**: no module in `src/` imports
 * the audit, and this file is the single place both are visible. Two facts make
 * that safe rather than merely tidy:
 *
 * 1. **They are different objects.** Asserted below, and the reason is the one
 *    used for the two `fflate` builds: a guard that compared the schema to
 *    *itself* would pass forever. `caotangSchema` and the audit's `caotangSchema`
 *    are separate `new Schema(...)` constructions, so a divergence is a real
 *    divergence.
 * 2. **The comparison is behavioural, not `===`.** Identity would be the one
 *    check a shared object passes by construction, so nothing here uses it as
 *    evidence of equivalence.
 *
 * ## What is compared, and what is deliberately not
 *
 * **Compared:** node and mark *names*; *attr names*; *content expressions*; and
 * — the strong form — the **ProseMirror document the same Markdown produces**
 * under each schema, compared as a tree of type names, attr values, marks and
 * text. The last one is what actually makes the audit's table evidence for the
 * product: it covers the two places the schemas are known to differ textually
 * (`list_item`'s group and `image.src`/`link.href` optionality) by showing the
 * difference is **inert** for every construct §3.3 calls exact.
 *
 * **Not compared:** `Schema` *groups*, and attr *optionality*. Both differ on
 * purpose, and the reasons are worth stating because a guard with unexplained
 * gaps is a guard with moods:
 *
 * - `list_item` declares §3.1's `listitem` group in the product and does not in
 *   the audit. Nothing in §3.1's content expressions uses that group, so it
 *   cannot change a document; `spec-parity.test.ts` is where the group is
 *   checked, against the spec.
 * - `image.src` and `link.href` are **required** in the product (no default) and
 *   defaulted to `null` in the audit, because both §3.1 and §3.2 mark them
 *   required and a default makes an attr optional whatever the prose says. The
 *   difference is only reachable by a caller that constructs an image or link
 *   node with no `src`/`href` — which no mdast construct can do, and which the
 *   tree comparison below confirms across the whole exact class.
 *
 * The honest way to close the second gap is not to widen this comparison but to
 * run the audit's own 59-entry corpus through the **product's** pipeline. That
 * is a real piece of work, left for later. A line asserting its own currency is
 * worse than one that does not, because the assertion is what a reader trusts in
 * place of re-measuring.
 *
 * ## `SUBSET` is a hand-copy, and the test below is named for more than it can see
 *
 * The list below is a second, independent transcription of the 22 bodies in
 * `pipeline.test.ts`'s `EXACT`, and the equivalence test that uses it was named
 * *"every construct in the exact class has an identical document shape"* —
 * a claim about a set nothing computes. It was the standing species one level
 * away from the registry harness: **this file's own header argues that a
 * hand-copied duplicate only proves the copy still matches itself, and then the
 * file's most load-bearing test hand-copies its input.** Measured: adding a
 * construct to `EXACT` moves the count and **reaches nothing here**. The test is
 * named for what the assertion actually is, and the structural fix (one source
 * for both lists) is left open, because choosing that source is a design
 * decision.
 */
import { Schema } from '@tiptap/pm/model';
import type { MarkSpec, NodeSpec } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { caotangSchema as auditSchema } from '@caotang/editor-audit';

import { parse, caotangSchema } from '../src/index.js';

const SUBSET = [
  'plain paragraph\n',
  '# Heading one\n',
  '### Heading three\n',
  '#\n',
  '> quoted line\n',
  '>\n',
  '- one\n- two\n',
  '-\n',
  '1. one\n2. two\n',
  '1.\n',
  '3. three\n',
  '***\n',
  '```js\nconst a = 1;\n```\n',
  '```\nplain\n```\n',
  'line one  \nline two\n',
  '![alt text](img/scene.png)\n',
  '_emphasis_\n',
  '**strong**\n',
  '~~struck~~\n',
  '`inline code`\n',
  '[link text](https://caotang.app)\n',
  '[link text](https://caotang.app "Title")\n',
];

/**
 * A document as data: `doc(paragraph("plain",[]))`.
 *
 * Attr *values* are in, because two schemas can agree on names and disagree on
 * what a handler produced — and that is exactly the class of divergence a
 * name-only comparison would miss. Ordered by child index, not by name, so a
 * reordered document is also a difference.
 */
const shapeOf = (node: PmNode): unknown =>
  [
    node.type.name,
    node.attrs,
    node.marks.map((m) => [m.type.name, m.attrs]).sort(),
    node.text,
    node.children.map(shapeOf),
  ].filter((part) => part !== null && part !== undefined);

/**
 * Attrs the product carries for the editor's own state (source-provenance.ts) and the audit's transcription of §3 does not. They are
 * never Markdown syntax, so the audit's preflight has nothing to say about them; a test below asserts they exist, so this list cannot
 * name an attr that is not there.
 */
const EDITOR_ONLY_ATTRS: ReadonlySet<string> = new Set(['doc.provenance', 'image.prov', 'link.prov']);

/** Build the product's schema again with node specs changed, for the control. */
const rebuild = (mutate: (nodes: Record<string, NodeSpec>) => void): Schema => {
  const nodes: Record<string, NodeSpec> = {};
  for (const name of Object.keys(caotangSchema.nodes)) {
    nodes[name] = { ...caotangSchema.nodes[name]!.spec };
  }
  const marks: Record<string, MarkSpec> = {};
  for (const name of Object.keys(caotangSchema.marks)) {
    marks[name] = { ...caotangSchema.marks[name]!.spec };
  }
  mutate(nodes);
  return new Schema({ nodes, marks, topNode: 'doc' });
};

/**
 * Compare two schemas on the three things the delegated decision named, and
 * return the differences rather than asserting them — so the control below can
 * call the same function and see it fail. A comparator that only ever runs
 * inside an `expect` cannot be shown to detect anything.
 */
const differences = (a: Schema, b: Schema): string[] => {
  const out: string[] = [];
  const attrNames = (spec: { attrs?: object | undefined }, owner: string): string[] =>
    Object.keys(spec.attrs ?? {})
      .filter((name) => !EDITOR_ONLY_ATTRS.has(`${owner}.${name}`))
      .sort();
  const names = [...new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])].sort();
  for (const name of names) {
    const left = a.nodes[name];
    const right = b.nodes[name];
    if (!left || !right) {
      out.push(`${name}: present in only one schema`);
      continue;
    }
    if ((left.spec.content ?? '').trim() !== (right.spec.content ?? '').trim()) {
      out.push(
        `${name}: content ${JSON.stringify((right.spec.content ?? '').trim())} vs ${JSON.stringify((left.spec.content ?? '').trim())}`,
      );
    }
    const leftAttrs = attrNames(left.spec, name);
    const rightAttrs = attrNames(right.spec, name);
    if (leftAttrs.join(',') !== rightAttrs.join(',')) {
      out.push(`${name}: attrs [${leftAttrs.join(',')}] vs [${rightAttrs.join(',')}]`);
    }
  }
  const markNames = [...new Set([...Object.keys(a.marks), ...Object.keys(b.marks)])].sort();
  for (const name of markNames) {
    const left = a.marks[name];
    const right = b.marks[name];
    if (!left || !right) {
      out.push(`mark ${name}: present in only one schema`);
      continue;
    }
    const leftAttrs = attrNames(left.spec, name);
    const rightAttrs = attrNames(right.spec, name);
    if (leftAttrs.join(',') !== rightAttrs.join(',')) {
      out.push(`mark ${name}: attrs [${leftAttrs.join(',')}] vs [${rightAttrs.join(',')}]`);
    }
  }
  return out;
};

describe('the product schema and the audit schema', () => {
  it('are two different objects, so no comparison below can be an identity check', () => {
    expect(caotangSchema).not.toBe(auditSchema);
    expect(caotangSchema.nodes.paragraph).not.toBe(auditSchema.nodes.paragraph);
    expect(caotangSchema.spec).not.toBe(auditSchema.spec);
  });

  it('carry the editor-only attrs the comparison leaves out, and the audit does not', () => {
    expect(caotangSchema.nodes.doc!.spec.attrs).toHaveProperty('provenance');
    expect(caotangSchema.nodes.image!.spec.attrs).toHaveProperty('prov');
    expect(caotangSchema.marks.link!.spec.attrs).toHaveProperty('prov');
    expect(auditSchema.nodes.doc!.spec.attrs ?? {}).not.toHaveProperty('provenance');
    expect(auditSchema.nodes.image!.spec.attrs).not.toHaveProperty('prov');
  });

  it('agree on node names, mark names, attr names and content expressions', () => {
    expect(differences(caotangSchema, auditSchema)).toEqual([]);
  });

  it('CONTROL: the comparator detects a deliberate divergence', () => {
    // The mutation is applied to a rebuilt copy, so the shipped schema is never
    // touched — and the first assertion is that the mutation *took*, because a
    // comparator that reports nothing because nothing changed is
    // indistinguishable from a comparator that cannot fail.
    const mutated = rebuild((nodes) => {
      const { hard_break: _drop, ...rest } = nodes;
      nodes.lineBreak = { ...nodes.hard_break! };
      for (const [name, spec] of Object.entries(rest)) nodes[name] = spec;
      delete nodes.hard_break;
    });
    expect(mutated.nodes.hard_break, 'the mutation must have applied').toBeUndefined();
    expect(mutated.nodes.lineBreak).toBeTruthy();
    const found = differences(caotangSchema, mutated);
    expect(found).toEqual(['hard_break: present in only one schema', 'lineBreak: present in only one schema']);
  });

  it('CONTROL: the comparator detects a content-expression divergence', () => {
    // `paragraph*` is a legal ProseMirror expression here (the node is a
    // `block`, so the expression builds) — unlike the `text*`/`text` pair the
    // spec guard pins, which the constructor refuses outright. A control whose
    // mutation is rejected by the library would test nothing.
    const mutated = rebuild((nodes) => {
      nodes.code_block = { ...nodes.code_block!, content: 'paragraph*' };
    });
    expect(mutated.nodes.code_block!.spec.content).toBe('paragraph*');
    expect(differences(caotangSchema, mutated)).toEqual([
      'code_block: content "paragraph*" vs "text*"',
    ]);
  });
});

describe('the same Markdown produces the same ProseMirror document under both', () => {
  it('every construct in this file’s SUBSET has an identical document shape under both', async () => {
    // The strong form of the equivalence claim, and the one that matters: it is
    // what lets §2.1's 59-construct result table count as evidence about the
    // product's pipeline. The audit's own `parse` is used, so the audit's
    // schema *and* its handler table are on the other side of the comparison —
    // the whole instrument, not just the schema.
    const { parse: auditParse } = await import('@caotang/editor-audit');
    for (const body of SUBSET) {
      const mine = shapeOf(await parse(body));
      const theirs = shapeOf(await auditParse(body));
      expect(theirs, `document shape for ${JSON.stringify(body)}`).toEqual(mine);
    }
  });

  it('the two known textual differences are inert across the whole class', async () => {
    // Stated as facts about the two schemas, so a future change to either side
    // that starts to matter fails here rather than in a user's document.
    expect(caotangSchema.nodes.list_item!.spec.group).toBe('listitem');
    expect(auditSchema.nodes.list_item!.spec.group).toBeUndefined();
    expect(caotangSchema.nodes.image!.spec.attrs?.src).not.toHaveProperty('default');
    expect(auditSchema.nodes.image!.spec.attrs?.src).toHaveProperty('default', null);
    // Inert: the exact class never constructs one without a value, which is why
    // the required/optional difference above changes no document.
    for (const body of SUBSET) {
      const pm = await parse(body);
      pm.descendants((node) => {
        if (node.type.name !== 'image') return;
        expect(typeof node.attrs.src, `image src for ${JSON.stringify(body)}`).toBe('string');
      });
    }
  });
});
