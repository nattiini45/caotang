/**
 * The gating suite of the Tiptap preflight: the corpus run and the result table.
 *
 * Shape borrowed from the `fflate` guard: every finding is an assertion, not
 * a comment, so a change that "fixes" one of them without updating §2 fails
 * exactly one test and the rest stay green. The inverse matters just as much —
 * `unknown types throw` is asserted because it is a hazard the editor must handle, not
 * because the library should keep throwing.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import { CORPUS, FINDINGS } from '../src/corpus.js';
import { measure, parse, serialize } from '../src/trace.js';
import {
  CANONICAL_STRINGIFY_OPTIONS,
  DEGRADE_CLASS,
  EXACT_CLASS_MDAST_TYPES,
  SPEC_STRINGIFY_OPTIONS,
  createParseHandlers,
} from '../src/handlers.js';
import { caotangSchema } from '../src/schema.js';

/** One measurement per entry, shared by the tests that need it. */
const results = new Map<string, Awaited<ReturnType<typeof measure>>>();
const measured = CORPUS.map((entry) => ({ entry, result: measure(entry) }));
beforeAll(async () => {
  for (const { entry, result } of measured) {
    results.set(entry.name, await result);
  }
});

const get = (name: string) => {
  const found = results.get(name);
  if (!found) throw new Error(`no measurement for ${name}`);
  return found;
};

describe('preflight · the §3 handler table is what §3.1/§3.2/§3.3 say', () => {
  // The `prosemirror-changeset` pin assertion that used to live here has moved
  // to `pins.test.ts`, which reads the manifest and the lockfile.
  //
  // It stood here as `expect(CANONICAL_STRINGIFY_OPTIONS.bullet).toBe('-')` —
  // a **remark-stringify dialect option** (which character a bullet list uses),
  // under a test named "§2 pins prosemirror-changeset 2.4.4". Reverting the real
  // pin from 2.4.4 to the deferred 2.4.2 left all 335 tests green; touching
  // `bullet` failed five. A pin assertion that reads a bullet character could
  // not have caught a pin moving. See a review, 2026-10-01.

  it('every §3.3 exact-class mdast type is either handled by us or by the library', () => {
    const handlers = createParseHandlers(caotangSchema) as unknown as Record<string, unknown>;
    // `text` is the one exact-class type we deliberately do NOT register: the
    // library's own dispatcher has a built-in `text` case that applies
    // `replaceNewlines(trimLines(value))`, and shadowing it would change
    // behaviour we want. §3.3 lists it, so the list is checked — against
    // "registered by us OR known to be the library's", not against ours alone.
    const LIBRARY_HANDLED = new Set(['text']);
    const missing = EXACT_CLASS_MDAST_TYPES.filter(
      (type) => handlers[type] === undefined && !LIBRARY_HANDLED.has(type),
    );
    expect(missing).toEqual([]);
  });

  it('the schema carries exactly the §3.1 nodes and §3.2 marks', () => {
    const nodes = Object.keys(caotangSchema.nodes).sort();
    const marks = Object.keys(caotangSchema.marks).sort();
    // `text` is a leaf, not in §3.1's table, but required by ProseMirror and
    // named in §3.1's Markdown-source column.
    expect(nodes).toEqual(
      [
        'blockquote',
        'bullet_list',
        'code_block',
        'doc',
        'hard_break',
        'heading',
        'horizontal_rule',
        'image',
        'list_item',
        'ordered_list',
        'paragraph',
        'text',
      ].sort(),
    );
    expect(marks).toEqual(['code', 'em', 'link', 'strike', 'strong']);
  });
});

describe('preflight · the corpus runs, and deterministically', () => {
  it('has every §5 group represented', () => {
    const groups = new Set(CORPUS.map((entry) => entry.group));
    expect([...groups].sort()).toEqual(
      ['blocks', 'inline', 'links', 'lists', 'obsidian', 'caotang', 'structural'].sort(),
    );
  });

  it('covers the constructs §5 names explicitly', () => {
    // The four §5 constructs called out by name, plus the Obsidian spacing samples.
    const names = CORPUS.map((entry) => entry.name);
    for (const required of [
      'intraword-underscore',
      'image-in-link',
      'scene-separator',
      'thematic-break-stars',
      'obsidian-4space-nested',
      'obsidian-loose-list',
      'obsidian-blank-line-list',
      'obsidian-heading-spacing',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('every construct that round-trips is deterministic — §3.3\'s real invariant', () => {
    // This is the invariant that actually governs, asserted across the whole
    // corpus: same input → same bytes, so a no-op edit cycle never dirties a
    // git diff. The four that throw are excluded here and asserted separately
    // below — a throw is not instability, it is a stronger failure, and
    // counting it as "unstable" would have hidden the difference.
    const unstable = [...results.entries()]
      .filter(([, result]) => !result.deterministic && result.threw === null)
      .map(([name]) => name);
    expect(unstable).toEqual([]);
  });

  it('no exact-class construct is lost — content survives the round-trip', () => {
    const lost = CORPUS.filter((entry) => entry.expect === 'exact')
      .filter((entry) => get(entry.name).outcome === 'lost')
      .map((entry) => entry.name);
    expect(lost).toEqual([]);
  });

  it('the exact class is byte-identical wherever the dialect allows', () => {
    // §5's dialect contract: byte-identity holds *iff* the input is already written in the
    // configured dialect. The constructs that are not byte-identical are the
    // ones §5 explicitly says normalize (foreign markers, setext, intraword
    // escapes), so this asserts the canonical spellings specifically.
    const canonical = [
      'paragraph',
      'atx-heading-1',
      'atx-heading-3',
      'thematic-break-stars',
      'blockquote',
      'bullet-dash',
      'ordered-dot',
      'ordered-start-3',
      'emphasis-underscore',
      'strong-double-star',
      'strike-gfm',
      'inline-code',
      'intraword-underscore',
      'link-inline',
      'link-title',
      'image-basic',
      'image-in-link',
      'code-fenced',
      'scene-separator',
      'percent-comment-line',
      'at-mention',
      'no-smart-punct',
    ];
    const notIdentical = canonical.filter((name) => !get(name).byteIdentical);
    expect(notIdentical).toEqual([]);
  });

  it('§3.3\'s intraword safety holds — `Kara_thal` is not emphasis', () => {
    const result = get('intraword-underscore');
    expect(result.pmMarks).not.toContain('em');
    expect(result.output.trim()).toBe('Kara_thal');
  });

  it('§13 D2 holds — `%%` and `@` stay plain text, byte-identical', () => {
    // This is the load-bearing claim of the "no new remark deps" decision: a
    // character name and a synopsis line must survive a load/save cycle as
    // text. If either ever becomes a node, the decision's cost was wrong.
    for (const name of ['percent-comment-line', 'at-mention']) {
      const result = get(name);
      expect(result.byteIdentical, name).toBe(true);
      // `descendants` does not include the doc node itself, so the shape being
      // exactly paragraph+text is the claim: no annotation node was invented.
      expect(result.pmNodes, name).toEqual(['paragraph', 'text']);
      expect(result.pmMarks, name).toEqual([]);
    }
  });

  it('the scene separator survives — `***` is the one horizontal_rule', () => {
    const result = get('scene-separator');
    expect(result.byteIdentical).toBe(true);
    expect(result.pmNodes).toContain('horizontal_rule');
  });

  it('the image-in-link composite holds — §5 names it explicitly', () => {
    const result = get('image-in-link');
    expect(result.byteIdentical).toBe(true);
    expect(result.pmNodes).toContain('image');
    expect(result.pmMarks).toContain('link');
  });

  it('3-level nesting round-trips and re-parses to the same bytes', async () => {
    // §5 fixes `listItemIndent: 'one'`. The bar is not "looks right" but
    // idempotence: serialize(parse(x)) must be a fixed point, or every save
    // rewrites the file.
    const input = '- level one\n  - level two\n    - level three\n';
    const once = serialize(await parse(input));
    const twice = serialize(await parse(once));
    expect(twice).toBe(once);
  });
});

describe('preflight · the outcome classifier measures the construct, not a stripped string', () => {
  it('a lost inline structure is a degrade, not an exact round-trip', () => {
    // **The construct the classifier used to get wrong.** `_gone and _struck_
    // together_` round-trips to `_gone and struck together_`: the inner
    // emphasis is gone, so a save re-parses as a *different* document — §3.3's
    // own table calls that a degrade, and the corpus declares it one.
    //
    // A comparison that strips everything but `[a-z0-9]` cannot see it: both
    // spellings reduce to the same letters, so the loss reads as an exact
    // round-trip.
    const result = get('strike-in-emphasis');
    expect(result.outcome).toBe('degrade');
    expect(result.outcome).not.toBe('exact');
  });

  it('a construct whose text is not Latin-alphabet is not called lost', async () => {
    // The other direction, and the same stripped comparison: `[a-z0-9]` keeps
    // only the Latin letters and the digits, so a CJK sentence reduces to the
    // empty string — and an empty string is the classifier's "the round-trip
    // produced no content", which is a *loss*. The round trip lost nothing
    // here; it returned the same characters.
    const cjk = await measure({ name: 'cjk', group: 'caotang', input: '你好，世界。' });
    expect(cjk.threw).toBeNull();
    expect(cjk.output).toContain('你好，世界。');
    expect(cjk.outcome).not.toBe('lost');
    expect(cjk.outcome).toBe('exact');

    // And the case the stripping actually breaks on: the body is CJK, and the
    // only Latin-alphabet characters in it are the ones inside an entity —
    // which remark decodes while parsing. So the **source** strips to
    // `amp` and the **output** strips to the empty string, and a classifier
    // that asks "is the output empty?" answers *lost* about a round trip that
    // changed nothing but an entity's spelling.
    const entity = await measure({ name: 'cjk-entity', group: 'caotang', input: '你好 &amp;' });
    expect(entity.threw).toBeNull();
    expect(entity.output).toContain('你好 &');
    expect(entity.outcome).not.toBe('lost');
    expect(entity.outcome).toBe('exact');
  });

  it('a round trip that deletes fence info-string characters is not exact', async () => {
    // remark parses `js title=x` as `lang: 'js', meta: 'title=x'`, and the
    // loader keeps only the language — so a save writes the fence back without
    // `title=x`: source characters deleted, with no loss warning. A shape that
    // folds only `lang` reads `code:js` on both sides and the code value is
    // unchanged, so the classifier would call that round trip exact. It is the
    // same dropped-attribute class as a link that loses its title, and it must
    // measure the same way.
    const fenced = await measure({
      name: 'fence-meta',
      group: 'caotang',
      input: '```js title=x\nconst a = 1;\n```\n',
    });
    expect(fenced.threw).toBeNull();
    expect(fenced.output).toContain('```js');
    expect(fenced.output).not.toContain('title=x');
    expect(fenced.outcome).not.toBe('exact');
    expect(fenced.outcome).toBe('degrade');
  });

  it('every corpus entry measures the class §3.3 declares for it', () => {
    // **The corpus's `expect` is load-bearing from here.** A declared class
    // that nothing ever compared against is a claim no test can check, and a
    // classifier that measures something else — a stripped string, say — can
    // answer "exact" for a construct that lost a mark and the table would
    // still be green.
    //
    // The four entries the library cannot degrade are the exception, and they
    // are the exception *by name*: §3.3 says Caotang degrades them and
    // remark-prosemirror 0.1.5 throws instead. That difference is §2's
    // finding, asserted by F3 and F4, and it is pinned here so it cannot widen
    // without this test noticing.
    const gaps: string[] = [];
    const mismatched: string[] = [];
    for (const entry of CORPUS) {
      const result = get(entry.name);
      if (result.threw !== null) {
        gaps.push(entry.name);
        expect(result.outcome, entry.name).toBe('lost');
        continue;
      }
      if (result.outcome !== entry.expect) {
        mismatched.push(`${entry.name}: measured ${result.outcome}, declared ${entry.expect}`);
      }
    }
    expect(gaps.sort()).toEqual(
      ['footnote-reference', 'html-raw-block', 'image-reference', 'table-gfm'].sort(),
    );
    expect(mismatched).toEqual([]);
  });
});

describe('preflight · the findings, each pinned by an assertion', () => {
  it('F1 · §5\'s rule/fence spellings are illegal; one character is what it wants', () => {
    // Proves the spec's literal text throws. The cast is needed *because* the
    // values are illegal: `as const` gives them literal types, and
    // `Options['rule']` is `'*' | '-' | '_'`, so TypeScript rejects the object
    // before it ever reaches the library. The runtime throw is the fact worth
    // recording; the cast is what lets the test get there.
    const illegal: Record<string, unknown> = { ...SPEC_STRINGIFY_OPTIONS };
    expect(() =>
      String(
        unified()
          .use(remarkStringify, illegal as never)
          .stringify({ type: 'root', children: [{ type: 'thematicBreak' }] } as never),
      ),
    ).toThrow(/Cannot serialize rules/);

    // ...and that the spec's *intent* — a `***` separator — is what the
    // single-character option actually produces.
    expect(
      String(
        unified()
          .use(remarkStringify, { rule: CANONICAL_STRINGIFY_OPTIONS.rule })
          .stringify({ type: 'root', children: [{ type: 'thematicBreak' }] } as never),
      ),
    ).toBe('***\n');
    expect(FINDINGS.stringifyOptionsAreOutputSpellings.used.rule).toBe('*');
  });

  it('F2 · `strike` needs remark-gfm on the SAVE chain, not just the parse chain', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'delete', children: [{ type: 'text', value: 'x' }] }] },
      ],
    } as never;
    expect(() => String(unified().use(remarkStringify).stringify(tree))).toThrow(
      /Cannot handle unknown node/,
    );
    expect(String(unified().use(remarkGfm).use(remarkStringify).stringify(tree))).toBe('~~x~~\n');
    // And the corpus proves the real pipeline has it.
    expect(get('strike-gfm').byteIdentical).toBe(true);
  });

  it('F3 · unknown mdast types THROW — degrade handlers are mandatory, not optional', async () => {
    // §3.3 says "anything unknown → degrade, literal text fallback". It does
    // not. This is the finding that most directly shapes the editor: the handler table
    // is not a convenience layer, it is the only thing preventing a load crash.
    const inputFor = (mdastType: string) =>
      mdastType === 'table'
        ? '| a |\n| --- |\n| 1 |'
        : mdastType === 'footnoteReference'
          ? 'text[^1]\n\n[^1]: note'
          : '![alt][ref]\n\n[ref]: img.png';
    for (const mdastType of FINDINGS.unknownTypesThrowNotDegrade.observed) {
      await expect(parse(inputFor(mdastType))).rejects.toThrow(
        new RegExp(`unknown markdown node: ${mdastType}`),
      );
    }
    // And the corpus records it rather than hiding it.
    for (const name of ['table-gfm', 'footnote-reference', 'image-reference']) {
      expect(get(name).outcome).toBe('lost');
      expect(get(name).threw).toMatch(/unknown markdown node/);
    }
  });

  it('F4 · block-level HTML throws — the default emits inline text where `block+` is required', async () => {
    await expect(parse('<div>raw</div>')).rejects.toThrow(/Invalid content for node doc/);
    expect(get('html-raw-block').threw).toMatch(/Invalid content for node doc/);
  });

  it('F5 · the `value`-carrying leaves lose content through the exported factories', () => {
    // The hazard is silent, so it is asserted positively: with the
    // hand-written handlers in place, the content is present. A change that
    // "simplifies" them back to fromPmMark/fromPmNode fails exactly here.
    expect(get('inline-code').byteIdentical).toBe(true);
    expect(get('code-fenced').byteIdentical).toBe(true);
    expect(get('backtick-run-double').output).toContain('a ` b');
  });

  it('F6 · the front-matter strip is load-bearing, not belt-and-braces', async () => {
    // §5 step 1 says front matter is stripped before parse. If a future change
    // assumed remark-prosemirror handled it, this fails.
    const raw = '---\ntitle: X\n---\n\nBody.';
    const result = await measure({ name: 'fm', group: 'caotang', input: raw });
    expect(result.output).toContain('## title: X');
    expect(result.output).toContain('***');
  });

  it('§3.3\'s degrade table is declared for every type the corpus does not register', () => {
    const declared = DEGRADE_CLASS.map((row) => row.mdastType);
    for (const type of ['table', 'footnoteReference', 'imageReference', 'html']) {
      expect(declared).toContain(type);
    }
    // Every declared row records a *measurement*, not just a claim.
    for (const row of DEGRADE_CLASS) {
      expect(row.measured.length, row.mdastType).toBeGreaterThan(0);
    }
  });
});

describe('preflight · the result table is a real table', () => {
  it('every corpus entry produced a measurement with a class', () => {
    expect(results.size).toBe(CORPUS.length);
    for (const [name, result] of results) {
      expect(['exact', 'degrade', 'lost'], name).toContain(result.outcome);
    }
  });

  it('the exact class outnumbers the rest — a spike that mostly failed measured nothing', () => {
    const counts = { exact: 0, degrade: 0, lost: 0 };
    for (const result of results.values()) counts[result.outcome]++;
    expect(counts.exact).toBeGreaterThan(counts.lost);
  });

  it('the four throws are exactly the four the library cannot degrade', () => {
    const threw = [...results.entries()].filter(([, r]) => r.threw !== null).map(([n]) => n);
    expect(threw.sort()).toEqual(
      ['footnote-reference', 'html-raw-block', 'image-reference', 'table-gfm'].sort(),
    );
  });
});
