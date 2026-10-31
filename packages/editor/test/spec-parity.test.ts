/**
 * §3.1 and §3.2, read out of the spec, compared to `caotangSchema`.
 *
 * ## Why a guard whose subject is a document has to read that document
 *
 * A hand-copied duplicate of §3.1's table would only prove the copy still
 * matches itself — the failure that lets a pin check
 * report a stale number as current, and the shape refused for §9's registry.
 * So this file reads `docs/architecture/editor-engine.md` and compares it to the
 * schema **column by column**: names, groups, content expressions, attrs, and
 * the required/optional distinction the table spells out.
 *
 * ## What it holds
 *
 * Four §3.1 cells rest on measurements — the `doc` row's Group and Content,
 * `code_block`'s content (`text` is unbuildable), and `paragraph`/`heading`
 * (`inline+` is lossy). In the schema, `list_item` carries a group, and
 * `image.src` / `link.href` carry no default because both tables mark them
 * **required**.
 *
 * A decision is only worth making if it cannot be quietly reversed, so the
 * second half of this file re-derives the two load-bearing measurements from the
 * schema itself. The rejected readings are held here as **pinned
 * counterexamples**: if a future ProseMirror makes `inline+` safe, these fail
 * and say so, rather than the decision quietly becoming the code's own
 * opinion.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Schema } from '@tiptap/pm/model';
import type { MarkSpec, NodeSpec } from '@tiptap/pm/model';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { fromProseMirror, remarkProseMirror } from '@handlewithcare/remark-prosemirror';
import type { Root as MdastRoot } from 'mdast';
import { describe, expect, it } from 'vitest';

import {
  CANONICAL_STRINGIFY_OPTIONS,
  createParseHandlers,
  createSerializeHandlers,
  caotangSchema,
} from '../src/index.js';

const specPath = resolve(__dirname, '../../../docs/architecture/editor-engine.md');

type Requiredness = 'required' | 'optional' | 'unstated';

interface SpecAttr {
  name: string;
  requiredness: Requiredness;
}

interface SpecNodeRow {
  node: string;
  group: string;
  content: string;
  attrs: SpecAttr[];
}

interface SpecMarkRow {
  mark: string;
  attrs: SpecAttr[];
}

/** `—` is how these tables say "none"; an em dash is not a value. */
const cell = (raw: string): string => {
  const stripped = raw.replace(/`/g, '').replace(/\*\*/g, '').trim();
  return stripped === '—' || stripped === '-' ? '' : stripped.replace(/\\\|/g, '|');
};

/**
 * Split a markdown table row on **unescaped** pipes only.
 *
 * §3.1's `heading` attrs cell is `` `level: 1\|2\|3\|4\|5\|6` ``, so a naive
 * split shifts every later column by one and the attrs cell arrives as five
 * fragments. Same hazard, same fix as that change's §9 reader.
 */
const splitRow = (line: string): string[] =>
  line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());

/** The `|---|---|` delimiter row is a row of the table in markdown, not of the schema. */
const isDelimiter = (line: string): boolean => /^\|[\s|:-]+\|$/.test(line.trim());

/**
 * The Attrs column is a prose list: `src: string` (required), `alt?: string`.
 *
 * The `?` is an explicit optional marker, `(required)` is an explicit required
 * one, and `level: 1|2|3|4|5|6` has neither — so requiredness is **unstated**
 * there rather than guessed. Guessing is how a guard ends up asserting a rule
 * the spec never wrote, and the point of this file is to report the spec.
 */
const parseAttrs = (raw: string): SpecAttr[] => {
  const value = cell(raw);
  if (value === '') return [];
  return value.split(',').map((part) => {
    const m = /^([a-z_]+)(\?)?\s*:\s*(.+)$/.exec(part.trim());
    if (!m) throw new Error(`§3 Attrs cell is not "name: type": ${JSON.stringify(part)}`);
    const name = m[1] as string;
    const declared = m[3] as string;
    const requiredness: Requiredness = m[2] === '?'
      ? 'optional'
      : /\(required\)/.test(declared)
        ? 'required'
        : 'unstated';
    return { name, requiredness };
  });
};

function section(heading: string, until: string): string {
  const spec = readFileSync(specPath, 'utf8');
  const from = spec.indexOf(heading);
  const to = spec.indexOf(until);
  expect(from, `${heading} not found in editor-engine.md`).toBeGreaterThan(-1);
  expect(to, `${until} not found in editor-engine.md`).toBeGreaterThan(from);
  return spec.slice(from, to);
}

function readNodes(): SpecNodeRow[] {
  const rows: SpecNodeRow[] = [];
  for (const line of section('### 3.1 Nodes', '### 3.2 Marks').split('\n')) {
    if (!line.startsWith('|') || isDelimiter(line)) continue;
    const c = splitRow(line);
    const node = cell(c[0] ?? '');
    if (node === '' || node === 'Node') continue;
    rows.push({ node, group: cell(c[1] ?? ''), content: cell(c[2] ?? ''), attrs: parseAttrs(c[3] ?? '') });
  }
  return rows;
}

function readMarks(): SpecMarkRow[] {
  const rows: SpecMarkRow[] = [];
  for (const line of section('### 3.2 Marks', '### 3.3 mdast handler table').split('\n')) {
    if (!line.startsWith('|') || isDelimiter(line)) continue;
    const c = splitRow(line);
    const mark = cell(c[0] ?? '');
    if (mark === '' || mark === 'Mark') continue;
    rows.push({ mark, attrs: parseAttrs(c[1] ?? '') });
  }
  return rows;
}

const specNodes = readNodes();
const specMarks = readMarks();

/**
 * The declared expression, read off the `NodeType`.
 *
 * Not off `schema.spec.nodes`: that field is an `OrderedMap`, indexed by
 * position, not by name — a lookup there returns `undefined` and reads as "the
 * schema declares no content" for every row at once.
 */
const declaredContent = (name: string): string => (caotangSchema.nodes[name]!.spec.content ?? '').trim();
/**
 * `NodeType.spec.group` is the declared group, and `undefined` is how a node
 * with none is spelled. The runtime also carries a `groups` array, but it is not
 * in the type declarations, and §3.1 gives at most one group per node — so the
 * declared string is both the typed and the sufficient answer.
 */
const declaredGroup = (name: string): string => caotangSchema.nodes[name]!.spec.group ?? '';
const declaredAttrs = (name: string): Array<[string, boolean]> =>
  Object.entries(caotangSchema.nodes[name]!.spec.attrs ?? {}).map(([k, v]) => [
    k,
    Object.prototype.hasOwnProperty.call(v, 'default'),
  ]);

/**
 * Rebuild this schema with some node specs changed, for the counterexamples
 * below. Rebuilding from `NodeType.spec` rather than cloning `schema.spec` is
 * forced: the latter holds an `OrderedMap`, which does not survive a
 * structured clone as a `SchemaSpec` and fails with *"Schema is missing its top
 * node type"* — a misleading error about `doc` for a change that touched
 * `code_block`.
 */
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

describe('§3.1 Nodes — the schema, read column by column out of the spec', () => {
  it('§3.1 parses into 14 node rows — a broken parse must fail, not pass', () => {
    // 14 = doc, paragraph, heading, blockquote, bullet_list, ordered_list,
    // list_item, horizontal_rule, code_block, hard_break, image, the two
    // footnote nodes (#270, §3.4), text.
    expect(specNodes).toHaveLength(14);
    expect(specNodes.map((r) => r.node)).toEqual([
      'doc',
      'paragraph',
      'heading',
      'blockquote',
      'bullet_list',
      'ordered_list',
      'list_item',
      'horizontal_rule',
      'code_block',
      'hard_break',
      'image',
      'footnote_reference',
      'footnote_definition',
      'text',
    ]);
  });

  it('the two node sets are equal in both directions', () => {
    const spec = specNodes.map((r) => r.node).sort();
    const code = Object.keys(caotangSchema.nodes).sort();
    expect(code).toEqual(spec);
  });

  for (const row of specNodes) {
    it(`${row.node}: group, content expression and attrs are §3.1's`, () => {
      expect(declaredGroup(row.node), 'group').toBe(row.group);
      expect(declaredContent(row.node), 'content').toBe(row.content);
      expect(declaredAttrs(row.node).map(([n]) => n), 'attr names').toEqual(
        row.attrs.map((a) => a.name),
      );
      for (const attr of row.attrs) {
        if (attr.requiredness === 'unstated') continue; // §3.1 does not say; do not guess
        const hasDefault = declaredAttrs(row.node).find(([n]) => n === attr.name)?.[1] ?? false;
        // A ProseMirror attr with a default is optional at runtime whatever the
        // table says, so this compares the runtime meaning, not the spelling.
        expect(hasDefault, `${row.node}.${attr.name} is ${attr.requiredness} in §3.1`).toBe(
          attr.requiredness === 'optional',
        );
      }
    });
  }

  it('the content expressions are load-bearing, not decoration', () => {
    // The table is a summary; these are the states it summarises. Each probe is
    // the behavioural consequence of one cell, so a cell edited to say something
    // the schema does not do fails here as well as above.
    const { doc, paragraph, heading, code_block: codeBlock, list_item: item, bullet_list: bullet } =
      caotangSchema.nodes;
    // `block+` on doc: one block is enough, zero is not.
    expect(doc!.createAndFill()).not.toBeNull();
    expect(() => doc!.createChecked([])).toThrow(/Invalid content/);
    // `inline*` on paragraph/heading: a paragraph with no inline is constructible.
    expect(paragraph!.createAndFill()).not.toBeNull();
    expect(heading!.createAndFill({ level: 1 })).not.toBeNull();
    // `text*` on code_block: an empty fence is constructible.
    expect(codeBlock!.createAndFill({ language: null })).not.toBeNull();
    // `block+` on list_item, `list_item+` on bullet_list.
    expect(item!.createAndFill()).not.toBeNull();
    expect(bullet!.createAndFill()).not.toBeNull();
    expect(() => bullet!.createChecked([])).toThrow(/Invalid content/);
  });
});

describe('§3.2 Marks', () => {
  it('§3.2 parses into 5 mark rows, and the two mark sets are equal', () => {
    expect(specMarks.map((r) => r.mark)).toEqual(['em', 'strong', 'strike', 'code', 'link']);
    expect(Object.keys(caotangSchema.marks).sort()).toEqual(specMarks.map((r) => r.mark).sort());
  });

  for (const row of specMarks) {
    it(`${row.mark}: attrs are §3.2's, with requiredness as the table states it`, () => {
      const declared = Object.entries(caotangSchema.marks[row.mark]!.spec.attrs ?? {}).map(
        ([k, v]) => [k, Object.prototype.hasOwnProperty.call(v, 'default')] as [string, boolean],
      );
      expect(declared.map(([n]) => n)).toEqual(row.attrs.map((a) => a.name));
      for (const attr of row.attrs) {
        if (attr.requiredness === 'unstated') continue;
        const hasDefault = declared.find(([n]) => n === attr.name)?.[1] ?? false;
        expect(hasDefault, `${row.mark}.${attr.name} is ${attr.requiredness} in §3.2`).toBe(
          attr.requiredness === 'optional',
        );
      }
    });
  }

  it('a required attr is required at runtime, not merely documented as such', () => {
    // §3.1/§3.2 mark `image.src` and `link.href` required. With a default they
    // would accept `create({})`; without one ProseMirror refuses. This is the
    // probe that makes "required" a property of the schema instead of a note.
    expect(() => caotangSchema.nodes.image!.create({})).toThrow(/No value supplied for attribute src/);
    expect(() => caotangSchema.marks.link!.create({})).toThrow(/No value supplied for attribute href/);
  });
});

describe('the two load-bearing cells, re-derived so the decision cannot become an opinion', () => {
  it("§3.1's rejected `code_block: text` is not a schema ProseMirror can build", () => {
    expect(() =>
      rebuild((nodes) => {
        nodes.code_block = { ...nodes.code_block!, content: 'text' };
      }),
    ).toThrow(/Only non-generatable nodes \(text\)/);
  });

  it("§3.1's rejected `inline+` round-trips three real constructs lossily", async () => {
    // `createAndFill` satisfies an `inline+` slot with an empty *text* node, and
    // an empty text node inside a block container serializes as a hard break.
    // So `>` came back as `> \` + `>`, `-` as `- \` and `1.` as `1. \` — three
    // constructs Markdown really contains, moved out of §3.3's exact class.
    const strict = rebuild((nodes) => {
      nodes.paragraph = { ...nodes.paragraph!, content: 'inline+' };
      nodes.heading = { ...nodes.heading!, content: 'inline+' };
    });
    expect(strict.nodes.paragraph!.spec.content).toBe('inline+');

    // The chain below is a local copy of §5's two processors, built here because
    // the shipped `parse`/`serialize` bind the product schema and this probe is
    // about a schema that must never ship. It reuses the product's own handler
    // factories and dialect options, so only the content expression differs.
    const roundTrip = async (body: string): Promise<string> => {
      const load = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkProseMirror, { schema: strict, handlers: createParseHandlers(strict, []) as never });
      const tree = (await load.run(load.parse(body))) as MdastRoot;
      const pm = load.stringify(tree) as unknown as Parameters<typeof fromProseMirror>[0];
      const handlers = createSerializeHandlers();
      const md = fromProseMirror(pm, {
        schema: strict,
        nodeHandlers: handlers as never,
        markHandlers: handlers as never,
      });
      return String(
        unified()
          .use(remarkGfm)
          .use(remarkStringify, { ...CANONICAL_STRINGIFY_OPTIONS })
          .stringify(md),
      );
    };

    // The three losses, pinned by their exact output.
    expect(await roundTrip('>\n')).toBe('> \\\n>\n');
    expect(await roundTrip('-\n')).toBe('- \\\n');
    expect(await roundTrip('1.\n')).toBe('1. \\\n');
  });
});
