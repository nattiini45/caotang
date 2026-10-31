/**
 * §4's seam, its projection map, and its banner — and the three controls that
 * make the claims about them mean something.
 *
 * ## Why so much of this file reads `editor-engine.md`
 *
 * The claim is §4's own sentence — `bodyOffsetFromPmPos(pmFromBodyOffset(o)) === o`
 * over whole docs, **quoted rather than restated**. A hand-written copy of that
 * identity would only prove the copy still matches itself — the same failure the
 * suites refuse for §3.1 and for §9's registry. So the sentence is read out of the spec file, the two
 * function **names** are parsed out of it, and the identity is then run through
 * whatever the package exports under those names. Deleting the sentence fails the
 * first test; renaming an export fails the second; and the round trip itself is
 * measured over the whole §13 corpus rather than over a fixture.
 *
 * ## What the map turned out to need, and why it is three levels
 *
 * §4 describes a per-block map and then asserts a round trip that a per-block map
 * cannot deliver — a selection is an offset *inside* a block. So the map also
 * records a run per text leaf, equally long on both sides, and the conversions
 * bisect to a run and fall back to a block. What this file pins is that the
 * *measurements* behind it hold: every text leaf of the whole corpus is located, no block degrades, and
 * every run is the same length on both sides.
 *
 * ## The three controls, in the direction each can fail
 *
 * 1. **The map is measured against `serialize(doc)`, not against §4's
 *    concatenation.** Two sibling lists are the case that separates them, and
 *    the alternation that makes it is measured: `- a\n\n- b` is *one* loose
 *    list, `- a\n\n* b` is *two*. A map built from per-block concatenation would
 *    measure offsets against a body this product never writes.
 * 2. **The carrier carries, and `groupLossWarnings` groups.** Both halves are
 *    settled; the controls are in both directions — a matched `<span>` pair becomes
 *    one entry reporting 2 nodes, and two *different* codes on one line stay two
 *    entries.
 * 3. **The interface is checked in both directions.** A conforming
 *    implementation is compiled by the real `tsc`; a **narrowed** one (a member
 *    removed) and a **widened** interface (a member added) are compiled from the
 *    same source text and must fail *naming that member*. The conforming file
 *    having zero diagnostics is what makes the other two non-vacuous: three files
 *    that all failed for an unrelated reason would otherwise pass a test that only
 *    looks for a non-zero exit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CORPUS } from '@caotang/editor-audit';
import type { Node as PmNode } from '@tiptap/pm/model';

import * as seam from '../src/index.js';
import type {
  LossWarning,
  LoadDiagnostics,
  ProjectionMap,
  ProjectionRun,
  RunMatch,
} from '../src/index.js';
import { createMemoryEditorApi } from './memory-api.js';

const repoRoot = resolve(__dirname, '../../..');
const specPath = join(repoRoot, 'docs/architecture/editor-engine.md');

/** §4, as the spec writes it. A boundary, not a copy of the section. */
const section4 = (): string => {
  const spec = readFileSync(specPath, 'utf8');
  const from = spec.indexOf('## 4. `EditorApi`');
  const to = spec.indexOf('## 5. Markdown pipeline');
  expect(from, '§4 not found in editor-engine.md').toBeGreaterThan(-1);
  expect(to, '§5 not found after §4').toBeGreaterThan(from);
  return spec.slice(from, to);
};

/**
 * §4's fixture sentence, parsed into **the two function names it names** and
 * nothing else. The identity itself is never written out in this file — it is
 * read from the spec and obeyed, which is what the criterion (a) asks for and
 * what a restatement could not do.
 */
const roundTripNames = (): { outer: string; inner: string } => {
  const hit = /`(\w+)\((\w+)\(o\)\) === o`/.exec(section4());
  if (!hit) throw new Error("§4 no longer states the round trip in a parseable form");
  return { outer: hit[1] as string, inner: hit[2] as string };
};

const parseable = async (input: string): Promise<PmNode> => {  try {
    return await seam.parse(input);
  } catch {
    return null as unknown as PmNode; // a corpus entry the library cannot load is not this file's subject
  }
};

// ---------------------------------------------------------------------------
// 1. The projection map
// ---------------------------------------------------------------------------

describe('the projection map, measured over the whole §13 corpus', () => {
  it('locates every text leaf of every corpus entry, and degrades no block', async () => {
    // The control assertion, and it is the one that makes the numbers below
    // mean anything: "0 degraded" is satisfied by a map with no blocks at all,
    // and "76 of 76" by a corpus that failed to load. So both are counted first.
    let blocks = 0;
    let runs = 0;
    let loaded = 0;
    const degraded: string[] = [];
    for (const entry of CORPUS) {
      const doc = await parseable(entry.input);
      if (!doc) continue;
      loaded += 1;
      const map = seam.buildProjectionMap(doc);
      blocks += map.blocks.length;
      runs += map.runs.length;
      for (const index of map.unlocated) degraded.push(`${entry.name}[${index}]`);
    }
    expect(loaded, 'corpus entries that failed to load').toBe(CORPUS.length);
    expect(blocks, 'top-level blocks walked').toBeGreaterThan(50);
    expect(runs, 'text leaves located').toBeGreaterThan(70);
    expect(degraded, 'blocks whose runs could not be located').toEqual([]);
  });

  it('every run is the same length on both sides — the property the identity rests on', async () => {
    for (const entry of CORPUS) {
      const doc = await parseable(entry.input);
      if (!doc) continue;
      for (const run of seam.buildProjectionMap(doc).runs) {
        expect(run.bodyEnd - run.bodyStart, `${entry.name} run body length`).toBe(
          run.pmTo - run.pmFrom,
        );
      }
    }
  });

  it('records WHICH locator located each run — asserted per leaf, because a total cannot see a rescue', async () => {
    // Instrumenting `locate` gives the split — most runs on the first search,
    // a few on the second, none on the third. Without the per-run field the
    // suite could only count totals. A total is exactly the
    // shape a silent rescue preserves: a leaf neither of the first two searches
    // finds gets picked up by the fallback and `runs.length` reads the same.
    // `ProjectionRun.matched` carries it per run, and this asserts it per leaf.
    //
    // The expectations are written as **leaves**, with their text, not as totals.
    // A total assertion would be satisfied by a `matched` hardcoded to
    // `'standalone'`, so the control is the existence of the four `raw` leaves.
    const expected: Record<string, { matched: RunMatch; text: string }[]> = {
      // remark escapes a space at a delimiter boundary, so a leaf ending in a
      // space is not the leaf's own serialization anywhere in the block.
      'nested-emphasis': [
        { matched: 'raw', text: 'outer ' },
        { matched: 'raw', text: 'inner' },
        { matched: 'raw', text: ' outer' },
      ],
      // The fence whose content is backticks: the fenced wrapper is not the leaf.
      'code-fence-longer-than-content': [{ matched: 'raw', text: '```' }],
    };

    let loaded = 0;
    let standalone = 0;
    let raw = 0;
    let escaped = 0;
    for (const entry of CORPUS) {
      const doc = await parseable(entry.input);
      if (!doc) continue;
      loaded += 1;
      const map = seam.buildProjectionMap(doc);
      const leaves = map.runs.map((run) => ({
        matched: run.matched,
        text: map.body.slice(run.bodyStart, run.bodyEnd),
      }));
      const nonDefault = leaves.filter((leaf) => leaf.matched !== 'standalone');
      // Every run is one of the three declared locators — a fourth value would
      // mean `locate` grew an arm the map cannot name.
      for (const leaf of leaves) {
        expect(['standalone', 'raw', 'escaped'], `${entry.name} declared locator`).toContain(
          leaf.matched,
        );
        if (leaf.matched === 'standalone') standalone += 1;
        if (leaf.matched === 'raw') raw += 1;
        if (leaf.matched === 'escaped') escaped += 1;
      }
      expect(nonDefault, `${entry.name} leaves not located by the first search`).toEqual(
        expected[entry.name] ?? [],
      );
    }

    expect(loaded, 'corpus entries that failed to load').toBe(CORPUS.length);
    // The measured split, kept as a cross-check on the per-leaf assertions above
    // rather than as the assertion. The figures are 76 / 4 / 0 over 80 runs: four §13
    // leaves carry an escape in their body spelling and are cut at it, so they contribute
    // more than one run each. Three of the four are `escape-bracket`, `html-raw-block`
    // and `html-raw-inline`. (`footnote-reference` was a fifth until #270: its `[^1]`
    // was escaped text, and it is now a marker, which is no text leaf and has no run,
    // so its `Text` and `The note.` are one run each.) The fourth,
    // `obsidian-heading-spacing`, has no escape left after the cut and is
    // byte-identical uncut. Cutting does not change **which** locator finds a leaf
    // — `raw` is 4 and `escaped` is 0 either way — so the per-leaf assertions
    // above are unaffected, which is the point of keeping them primary.
    expect({ standalone, raw, escaped }).toEqual({ standalone: 76, raw: 4, escaped: 0 });
    // And the control in the direction the field can lie: a `matched` that was
    // always `'standalone'` passes every total above and fails these two.
    expect(raw, 'leaves the first search could not find').toBeGreaterThan(0);
    expect(Object.keys(expected), 'leaves named per leaf in the test').toHaveLength(2);
  });

  it("the map's body is serialize(doc), and the block spans partition it", async () => {
    const body = '> quoted\n\n- item';
    const doc = (await seam.parse(body)) as PmNode;
    const map = seam.buildProjectionMap(doc);
    expect(map.body).toBe(seam.serialize(doc));
    // A partition: contiguous, non-overlapping, and covering the body exactly.
    expect(map.blocks[0]!.bodyStart).toBe(0);
    for (const [i, block] of map.blocks.entries()) {
      expect(block.bodyEnd).toBeGreaterThan(block.bodyStart);
      if (i > 0) expect(block.bodyStart).toBe(map.blocks[i - 1]!.bodyEnd);
    }
    expect(map.blocks[map.blocks.length - 1]!.bodyEnd).toBe(map.body.length);
  });

  it('adjacent lists: the spans follow the body, not §4\'s per-block concatenation', async () => {
    // The measured alternation, and the reason the map is built from prefix
    // serializations rather than from concatenated blocks. `perBlock` is what
    // §4's sentence as written produces, and it is a body this product never
    // writes — the second list's own serialization is `- b`, which re-parses as
    // one loose list rather than two.
    const doc = (await seam.parse('- a\n\n* b')) as PmNode;
    const map = seam.buildProjectionMap(doc);
    expect(map.blocks).toHaveLength(2);
    // The two blocks' text, as the body actually spells them.
    expect(map.body.slice(map.blocks[0]!.bodyStart, map.blocks[0]!.bodyEnd)).toBe('- a\n');
    expect(map.body.slice(map.blocks[1]!.bodyStart, map.blocks[1]!.bodyEnd)).toBe('\n* b\n');
    // And the *runs* land on the real text of each list, not on a re-serialized
    // `- b` that exists nowhere in this document.
    expect(map.body.slice(map.runs[1]!.bodyStart, map.runs[1]!.bodyEnd)).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// 2. The third locator — measured at zero over the corpus, and it was the broken one
// ---------------------------------------------------------------------------

describe('the escape-tolerant locator, which measured zero and had never run', () => {
  // §5 escapes on the way out and the first two locators look for unescaped text,
  // so the third exists for a leaf that is written with escapes. It fires
  // **zero times over the whole §13 corpus**, proved by replacing its regexp with
  // one that can never match — which left all 234 editor tests green, because the
  // branch never fired. "Never fires" and "would work if it fired" are different
  // claims, and the second one was false: the pattern was built with
  // `text.replace(ESCAPABLE, '\\?$&')`, whose replacement is a regex source reading
  // `\?` — a **literal question mark**. For any text holding an escapable character
  // the chain emitted two quantifiers on one atom and `new RegExp` **threw
  // `SyntaxError: Nothing to repeat` out of `buildProjectionMap`**.
  //
  // These shapes are the measured family that reaches it, and they are ordinary
  // Markdown: an escaped asterisk, bracket, tilde or backtick in a marked run.

  /** `locate`'s three arms over one document, and what it produced. */
  const located = async (input: string) => {
    const doc = (await seam.parse(input)) as PmNode;
    const map = seam.buildProjectionMap(doc);
    return {
      doc,
      map,
      escaped: map.runs.filter((run) => run.matched === 'escaped').length,
    };
  };

  // **Each of these is 2, not 1**, and the number is a
  // consequence rather than a choice: a leaf carrying one escape is **two**
  // runs with the backslash between them, so the count follows the leaf. The
  // `matched` value is per run, so it counts runs, not locators.
  it.each([
    ['**a\\*b** and 2. c\\*d', 2],
    ['a\\*b *2. c*', 2],
    ['**a\\[b** and 2. c\\[d', 2],
    ['**a\\~b** and 2. c\\~d', 2],
    ['**a\\`b** and 2. c\\`d', 2],
    ['**a\\{b\\}c** and 2. d\\*e', 2],
  ])('locates a leaf neither of the first two searches can find: %s', async (input, expected) => {
    const { map, escaped } = await located(input);
    // The block degraded instead of being located — which is what the old
    // construction produced, as an exception rather than as an `unlocated`.
    expect(map.unlocated, `blocks degraded in ${input}`).toEqual([]);
    expect(escaped, `runs the escape-tolerant locator resolved in ${input}`).toBe(expected);
    // And the run it returned is a run like any other: equal length on both sides.
    for (const run of map.runs.filter((r) => r.matched === 'escaped')) {
      expect(run.bodyEnd - run.bodyStart).toBe(run.pmTo - run.pmFrom);
    }
  });

  it('no leaf text produces an invalid pattern — the construction cannot throw', async () => {
    // Every character §5 may escape, in the shape that reaches the third arm —
    // **and measured 2026-10-06: 6 of these 16 reach it, and 10 do
    // not.** The six are the escaped `*` (in two documents), `[`, `~`, the
    // backtick and the `{b}c` case; the other ten — `-`, `.`, `_`, `?`, `(`,
    // `|`, `{`, `}`, `!` and `+` — resolve on the first or second search, so no
    // pattern is ever constructed for them and they cannot fail for this test's
    // reason. **Not all sixteen are "in the shape
    // that reaches the third arm"**: only these six reach arm 3.
    //
    // The claim is not "does not throw" (an unexercised branch satisfies that
    // too): it is that each of these documents yields a **complete** map, and
    // the first of them threw out of `buildProjectionMap` before the
    // construction was rebuilt character by character. The six are enough to
    // hold the construction, because it is uniform over characters rather than
    // per-character — arm 3 made to throw fails 13 tests, and the older
    // string-replace chain fails 13.
    const family = [
      '**a\\*b** and 2. c\\*d',
      'a\\*b *2. c*',
      '**a\\-b** and 2. c\\-d',
      '**a\\.b** and 2. c\\.d',
      '**a\\_b** and 2. c\\_d',
      '**a\\?b** and 2. c\\?d',
      '**a\\(b** and 2. c\\(d',
      '**a\\[b** and 2. c\\[d',
      '**a\\|b** and 2. c\\|d',
      '**a\\{b** and 2. c\\{d',
      '**a\\}b** and 2. c\\}d',
      '**a\\!b** and 2. c\\!d',
      '**a\\~b** and 2. c\\~d',
      '**a\\+b** and 2. c\\+d',
      '**a\\`b** and 2. c\\`d',
      '**a\\{b\\}c** and 2. d\\*e',
    ];
    for (const input of family) {
      const { map } = await located(input);
      expect(map.unlocated, `blocks degraded in ${input}`).toEqual([]);
      // Non-vacuous: "not empty" is satisfied by a document with no text at all.
      expect(map.runs.length, `runs located in ${input}`).toBeGreaterThan(0);
    }
  });

  it('the run it returns is cut at the escape, so its body text IS its PM text — the tail is no longer short', async () => {
    // **This test asserted the defect.** It read: *"an escape-tolerant match
    // cannot also give equal text: the body holds a `\` the leaf does not, so the
    // run is placed at the leaf's first character and its span is the leaf's
    // length — the tail is short by the escapes inside it. That is a real cost, so
    // it is asserted here: if a future change makes the two agree, ... this
    // fails."* It named the cost and then pinned it in place.
    //
    // The premise was wrong: a run can be equally long on both sides **and** carry
    // the leaf's text, because the leaf does not need to be one run. Cut at the
    // escape, each piece is a run and each reads the same string on both sides; the
    // backslash is the gap, and §4's stated clamp covers it. The test is inverted
    // rather than deleted, because the sentence it used to assert was a real
    // (unverified) belief and its replacement is worth the same weight.
    const { doc, map } = await located('**a\\*b** and 2. c\\*d');
    const escaped = map.runs.filter((run) => run.matched === 'escaped');
    expect(escaped.length, 'escape-tolerant runs').toBe(2);
    // Each run's body slice is its PM text — the property the old code violated.
    for (const run of escaped) {
      expect(map.body.slice(run.bodyStart, run.bodyEnd)).toBe(
        doc.textBetween(run.pmFrom, run.pmTo),
      );
      expect(run.bodyEnd - run.bodyStart).toBe(run.pmTo - run.pmFrom);
    }
    // Stated as the placement it is, so a regression is legible rather than only
    // red: ` and 2. c`, the backslash, then `*d` — the escaped character keeps its
    // own run, which is the refinement the corpus's `#Title` forced.
    expect(escaped.map((run) => map.body.slice(run.bodyStart, run.bodyEnd))).toEqual([
      ' and 2. c',
      '*d',
    ]);
    expect(map.body.slice(escaped[0]!.bodyEnd, escaped[1]!.bodyStart)).toBe('\\');
    // And the leaf's own first character is located, not clamped: the old code put
    // `a*b`'s run at body 0 — the ** — and resolved body 2 to PM 3. It is PM 1.
    const strong = map.runs.filter((run) => run.matched === 'standalone');
    expect(strong.map((run) => map.body.slice(run.bodyStart, run.bodyEnd))).toEqual(['a', '*b']);
    expect(seam.pmFromBodyOffset(map, 2), 'body 2 is the leaf text `a`').toBe(1);

    // And the map on that document is still a retraction, in both directions —
    // which is the property §4 actually states, and the reason a misaligned tail
    // was a fidelity cost rather than a broken map.
    const f = seam.pmFromBodyOffset;
    const g = seam.bodyOffsetFromPmPos;
    for (let o = 0; o <= map.body.length; o += 1) {
      const once = g(map, f(map, o));
      expect(g(map, f(map, once)), `offset ${o} is not a fixed point`).toBe(once);
    }
    for (let p = 0; p <= map.docSize; p += 1) {
      const once = f(map, g(map, p));
      expect(f(map, g(map, once)), `pm ${p} is not a fixed point`).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// 2b. The run a leaf's body spelling actually occupies
// ---------------------------------------------------------------------------

/**
 * **Every character inside a run is the same character on both sides.**
 *
 * This is the assertion the escape-aware runs make possible. §4's retraction is satisfied by a map that is wrong:
 * `pmFromBodyOffset` and `bodyOffsetFromPmPos` compose into a retraction even when
 * a run's body text is `not \[a link` and its PM text is `not [a link]`, because
 * both conversions are consistently wrong about the same characters. §4's own words
 * for the guarantee it wants are *"the identity therefore holds over every offset
 * inside a located run"* — and the identity is a **character** identity, not an
 * offset identity. So this is checked as one.
 *
 * It asks the **run** what it claims, not the map: a run claims `pmFrom +
 * (o - bodyStart)` at body offset `o`, and §4's equal lengths are what make that
 * the mapping. Asking the map instead would make the control below unfalsifiable:
 * `pmFromBodyOffset(map, o)` computed for a run moved one character cannot fail.
 * The tie between
 * the two is asserted in the next test, so the predicate cannot silently drift away
 * from the conversion it is supposed to be checking.
 */
const disagreements = (doc: PmNode, map: ProjectionMap, run: ProjectionRun): string[] => {
  const out: string[] = [];
  for (let o = run.bodyStart; o < run.bodyEnd; o += 1) {
    const pm = run.pmFrom + (o - run.bodyStart);
    const onBody = map.body[o]!;
    const onPm = doc.textBetween(pm, pm + 1);
    if (onBody !== onPm) out.push(`body ${o} ${JSON.stringify(onBody)} -> pm ${pm} ${JSON.stringify(onPm)}`);
  }
  return out;
};

describe('a leaf carrying an escape is cut at it, and every run reads the same on both sides', () => {
  /** The row's two families: the four that escape inside strong, then the rest of ESCAPABLE_SET. */
  const FAMILY = [
    '**a\\*b** and 2. c\\*d',
    '**a\\[b** and 2. c\\[d',
    '**a\\~b** and 2. c\\~d',
    '**a\\`b** and 2. c\\`d',
    '**a\\_b** and 2. c\\_d',
    '**a\\?b** and 2. c\\?d',
    '**a\\(b** and 2. c\\(d',
    '**a\\)b** and 2. c\\)d',
    '**a\\|b** and 2. c\\|d',
    '**a\\{b** and 2. c\\{d',
    '**a\\}b** and 2. c\\}d',
    '**a\\+b** and 2. c\\+d',
    '**a\\!b** and 2. c\\!d',
    '**a\\-b** and 2. c\\-d',
    '**a\\.b** and 2. c\\.d',
  ];

  it.each(FAMILY)('every offset inside every run holds the same character on both sides: %s', async (input) => {
    const doc = (await seam.parse(input)) as PmNode;
    const map = seam.buildProjectionMap(doc);
    expect(map.unlocated, `blocks degraded in ${input}`).toEqual([]);
    // Non-vacuous: a map with no runs satisfies the loop above, and this is the
    // family that does degrade to nothing when the construction is wrong.
    expect(map.runs.length, `runs located in ${input}`).toBeGreaterThan(1);
    const bad = map.runs.flatMap((run) => disagreements(doc, map, run));
    expect(bad, `offsets inside a run that disagree in ${input}`).toEqual([]);
  });

  it('the check can fail: a run moved one character disagrees with itself', async () => {
    const doc = (await seam.parse('**a\\*b** and 2. c\\*d')) as PmNode;
    const map = seam.buildProjectionMap(doc);
    const first = map.runs[0]!;
    expect(disagreements(doc, map, first), 'the unshifted run agrees').toEqual([]);
    // The control, in the exact shape of the source mutation the acceptance
    // criterion names — "a mutation moving the arm-1 start by one character". That
    // mutation edits `at + aligned.inner`, so it moves `bodyStart` and leaves
    // `bodyEnd`: the run gets one character *shorter*, and a one-character run gets
    // **empty**, which is why the run chosen here is the longest in the map rather
    // than the first. An earlier draft shifted a one-character run and could not
    // fail, for exactly that reason — the control was measuring nothing.
    const longest = map.runs.reduce((a, b) => (b.bodyEnd - b.bodyStart > a.bodyEnd - a.bodyStart ? b : a));
    expect(longest.bodyEnd - longest.bodyStart, 'the control needs a run longer than one').toBeGreaterThan(1);
    const shifted = { ...longest, bodyStart: longest.bodyStart + 1 };
    expect(
      disagreements(doc, map, shifted),
      'a run moved one character must disagree — if this is empty the check is vacuous',
    ).not.toEqual([]);
  });

  it('the run\'s own claim is the map\'s conversion, so the check above is about this map', async () => {
    // The tie the previous test's comment claims. `pmFromBodyOffset` finds the run
    // and clamps; inside a run the clamp is a no-op, so the two must agree on every
    // offset of every run. If a future change moved the conversion away from the
    // run's linearity, this goes red before the character check can go quietly
    // meaningless.
    for (const entry of CORPUS) {
      const doc = await parseable(entry.input);
      if (!doc) continue;
      const map = seam.buildProjectionMap(doc);
      for (const run of map.runs) {
        for (let o = run.bodyStart; o < run.bodyEnd; o += 1) {
          expect(
            seam.pmFromBodyOffset(map, o),
            `${entry.name} body ${o} inside a run`,
          ).toBe(run.pmFrom + (o - run.bodyStart));
        }
      }
    }
  });

  it('and it holds over the whole §13 corpus, whose five escaped leaves were all mis-placed before', async () => {
    let escapedLeaves = 0;
    for (const entry of CORPUS) {
      const doc = await parseable(entry.input);
      if (!doc) continue;
      const map = seam.buildProjectionMap(doc);
      for (const run of map.runs) {
        const bad = disagreements(doc, map, run);
        expect(bad, `offsets inside a run that disagree in ${entry.name}`).toEqual([]);
      }
      // Non-vacuity over the corpus, named: these five carry a `\` in a run's body
      // and every one of them read a **different** string on the two sides before.
      if (map.runs.some((run) => map.body.slice(run.bodyStart, run.bodyEnd).includes('\\'))) {
        escapedLeaves += 1;
      }
    }
    // After the cut no run's *body* holds a backslash — that is the whole point of
    // the change — so this counts runs, not leaves, and must be zero.
    expect(escapedLeaves, 'corpus runs whose body still holds a backslash').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. §4's own sentence, quoted rather than restated
// ---------------------------------------------------------------------------

describe("§4's fixture sentence, read out of the spec and then obeyed", () => {
  it('§4 states the round trip this file asserts — deleting that sentence fails here', () => {
    // The sentence as shipped, with its two measured corrections:
    // `pmPosFromBodyOffset` was renamed to the shipped `pmFromBodyOffset`, and
    // the identity holds over a located run rather than over every offset of every
    // document — a body character and a PM position are not in bijection once a
    // document holds a hard break, an image or a list marker.
    expect(section4()).toMatch(
      /`bodyOffsetFromPmPos\(pmFromBodyOffset\(o\)\) === o`/,
    );
  });

  it("the two function names in §4's sentence are the ones this package exports", () => {
    const { outer, inner } = roundTripNames();
    const exported = seam as unknown as Record<string, unknown>;
    for (const name of [outer, inner]) {
      expect(typeof exported[name], `${name} is named by §4 but not exported`).toBe('function');
    }
  });

  it('obeys it: the round trip is the identity over every located offset, whole corpus', async () => {
    // Composed from the names in the spec's sentence, in the order the sentence
    // puts them — so this is the spec's claim under test, not a restatement.
    const named = roundTripNames();
    const table = seam as unknown as Record<string, (m: ProjectionMap, p: number) => number>;
    const outer = table[named.outer]!;
    const inner = table[named.inner]!;

    let checked = 0;
    for (const entry of CORPUS) {
      const doc = await parseable(entry.input);
      if (!doc) continue;
      const map = seam.buildProjectionMap(doc);
      for (const run of map.runs) {
        for (let o = run.bodyStart; o < run.bodyEnd; o += 1) {
          expect(outer(map, inner(map, o)), `${entry.name} offset ${o}`).toBe(o);
          checked += 1;
        }
      }
    }
    // Non-vacuous: the loop above is satisfied by a map with no runs.
    expect(checked).toBeGreaterThan(500);
  });

  it('pins the retraction over the WHOLE corpus, in both directions — the property §4 A1 states', async () => {
    // The retraction is what §4 A1
    // claims (`bodyOffsetFromPmPos(pmFromBodyOffset(b)) === bodyOffsetFromPmPos(
    // pmFromBodyOffset(b))` at **every** offset); one hand-built fixture is not
    // enough to pin it, so it is asserted over the whole corpus.
    //
    // Three claims, kept separate because they are separate:
    //   (a) the **retraction** holds at every body offset and every PM position of
    //       every corpus entry — measured: 0 failures in 1164 body offsets and 0 in
    // **1073** PM positions (`0…docSize` inclusive; the spec figure of 1014
    //       is the same measurement over `0…docSize-1`, so this is the stronger
    //       claim rather than a different one);
    //   (b) the **identity** holds at every offset inside a located run — measured:
    //       641 of those offsets, all of them holding;
    //   (c) and the map is **not** an identity over the corpus: 443 of the 1164
    //       offsets fail it, because a body character and a PM position stop being
    //       in bijection once the body holds a hard break, an image, a list marker
    //       or a fence. Without (c) a test of (a) alone would also pass on a map
    //       that *was* the identity everywhere, which §4 does not claim.
    let bodyOffsets = 0;
    let pmPositions = 0;
    let identityFailures = 0;
    let interiorOffsets = 0;
    const f = seam.pmFromBodyOffset;
    const g = seam.bodyOffsetFromPmPos;
    for (const entry of CORPUS) {
      const doc = await parseable(entry.input);
      if (!doc) continue;
      const map = seam.buildProjectionMap(doc);
      for (let o = 0; o <= map.body.length; o += 1) {
        bodyOffsets += 1;
        const once = g(map, f(map, o));
        expect(g(map, f(map, once)), `${entry.name} offset ${o} is not a fixed point`).toBe(once);
        if (once === o) continue;
        identityFailures += 1;
        const inside = map.runs.some((r) => o >= r.bodyStart && o < r.bodyEnd);
        expect(inside, `${entry.name} offset ${o} fails the identity outside every run`).toBe(false);
      }
      for (const run of map.runs) {
        for (let o = run.bodyStart; o < run.bodyEnd; o += 1) {
          interiorOffsets += 1;
          expect(g(map, f(map, o)), `${entry.name} offset ${o} inside a located run`).toBe(o);
        }
      }
      for (let p = 0; p <= map.docSize; p += 1) {
        pmPositions += 1;
        const once = f(map, g(map, p));
        expect(f(map, g(map, once)), `${entry.name} pm ${p} is not a fixed point`).toBe(once);
      }
    }
    // Non-vacuity in both directions, and the counts are ranges rather than the
    // measured figures so a corpus that grows does not fail a true property.
    expect(bodyOffsets, 'body offsets measured').toBeGreaterThan(1000);
    expect(pmPositions, 'PM positions measured').toBeGreaterThan(900);
    expect(interiorOffsets, 'offsets inside a located run').toBeGreaterThan(500);
    expect(identityFailures, 'offsets where the composition is not the identity').toBeGreaterThan(0);
  });

  it('clamps rather than throws off either end, and the composed pair is a retraction', async () => {
    // §4: "offsets map to nearest position; the anchor ladder is the verification
    // layer above them". So out-of-range input is clamped rather than an error,
    // and the round trip is **idempotent everywhere it is not an identity** — the
    // property that makes a second trip through the bridge a no-op.
    //
    // The claim is stated as `(f∘g)² = f∘g` and not as `f∘g = id` because the two
    // are different claims: a PM position in a block separator has no body
    // counterpart and clamps to the nearest *text* position, which is inside the
    // previous block. Measured on `line one  \nline two\n\n> quoted`, asserting
    // identity over all positions is asserting that a position ProseMirror can
    // hold and this map cannot represent round-trips to itself.
    const doc = (await seam.parse('line one  \nline two\n\n> quoted')) as PmNode;
    const map = seam.buildProjectionMap(doc);
    expect(seam.pmFromBodyOffset(map, -50)).toBeGreaterThanOrEqual(0);
    expect(seam.bodyOffsetFromPmPos(map, 10_000)).toBeLessThanOrEqual(map.body.length);

    const f = seam.pmFromBodyOffset;
    const g = seam.bodyOffsetFromPmPos;
    for (let p = 0; p <= map.docSize; p += 1) {
      const once = f(map, g(map, p));
      expect(f(map, g(map, once)), `pm ${p} is not a fixed point`).toBe(once);
    }
    for (let o = 0; o <= map.body.length; o += 1) {
      const once = g(map, f(map, o));
      expect(g(map, f(map, once)), `offset ${o} is not a fixed point`).toBe(once);
    }
    // And the identity, on the domain where it is claimed: inside a run.
    for (const run of map.runs) {
      for (let o = run.bodyStart; o < run.bodyEnd; o += 1) {
        expect(g(map, f(map, o)), `offset ${o} in a located run`).toBe(o);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The carrier
// ---------------------------------------------------------------------------

describe('§4\'s carrier carries the diagnostics half of the load, unchanged', () => {
  const load = async (initialBody: string) => {
    const seen: LoadDiagnostics[] = [];
    const instance = await createMemoryEditorApi().mount({} as HTMLElement, {
      docId: 'doc-1',
      initialBody,
      onLoadDiagnostics: (d) => seen.push(d),
    });
    return { seen, instance, reference: await seam.parseWithDiagnostics(initialBody) };
  };

  it('a matched pair arrives as two nodes and groups as one entry', async () => {
    // The control, direction 1: `<span>x</span>` is two `html` nodes on one
    // line, so the carrier's array is **two** entries and the banner's is **one**
    // reporting 2. The two numbers are the point — a carrier that grouped would
    // make them the same, and a banner that did not would make them two.
    const { seen, reference } = await load('a <span>x</span> b\n');
    expect(reference.warnings).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.warnings).toHaveLength(2);
    expect(seam.groupLossWarnings(seen[0]!.warnings)).toHaveLength(1);
  });

  it('same length, same order, same positions — no merging, no reordering, no dedupe', async () => {
    const { seen, reference } = await load('| a | b |\n\n<div>raw</div>\n');
    expect(seen[0]!.warnings).toEqual(reference.warnings);
    // Ordered by position, as the parse emitted them.
    expect(seen[0]!.warnings.map((w) => w.position?.line)).toEqual(
      reference.warnings.map((w) => w.position?.line),
    );
  });

  it('DialectNotice[] travels beside the warnings, not inside them', async () => {
    const { seen, reference } = await load('* one\n* two\n');
    expect(seen[0]!.dialect).toEqual(reference.dialect);
    expect(reference.dialect.length).toBeGreaterThan(0);
    // Not merged: a dialect entry carries the two spellings and no `code`, a
    // warning carries a `code` and no spellings. The `dialect.test.ts` asserts
    // the two are disjoint as *sets*; what is asserted here is that the carrier
    // did not flatten one into the other on the way past.
    for (const notice of seen[0]!.dialect) {
      expect(notice).not.toHaveProperty('code');
    }
    for (const warning of seen[0]!.warnings) {
      expect(warning).not.toHaveProperty('source');
      expect(warning).not.toHaveProperty('canonical');
    }
  });

  it('setContent reports again, because an agent apply is a load too', async () => {
    const { seen, instance } = await load('plain\n');
    expect(seen).toHaveLength(1);
    await instance.setContent('| a | b |\n| - | - |\n');
    expect(seen).toHaveLength(2);
    expect(seen[1]!.warnings.map((w) => w.code)).toEqual(['lossy-structure']);
  });
});

// ---------------------------------------------------------------------------
// 5. The banner
// ---------------------------------------------------------------------------

describe('the banner groups for display and says how many nodes it merged', () => {
  const warn = (code: LossWarning['code'], mdastType: string, line?: number): LossWarning => ({
    code,
    mdastType,
    ...(line === undefined ? {} : { position: { line, column: 1 } }),
    detail: `${code} ${mdastType}`,
  });

  it('a matched pair on one line is one entry reporting 2 nodes', () => {
    const groups = seam.groupLossWarnings([
      warn('unsupported-node', 'html', 1),
      warn('unsupported-node', 'html', 1),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.nodes).toBe(2);
    expect(groups[0]!.warnings).toHaveLength(2);
  });

  it('two different codes on one line stay two entries — the rejected over-merge', () => {
    // Grouping by `mdastType` alone would make this one entry and would drop
    // `code` from the key, so a `lossy-attribute` and an `unsupported-node` would
    // report as the same event.
    const groups = seam.groupLossWarnings([
      warn('unsupported-node', 'html', 4),
      warn('lossy-attribute', 'html', 4),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.code)).toEqual(['unsupported-node', 'lossy-attribute']);
  });

  it('the node counts sum to the input — a group reporting 1 where two warned is a lie', () => {
    const input = [
      warn('unsupported-node', 'html', 1),
      warn('unsupported-node', 'html', 1),
      warn('lossy-attribute', 'html', 1),
      warn('lossy-structure', 'table', 9),
      warn('lossy-attribute', 'html', 9),
    ];
    const groups = seam.groupLossWarnings(input);
    expect(groups.reduce((sum, g) => sum + g.nodes, 0)).toBe(input.length);
    expect(groups.flatMap((g) => g.warnings)).toHaveLength(input.length);
  });

  it('order is the order it is handed, whatever that is, and a singleton stays a singleton', () => {
    // **Retitled (2026-10-06 02:0x).** This read *"order is the
    // order the constructs were met"*, and that is a claim about the **parse**,
    // which this test cannot make: it hand-builds the array, so it proves only
    // that grouping preserves what it is given — true, and much weaker than the
    // title. appends the merged-run warnings after the compile, what it
    // is given is *not* document order (measured: `html@5` before `emphasis@1`),
    // and a banner reading top to bottom is a product question. The
    // parse's actual order is pinned where the parse is: `merged-runs.test.ts`,
    // "the array is handlers-then-structural, and the banner shows it". The
    // `[9, 1]` below is kept as the control that grouping does not sort.
    const groups = seam.groupLossWarnings([
      warn('lossy-structure', 'table', 9),
      warn('unsupported-node', 'html', 1),
    ]);
    expect(groups.map((g) => g.line)).toEqual([9, 1]);
    expect(seam.groupLossWarnings([])).toEqual([]);
    expect(seam.groupLossWarnings([warn('unsupported-node', 'html', 1)])[0]!.nodes).toBe(1);
  });

  it('a warning with no position groups under a null line rather than under line 0', () => {
    // mdast's own `position` is optional, and inventing a line would be a claim
    // about a location rather than about a loss.
    const groups = seam.groupLossWarnings([warn('unsupported-node', 'html'), warn('unsupported-node', 'html')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.line).toBeNull();
    expect(groups[0]!.nodes).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. §4 through an implementation that exists
// ---------------------------------------------------------------------------

describe('§4 through the in-memory implementation', () => {
  const mount = async (initialBody: string, extra: Record<string, unknown> = {}) => {
    const api = createMemoryEditorApi();
    return api.mount({} as HTMLElement, { docId: 'doc-1', initialBody, ...extra });
  };

  it('a new empty document mounts, because §5 says a parse cannot fail', async () => {
    // Measured 2026-10-04 21:0x: `parse('')` threw `Invalid content for node
    // doc: <>`, because §3.1's `doc` is `block+` and an empty mdast root compiles
    // to an empty doc. §5's load is stated to be total, and this is the most
    // common document the product will ever open.
    const instance = await mount('');
    expect(instance.getContent()).toBe('');
    instance.insertAtSelection('The first line.');
    expect(instance.getContent()).toBe('The first line.\n');
  });

  it('mount throws only on a bad host, and nothing else', async () => {
    await expect(
      createMemoryEditorApi().mount(null as unknown as HTMLElement, {
        docId: 'd',
        initialBody: 'x',
      }),
    ).rejects.toThrow(/programmer error/);
    // A body full of degrade constructs is not an error either: it loads and
    // reports, which is §4's whole error-modes clause. A GFM table needs its
    // delimiter row — `| a | b |` alone is a paragraph, and measured as one.
    const instance = await mount('| a | b |\n| - | - |\n');
    expect(instance.getContent()).toBe('a b\n');
  });

  it('the bridge round-trips a real transaction: replaceRange lands where the offset said', async () => {
    const instance = await mount('hello world');
    instance.replaceRange({ from: 0, to: 5 }, 'goodbye');
    expect(instance.getContent()).toBe('goodbye world\n');
    expect(instance.getSelection()).toEqual({ from: 0, to: 7 });
  });

  it('the map is rebuilt on every doc change, and the second primitive proves it', async () => {
    // The stale-map case: the second primitive's offset is only correct against a
    // map built from the *edited* body, so removing the rebuild line moves text.
    const instance = await mount('hello world');
    instance.replaceRange({ from: 0, to: 5 }, 'goodbye');
    instance.revealRange({ from: 8, to: 13 });
    instance.insertAtSelection('!');
    expect(instance.getContent()).toBe('goodbye world!\n');
  });

  it('getSelection is null when collapsed and a range after revealRange', async () => {
    const instance = await mount('hello world');
    expect(instance.getSelection()).toBeNull();
    instance.revealRange({ from: 2, to: 7 });
    expect(instance.getSelection()).toEqual({ from: 2, to: 7 });
    // §4: "null when collapsed".
    instance.revealRange({ from: 3, to: 3 });
    expect(instance.getSelection()).toBeNull();
  });

  it('captureAnchor takes its revision from the store that owns it, and null without one', async () => {
    // §9: "Revision source of truth: the bus/store, never the editor." So the
    // anchor's `capturedRevision` is read from an injected reader, and with no
    // store there is no honest number to put there.
    const withoutStore = await mount('hello world');
    withoutStore.revealRange({ from: 0, to: 5 });
    expect(withoutStore.captureAnchor()).toBeNull();

    const withStore = createMemoryEditorApi({ readRevision: () => 7 });
    const instance = await withStore.mount({} as HTMLElement, {
      docId: 'doc-1',
      initialBody: 'hello world',
    });
    instance.revealRange({ from: 0, to: 5 });
    expect(instance.captureAnchor()).toEqual({
      from: 0,
      to: 5,
      exact: 'hello',
      prefix: '',
      // The body projection is `hello world\n`, and the suffix is the next 32
      // characters *of that* — the trailing newline included. It is the honest
      // context: §6's ladder re-reads the same bytes, so an anchor whose suffix
      // stopped short of the projection's end would be quoting a different
      // string from the one verification will run against.
      suffix: ' world\n',
      capturedRevision: 7,
    });
  });

  it("wordCount is §9's rule: words split on whitespace, chars the body length", async () => {
    const instance = await mount('one two  three\n\nfour\n');
    const { words, chars } = instance.wordCount();
    expect(words).toBe(4);
    expect(chars).toBe(instance.getContent().length);
    // §9's rule is "words = **block text** split on whitespace", and the body
    // projection's block text carries the blockquote marker. Measured, and
    // pinned rather than quietly fixed: a count that excluded it is a different
    // rule, and §9 does not state one. The reading this slice implements is the
    // sentence as written.
    const quoted = await mount('> quoted\n');
    expect(quoted.wordCount().words).toBe(2);
  });

  it('onChange fires once per change, and onSelectionChange reports the collapse', async () => {
    let changes = 0;
    const selections: Array<unknown> = [];
    const api = createMemoryEditorApi();
    const instance = await api.mount({} as HTMLElement, {
      docId: 'doc-1',
      initialBody: 'hello world',
      onChange: () => (changes += 1),
      onSelectionChange: (sel) => selections.push(sel),
    });
    instance.revealRange({ from: 0, to: 5 });
    instance.insertAtSelection('!');
    expect(changes).toBe(1);
    expect(selections[0]).toEqual({ from: 0, to: 5 });
  });

  it('replaceRange reads its text as body Markdown, the way the Tiptap adapter does', async () => {
    // The fixture and the product share `insertionOf`, and this pins the result the shared
    // suite could not see: a literal `*` would save as `\*Howdy\*`, which is not what was asked.
    const instance = await mount('Hello.\n');
    instance.replaceRange({ from: 0, to: 5 }, '*Howdy*');
    expect(instance.getContent()).toBe('_Howdy_.\n');
  });

  it('an offset in a heading’s leading syntax replaces the heading’s text, and adds no block', async () => {
    // Before the fix, offset 0 mapped to `-1`, and the insert was refused by the view.
    const instance = await mount('# Title\n\nSome text.\n');
    expect(() => instance.replaceRange({ from: 0, to: 1 }, 'X')).not.toThrow();
    expect(instance.getContent()).toBe('# XTitle\n\nSome text.\n');
  });
});

// ---------------------------------------------------------------------------
// 7. Non-vacuity: the interface is checked in both directions
// ---------------------------------------------------------------------------

/**
 * Compile three variants of the **same** implementation text with the real
 * `tsc`, and return the diagnostics per variant.
 *
 * The variants are string mutations of `test/memory-api.ts` rather than three
 * hand-written fixtures, so the control cannot pass by being about a different
 * implementation than the one the round-trip test drives. Every mutation asserts
 * that its marker was found: a mutation that silently matched nothing would
 * produce a duplicate of the conforming file and a control that passes for the
 * wrong reason.
 *
 * ## Where the project lives, and why that is not a detail
 *
 * Inside the package's own `test/` directory, and it has to be. The variants
 * import the seam by a **relative** specifier, so the copy has to sit at a
 * known depth below the repo — and a temp directory under `%TEMP%` is on a
 * different drive from `D:`, where no relative path reaches. `tsconfig.json`'s
 * `exclude` keeps the deliberately-broken copies out of `pnpm typecheck`, so a
 * crashed test cannot leave a red typecheck behind.
 *
 * ## The guard that this instrument needed
 *
 * The first version of this file put the project in `%TEMP%`, reached the
 * package through `compilerOptions.paths` + `baseUrl`, and reported **zero
 * diagnostics for all three variants** — which read as two passing controls. The
 * compiler had in fact failed on `Option 'baseUrl' is deprecated` (TS 6.0,
 * TS5101) and never checked a file. A config error and a clean compile are
 * indistinguishable if you only count diagnostics, so the exit status and the
 * absence of any `tsconfig.json` diagnostic are both asserted below.
 */
function compileInterfaceVariants(): { diagnostics: Map<string, string[]>; status: number | null } {
  const fixture = readFileSync(join(__dirname, 'memory-api.ts'), 'utf8');
  // The copy sits one directory deeper than the fixture, so its imports reach the
  // same module by a different relative path. No `paths`, no `baseUrl`. **Both**
  // imports — the value one and the type one — and the count is asserted, because
  // a `String.replace` that matched only the first left the second pointing at a
  // `test/src/index.js` that does not exist, and the compiler said so with
  // TS2307 on all three variants.
  const SPECIFIER = "'../src/index.js'";
  const occurrences = fixture.split(SPECIFIER).length - 1;
  if (occurrences === 0) throw new Error('the fixture no longer imports ../src/index.js');
  const source = fixture.replaceAll(SPECIFIER, "'../../src/index.js'");

  const DROP = '    destroy: () => {\n      destroyed = true;\n    },\n';
  if (!source.includes(DROP)) throw new Error('narrowed variant: the destroy member moved');
  const narrowed = source.replace(DROP, '');

  const WIDEN = '): EditorApi => ({';
  if (!source.split('\n').some((line) => line.includes(WIDEN))) {
    throw new Error('widened variant: the EditorApi return annotation moved');
  }
  const widened = source
    .replace(WIDEN, '): EditorApiPlus => ({')
    .replace(
      'import type {',
      'interface EditorApiPlus extends EditorApi { zzzNotImplemented(): void }\n\nimport type {',
    );

  const dir = join(__dirname, '.tsc-control');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2023', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          moduleDetection: 'force',
          strict: true,
          noUncheckedIndexedAccess: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
        },
        files: ['conforms.ts', 'narrowed.ts', 'widened.ts'],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'conforms.ts'), source);
  writeFileSync(join(dir, 'narrowed.ts'), narrowed);
  writeFileSync(join(dir, 'widened.ts'), widened);

  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  let output: string;
  let status: number | null = 0;
  try {
    output = execFileSync(process.execPath, [tsc, '-p', dir], { cwd: dir, encoding: 'utf8' });
  } catch (error) {
    // A non-zero exit is the expected shape of two of the three variants; the
    // diagnostics *and* the status are the subject, so both are read.
    status = (error as { status?: number }).status ?? null;
    output = String((error as { stdout?: string }).stdout ?? '') + String((error as { stderr?: string }).stderr ?? '');
  }

  const diagnostics = new Map<string, string[]>([
    ['conforms.ts', []],
    ['narrowed.ts', []],
    ['widened.ts', []],
    ['tsconfig.json', []],
  ]);
  for (const line of output.split(/\r?\n/)) {
    const hit = /^([\w.]+\.ts(?:json)?)\(\d+,\d+\): (error TS\d+: .*)$/.exec(line.trim());
    if (hit) diagnostics.get(hit[1]!)?.push(hit[2]!);
  }
  return { diagnostics, status };
}

describe('the interface is checked in both directions — criterion (c)', () => {
  const { diagnostics, status } = compileInterfaceVariants();

  afterAll(() => {
    // The variants include two deliberately broken files. Leaving them in a tree
    // the next `pnpm typecheck` collects is the one way this guard could hurt the
    // change that follows, so they go in the same run that made them.
    rmSync(join(__dirname, '.tsc-control'), { recursive: true, force: true });
  });

  it('the compiler ran, and it did not fail on its own configuration', () => {
    // The guard the first version of this file lacked. `tsc -p` on a config it
    // rejects exits non-zero with **no** per-file diagnostics, which reads as a
    // clean compile and would have made the next three assertions vacuous.
    expect(diagnostics.get('tsconfig.json'), 'the harness config itself failed').toEqual([]);
    expect(status, 'tsc must have exited with its compile-error status').toBe(2);
  });

  it('the in-memory implementation compiles against the shipped interface', () => {
    // This is what makes the next two non-vacuous: three files that all failed
    // for an unrelated reason would satisfy "the narrowed one fails" too. The
    // compiler's own words go in the failure message, because a control that
    // cannot say what it saw is a control that has to be re-derived by hand.
    const errors = diagnostics.get('conforms.ts')!;
    expect(errors, `conforms.ts: ${errors.join(' | ')}`).toEqual([]);
  });

  it('a narrowed implementation fails to compile, naming the member it dropped', () => {
    const errors = diagnostics.get('narrowed.ts')!;
    expect(errors.length, `narrowed.ts: ${errors.join(' | ')}`).toBeGreaterThan(0);
    // The *named* member, not merely a non-zero exit: an unrelated error in the
    // file would otherwise satisfy this.
    expect(errors.join('\n')).toMatch(/destroy/);
  });

  it('a widened interface fails to compile, naming the member nobody implemented', () => {
    const errors = diagnostics.get('widened.ts')!;
    expect(errors.length, `widened.ts: ${errors.join(' | ')}`).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(/zzzNotImplemented/);
  });
});
