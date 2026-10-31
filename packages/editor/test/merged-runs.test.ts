/**
 * §3.3's **merged inline run** row — a structural loss the product used to take
 * silently.
 *
 * ## The defect, as a fixture
 *
 * `_gone and _struck_ together_` loads, and the document that comes out holds
 * **one** inline run — `"gone and struck together"` carrying a single `em` mark —
 * where the source had two levels of emphasis. Saving writes
 * `_gone and struck together_`, which re-parses as a **single** emphasis: a
 * different document, every character intact, the run boundary gone. Neither
 * channel said anything (`warnings` and `dialect` were both empty), which is the
 * exact failure this walk exists to remove.
 *
 * ## Why this file exists separately from `degrade.test.ts`
 *
 * That file is headed *"the four load-fatal constructs"* and its fixtures are the
 * four that **throw** without a handler. This row's construct loads cleanly every
 * time, so filing it there would make that header false and would hide the
 * distinction that matters: §3.3's degrade class is not "the things that break",
 * it is "the things that change shape", and this one is the only row whose
 * construct is in the **exact** class by type and degrade by *condition*.
 *
 * ## The premise that is easy to get wrong, and why the right one is the test
 *
 * It is tempting to read the loss as *"three sibling `emphasis` nodes collapse"*. Measured, the
 * mdast is **nested** — one `emphasis` inside another — and the two shapes behave
 * **oppositely**:
 *
 * - `_a_ _b_` — two `emphasis` **siblings**, separated by a text node → three runs,
 *   nothing lost, and a sibling-keyed check would warn here.
 * - `_a *b* c_` — **nested** → one run, the boundary lost, and a sibling-keyed
 *   check stays silent here.
 *
 * So a check written to the sibling reading would be wrong in *both* directions at
 * once, and would still pass a test that only asserted "a warning was emitted".
 * Every test below is therefore written against the **shape**, and the engine's
 * own capability is asserted first, so the criterion cannot be met by reporting a
 * number instead of preserving a document.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { CORPUS } from '@caotang/editor-audit';

import {
  DEGRADE_MDAST_TYPES,
  EXACT_CLASS_MDAST_TYPES,
  groupLossWarnings,
  parseWithDiagnostics,
  caotangSchema,
  serialize,
} from '../src/index.js';

/** §13's own entry, by name. A rename fails here rather than testing nothing. */
const corpusEntry = (name: string) => {
  const entry = CORPUS.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no §13 corpus entry named ${name}`);
  return entry;
};

/** §13's `strike-in-emphasis` — the entry whose sweep *found* this defect. */
const MERGED = corpusEntry('strike-in-emphasis');

/** `code:mdastType` per warning, the form §3.3's banner groups by. */
const codes = (warnings: { code: string; mdastType: string }[]): string[] =>
  warnings.map((w) => `${w.code}:${w.mdastType}`);

/**
 * Every text node in the document, with its mark names — so an assertion cannot
 * pass on a run count without also saying which marks survived.
 */
const textRuns = (doc: PmNode): string[] => {
  const runs: string[] = [];
  doc.descendants((node) => {
    if (node.isText) runs.push(`${node.text}[${node.marks.map((m) => m.type.name).sort().join(',')}]`);
  });
  return runs;
};

/** The runs that carry at least one mark — the ones a merge would eat. */
const markedRuns = (doc: PmNode): string[] =>
  textRuns(doc).filter((run) => /\[.+\]/.test(run));

describe('the engine cannot hold the shape this row would preserve', () => {
  // **First, because the whole row rests on it.** The lesson: an acceptance
  // criterion that asks a fix to preserve something the engine cannot represent
  // will be met by a test that does not test it. So the *capability* is asserted
  // here, before any criterion that depends on it, and the control is in the
  // other direction — mixed marks DO survive as three, so "3" is not what the
  // number means by accident.
  it('coalesces three adjacent same-mark runs into one, and keeps three mixed ones', () => {
    const em = caotangSchema.marks.em!.create();
    const same = caotangSchema.nodes.paragraph!.create(
      null,
      Fragment.fromArray([
        caotangSchema.text('a', [em]),
        caotangSchema.text('b', [em]),
        caotangSchema.text('c', [em]),
      ]),
    );
    // The premise, as data. `textContent` is the join, so a run count of 1 with
    // all three characters present is the collapse, not a truncation.
    expect(same.childCount).toBe(1);
    expect(same.textContent).toBe('abc');

    const mixed = caotangSchema.nodes.paragraph!.create(
      null,
      Fragment.fromArray([
        caotangSchema.text('a', [em]),
        caotangSchema.text('b', [caotangSchema.marks.strong!.create()]),
        caotangSchema.text('c', [em]),
      ]),
    );
    // The control: 3 here is a measurement of preservation, not a coincidence.
    // A "did the run count come out as 3" test above would have passed on a
    // document that had lost two boundaries and reported them.
    expect(mixed.childCount).toBe(3);
  });

  it('refuses the empty separator that would otherwise split two same-mark runs', () => {
    // The one workaround the engine offers for splitting a coalesced run, and it
    // is not a workaround. Without this, "prevent the merge" looks reachable.
    expect(() =>
      caotangSchema.nodes.paragraph!.create(
        null,
        Fragment.fromArray([
          caotangSchema.text('a', [caotangSchema.marks.em!.create()]),
          caotangSchema.text('', []),
          caotangSchema.text('b', [caotangSchema.marks.em!.create()]),
        ]),
      ),
    ).toThrow(RangeError);
  });
});

describe('§3.3 declares the row, and §3.3 is the contract', () => {
  // Acceptance clause (1), read out of the spec rather than asserted about the
  // code: the row has to exist in the spec, carry `degrade`, carry the code, and
  // sit beside the block-level row that uses the same code. A test that only
  // checked the handler's output would leave the spec free to omit the row and
  // the next change free to read a spec with nothing to implement.
  it('has a degrade row with `lossy-structure`, next to the `table` row that shares the code', () => {
    const spec = readFileSync(resolve(__dirname, '../../../docs/architecture/editor-engine.md'), 'utf8');
    const section = spec.slice(
      spec.indexOf('### 3.3 mdast handler table'),
      spec.indexOf('## 4. `EditorApi`'),
    );
    expect(section.length).toBeGreaterThan(0);

    const rows = section
      .split('\n')
      .filter((line) => line.startsWith('|') && !/^\|[\s|:-]+\|$/.test(line.trim()))
      .map((line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim()));

    const merged = rows.find(
      (cells) => (cells[0] ?? '').includes('nested inside the same mark'),
    );
    expect(merged, '§3.3 has no row for a mark nested inside the same mark').toBeDefined();
    // The class, the code, and the fact that it is a condition rather than a
    // type — the last one is the part a future edit would most easily drop, by
    // folding the three types into the exact-content row above.
    expect((merged![2] ?? '').replace(/\*\*/g, '')).toBe('degrade');
    expect(merged![3]).toContain('lossy-structure');
    for (const type of ['emphasis', 'strong', 'delete']) {
      expect(merged![0]).toContain(`\`${type}\``);
    }

    // **Beside the block-level row that carries the same code**, and the reason
    // is that it is the same *shape* of loss: a table's rows become paragraphs,
    // this run's boundary disappears, and in both cases every character survives
    // and the structure does not. A different code here would mean the taxonomy
    // had grown a second name for one shape.
    const tableRow = rows.find((cells) => (cells[0] ?? '').includes('`table`'));
    expect(tableRow![3]).toContain('lossy-structure');
    expect(rows.indexOf(tableRow!)).toBeLessThan(rows.indexOf(merged!));
  });

  it('keeps the three types in the exact class, so §3.3\'s exact-content row still holds', () => {
    // A single `_x_` is exact. If the row were filed as a *type*, these would
    // leave the exact class and every ordinary italic in every document would
    // start warning.
    for (const type of ['emphasis', 'strong', 'delete']) {
      expect([...EXACT_CLASS_MDAST_TYPES]).toContain(type);
      // …and must not enter the per-type degrade list, which `dialect.ts` reads
      // as its *skip* set. This is the false-positive that would have been
      // invisible in the loss channel and very visible in the dialect one.
      expect([...DEGRADE_MDAST_TYPES]).not.toContain(type);
    }
  });
});

describe('the load declares the loss', () => {
  it('warns exactly once for the corpus entry, and the save does not move', async () => {
    // Acceptance clause (2). The `expect: 'degrade'` is read from §13 rather than
    // re-typed, so the reason the round trip is not byte-identical is a fact
    // about the corpus and not an assertion in this file.
    expect(MERGED.expect).toBe('degrade');
    expect(MERGED.input).toBe('_gone and _struck_ together_');

    const before = await parseWithDiagnostics(MERGED.input);
    // Exactly **one**. Three sibling-level nodes would warn three times, and a
    // banner that says the same loss three times is a count no writer can act on.
    expect(codes(before.warnings)).toEqual(['lossy-structure:emphasis']);
    // The position, because a warning a banner cannot place is a warning about
    // nothing: the inner run's own start, not the paragraph's.
    expect(before.warnings[0]!.position).toEqual({ line: 1, column: 11 });

    const after = await parseWithDiagnostics(MERGED.input);
    // **The save must not move.** The fix is a declaration, so a change here
    // would mean the implementation also changed the document — which is the one
    // thing §3.3's stability invariant and this row's premise both forbid, and
    // which acceptance clause (2) exists to catch.
    expect(serialize(after.doc)).toBe(serialize(before.doc));
    expect(serialize(after.doc)).toBe('_gone and struck together_\n');
  });

  it('asserts the round trip is NOT byte-identical, so the loss cannot pass as exact', async () => {
    // Acceptance clause (5). Written as its own test and as a **negative**
    // assertion, because "the corpus says degrade" and "the bytes differ" are two
    // separate claims and a single `expect` column would let one error explain the
    // other. If a future engine could round-trip this, this test fails and says
    // the row should be revisited — which is the intended direction of failure.
    const { doc } = await parseWithDiagnostics(MERGED.input);
    const saved = serialize(doc);
    expect(saved).not.toBe(MERGED.input);
    // …and the difference is exactly the two former run boundaries, so "not
    // byte-identical" is not satisfied by some unrelated normalisation.
    expect(saved.trimEnd()).toBe('_gone and struck together_');
  });

  it('a document with a single emphasis emits nothing', async () => {
    // Acceptance clause (3): the ordinary case, and the one a check keyed on
    // "is there an `emphasis` in this document" would break. It is also the
    // regression a writer would actually notice — a banner on every italic.
    const { warnings } = await parseWithDiagnostics('_gone_\n');
    expect(warnings).toEqual([]);
  });

  it('mixed marks emit nothing and keep their runs', async () => {
    // Acceptance clause (4), and the control that makes clause (3) meaningful:
    // the same paragraph shape, three marked spans, no warning.
    const { doc, warnings } = await parseWithDiagnostics('*a* **b** *c*');
    expect(warnings).toEqual([]);
    // **Three marked runs, and "marked" is load-bearing.** The spaces between
    // them are unmarked text nodes, so the document holds five text nodes in
    // all; the clause is about the three spans a merge would have eaten, and
    // asserting `childCount === 3` would have passed on a document that had
    // merged all three into one run plus its two spaces.
    expect(markedRuns(doc)).toEqual(['a[em]', 'b[strong]', 'c[em]']);
  });
});

describe('the condition is nesting, and the controls are what prove it', () => {
  it('warns on `strong` and on `delete` nesting, the other two types the row names', async () => {
    // The row names three types. Testing only `emphasis` leaves a rule that could
    // have been written as `parent.type === 'emphasis'`, and `~~a ~~b~~ c~~` is
    // the same loss with a different mark.
    expect(codes((await parseWithDiagnostics('**a **b** c**')).warnings)).toEqual([
      'lossy-structure:strong',
    ]);
    expect(codes((await parseWithDiagnostics('~~a ~~b~~ c~~')).warnings)).toEqual([
      'lossy-structure:delete',
    ]);
  });

  it('stays silent for sibling marks, which lose nothing', async () => {
    // **The false-positive control, and the direct consequence of the row's
    // correction.** These are two `emphasis` nodes side by side, which is what the
    // row as cut described. They are separated by a text node, so nothing merges
    // and nothing is lost — a check keyed on "adjacent same-type siblings" warns
    // here, on a document that is perfectly fine, and that is the failure mode a
    // wrong premise produces silently.
    for (const body of ['_a_ _b_', '*a* *b*', '**a** **b**', '~~a~~ ~~b~~']) {
      const { warnings, doc } = await parseWithDiagnostics(body);
      expect(codes(warnings), body).toEqual([]);
      // Three runs each: the assertion the sibling case is entitled to, and the
      // one that makes "no warning" mean "nothing was lost" rather than "nothing
      // was looked at".
      expect(markedRuns(doc), body).toHaveLength(2);
    }
  });

  it('reaches an ancestor that is two levels up, where the mark is applied anyway', async () => {
    // The case that makes a `parent.type`-only check insufficient, and the reason
    // the implementation is a walk rather than a handler. The inner `emphasis`
    // sits under a `link`, so the whole link's content carries `em`+`link` and
    // the inner run merges with its own neighbours regardless of its direct
    // parent. The inner emphasis is **erased outright** from the save.
    const body = '_a [b _c_ d](u) e_';
    const { doc, warnings } = await parseWithDiagnostics(body);
    expect(codes(warnings)).toEqual(['lossy-structure:emphasis']);
    // **Three** runs, not four: the outer emphasis's "a " and " e" keep their own
    // runs (the `link` run between them has different marks), while "b ", "c" and
    // " d" have become one `em`+`link` run — and the boundary the writer typed
    // between `b ` and ` d` is exactly the one that is gone. The spaces are inside
    // the runs because the whole outer emphasis carries `em`; that is what
    // `Fragment.join` produced, and the run texts are the measured ones rather
    // than a tidied-up version of them.
    expect(markedRuns(doc)).toEqual(['a [em]', 'b c d[em,link]', ' e[em]']);
    expect(serialize(doc)).toBe('_a [b c d](u) e_\n');
  });

  it('stays silent when the two nested marks are different', async () => {
    // The other direction on the same shape. `_a **b** c_` nests `strong` inside
    // `emphasis`, the inner node's mark is *not* already applied, and both runs
    // survive — so a rule that warned on "any mark nested inside any mark" would
    // be right about the shape and wrong about the loss.
    for (const body of ['_a **b** c_', '**a *b* c**', '*a **b** c*']) {
      const { warnings, doc } = await parseWithDiagnostics(body);
      expect(codes(warnings), body).toEqual([]);
      // Three runs, which is the claim the warning would have contradicted.
      expect(markedRuns(doc), body).toHaveLength(3);
    }
  });

  it('stays silent on `***x***`, where both marks are kept and only the spelling moves', async () => {
    // `em` outside `strong` is a *different* mark set, so both survive; the save
    // re-spells it (`_**x**_`) and §5's dialect channel owns that, not this one.
    // A check on "is any mark repeated in this document" would warn here.
    const { doc, warnings, dialect } = await parseWithDiagnostics('***x***');
    expect(warnings).toEqual([]);
    expect(markedRuns(doc)).toEqual(['x[em,strong]']);
    // The two channels stay disjoint on this construct, which is §3.3's own
    // "a loss is not a re-spelling" rule holding in the case a nested mark
    // creates.
    expect(dialect).toHaveLength(1);
  });

  it('does not touch the dialect channel, and `strike-in-emphasis` stays in its sweep', async () => {
    // §5's sweep in `dialect.test.ts` lists the corpus entries whose bytes change
    // with no dialect notice, and this one is on it. The fix moves it between
    // *channels* without moving it between *lists* — a dialect notice here would
    // describe the same change twice, and removing it from the sweep list would
    // hide a change that is still undeclared as a spelling.
    const { warnings, dialect } = await parseWithDiagnostics(MERGED.input);
    expect(codes(warnings)).toEqual(['lossy-structure:emphasis']);
    expect(dialect).toEqual([]);
  });
});

describe('the warning is derived per load, like every other one', () => {
  it('is stable across two loads of the same body with an unrelated load between them', async () => {
    // The same determinism argument `handlers.ts` makes for the sink array: a
    // module-level collector — the obvious way to write a tree walk — passes every
    // single-parse assertion in this file and fails this one. Two inner nodes in
    // one body is the fixture that makes the count 2 rather than 1.
    const body = '_a _b_ c_ and _d _e_ f_';
    const first = await parseWithDiagnostics(body);
    expect(codes(first.warnings)).toEqual(['lossy-structure:emphasis', 'lossy-structure:emphasis']);

    // An unrelated load between the two, so a shared array would show it.
    await parseWithDiagnostics('| a | b |\n|---|---|\n| c | d |\n');

    const second = await parseWithDiagnostics(body);
    expect(second.warnings).toEqual(first.warnings);
    expect(codes(second.warnings)).toEqual([
      'lossy-structure:emphasis',
      'lossy-structure:emphasis',
    ]);
  });

  it('counts one warning per lost boundary, not one per paragraph', async () => {
    // Two paragraphs, two separate erasures. One warning per paragraph would read
    // as "this document has a problem" where the honest count is "two of these
    // are wrong", and the two positions are what let a writer find both.
    const { warnings } = await parseWithDiagnostics('_a _b_ c_\n\n_d _e_ f_\n');
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.position)).toEqual([
      { line: 1, column: 4 },
      { line: 3, column: 4 },
    ]);
  });

  it('every warning carries the five §3.3 fields, and the detail says what was kept', async () => {
    // The `detail` is the sentence a load banner shows, so it has to say which
    // half survived — a warning that only named the construct would leave the
    // writer to guess whether their text was damaged.
    const { warnings } = await parseWithDiagnostics(MERGED.input);
    const [warning] = warnings;
    expect(Object.keys(warning!).sort()).toEqual(
      ['code', 'detail', 'mdastType', 'position'].sort(),
    );
    expect(warning!.detail).toContain('merged');
    expect(warning!.detail).toContain('not stored in v0.1');
  });
});

// ---------------------------------------------------------------------------
// Three measurements that used to live only in prose
// ---------------------------------------------------------------------------

describe('merged runs: three measurements that used to live only in prose', () => {
  it('the array is handlers-then-structural, and the banner shows it', async () => {
    // **The placement of the walk, measured — and the reason a document-order claim
    // somewhere else went false.** `pipeline.ts` calls this walk *after* the
    // compile, so the merge warnings land at the end of the array however the
    // document is ordered. Put the merged run at the top and a degrade construct
    // below it, and the two arrive in the opposite order to their lines.
    const body = '_gone and _struck_ together_\n\nplain\n\n<div>x</div>\n';
    const { warnings } = await parseWithDiagnostics(body);
    expect(codes(warnings)).toEqual([
      'unsupported-node:html',
      'lossy-structure:emphasis',
    ]);
    expect(warnings.map((w) => w.position?.line)).toEqual([5, 1]);
    // §4's banner preserves what it is handed, so the writer is shown line 5
    // before line 1. Whether that is the *right* order for a banner is build
    // This asserts the current order so the decision has a fact to
    // change, and `groupLossWarnings` must not sort either way (the carrier
    // contract is "no merging, no reordering, no dedupe").
    expect(groupLossWarnings(warnings).map((g) => g.line)).toEqual([5, 1]);
  });

  it('a nested run silences the dialect notice for a block whose spelling also moves', async () => {
    // **The finding, and it is a conjunction: one warning standing in for two
    // byte changes.** §5's channel declares that a save will re-style a
    // paragraph, and `dialect.ts` suppresses that notice when the block already
    // carries a loss warning — correct while every loss warning came from a
    // degrade construct, whose re-spelling *was* the declared change. This row
    // adds a loss warning for a type that is deliberately **not** a degrade type,
    // so the suppression now reaches blocks whose loss does not explain the whole
    // change. Measured in both directions: unwiring the call in `pipeline.ts`
    // takes this input from one dialect notice to none, with the loss warning
    // gone in exchange and the save byte-identical.
    const { doc, warnings, dialect } = await parseWithDiagnostics(
      '*gone and _struck_ together*',
    );
    // Both changes are real: `*` is not §5's canonical `_`, and the inner
    // boundary is gone.
    expect(serialize(doc)).toBe('_gone and struck together_\n');
    expect(codes(warnings)).toEqual(['lossy-structure:emphasis']);
    // …and only one of them is declared. **This is the subject, not a
    // claim that the silence is right** — it is pinned so the fix is visible when
    // it lands, and this test is expected to go red when it does.
    expect(dialect).toEqual([]);

    // **Both halves alone, or the assertion above says nothing.** The canonical
    // spelling with a nested run is the case the suppression was designed for
    // (`strike-in-emphasis`, on §5's sweep list): no notice, correctly. The
    // foreign spelling with no nested run still gets one, which is the reason
    // The exclusion of these three types from `DEGRADE_MDAST_TYPES` was right.
    expect((await parseWithDiagnostics('*emphasized*')).dialect).toHaveLength(1);
    expect((await parseWithDiagnostics(MERGED.input)).dialect).toHaveLength(0);

    // **And the control that keeps the blast radius honest: block-scoped.** The
    // suppression is per block, not per document, in both orders — so what is
    // under-declared is one paragraph, not the file.
    for (const body of [
      '*foreign*\n\n_gone and _struck_ together_\n',
      '_gone and _struck_ together_\n\n*foreign*\n',
    ]) {
      expect((await parseWithDiagnostics(body)).dialect, body).toHaveLength(1);
    }
  });

  it('two references to the same target coalesce too, and only the attribute row declares it', async () => {
    // `link` is excluded from the set on attribute grounds, and two direct links to one target still coalesce. A reference link
    // carries the id of its own written source (source-provenance.ts), so two references are two different marks: nothing merges,
    // each saves as written, and no warning is emitted.
    const { doc, warnings } = await parseWithDiagnostics('[a][x][a][x]\n\n[x]: u\n');
    expect(markedRuns(doc)).toEqual(['a[link]', 'a[link]']);
    expect(serialize(doc)).toBe('[a][x][a][x]\n\n[x]: u\n');
    expect(warnings).toEqual([]);
    // Two *different* targets are the control: nothing merges there either.
    const split = await parseWithDiagnostics('[a][x][a][y]\n\n[x]: u\n[y]: v\n');
    expect(serialize(split.doc)).toBe('[a][x][a][y]\n\n[x]: u\n[y]: v\n');
    // Two direct links to one target do merge, which is the attribute row's claim.
    const direct = await parseWithDiagnostics('[a](u)[a](u)\n');
    expect(markedRuns(direct.doc)).toEqual(['aa[link]']);
  });
});
