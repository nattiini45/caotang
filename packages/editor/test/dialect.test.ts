/**
 * §5's **dialect contract**: the `DialectNotice[]` a load produces for the
 * blocks a save will re-spell, and the boundary it draws around what is a loss.
 *
 * ## Why this is a separate file from `degrade.test.ts`
 *
 * The two are adjacent and easy to confuse, and the confusion is the whole
 * failure mode. A `LossWarning` says *you lost something*. A `DialectNotice` says
 * *nothing was lost, but the spelling is not ours and a save will rewrite it*. §5
 * gives the second its own banner sentence — *"saving will re-style N
 * paragraphs"* — and the 08:0x decision settled that a decoded `&amp;` is
 * **not** a loss for exactly this reason. One array for both would make the
 * banner either cry wolf on every document or hide a real loss among
 * normalizations, and neither failure is recoverable once a writer learns to
 * ignore it.
 *
 * ## The construct that forced the question
 *
 * The §13 corpus entry is `entity`, input `&amp; stays literal`, and §3.3's
 * taxonomy has **no row for it** — which is correct, and is the finding. An HTML
 * entity is not an mdast node at all: remark-parse decodes it while parsing, so
 * `&amp;` becomes the literal text `&` before any handler runs. There is
 * therefore nothing for §3.3's *"anything unknown"* catch-all to catch and no
 * handler that could warn about it. It is a pure spelling change, and the only
 * place it can be observed is the source side — which is what §5's own mechanism
 * says: *"count computed by parse-side dialect sniffing"*.
 *
 * ## What each test below would have caught
 *
 * - **The entity fixture** pins the count, the two spellings, and — the part that
 *   is the actual claim — that `warnings` is **empty**. A channel that reported
 *   the entity in both places would pass on the count and lie in the banner.
 * - **The loss controls** run genuine losses through the same two channels and
 *   assert the arithmetic: each is counted as a loss and *not* as a dialect
 *   notice. Without them, "the channels are disjoint" and "the dialect channel
 *   happens to be empty" are the same statement.
 * - **The corpus sweep** is the false-positive guard, and it is the reason the
 *   rule is a comparison rather than a list of foreign constructs. It is also the
 *   test that *found* the two defects this file now pins: a dialect channel built
 *   on a different stringify chain than the save, and a boundary nobody had
 *   written down.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { fromProseMirror } from '@handlewithcare/remark-prosemirror';
import type { Root as MdastRoot } from 'mdast';
import { CORPUS } from '@caotang/editor-audit';
import remarkParse from 'remark-parse';

import {
  CANONICAL_STRINGIFY_OPTIONS,
  DEGRADE_MDAST_TYPES,
  EXACT_CLASS_MDAST_TYPES,
  SAVE_STRINGIFY_OPTIONS,
  createSerializeHandlers,
  parse,
  parseWithDiagnostics,
  caotangSchema,
  serialize,
} from '../src/index.js';
// The two span derivations and the recorded chain's options, read from the
// module rather than the package entry point on purpose: they are internal, the
// guards below are the only readers, and none of them belongs in the contract
// `index.ts` documents.
import { toSaveTree } from '../src/save-tree.js';
import {
  RECORDED_STRINGIFY_OPTIONS,
  ownTextsByPrefix,
  ownTextsRecorded,
  parseSideOwnTexts,
  renderSaveRecorded,
  saveSideOwnTexts,
} from '../src/dialect.js';
import { compiledBlockSpan } from '../src/handlers.js';
import type * as EditorHandlers from '../src/handlers.js';
import type { OwnTexts, Rendered } from '../src/dialect.js';
import type { DialectNotice, LossWarning } from '../src/index.js';

const corpusInput = (name: string): string => {
  const entry = CORPUS.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no §13 corpus entry named ${name}`);
  return entry.input;
};

const ENTITY = corpusInput('entity');
const TABLE = corpusInput('table-gfm');
const IMAGE_REF = corpusInput('image-reference');
const LINK_REF = corpusInput('link-reference');
const TASK_ITEM = corpusInput('list-task-item');

/** `code:mdastType` per warning, the form a banner groups by. */
const codes = (warnings: LossWarning[]): string[] =>
  warnings.map((w) => `${w.code}:${w.mdastType}`);

const spellings = (notices: DialectNotice[]): Array<[string, string]> =>
  notices.map((n) => [n.source, n.canonical]);

/** The bytes a save writes, without the separator every saved file ends with. */
const saved = async (body: string): Promise<string> =>
  serialize(await parse(body)).replace(/\n+$/, '');

// ---------------------------------------------------------------------------
// The banner's cost. Everything below is about *where the per-block
// canonical text comes from*, and nothing else in `sniffDialect`.
// ---------------------------------------------------------------------------

/**
 * A long, ordinary manuscript: headings, lists, a blockquote, a rule and prose,
 * in a repeating mix, written **in Caotang's own dialect** so a correct sniffer
 * reports nothing for any of it.
 *
 * The size is this file's own, not a remembered figure. A cost measured on a
 * "synthetic 400-block" document whose construction is not written down is a
 * story rather than a measurement; this is a document anyone can rebuild exactly, and the generator is the three
 * lines below rather than a paragraph about them.
 */
const longManuscript = (blocks: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < blocks; i++) {
    switch (i % 8) {
      case 0:
        parts.push(`## Chapter ${i / 8 + 1}`);
        break;
      case 1:
        parts.push(`- item one for chapter ${i}\n- item two for chapter ${i}`);
        break;
      case 2:
        parts.push('***');
        break;
      case 3:
        parts.push(`> A quoted line number ${i} in the manuscript.`);
        break;
      case 4:
        parts.push('1. first\n2. second');
        break;
      default:
        parts.push(
          `A paragraph of ordinary prose, number ${i}, written the way a writer writes it.`,
        );
    }
    parts.push('');
  }
  return parts.join('\n');
};

/**
 * The same document in a **foreign** dialect: `*` bullets where Caotang writes `-`,
 * and setext headings where it writes ATX. Every list and every setext heading
 * re-spells on save, so `sniffDialect` has notices to attribute — which is the
 * only thing that makes the parse-side rendering exist at all.
 */
const longForeignManuscript = (blocks: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < blocks; i++) {
    if (i % 4 === 0) parts.push(`* item one for chapter ${i}\n* item two for chapter ${i}`);
    else if (i % 4 === 1) parts.push(`Chapter ${i}\n=========\n`);
    else if (i % 4 === 2) parts.push(`+ a plus-marked item ${i}`);
    else parts.push(`Ordinary prose for block ${i}, written the way a writer writes it.`);
    parts.push('');
  }
  return parts.join('\n');
};

/**
 * The two derivations, run over a real load.
 *
 * **The recorded half calls the same two exported functions `sniffDialect` calls**
 * — `saveSideOwnTexts` and `parseSideOwnTexts` — rather than a chain this file
 * builds. That is deliberate, and it was learned the hard way inside this slice: a
 * harness with its own `unified()` chain has no `join` hook on it, so it exercises
 * a path that cannot exist in production, and a harness that re-derives the wiring
 * is not testing the wiring at all. Only the **prefix** half is built here, because
 * that one is the oracle — an oracle that calls the code under test is not an
 * oracle, and this file's whole claim is that the two agree.
 */
const bothDerivations = async (
  body: string,
): Promise<{
  count: number;
  save: { recorded: OwnTexts; byPrefix: OwnTexts };
  parse: { recorded: OwnTexts; byPrefix: OwnTexts };
}> => {
  const doc = await parse(body);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as MdastRoot;
  const blocks = tree.children;
  // The offset at which each top-level block ends in the ProseMirror document —
  // the same computation `dialect.ts` does, written out again rather than
  // imported, because it is four lines and importing it would make this harness
  // unable to catch an error in it.
  const ends: number[] = [];
  let pmOffset = 0;
  doc.forEach((node) => {
    pmOffset += node.nodeSize;
    ends.push(pmOffset);
  });
  const count = Math.min(blocks.length, ends.length);
  const chain = unified()
    .use(remarkGfm)
    .use(remarkStringify, SAVE_STRINGIFY_OPTIONS)
    .freeze();
  // The save tree a prefix is rendered with is the shared one, so a reference link's own spelling is what each side compares.
  const savePrefix = (n: number): Rendered => {
    const t = toSaveTree(caotangSchema.topNodeType.create(doc.attrs, doc.content.cut(0, ends[n - 1]!)) as never, {
      definitions: false,
    }) as MdastRoot;
    return { text: String(chain.stringify(t as never)), children: t.children };
  };
  const parsePrefix = (n: number): Rendered => ({
    text:
      n === 0
        ? ''
        : String(chain.stringify({ type: 'root', children: blocks.slice(0, n) } as never)),
    children: blocks.slice(0, n),
  });
  return {
    count,
    save: {
      recorded: saveSideOwnTexts(doc, ends, count),
      byPrefix: ownTextsByPrefix(count, savePrefix),
    },
    parse: {
      recorded: parseSideOwnTexts(count, blocks),
      byPrefix: ownTextsByPrefix(count, parsePrefix),
    },
  };
};

describe('§5 dialect contract — the entity is a notice, not a loss', () => {
  it('is counted as a dialect notice, with both spellings, and is not a loss', async () => {
    const { dialect, warnings } = await parseWithDiagnostics(ENTITY);
    // The count, because §5's banner is a count and a count is the thing a
    // reader acts on. One: the fixture is one paragraph.
    expect(dialect).toHaveLength(1);
    // The two spellings, because "it differs" is not a claim anyone can check —
    // `&amp;` → `&` is, and it is the difference between "re-spelled" and
    // "decoded" stated as data rather than as prose.
    expect(spellings(dialect)).toEqual([['&amp; stays literal', '& stays literal']]);
    expect(dialect[0]!.mdastType).toBe('paragraph');
    expect(dialect[0]!.position).toEqual({ line: 1, column: 1 });
    // **The claim this whole slice exists to make.** Empty, not "no
    // `lossy-attribute`" — *no warnings at all*, because nothing was lost. The
    // `&` is still in the document; only its spelling changed.
    expect(warnings).toEqual([]);
    // And the document really does keep the character, which is what makes the
    // empty-warnings claim true rather than merely asserted.
    const doc = await parse(ENTITY);
    expect(doc.textBetween(0, doc.content.size)).toBe('& stays literal');
  });

  it('counts a block once however many things inside it are re-spelled', async () => {
    // The count is only usable if it means blocks. §5 says "N paragraphs", and a
    // rule that walked down to the text node would report 3 for this one list —
    // one for the `*em*` emphasis, one for the entity, and one for whatever else
    // the per-node rule tripped over. Three is a number no reader can act on.
    const { dialect } = await parseWithDiagnostics('- a *b* &amp; c\n');
    expect(dialect).toHaveLength(1);
    expect(spellings(dialect)).toEqual([['- a *b* &amp; c', '- a _b_ & c']]);
  });

  it('counts a canonical sibling block as canonical, even next to a foreign one', async () => {
    // The complement, and the one that keeps the count meaningful: a re-spelled
    // paragraph and a list that saves byte-identically, in one document.
    // Reporting 2 would over-count, and the writer would be told to check a block
    // that needs no attention.
    const { dialect } = await parseWithDiagnostics('*em* &amp; c\n\n- d\n');
    expect(spellings(dialect)).toEqual([['*em* &amp; c', '_em_ & c']]);
  });

  it('a document already in Caotang\'s dialect reports nothing', async () => {
    // The false-positive guard, in the form that matters: the rule is a
    // comparison, so a rule that compared the wrong two things — or trimmed the
    // wrong side — would report every canonical document as foreign, and the
    // banner would be up on every load.
    const { dialect } = await parseWithDiagnostics(
      '& plain\n\n- item\n\n# Title\n\n_em_ and **strong**\n',
    );
    expect(dialect).toEqual([]);
  });
});

describe('the dialect channel and the loss channel do not overlap', () => {
  it('a genuine `lossy-attribute` is a loss and not a dialect notice', async () => {
    // The control the entity fixture alone cannot supply: with only the entity in
    // the suite, "the channels are disjoint" and "the dialect channel is always
    // empty" are the same statement. This makes the second one false.
    // A reference whose label carries a mark cannot keep its spelling, so it expands and says so (source-provenance.ts). Its
    // definition is kept, so only the reference is reported.
    const { dialect, warnings } = await parseWithDiagnostics('see [*em*][d]\n\n[d]: https://e.com\n');
    expect(codes(warnings)).toEqual(['lossy-attribute:linkReference']);
    // Empty, and for a specific reason rather than by luck: the block's bytes change because the reference was expanded, and that
    // is already reported.
    expect(dialect).toEqual([]);
  });

  it('a reference that keeps its spelling is neither a loss nor a re-spelling', async () => {
    for (const body of [IMAGE_REF, LINK_REF]) {
      const { dialect, warnings } = await parseWithDiagnostics(body);
      expect(warnings, body).toEqual([]);
      expect(dialect, body).toEqual([]);
    }
  });

  it('a task item\'s dropped checkbox is a loss, not a re-spelling', async () => {
    // The construct the 08:0x decision settled, read from the other side. The
    // block *is* re-spelled (`- [x] done` → `- done`), so a sniffer that only
    // compared spellings would count it as a dialect notice and tell a writer
    // their checklist will be restyled, which is true and useless — the thing
    // they need to know is that the ticks are gone.
    const { dialect, warnings } = await parseWithDiagnostics(TASK_ITEM);
    expect(codes(warnings)).toEqual(['lossy-attribute:listItem', 'lossy-attribute:listItem']);
    expect(dialect).toEqual([]);
  });

  it('a degrade and a foreign spelling in one document are each counted once, in their own channel', async () => {
    // The case that makes the split real rather than theoretical: one document
    // that needs both banners, with counts that must not be confused. A table
    // (loss) and a setext heading (spelling) in one body, in that order, so the
    // positions are as distinguishable as the channels.
    const { dialect, warnings } = await parseWithDiagnostics(
      ['Setext', '=====', '', '| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
    );
    expect(codes(warnings)).toEqual(['lossy-structure:table']);
    expect(spellings(dialect)).toEqual([['Setext\n=====', '# Setext']]);
  });

  it('a table is not re-spelled, even though its bytes change', async () => {
    // The half of the disjointness that is easy to miss, because the table *is*
    // a spelling change too. Counting it in both channels would report the same
    // flattening once as "you lost the table" and once as "this will be
    // re-spelled", and a reader would have no way to tell which one to act on.
    expect((await parseWithDiagnostics(TABLE)).dialect).toEqual([]);
  });
});

/**
 * The two sides of §5's comparison are two different lists, and the pairing
 * between them is the whole of the rule.
 *
 * `blocks` are the *parse tree*'s top-level blocks; `boundaries` are the
 * *compiled document*'s. A degrade can turn one parse block into several
 * compiled blocks — §3.3's table becomes a paragraph per row — or into none at
 * all, and a pairing by **index** then compares every later block with the
 * wrong bytes.
 *
 * **The failure this describe exists for is not loud.** The notice it produced
 * was about a block that had not changed, carrying a canonical form that
 * belonged to a different block entirely. The §13 corpus could not see it,
 * because every corpus entry is a single construct: the table is alone in its
 * document, so there is no *later* block to misalign. The defect needs a
 * second block.
 */
describe('§5 dialect contract — the parse blocks and the compiled blocks are paired', () => {
  it('does not report a canonical paragraph that follows a table', async () => {
    // The false positive. A table compiles into a paragraph per row, so the
    // compiled document has **three** blocks where the parse tree has **two**,
    // and the paragraph after the table is the compiled document's *third*
    // block. A pairing by index compares it with the second — the table's
    // second row — and reports a re-spelling of a paragraph that saves
    // byte-for-byte.
    const { dialect } = await parseWithDiagnostics(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', 'Plain canonical paragraph.'].join('\n'),
    );
    expect(dialect).toEqual([]);
  });

  it('reports a foreign paragraph after a table with its own canonical form', async () => {
    // The other direction, and the half that says the pairing is right rather
    // than merely quiet: the paragraph *does* re-spell, so it must be
    // reported — and the canonical form in the notice has to be **this**
    // paragraph's canonical form. A pairing by index reports it too, with the
    // table's second row as its canonical form, which is a claim about a block
    // the writer never wrote.
    const { dialect } = await parseWithDiagnostics(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '&amp; stays literal'].join('\n'),
    );
    expect(spellings(dialect)).toEqual([['&amp; stays literal', '& stays literal']]);
  });

  it('reports a foreign paragraph that follows a link definition', async () => {
    // The other way the two lists come to differ, and the one that loses a
    // notice rather than inventing one. A `definition` compiles to **no**
    // block at all — it is the URL a reference resolves against, and the
    // reference is what the document keeps — so the compiled document has one
    // block fewer than the parse tree. A pairing by index stops at the
    // shorter list and never reaches the paragraph, so the re-spelling is
    // never reported at all.
    const { dialect } = await parseWithDiagnostics(
      ['[ref]: http://example.com', '', '&amp; stays literal'].join('\n'),
    );
    expect(spellings(dialect)).toEqual([['&amp; stays literal', '& stays literal']]);
  });

  it('the span rule accounts for every compiled block of every corpus document', async () => {
    // **The guard on the rule itself.** The pairing advances by the number of
    // blocks each parse block produced, and that number comes from the
    // handler table. If it is wrong for any construct, the two totals stop
    // adding up and the sniffer refuses the document — which is safe, but a
    // refusal nobody sees is a channel that has stopped working. So the rule
    // is measured against the compiled document, over the whole corpus.
    const mismatched: string[] = [];
    for (const entry of CORPUS) {
      const tree = unified().use(remarkParse).use(remarkGfm).parse(entry.input) as MdastRoot;
      // The two bodies the loader answers before it compiles anything: an empty
      // body, and a body that holds nothing but link definitions. Both are
      // filled with an empty paragraph, so neither has a compiled block to
      // account for.
      if (tree.children.length === 0) continue;
      if (tree.children.every((child) => child.type === 'definition')) continue;
      const doc = await parse(entry.input);
      const spans = tree.children.reduce((total, child) => total + compiledBlockSpan(child), 0);
      if (spans !== doc.childCount) {
        mismatched.push(`${entry.name}: rule says ${spans}, document has ${doc.childCount}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('every block that compiles to zero blocks is a block the comparison skips', () => {
    // The pairing's per-block invariant, pinned over the corpus. A zero span is
    // only safe for a type the comparison skips as a degrade — a zero-span
    // block of any other type would leave the compiled index standing still
    // while the walk moved on, and every later block would be compared with a
    // neighbour's bytes. Today both zero-span types (`definition` and
    // `footnoteDefinition`) are in the skip set, and the sniffer enforces the
    // rule per block rather than resting on that coincidence.
    const offenders: string[] = [];
    for (const entry of CORPUS) {
      const tree = unified().use(remarkParse).use(remarkGfm).parse(entry.input) as MdastRoot;
      for (const child of tree.children) {
        if (
          compiledBlockSpan(child) === 0 &&
          !(DEGRADE_MDAST_TYPES as readonly string[]).includes(child.type)
        ) {
          offenders.push(`${entry.name}: ${child.type}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('refuses a document whose per-block spans mispair, even when the totals add up — and says so', async () => {
    // Two offsetting span errors: the heading over-claims and the paragraph
    // under-claims, so `spanTotal === boundaries.length` still holds while the
    // pairing is exactly the misalignment the walk exists to prevent — the
    // heading would be compared with the paragraph's canonical text and the
    // paragraph would emit an empty canonical form. The aggregate check cannot
    // see this; the per-block rule can, because a paragraph that compiles to
    // zero blocks is not a type the comparison skips. And the refusal is
    // **warned**: a refusal nobody sees is a channel that has stopped working.
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.resetModules();
      vi.doMock('../src/handlers.js', async (importOriginal) => {
        const actual = await importOriginal<typeof EditorHandlers>();
        const mispaired = (node: { type: string }): number => {
          if (node.type === 'paragraph') return 0;
          if (node.type === 'heading') return 2;
          return actual.compiledBlockSpan(node as never);
        };
        return { ...actual, compiledBlockSpan: mispaired };
      });
      const { sniffDialect } = await import('../src/dialect.js');
      const body = ['# T', '', '&amp; stays literal', ''].join('\n');
      const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as MdastRoot;
      const doc = await parse(body);
      expect(sniffDialect(body, tree, doc, [])).toEqual([]);
      expect(warned, 'the refusal is silent').toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/handlers.js');
      vi.resetModules();
      warned.mockRestore();
    }
  });

  it('refuses a document whose span total does not add up, and names the disagreement rather than a zero', async () => {
    // **The other half of the same refusal**, and the one the fixture above
    // cannot reach: that one forces the zero-span half with the totals equal,
    // so the aggregate message — the branch a handler table that over-claims a
    // block takes — was never asserted by anything.
    //
    // The fixture mocks **one** block's span and leaves no zero anywhere: the
    // paragraph claims two compiled blocks and the document has one, so the
    // totals disagree and the per-block half has nothing to say. The refusal
    // has to name the disagreement it found, and must not blame a zero that is
    // not there.
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.resetModules();
      vi.doMock('../src/handlers.js', async (importOriginal) => {
        const actual = await importOriginal<typeof EditorHandlers>();
        const overclaimed = (node: { type: string }): number => {
          if (node.type === 'paragraph') return 2;
          return actual.compiledBlockSpan(node as never);
        };
        return { ...actual, compiledBlockSpan: overclaimed };
      });
      const { sniffDialect } = await import('../src/dialect.js');
      const body = 'A single paragraph.\n';
      const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as MdastRoot;
      const doc = await parse(body);
      expect(sniffDialect(body, tree, doc, [])).toEqual([]);
      expect(warned, 'the refusal is silent').toHaveBeenCalled();
      const message = warned.mock.calls.map((call) => String(call[0])).join('\n');
      expect(message).toMatch(/the parse blocks claim 2 compiled blocks and the document has 1/);
      expect(message).not.toMatch(/compiles to zero blocks/);
    } finally {
      vi.doUnmock('../src/handlers.js');
      vi.resetModules();
      warned.mockRestore();
    }
  });
});

describe('§5 dialect contract — what a save writes, and who writes it', () => {
  it('counts a loose list, and its canonical form is what the save actually writes', async () => {
    // **The finding, in the form the banner will show it.** A loose list is not a
    // foreign dialect: the markers are the pinned `-`. What changes the bytes is
    // that `fromPmNode('list')` pins `spread: false` and the ProseMirror schema
    // has nowhere to keep the looseness. The previous version of this channel
    // compared the *parse* tree, where `spread: true` survives, so it called this
    // document canonical and said nothing.
    const { dialect, warnings } = await parseWithDiagnostics(corpusInput('list-loose'));
    expect(dialect).toHaveLength(1);
    expect(dialect[0]!.cause).toBe('list-spread');
    expect(spellings(dialect)).toEqual([['- one\n\n- two', '- one\n- two']]);
    // **Still not a loss.** The document keeps both items and both words; only the
    // blank line between them goes. A channel that reported this as a loss would
    // train the reader to distrust the one that means it.
    expect(warnings).toEqual([]);
    // And the claim `canonical` makes is checkable rather than asserted: it is
    // byte-equal to what a save writes for the document. This is the assertion
    // that would fail if the field ever went back to rendering the parse tree,
    // which is the bug this whole slice is about.
    expect(dialect[0]!.canonical).toBe(await saved(corpusInput('list-loose')));
  });

  it('counts a tight nested list gaining a blank line, and attributes it to the item, not the option', async () => {
    // The other direction, and the one §5's amendment explained wrongly. A tight
    // nested list is *tightened into* a looser spelling — the opposite of the
    // loose-list case — so a single "list dialect" story could not tell them
    // apart, which is what a `cause` field is for.
    const { dialect } = await parseWithDiagnostics(corpusInput('list-nested-3-level'));
    expect(dialect).toHaveLength(1);
    expect(dialect[0]!.cause).toBe('list-item-spread');
    expect(spellings(dialect)).toEqual([
      [
        '- level one\n  - level two\n    - level three',
        '- level one\n\n  - level two\n\n    - level three',
      ],
    ]);
    expect(dialect[0]!.canonical).toBe(await saved(corpusInput('list-nested-3-level')));
  });

  it('attributes each cause to a handler field that exists in the source', async () => {
    // **A `cause` is a claim about this repository's code, so it is checked
    // against that code.** A notice field that says "Caotang writes lists tight
    // because `fromPmNode('list')` pins `spread: false`" is a lie in the one
    // place a writer will read it if the handler stops doing that, and nothing
    // behavioural can see it: the bytes would be identical either way for a
    // corpus where the other half of the round trip compensated.
    const source = readFileSync(resolve(__dirname, '../src', 'handlers.ts'), 'utf8');
    // `list` → `list-spread`: both list factories pin `spread: false`.
    expect(source).toMatch(
      /bullet_list: fromPmNode\('list', \(\) => \(\{ ordered: false, spread: false \}\)\)/,
    );
    expect(source).toMatch(/ordered_list: fromPmNode\('list', \(node\) => \(\{[\s\S]{0,200}?spread: false/);
    // `listItem` → `list-item-spread`: the factory takes **no options at all**,
    // so it cannot carry a `spread`, and remark-stringify then inserts the blank
    // line. The negative assertion is the claim, so it needs its own control: a
    // pattern loose enough to match anywhere in the file would pass on a handler
    // that *does* pin the field.
    expect(source).toMatch(/list_item: fromPmNode\('listItem'\)/);
    // The control, and it is the sharp half: the pattern above is a claim that
    // the factory is called with **no argument list at all**, so it cannot carry
    // a `spread`. A factory that *did* take options must not match it — otherwise
    // the positive assertion would be satisfied by a prefix of the longer form
    // and would keep passing after a handler started pinning the field.
    expect("list_item: fromPmNode('listItem', (node) => ({ spread: false }))").not.toMatch(
      /list_item: fromPmNode\('listItem'\)/,
    );
  });

  it('`listItemIndent` is not the cause of the nested blank line, in any setting', async () => {
    // **The falsification, pinned so it cannot be re-asserted.** It is easy to
    // name `listItemIndent: 'one'` as the
    // reason a nested list gains a blank line. It is the reason nothing here: the
    // blank line appears with the key **absent**, and `'one'` and `'tab'` change
    // only the indentation. Without this test the false reason survives, because
    // §5's own option list is exactly the kind of plausible cause a reader will
    // accept — and a false reason in a spec is re-derived by the next change
    // rather than checked.
    const { doc } = await parseWithDiagnostics(corpusInput('list-nested-3-level'));
    const tree = fromProseMirror(doc, {
      schema: caotangSchema,
      nodeHandlers: createSerializeHandlers() as never,
      markHandlers: createSerializeHandlers() as never,
    }) as MdastRoot;
    const withOption = (options: Record<string, unknown>): string =>
      String(
        unified()
          .use(remarkGfm)
          .use(remarkStringify, { ...CANONICAL_STRINGIFY_OPTIONS, ...options } as never)
          .stringify(tree as never)
          .replace(/\n+$/, ''),
      );
    const absent = withOption({});
    expect(absent).toContain('\n\n  - level two');
    // The option is present and does something — otherwise "absent" and `'one'`
    // being equal would prove nothing. It changes the *indentation*, which is the
    // whole of what it is here to show.
    const tabbed = withOption({ listItemIndent: 'tab' });
    expect(tabbed).not.toBe(absent);
    expect(tabbed.replace(/ +/g, ' ')).toContain('\n\n - level two');
    // The blank line is still there under every setting, which is the claim: the
    // option is not what produces it.
    expect(tabbed).toContain('\n\n');
    expect(withOption({ listItemIndent: 'one' })).toBe(absent);
  });

  it('keeps a loss out of this channel even though the save-path comparison sees its bytes change', async () => {
    // **The negative control for a strictly more sensitive instrument.** That change's
    // comparison notices any change the round trip makes, and `strike-in-emphasis`
    // is one — a nested emphasis collapsing into the one around it. It is a
    // **loss**, `LossWarning` reports it, and reporting it here as well would
    // describe one change in two vocabularies with nothing to tell the writer
    // which to act on. `emphasis` is not a degrade *type*, so the type-based skip
    // cannot see it and the position-based one is what holds the boundary.
    const body = corpusInput('strike-in-emphasis');
    const { dialect, warnings } = await parseWithDiagnostics(body);
    expect(codes(warnings)).toEqual(['lossy-structure:emphasis']);
    expect(dialect).toEqual([]);
    // Non-vacuity, both halves: the block's bytes really do change, and really
    // are the save's doing — so an empty dialect array is the skip working, not
    // the instrument being blind.
    expect(await saved(body)).not.toBe(body.replace(/\n+$/, ''));
    expect(await saved(body)).toBe('_gone and struck together_');
  });

  it('tells the writer which mechanism wrote it — `detail` is the sentence, and it is pinned', async () => {
    // **Added. `cause` was pinned four ways and its prose zero.**
    // §5.1's whole justification for the third attribution is a *prose* one —
    // "`source`/`canonical` cannot carry *who did it*, because 'your marker is
    // not ours' is actionable and 'the product writes every list tight' has to
    // be told or it reads as their own mistake" — and `detailFor`'s own comment
    // says it is "the only place `cause` becomes prose". So `detail` is the
    // surface the decision was made for, and at HEAD **no test read it**: zero
    // occurrences of `.detail` in this file.
    //
    // Measured on the own bytes (both
    // restored byte-identical): `detailFor` returning **one sentence for all four
    // causes** left **195/195 green**, and **swapping the two list sentences** —
    // the exact pair this module says "a single 'list dialect' story could not
    // tell apart" — also left **195/195 green**. `cause` would have been right
    // and the sentence wrong, which is the precise failure §5.1 names and the
    // one a writer cannot act on.
    //
    // The same package pins `LossWarning.detail` six times (`degrade.test.ts`,
    // `merged-runs.test.ts`), so a *second* prose field with no test
    // would be an inconsistency inside the package's own practice, not a house rule.
    const entity = (await parseWithDiagnostics(ENTITY)).dialect[0]!;
    const loose = (await parseWithDiagnostics(corpusInput('list-loose'))).dialect[0]!;
    const nested = (
      await parseWithDiagnostics(corpusInput('list-nested-3-level'))
    ).dialect[0]!;

    // Non-vacuity: three notices, three *different* causes, so the three
    // sentences below are three different sentences by construction rather than
    // by the fixture happening to produce equal strings.
    expect([entity.cause, loose.cause, nested.cause]).toEqual([
      'parse-side',
      'list-spread',
      'list-item-spread',
    ]);

    // Each sentence names **its own** mechanism. The two negative assertions are
    // the half that fires on a swap: `list-spread` must not describe the nested
    // list's blank line, and `list-item-spread` must not describe writing lists
    // tight. A copy-paste collapse fails `not.toBe`; a swap fails the pair.
    expect(loose.detail).toContain('writes every list tight');
    expect(loose.detail).not.toContain('nested list');
    expect(nested.detail).toContain('blank line before a nested list');
    expect(nested.detail).not.toContain('tight');
    expect(entity.detail).toContain('canonical dialect');
    expect(entity.detail).not.toContain('list');

    // And the three are pairwise distinct, which is the claim the constant-
    // sentence mutant violates and nothing else in the file could see.
    const sentences = [entity.detail, loose.detail, nested.detail];
    expect(new Set(sentences).size).toBe(3);

    // **Stated rather than faked:** the fourth sentence, `save-side`, is not
    // reachable from the corpus by design — the `never falls back to an
    // unattributed save-side cause across the corpus` test, in the describe
    // block *below* this one, is what holds that, and it is why no assertion
    // here can pin it. Three of four are pinned; the fourth is pinned as
    // unreachable rather than as prose, and if a change ever makes it reachable
    // that test fails and this comment stops being true.
  });
});

describe('§5 dialect contract — the rule is a comparison, not a list', () => {
  it('catches a construct no table of foreign dialects would list', async () => {
    // §5's own examples are bullets, emphasis, setext headings, `+` markers and
    // tab-indented lists. This is none of them: a decimal character reference
    // with no name, which remark-parse decodes to a single non-ASCII character.
    // A hardcoded list would have to be extended for every construct remark ever
    // decides to re-spell; a comparison gets this for free.
    expect(spellings((await parseWithDiagnostics('caf&#233;\n')).dialect)).toEqual([
      ['caf&#233;', 'café'],
    ]);
  });

  it('does not report a backslash escape that is already canonical', async () => {
    // The confusable, and the reason the rule is a comparison rather than a
    // "did the text change" test. `a \* b` survives a round trip byte-for-byte —
    // remark-stringify re-emits the escape — so there is nothing to re-spell, and
    // a rule keyed on "the source contains a backslash" would report it.
    const body = 'a \\* b\n';
    expect((await parseWithDiagnostics(body)).dialect).toEqual([]);
    // Non-vacuity: the bytes really are canonical, or the empty result would only
    // be telling us the rule did not fire.
    expect(await saved(body)).toBe('a \\* b');
  });

  it('reports the line-break style, because the channel renders with the save\'s chain', async () => {
    // The false positive this file found, kept as a test. `§3.3`'s `break` row
    // makes the product write two spaces where the source had a backslash, and
    // when the sniffer used the five bare dialect options it reported the
    // *canonical* two-space form as foreign — a notice on a document whose bytes
    // never change. Sharing one chain fixed it and closed a real gap: the
    // backslash form is now reported, because the product really does rewrite it.
    const backslash = corpusInput('hard-break-backslash');
    const twoSpace = corpusInput('hard-break-two-space');
    expect(await saved(twoSpace)).toBe(twoSpace.replace(/\n+$/, ''));
    expect((await parseWithDiagnostics(twoSpace)).dialect).toEqual([]);
    expect((await parseWithDiagnostics(backslash)).dialect).toHaveLength(1);
    expect((await saved(backslash))).not.toBe(backslash.replace(/\n+$/, ''));
  });

  it('carries §5\'s five values and §3.3\'s break override — the constant, asserted', async () => {
    // **What this test does, and what it does not.** It asserts the *contents* of
    // the one object both chains are supposed to share. It cannot assert that they
    // share it: neither `dialect.ts` nor `pipeline.ts` is read here, so a chain
    // pointed somewhere else passes it. **Measured 2026-10-05 10:0x:**
    // pointing the sniffer's chain at the five bare `CANONICAL_STRINGIFY_OPTIONS`
    // leaves **this** test green and fails 2 elsewhere (the line-break test below and
    // the §13 sweep); pointing the *save*'s chain at them leaves it green and fails 4
    // (those two plus `pipeline.test.ts`'s two hard-break tests). This test was
    // titled *"renders with the same options the save does — the coupling is
    // asserted, not assumed"*, and docs/decisions.md cited it as the test that asserts
    // the coupling — so a test that cannot fail under the exact mutation it was
    // cited for was the recorded holder of the guarantee. The guarantee is real; the
    // attribution was not. The next test is what makes it true.
    expect(SAVE_STRINGIFY_OPTIONS).toMatchObject(CANONICAL_STRINGIFY_OPTIONS);
    expect(typeof SAVE_STRINGIFY_OPTIONS.handlers.break).toBe('function');
    expect(SAVE_STRINGIFY_OPTIONS.handlers.break()).toBe('  \n');
  });

  it('names the one object at both call sites, so a second definition cannot appear', () => {
    // The half no behavioural test can see, and the half the old title claimed. A
    // **second literal copy** of these options — a different object with identical
    // contents — is indistinguishable from the shared one to every test in this
    // file, measured: `{ ...SAVE_STRINGIFY_OPTIONS }` leaves **187 green**. It is
    // also exactly the drift the object was introduced to prevent, since the whole
    // argument for it was that two modules "must not be able to disagree" about
    // this product's canonical dialect. A behaviour-changing divergence is the four
    // tests' job above; **this is a reachability claim about the source, so it reads
    // the source** — the pair has disjoint blind spots and either one alone is a
    // green lie.
    //
    // The pattern matches the **call**, not the word. `remarkStringify,
    // SAVE_STRINGIFY_OPTIONS` is code; both files' prose names
    // `SAVE_STRINGIFY_OPTIONS` on its own with no `remarkStringify,` in front of
    // it, and the control below asserts the difference so a future loosening of
    // this regex cannot quietly turn it back into a word-match. A guard a file's
    // own explanatory comment trips has to be weakened, and a weakened guard is how
    // "no second writer" becomes "no second writer except the ones I found
    // irritating".
    // **Strengthened, because the mutation this guard defends got
    // easier.** `dialect.ts` now builds *two* chains — one for the parse tree and
    // one for the save — so "at least one call names the shared object" is no
    // longer the claim; the claim is that *every* chain in the file does. A copy
    // on the second chain would render the save with a different dialect from
    // `pipeline.ts` and every behavioural test here would still pass, because the
    // copy would be byte-identical by construction.
    // **Extended, and the extension is the point rather than an
    // allowance.** `dialect.ts` has a third chain — the one that renders
    // the whole document once with a `join` hook attached, which is where the
    // per-block offsets now come from. It is handed
    // `RECORDED_STRINGIFY_OPTIONS`, which *is* a spread copy of the shared object,
    // and the guard's whole subject is spread copies. So the claim is restated
    // from "every chain names `SAVE_STRINGIFY_OPTIONS`" to **"every chain names
    // the shared object or the one derived object, and the derived object is the
    // shared object plus exactly one hook"** — the second half asserted in the next
    // test, against the object itself rather than against the source text. A
    // second *dialect* definition would have to be written outside that one
    // `RECORDED_STRINGIFY_OPTIONS` literal to get past both.
    for (const file of ['dialect.ts', 'pipeline.ts']) {
      const source = readFileSync(resolve(__dirname, '../src', file), 'utf8');
      const chains = source.match(/remarkStringify,/g) ?? [];
      // Asserted non-zero: a file that stopped rendering entirely would satisfy a
      // "for each chain" rule with nothing to iterate.
      expect(chains.length, `${file} renders with no chain at all`).toBeGreaterThan(0);
      expect(source, `${file} does not render with the shared options`).toMatch(
        /remarkStringify,\s*(SAVE_STRINGIFY_OPTIONS|RECORDED_STRINGIFY_OPTIONS)/,
      );
      expect(
        chains.length,
        `${file} has a chain that does not name the shared options`,
      ).toBe(
        (source.match(/remarkStringify,\s*(SAVE_STRINGIFY_OPTIONS|RECORDED_STRINGIFY_OPTIONS)/g) ?? [])
          .length,
      );
    }
    // The control for the pattern itself: a bare mention is not a call site, and a
    // regex loose enough to match one would pass on a chain that had moved.
    expect('// SAVE_STRINGIFY_OPTIONS is shared with `dialect.ts`.').not.toMatch(
      /remarkStringify,\s*(SAVE_STRINGIFY_OPTIONS|RECORDED_STRINGIFY_OPTIONS)/,
    );
    // **And the second allowed name is a name, not a wildcard.** A chain handed
    // some other object — a literal, a member expression, a renamed copy — fails
    // the alternation above. Asserted here so widening the pattern to a character
    // class later is a red test rather than a silent hole.
    expect('unified().use(remarkStringify, { bullet: \'-\' })').not.toMatch(
      /remarkStringify,\s*(SAVE_STRINGIFY_OPTIONS|RECORDED_STRINGIFY_OPTIONS)/,
    );
  });

  it('builds the save chain once, not on every save', () => {
    // **The other half of the chain claim, and the one that is about cost.**
    //
    // `dialect.ts` builds its chains once, at module level, and says why: *"A
    // processor is immutable once built, so one module-level instance is safe
    // to reuse."* `pipeline.ts`'s `serialize` did not: it built a fresh
    // `unified()` chain and a fresh handler table on **every call**, and
    // `serialize` is what a keystroke calls.
    //
    // Measured on a 15 kB document, 30 calls each: a fresh chain per call costs
    // 4.448 ms against 3.671 ms for the shared one — **17.5 % of the cost of
    // every keystroke's serialization**, paid to re-freeze a chain that cannot
    // have changed. The chain is the *only* thing that is rebuilt; the
    // `fromProseMirror` pass and the stringification are the document's own
    // cost and are unavoidable.
    //
    // The claim is about the **source**, because the cost is not observable in
    // the output: two chains with the same options write the same bytes, so
    // every behavioural test in this file is blind to it — and a guard that
    // cannot see the mutation it is cited for is the green lie this file is
    // about.
    const source = readFileSync(resolve(__dirname, '../src', 'pipeline.ts'), 'utf8');
    const start = source.indexOf('export const serialize');
    expect(start, 'pipeline.ts has no serialize').toBeGreaterThan(-1);
    // The end of the slice is guarded explicitly: an `indexOf` that answered -1
    // would slice to *almost the whole file* — which does contain `unified(`,
    // in `parseWithDiagnostics` — and fail pointing at code that is not
    // `serialize` at all.
    const end = source.indexOf('\n};', start);
    expect(end, 'serialize has no column-0 closer — the slice bound moved').toBeGreaterThan(start);
    const body = source.slice(start, end);
    // And the slice really is the whole of `serialize`: a `\n};` appearing
    // early inside the body would truncate it and let both `not.toMatch`
    // assertions below pass vacuously. The shared chain is what `serialize`
    // stringifies through, so a body that reaches it was not cut short.
    expect(body, 'the slice is not the whole serialize body').toContain('SAVE_CHAIN.stringify');
    // The two things `serialize` used to build per call.
    expect(body, 'serialize builds a chain per call').not.toMatch(/unified\(/);
    expect(body, 'serialize builds a handler table per call').not.toMatch(/createSerializeHandlers\(/);
    // And the module does build them, once, at the top level — so the
    // assertions above are not satisfied by a file that renders nothing.
    expect(source, 'pipeline.ts has no module-level save chain').toMatch(
      /^const SAVE_CHAIN = unified\(\)/m,
    );
    // The handler table moved with the save tree, which `serialize` and the dialect sniffer both render through.
    const saveTree = readFileSync(resolve(__dirname, '../src', 'save-tree.ts'), 'utf8');
    expect(saveTree, 'save-tree.ts has no module-level save handlers').toMatch(
      /^const SAVE_HANDLERS = createSerializeHandlers\(\)/m,
    );
    expect(body, 'serialize does not render through the shared save tree').toContain('toSaveTree(pm)');
  });

  it('derives the recorded chain\'s options from the shared object and adds nothing else', () => {
    // The half of the guard above that reads an *object* rather than a source
    // line, and the half that actually closes the hole the chain opened: the
    // derived object is compared key by key against `SAVE_STRINGIFY_OPTIONS`, so
    // a seventh dialect value, a second `break` handler, or a changed bullet
    // marker on the recorded chain is red even though the recorded chain is
    // byte-identical in output today.
    //
    // **The one extra key is asserted by name, not by count.** `join` is the hook
    // the recorder needs; anything else in that object is a second dialect definition with a
    // worse disguise, and `Object.keys(...).sort()` makes the pair readable in a
    // failure rather than a bare "not equal".
    const derived = RECORDED_STRINGIFY_OPTIONS as Record<string, unknown>;
    const shared = SAVE_STRINGIFY_OPTIONS as unknown as Record<string, unknown>;
    expect(Object.keys(derived).sort()).toEqual([...Object.keys(shared), 'join'].sort());
    for (const key of Object.keys(shared)) {
      // `toEqual` on the values, and the `break` handler is the one that carries
      // §3.3's override, so it is compared by calling it rather than by identity.
      expect(derived[key], `${key} differs on the recorded chain`).toEqual(shared[key]);
    }
    expect(SAVE_STRINGIFY_OPTIONS.handlers.break()).toBe('  \n');
    // And the hook itself changes no separator: it returns `undefined`, which is
    // the library's own "no opinion", so `joinDefaults` still decides. A rule that
    // answered `false` would put `<!---->` between two blocks and every corpus byte
    // would change.
    expect(derived.join).toHaveLength(1);
    //
    // **`toHaveLength(1)` counts the rules; it does not call one.** The sentence
    // above used to end "Asserted by calling it", and nothing here called it — the
    // assertion beside it reads an array's length. `join` is a *list* of rules, so
    // the count is a real claim about the shape and no claim at all about the
    // answer, and the two are independent: a rule answering `false` or `'\n\n'`
    // passes `toHaveLength(1)` untouched. Measured:
    // returning a real `'\n\n'` left **29 of 31** tests green,
    // because the separator lives in the join and never enters a per-block
    // capture, so no per-block assertion *can* see it, and the only two tests that
    // reacted did so by timing out. Hence the end-to-end assertion below, which is
    // the one that can fire.
    // **The claim itself, end to end: the recorded chain renders what the save
    // chain renders.** `dialect.ts` and docs/decisions.md both say it, and it is a
    // statement about the *whole document* rather than about any one block —
    // which is precisely why the per-block sweep above cannot hold it. The rule is
    // not called directly here: it reads its fourth argument, so a synthetic
    // `state` would test the mechanism's internals instead of the claim.
    const MULTI_BLOCK = '# Title\n\nOne paragraph.\n\n- a\n- b\n\n> quoted\n';
    const root = unified().use(remarkParse).use(remarkGfm).parse(MULTI_BLOCK) as MdastRoot;
    const throughSave = unified()
      .use(remarkGfm)
      .use(remarkStringify, SAVE_STRINGIFY_OPTIONS)
      .stringify(root);
    const throughRecorder = unified()
      .use(remarkGfm)
      .use(remarkStringify, RECORDED_STRINGIFY_OPTIONS)
      .stringify(root);
    expect(throughRecorder.replace(/\n+$/, '')).toBe(throughSave.replace(/\n+$/, ''));
  });

  it('measures the whole §13 corpus, in both directions', async () => {
    // The sweep. Every entry is loaded and both facts are measured rather than
    // assumed: whether a save changes the bytes, and whether that change is a
    // dialect spelling. The two are kept apart because they are separate claims,
    // and one "expected value" column would let a single error explain the other.
    const noisyDespiteNoChange: string[] = [];
    const changedButNotCounted: string[] = [];
    let fired = 0;

    for (const entry of CORPUS) {
      const { doc, dialect } = await parseWithDiagnostics(entry.input);
      const changes = serialize(doc).replace(/\n+$/, '') !== entry.input.replace(/\n+$/, '');
      if (dialect.length > 0) fired++;
      if (dialect.length > 0 && !changes) noisyDespiteNoChange.push(entry.name);
      if (changes && dialect.length === 0) changedButNotCounted.push(entry.name);
    }

    // The sweep is not vacuous: the channel really does fire across the corpus,
    // and a suite where `dialect` was empty everywhere would satisfy both
    // assertions below.
    expect(fired).toBeGreaterThan(5);
    // **No false positive.** A document whose bytes are already ours is never
    // reported. This is the assertion a per-node comparison fails, and it is why
    // the rule trims the block separators before comparing.
    expect(noisyDespiteNoChange).toEqual([]);
    // **The boundary, pinned by name rather than by silence.** Every entry whose
    // bytes change without a dialect notice is a **loss that `LossWarning` already
    // reports**, and that is a single claim this list can make.
    //
    // Two groups make it up:
    //
    //  1. the degrade class, which `LossWarning` already reports;
    //  2. one structural loss (`strike-in-emphasis`). The save-path comparison
    //     is *more* sensitive and does see this block's bytes change, so this
    //     name is the control proving the extra sensitivity did not pull a loss
    //     into the dialect channel.
    //
    // The serialize-side normalizations (a loose list saved tight under
    // `spread: false`, `* item` → `- item` under `bullet: '-'`) are counted, not
    // listed: "declared by §5's own pinned options" is no reason to exempt a
    // change, since every counted family is caused by a pinned option.
    // `listItemIndent` changes the *indentation* and never the blank line
    // (measured with the key absent, `'one'` and `'tab'`).
    //
    // A new name here means a new undeclared change, which is the failure this
    // list exists to catch. **Removing** a name is a fix, and this assertion is
    // expected to be updated with it.
    expect(changedButNotCounted.sort()).toEqual(
      [
        // The degrade class, which `LossWarning` already reports.
        'html-raw-block',
        'html-raw-inline',
        // `image-reference` and `link-reference` left this list: a reference keeps its written spelling, so a save does not change
        // their bytes (source-provenance.ts).
        'list-task-item',
        'table-gfm',
        'footnote-reference',
        // **Still here.**
        // The save-path comparison is strictly more sensitive and
        // *does* see this block's bytes change — a nested emphasis collapsing
        // into the one around it. It is a **loss**, `LossWarning` reports it, and
        // a dialect notice for the same block would describe one change in two
        // vocabularies. So this name is now the negative control that the extra
        // sensitivity did not drag a loss into this channel, and it is why the
        // list cannot shrink past eight. The mechanism, precisely: it is a
        // **nested** `emphasis` that collapses into the one around it, not three
        // sibling nodes — the two shapes behave oppositely, and a check written
        // to the sibling version would warn on the case that loses nothing and
        // stay silent on the one that does.
        'strike-in-emphasis',
        // **Removed:** `list-loose` and `obsidian-blank-line-list` (the same input, so
        // two names for one construct) were a loose list saving tight, and
        // `list-nested-3-level` was a tight nested list gaining a blank line.
        // They were *declared by the pinned options* — and the options are not
        // what caused them; the handlers are. See the cause tests below.
        //
        // **Kept: `strike-in-emphasis`**, which is the loss. The save-path
        // comparison is strictly more sensitive than the parse one
        // and *does* see this block's bytes change — so this name is the negative
        // control that says the extra sensitivity did not drag a loss into the
        // dialect channel, and it is the reason the list cannot shrink further.
      ].sort(),
    );
    // **Every entry that was removed is gone for a reason this file can state,
    // and the three that are left are all losses** — the property the list is
    // for. Asserted rather than described: a future change that leaves a *spelling*
    // on this list has re-opened that decision, whatever the comment says.
    expect(changedButNotCounted).not.toContain('list-loose');
    expect(changedButNotCounted).not.toContain('obsidian-blank-line-list');
    expect(changedButNotCounted).not.toContain('list-nested-3-level');
  });

  it('places every loss, because the skip that keeps them out of this channel needs a position', async () => {
    // **The limit of `carriesLoss`'s second test, asserted instead of assumed.**
    // A `LossWarning` with no position cannot be attributed to a block, so it
    // would not suppress a dialect notice — and the whole disjointness argument
    // would rest on a list this suite never checked. It is empty across the
    // corpus today. A warning producer that starts emitting position-less
    // warnings fails here rather than quietly double-reporting a block in two
    // vocabularies.
    const unplaced: string[] = [];
    for (const entry of CORPUS) {
      const { warnings } = await parseWithDiagnostics(entry.input);
      if (warnings.some((w) => w.position === undefined)) unplaced.push(entry.name);
    }
    expect(unplaced).toEqual([]);
  });

  it('never falls back to an unattributed `save-side` cause across the corpus', async () => {
    // The honesty guard on the fallback value. `DialectCause` carries a
    // `'save-side'` for a round-trip change whose responsible field is not in the
    // map, so that such a change is *visible* rather than mislabelled. A fallback
    // nothing exercises is a claim; one the corpus exercises is a finding, and
    // this is where it would surface. Zero here, with the count asserted so the
    // test is not satisfied by a `dialect` that is empty everywhere.
    let reported = 0;
    const unattributed: string[] = [];
    for (const entry of CORPUS) {
      const { dialect } = await parseWithDiagnostics(entry.input);
      for (const notice of dialect) {
        reported++;
        if (notice.cause === 'save-side') unattributed.push(entry.name);
      }
    }
    expect(reported).toBeGreaterThan(15);
    expect(unattributed).toEqual([]);
  });

  it('reads the degrade list from the handler table, so a new degrade cannot land in both channels', async () => {
    // The skip rule reads `DEGRADE_MDAST_TYPES` rather than repeating it. If a
    // copy had been made here, a construct that started degrading would be
    // counted as a re-spelling too, and the two banners would describe one
    // change in two vocabularies. Asserting the list is non-trivial keeps a
    // refactor that empties it from turning this into a no-op.
    expect(DEGRADE_MDAST_TYPES.length).toBeGreaterThan(4);
    expect([...EXACT_CLASS_MDAST_TYPES]).toContain('listItem');
  });
});

/**
 * The budget for the two 400-block fixtures below — **explicit, per-test, and
 * never `vitest.config.ts`'s default**.
 *
 * **Why 5 000 ms was never these tests' budget.** Neither of them measures wall
 * clock. One asserts that two derivations *agree* block for block; the other
 * asserts a **render count** — `2` against `400` — and says so in its own comment:
 * *"A timing test says the number is small on the machine it ran on; a render
 * count says the shape is different, on every machine, forever."* So the 5 000 ms
 * default was never guarding their claim. It was guarding a fixture that
 * **deliberately runs the `O(n²)`-shaped path**, which is the very path the recorder is checked
 * against — the cost is the subject matter, not an accident.
 *
 * **Measured, both directions.** Under load they ran
 * 15 193 ms and 17 244 ms with `--testTimeout=60000` — 3.0× and 3.2× the default.
 * Alone and idle on one development machine: **4 372 ms**
 * and **6 112 ms**. **The second exceeds 5 000 ms with no contention at all**, so
 * on this hardware that test is red *unconditionally* and no amount of re-running
 * an idle machine fixes it — the gate's colour is not purely a property of load. Under the full suite's 47 workers the same
 * two run 6 730 ms and 7 373 ms.
 *
 * **30 000 ms clears every figure recorded on either machine (max 17 244 ms) with
 * headroom, and still fails a hang.** Raising the config default instead would move
 * every other test's budget in the repo to accommodate two fixtures, which is the
 * option the decision explicitly rules out.
 */
const LONG_FIXTURE_TIMEOUT = 30_000;

describe('§5 dialect contract — the cost of counting', () => {
  it('produces the same per-block text as the prefix algorithm, over the whole corpus', async () => {
    // **The control.** The recorder changes where the per-block canonical
    // text comes from — one render of the document, with the serializer's own
    // per-block strings read off it, instead of one render of every growing
    // prefix — and changed nothing else. So the guard is the two derivations run
    // side by side over every §13 entry, compared block for block.
    //
    // The corpus is swept rather than sampled because the property being relied on
    // is a *library* property (a construct's rendering depends on its preceding
    // siblings and never on a following one), and the corpus is where the
    // constructs that could break it live: adjacent lists, a list inside a
    // blockquote, a definition followed by a paragraph. An entry whose recorded
    // text disagreed with the prefix difference would be a false positive on a
    // document whose bytes never change, which is the one failure this channel
    // cannot have.
    const disagree: string[] = [];
    for (const entry of CORPUS) {
      const { save, parse: parseSide } = await bothDerivations(entry.input);
      // Non-null is asserted per side and separately from the comparison: a
      // recorder that declined would otherwise fall through to a comparison
      // against `null` and read as an ordinary mismatch. **Both sides are checked
      // and both are load-bearing** — the save side decides what is reported and
      // the parse side decides what it is *called*, and a parse side that quietly
      // ran on the old algorithm would cost `O(n²)` on every document that has a
      // notice while every assertion here stayed green.
      for (const [side, pair] of [
        ['save', save],
        ['parse', parseSide],
      ] as const) {
        // **`via` first, and it is the assertion that gives the rest its meaning.**
        // Both derivations return the same numbers when the recorder declines, so
        // a value comparison alone is green whether the fast path ran or not — the
        // guard would be measuring the fallback and calling it the mechanism.
        if (pair.recorded.via !== 'recorded') {
          disagree.push(`${entry.name}/${side}: via=${pair.recorded.via}`);
          continue;
        }
        if (JSON.stringify(pair.recorded.own) !== JSON.stringify(pair.byPrefix.own)) {
          disagree.push(`${entry.name}/${side}: own`);
        }
        // `saved` is the mdast the save produced for each block, which the cause
        // walk compares field by field. Two renders produce two different objects
        // with the same content, so this is deep equality rather than identity —
        // and deep equality is the stronger claim anyway, because it also holds if
        // the two derivations ever started disagreeing about the *cause*.
        if (side === 'save' && JSON.stringify(pair.recorded.saved) !== JSON.stringify(pair.byPrefix.saved)) {
          disagree.push(`${entry.name}/${side}: saved`);
        }
      }
    }
    expect(disagree).toEqual([]);
  });

  it('agrees on a 400-block document too, where the prefix algorithm costs 1 586 ms', async () => {
    // The corpus is small; the cost was not. A derivation that is right on 57
    // one-construct fixtures and wrong on a real manuscript is a derivation whose
    // agreement is a coincidence of size, so the same comparison runs on this
    // row's own document — and **every block is canonical**, so a non-empty
    // `own` difference here is a false positive on 400 blocks at once.
    const body = longManuscript(400);
    const { count, save } = await bothDerivations(body);
    expect(count).toBe(400);
    expect(save.recorded.via).toBe('recorded');
    expect(save.recorded.own).toEqual(save.byPrefix.own);
    // Non-vacuous in the direction that matters: the two derivations really are
    // being asked for 400 distinct answers, and every one of them is a block's
    // own text rather than the whole document.
    expect(save.recorded.own).toHaveLength(400);
    expect(save.recorded.own.every((text) => text.length > 0)).toBe(true);
    expect(new Set(save.recorded.own).size).toBeGreaterThan(20);
  }, LONG_FIXTURE_TIMEOUT);

  it('agrees on a document where every block re-spells, which is the parse side\'s worst case', async () => {
    // **The parse side only exists when there is a notice to attribute**, so a
    // document in our own dialect never builds it and a guard that only read the
    // save side would never notice a parse side that had gone back to the old
    // per-block memo — the shape that cost `O(n²)` precisely here, on a document
    // where every block needs attributing. Written in a foreign dialect on
    // purpose: `*` bullets where Caotang writes `-`, so each list is reported.
    const body = longForeignManuscript(120);
    const { count, save, parse: parseSide } = await bothDerivations(body);
    expect(count).toBe(120);
    // Non-vacuity first: the notices are real, so the parse side is really built
    // by the production path and not only by this harness.
    const { dialect } = await parseWithDiagnostics(body);
    expect(dialect.length).toBeGreaterThan(20);
    expect(dialect.every((notice) => notice.cause === 'parse-side')).toBe(true);
    // **Both sides on the recorded path.** Measured while building this slice:
    // pointing the parse side back at the non-recording chain produces *identical
    // numbers* — it just falls back — so every value assertion above stays green
    // and the regression shows up only as two tests timing out. `via` is what
    // turns that from a mood into a failure.
    expect(save.recorded.via).toBe('recorded');
    expect(parseSide.recorded.via).toBe('recorded');
    expect(save.recorded.own).toEqual(save.byPrefix.own);
    expect(parseSide.recorded.own).toEqual(parseSide.byPrefix.own);
    expect(parseSide.recorded.own).toHaveLength(120);
  });

  it('gives the two sides different answers, which is the only reason there are two', async () => {
    // The claim behind the two-channel design, asserted rather than assumed: the
    // parse side and the save side are not the same computation over the same
    // tree, so a rule keyed on one of them would mislabel the other's findings.
    // `> one\n> two` is the smallest document where they part company — the parse
    // tree keeps the soft break and the ProseMirror round trip does not, so the
    // parse side says *"remark left your spelling alone"* and the save side says
    // *"the product rewrote this block"*. Every other block in the foreign
    // manuscript above is `parse-side` on both, which is exactly why asserting a
    // difference there was wrong and is not done.
    const { save, parse: parseSide } = await bothDerivations('> one\n> two\n');
    expect(save.recorded.own[0]).toBe('> one two');
    expect(parseSide.recorded.own[0]).toBe('> one\n> two');
    expect(save.recorded.via).toBe('recorded');
    expect(parseSide.recorded.via).toBe('recorded');
  });

  it('renders the document once, and the prefix algorithm once per block', async () => {
    // **The cost claim as a fact rather than as a stopwatch.** A timing test says
    // the number is small on the machine it ran on; a render count says the shape
    // is different, on every machine, forever. The loop rendered prefixes
    // `1 … n`, so it converted `n²/2` blocks' worth of tree; this renders the
    // document once and a single block once.
    const body = longManuscript(400);
    const { count, save: derivation } = await bothDerivations(body);
    expect(count).toBe(400);
    // Reset and re-run each derivation on its own so the counts are not summed.
    let renders = 0;
    const doc = await parse(body);
    const boundaries: number[] = [];
    let offset = 0;
    doc.forEach((node) => {
      offset += node.nodeSize;
      boundaries.push(offset);
    });
    const saveChain = unified()
      .use(remarkGfm)
      .use(remarkStringify, SAVE_STRINGIFY_OPTIONS)
      .freeze();
    const handlers = createSerializeHandlers();
    const counted = (pm: Parameters<typeof fromProseMirror>[0]): Rendered => {
      renders++;
      const t = fromProseMirror(pm, {
        schema: caotangSchema,
        nodeHandlers: handlers as never,
        markHandlers: handlers as never,
      }) as MdastRoot;
      return { text: String(saveChain.stringify(t as never)), children: t.children };
    };
    const prefix = (n: number): Rendered =>
      counted(caotangSchema.topNodeType.create(null, doc.content.cut(0, boundaries[n - 1]!)));
    renders = 0;
    ownTextsRecorded(400, () => prefix(1), () => {
      renders++;
      const { text, tree } = renderSaveRecorded(doc);
      return { text, children: tree.children };
    });
    const recordedRenders = renders;
    renders = 0;
    ownTextsByPrefix(400, prefix);
    const prefixRenders = renders;
    // Two, and four hundred. The prefix algorithm converts `400²/2 =
    // 80 200` blocks' worth of tree per load, the recorder converts `400 + 1`.
    expect(recordedRenders).toBe(2);
    expect(prefixRenders).toBe(400);
    // And the count is connected to the mechanism rather than to a helper nobody
    // calls: `saveSideOwnTexts` is what `sniffDialect` calls, and the two tests
    // above assert it took the recorded branch on real documents.
    expect(derivation.recorded.via).toBe('recorded');
  }, LONG_FIXTURE_TIMEOUT);

  it('declines, rather than answering, when the capture does not line up', async () => {
    // **The guard is a two-way control, and this is its negative direction.** The
    // recorder returns `null` — and `sniffDialect` falls back to the prefix
    // algorithm — unless it has captured every block after the first *and* each
    // captured node is the very block it claims. Without this, "the capture lines
    // up" is a sentence nobody can check, and a recorder that quietly stopped
    // recording would still produce plausible per-block text.
    //
    // Forced by handing `ownTextsRecorded` a `renderWhole` that renders nothing
    // through the recording chain, which is exactly what a library whose
    // dispatcher stopped being `state.handle` would look like from in here.
    const body = longManuscript(6);
    const doc = await parse(body);
    const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as MdastRoot;
    const boundaries: number[] = [];
    let offset = 0;
    doc.forEach((node) => {
      offset += node.nodeSize;
      boundaries.push(offset);
    });
    const saveChain = unified()
      .use(remarkGfm)
      .use(remarkStringify, SAVE_STRINGIFY_OPTIONS)
      .freeze();
    const handlers = createSerializeHandlers();
    const save = (pm: Parameters<typeof fromProseMirror>[0]): Rendered => {
      const t = fromProseMirror(pm, {
        schema: caotangSchema,
        nodeHandlers: handlers as never,
        markHandlers: handlers as never,
      }) as MdastRoot;
      return { text: String(saveChain.stringify(t as never)), children: t.children };
    };
    const prefix = (n: number): Rendered =>
      save(caotangSchema.topNodeType.create(null, doc.content.cut(0, boundaries[n - 1]!)));
    // The silent renderer: correct `children`, a plausible `text`, and no capture
    // at all — which is what the recorder sees if the library's dispatcher ever
    // stopped being `state.handle`. A count-only guard would pass this.
    const silent = (): Rendered => {
      const through = prefix(tree.children.length);
      return { text: through.text, children: through.children };
    };
    expect(ownTextsRecorded(tree.children.length, () => prefix(1), silent)).toBeNull();
    // **The identity half, separately.** A renderer that captured nothing fails
    // the *count*, and a count-only guard is a real guard — but it is not the one
    // that caught this slice's own bug. The first version of the identity check
    // compared the save side's captured nodes against the **parse** tree's
    // children, which can never match; it presented as five corpus entries
    // declining and a cost that got *worse* (1 877 ms against 1 586 ms), because
    // every one of those documents rendered and then fell back. So the count is
    // now only half the guard, and this is the other half: the right number of
    // captures, attached to the wrong blocks.
    const rotated = (): Rendered => {
      const whole = renderSaveRecorded(doc);
      return { text: whole.text, children: [...whole.tree.children].reverse() };
    };
    expect(ownTextsRecorded(tree.children.length, () => prefix(1), rotated)).toBeNull();
    // And the same harness with the real recorder answers, so the nulls above are
    // the guard firing rather than the harness being unable to produce an answer.
    const answered = ownTextsRecorded(tree.children.length, () => prefix(1), () => {
      const { text, tree: savedTree } = renderSaveRecorded(doc);
      return { text, children: savedTree.children };
    });
    expect(answered?.via).toBe('recorded');
    expect(answered?.own).toEqual(ownTextsByPrefix(tree.children.length, prefix).own);
  });

  it('still reports a save-side change no named mechanism accounts for', async () => {
    // **As a live fixture: a cheaper banner that cannot see
    // a new defect is a banner that has stopped working.** The rejected
    // shortcut — skipping the save-path render for blocks with no list in them —
    // would make the common case linear and *this* test impossible to pass, which
    // is the trade that was refused. So the sweep's ability to report an
    // undeclared change is asserted on a real one.
    //
    // **A tight blockquote is one, and it is live today.** `> one\n> two` is one
    // paragraph with a soft break in it; the ProseMirror round trip has nowhere to
    // keep the soft break, so a save writes `> one two`. Nothing is lost — both
    // words survive, which is why `warnings` is empty — so this is a *spelling*
    // and belongs in this channel. And no entry in `SAVE_SIDE_CAUSES` names a
    // blockquote, so the cause is honestly `save-side` rather than a mislabel.
    //
    // **The corpus's zero is a fact about the corpus, not about the mechanism.**
    // The sweep above asserts `save-side` never appears across §13, and that
    // assertion is still true; this test is the counterweight, because a corpus
    // that happens not to contain the construct is not evidence that the
    // unattributed value is unreachable.
    const body = '> one\n> two\n';
    const { dialect, warnings } = await parseWithDiagnostics(body);
    expect(spellings(dialect)).toEqual([['> one\n> two', '> one two']]);
    expect(dialect[0]!.cause).toBe('save-side');
    // The two claims the `save-side` value rests on, asserted: the bytes really
    // do change (so this is not a notice about a canonical document), and
    // nothing is lost (so it is not a loss wearing a notice's clothes).
    expect(await saved(body)).toBe('> one two');
    expect(warnings).toEqual([]);
    // Non-vacuity the other way: the *loose* form is canonical, so the same
    // construct in the same corpus produces no notice, and a rule keyed on
    // "blockquote" rather than on "the bytes moved" would fail here.
    const loose = '> one\n>\n> two\n';
    expect(await saved(loose)).toBe(loose.replace(/\n+$/, ''));
    expect((await parseWithDiagnostics(loose)).dialect).toEqual([]);
  });

  it('is fast enough to open a long document, and the bound is measured, not asserted', async () => {
    // **The product claim, with its number.** Measured on this machine, this
    // document, on 2026-10-05: the rule **1 586 ms**, and 4 799 ms at 800
    // blocks — the 800-block load exceeded vitest's own 5 s default timeout
    // twice in the run where the baseline was taken. After that change the same document
    // loads in **107 ms** and 800 blocks in **192 ms**.
    //
    // The bound below is 1 000 ms: loose enough that a loaded machine passes it (a
    // full run of the whole workspace measured 419 ms here, against 400 ms before),
    // and tight enough that the quadratic fails it, at 1 586 ms on this document.
    // **A timing test is a weaker guard than the render count above and is here for
    // the product reason, not as the proof** — the proof is that the shape changed,
    // and that is the test above.
    const body = longManuscript(400);
    await parseWithDiagnostics(body); // warm the module-level chains
    const started = performance.now();
    const { dialect } = await parseWithDiagnostics(body);
    const elapsed = performance.now() - started;
    // Zero notices, so this also re-asserts the false-positive guard at size: a
    // document written in Caotang's own dialect must not report anything, however
    // long it is.
    expect(dialect).toEqual([]);
    expect(elapsed).toBeLessThan(1_000);
  });

  // The decision, executed: **the mutation, and the reason the fix
  // is a test rather than a comment.** Dropping the third argument from either
  // fixture above *is* the regression, and it has the worst possible shape —
  // it leaves the file green for hours and red later, on someone else's commit,
  // on a machine nobody was measuring. So the budget is asserted here, **by
  // name**: each fixture is located by its `it('…'` call and its own body is
  // checked, so the failure names the fixture that lost its budget.
  //
  // **The search is for `it('…'`, not for the bare title, and that is
  // load-bearing.** This test's own `FIXTURES` array holds those titles, so a
  // search for the title alone would find *this line* first and slice from here
  // to the end of the file — a check that passes on any file whatsoever,
  // including one with neither timeout.
  const FIXTURES = [
    'agrees on a 400-block document too, where the prefix algorithm costs 1 586 ms',
    'renders the document once, and the prefix algorithm once per block',
  ];

  it('both 400-block fixtures carry their own budget, by name', () => {
    const source = readFileSync(resolve(__dirname, 'dialect.test.ts'), 'utf8');
    for (const title of FIXTURES) {
      const at = source.indexOf(`it('${title}'`);
      // The control: a search that found nothing must fail here rather than
      // slice to the end of the file and find the timeout somewhere else.
      expect(at, `fixture not found as an it() call: ${title}`).toBeGreaterThan(-1);
      const body = source.slice(at, source.indexOf('\n  it(', at + 1));
      expect(body, `${title} must declare its own timeout`).toContain('}, LONG_FIXTURE_TIMEOUT)');
    }
    // …and the figure is one named constant, so the two budgets cannot drift
    // apart into two literals that differ by a digit.
    expect(source.match(/const LONG_FIXTURE_TIMEOUT = [\d_]+;/g)).toHaveLength(1);
  });

  it('leaves vitest.config.ts\'s default alone — two fixtures do not move the repo', () => {
    // The decision names the rejected option explicitly: raising the config
    // default "would move every other test's budget too". This asserts it was
    // not taken, by reading the config rather than by trusting the diff.
    //
    // **The assertion is the ABSENCE of the key, not two of its values.** A guard of
    // `/testTimeout:\s*(?:30_?000|60_?000)/` is
    // blind in the direction that matters: planting `testTimeout: 10_000` — the
    // rejected option, at a value the regex does not name — left all 34 tests in
    // this file green, while the same guard does fire on 30 000. A guard that
    // enumerates values asserts those values; the claim is about the key.
    const config = readFileSync(resolve(__dirname, '../../../vitest.config.ts'), 'utf8');
    expect(config, 'the default budget must not have been widened for two fixtures').not.toMatch(
      /\btestTimeout\b/,
    );
  });
});
