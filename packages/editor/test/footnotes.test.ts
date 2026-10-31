/**
 * §3.4 (#270): GFM footnotes in the schema — the canonical rule, the load, the save,
 * the one dialect notice, and agent edits that touch a footnote.
 *
 * The fixtures are the ones the issue names: numeric and named footnotes, a
 * multi-paragraph note, a reference without a note, a note without a reference, and
 * footnotes in a scene with `***` separators. The byte-identical half of the round
 * trip is also in `pipeline.test.ts`'s exact class; this file holds what is particular
 * to footnotes.
 */
import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import type { Node as PmNode } from '@tiptap/pm/model';

import {
  buildProjectionMap,
  caotangSchema,
  canonicalizeFootnoteTree,
  footnoteKey,
  insertionOf,
  parse,
  parseFragment,
  parseWithDiagnostics,
  planFootnotes,
  planPmFootnotes,
  resolveAnchor,
  serialize,
} from '../src/index.js';

const roundTrip = async (body: string): Promise<string> => serialize(await parse(body));

/** The labels of the document's markers and notes, in document order. */
const labelsOf = (doc: PmNode): { refs: string[]; notes: string[] } => {
  const refs: string[] = [];
  const notes: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'footnote_reference') refs.push(node.attrs.label as string);
    if (node.type.name === 'footnote_definition') notes.push(node.attrs.label as string);
    return true;
  });
  return { refs, notes };
};

/** The issue's fixtures, in the canonical spelling. */
const SCENE_WITH_SEPARATORS = [
  'The harbour was quiet[^1].',
  '',
  '***',
  '',
  'The ferry came in on the second bell[^ferry], late as always[^3].',
  '',
  '***',
  '',
  'Nobody counted the boats.',
  '',
  '[^1]: Before the storm.',
  '',
  '[^ferry]: The _Marta_, which ran twice a day.',
  '',
  '    In winter, once.',
  '',
  '[^3]: The first note on lateness.',
  '',
  '[^4]: A note nothing points at.',
  '',
].join('\n');

describe('§3.4 · the planner', () => {
  it('orders by first reference, re-flows numeric labels and keeps named ones', () => {
    const plan = planFootnotes(
      ['7', 'note', '7', '3'],
      [
        { label: '3', innerRefs: [] },
        { label: 'note', innerRefs: [] },
        { label: '7', innerRefs: [] },
        { label: '9', innerRefs: [] },
      ],
    );
    expect(plan.notes).toEqual([
      { def: 2, label: '1' },
      { def: 1, label: 'note' },
      { def: 0, label: '3' },
      { def: 3, label: '4' },
    ]);
    expect([...plan.refLabel]).toEqual([
      [footnoteKey('7'), '1'],
      [footnoteKey('note'), 'note'],
      [footnoteKey('3'), '3'],
      [footnoteKey('9'), '4'],
    ]);
  });

  it('numbers a footnote inside a note after the text’s own, as a reader meets it', () => {
    const plan = planFootnotes(['a', '5'], [
      { label: '1', innerRefs: [] },
      { label: 'a', innerRefs: ['1'] },
      { label: '5', innerRefs: [] },
    ]);
    expect(plan.notes.map((note) => note.label)).toEqual(['a', '2', '3']);
    expect(plan.notes.map((note) => note.def)).toEqual([1, 2, 0]);
  });

  it('keeps a second definition of a label as a note of its own, never a collision', () => {
    const plan = planFootnotes(['1'], [
      { label: '1', innerRefs: [] },
      { label: '1', innerRefs: [] },
      { label: '1-2', innerRefs: [] },
    ]);
    expect(plan.notes).toEqual([
      { def: 0, label: '1' },
      { def: 1, label: '1-3' },
      { def: 2, label: '1-2' },
    ]);
  });

  it('a marker with no note is planned a new, empty one', () => {
    const plan = planFootnotes(['1'], []);
    expect(plan.notes).toEqual([{ def: null, label: '1' }]);
  });

  it('keys labels the way micromark does: case and whitespace fold', () => {
    expect(footnoteKey('Note')).toBe(footnoteKey('NOTE'));
    expect(footnoteKey('ß')).toBe(footnoteKey('SS'));
  });
});

describe('§3.4 · load and save', () => {
  it('the issue’s fixture — numeric, named, multi-paragraph, unreferenced, `***` — round-trips byte for byte', async () => {
    const { doc, warnings, dialect } = await parseWithDiagnostics(SCENE_WITH_SEPARATORS);
    expect(warnings).toEqual([]);
    expect(dialect).toEqual([]);
    // A named footnote has a position too: `[^ferry]` is the second, so the next numeric label is 3.
    expect(labelsOf(doc)).toEqual({ refs: ['1', 'ferry', '3'], notes: ['1', 'ferry', '3', '4'] });
    // The separators stay where they were; the notes are after the last of them.
    expect(doc.content.content.map((block) => block.type.name)).toEqual([
      'paragraph',
      'horizontal_rule',
      'paragraph',
      'horizontal_rule',
      'paragraph',
      'footnote_definition',
      'footnote_definition',
      'footnote_definition',
      'footnote_definition',
    ]);
    expect(serialize(doc)).toBe(SCENE_WITH_SEPARATORS);
  });

  it('a note keeps its marks, its paragraphs and an inline footnote of its own', async () => {
    const body = 'Main[^a].\n\n[^a]: _Em_ and a note[^b].\n\n    Second.\n\n[^b]: Inner.\n';
    const doc = await parse(body);
    const note = doc.child(1);
    expect(note.type.name).toBe('footnote_definition');
    expect(note.childCount).toBe(2);
    expect(note.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['em']);
    expect(serialize(doc)).toBe(body);
  });

  it('a reference without a note is text, as GFM reads it — kept, and saved escaped', async () => {
    const { doc, warnings } = await parseWithDiagnostics('Text[^1] no note');
    expect(warnings).toEqual([]);
    expect(labelsOf(doc).refs).toEqual([]);
    expect(serialize(doc)).toBe('Text\\[^1] no note\n');
    expect(await roundTrip(serialize(doc))).toBe(serialize(doc));
  });

  it('a body of only notes saves without the empty line §3.1’s leading block would add', async () => {
    const { doc } = await parseWithDiagnostics('[^1]: Only a note.');
    expect(doc.firstChild!.type.name).toBe('paragraph');
    expect(doc.firstChild!.childCount).toBe(0);
    expect(serialize(doc)).toBe('[^1]: Only a note.\n');
  });

  it('a foreign layout is re-spelled once, with one notice for the document', async () => {
    const body = [
      'First[^b], then[^a].',
      '',
      '[^a]: Named a.',
      '',
      'Middle text[^3].',
      '',
      '[^3]: Three.',
      '',
      '[^b]: Named b.',
    ].join('\n');
    const { doc, dialect, warnings } = await parseWithDiagnostics(body);
    expect(warnings).toEqual([]);
    expect(serialize(doc)).toBe(
      ['First[^b], then[^a].', '', 'Middle text[^3].', '', '[^b]: Named b.', '', '[^a]: Named a.', '', '[^3]: Three.', ''].join('\n'),
    );
    expect(dialect).toHaveLength(1);
    expect(dialect[0]!.cause).toBe('footnote-layout');
    expect(dialect[0]!.mdastType).toBe('footnoteDefinition');
    expect(dialect[0]!.position).toEqual({ line: 3, column: 1 });
    // The save is stable after the first one.
    const saved = serialize(doc);
    const again = await parseWithDiagnostics(saved);
    expect(again.dialect).toEqual([]);
    expect(serialize(again.doc)).toBe(saved);
  });

  it('a block whose only change is a re-numbered marker is counted in the footnote notice, not on its own', async () => {
    const { dialect } = await parseWithDiagnostics('X[^2] and Y[^1]\n\n[^1]: one\n\n[^2]: two');
    expect(dialect.map((notice) => notice.cause)).toEqual(['footnote-layout']);
  });

  it('CONTROL: a paragraph that is re-spelled for another reason still gets its own notice', async () => {
    const { dialect } = await parseWithDiagnostics('*X*[^2] and Y[^1]\n\n[^1]: one\n\n[^2]: two');
    expect(dialect.map((notice) => [notice.mdastType, notice.cause])).toEqual([
      ['paragraph', 'parse-side'],
      ['footnoteDefinition', 'footnote-layout'],
    ]);
  });

  it('the mdast rule leaves a tree without footnotes alone', () => {
    const tree = unified().use(remarkParse).use(remarkGfm).parse('Plain.\n\n> Quote.') as Root;
    const before = JSON.stringify(tree);
    expect(canonicalizeFootnoteTree(tree)).toEqual({ changed: false, relabelled: new Map() });
    expect(JSON.stringify(tree)).toBe(before);
  });
});

describe('§3.4 · the ProseMirror rule', () => {
  it('a canonical document needs no fix', async () => {
    expect(planPmFootnotes(await parse(SCENE_WITH_SEPARATORS))).toBeNull();
  });

  it('a marker inserted before the others takes number 1, and the notes follow it', async () => {
    const doc = await parse('A[^1] B[^2]\n\n[^1]: one\n\n[^2]: two\n');
    const ref = caotangSchema.nodes.footnote_reference!.create({ label: '3' });
    const note = caotangSchema.nodes.footnote_definition!.createAndFill({ label: '3' })!;
    // `A` is at 1; insert the marker before it, and its note at the end.
    const edited = doc.copy(
      doc.content
        .replaceChild(0, doc.child(0).copy(doc.child(0).content.addToStart(ref)))
        .addToEnd(note),
    );
    const fix = planPmFootnotes(edited)!;
    expect(fix).not.toBeNull();
    expect(fix.relabel.map((entry) => entry.label)).toEqual(['1', '2', '3']);
    expect(fix.tail!.map((def) => def.attrs.label)).toEqual(['1', '2', '3']);
    expect(fix.tail!.map((def) => def.textContent)).toEqual(['', 'one', 'two']);
    expect([...fix.mapping]).toEqual([
      [footnoteKey('3'), '1'],
      [footnoteKey('1'), '2'],
      [footnoteKey('2'), '3'],
    ]);
  });
});

describe('§3.4 · agent edits keep footnotes intact', () => {
  it('a fragment read against the document’s notes keeps `[^1]` a marker', () => {
    const plain = parseFragment('Rewritten[^1] sentence.');
    expect(labelsOf(plain).refs).toEqual([]);
    const read = parseFragment('Rewritten[^1] sentence.', ['1']);
    expect(labelsOf(read).refs).toEqual(['1']);
    // The stub note is taken out again: the fragment is one paragraph.
    expect(read.childCount).toBe(1);
  });

  it('a fragment that ends in an unclosed fence keeps its blocks; the stubs are not cut by count', () => {
    const fenced = parseFragment('```\ncode that never closes', ['1', '2']);
    expect(fenced.childCount).toBe(1);
    expect(fenced.firstChild!.type.name).toBe('code_block');
    expect(fenced.textContent).toBe('code that never closes');
    const tail = parseFragment('Intro[^1].\n\n```\nopen', ['1']);
    expect(tail.childCount).toBe(2);
    expect(tail.child(1).type.name).toBe('code_block');
    expect(tail.child(1).textContent).toBe('open');
    // The stubs did not come back out cleanly, so the fragment is read on its own: the marker degrades to text.
    expect(labelsOf(tail).refs).toEqual([]);
    expect(tail.child(0).textContent).toBe('Intro[^1].');
  });

  it('a fragment that ends in an open raw HTML block keeps its blocks', () => {
    const html = parseFragment('Lead[^1].\n\n<pre>\nraw', ['1']);
    expect(html.textContent).toContain('raw');
    expect(html.textContent).not.toContain('caotang-fragment-stub');
  });

  it('a `[^1]:` line inside a code block is not the fragment’s own note, so `[^1]` stays a marker', () => {
    const read = parseFragment('Kept[^1] marker.\n\n```\n[^1]: not a note\n```', ['1']);
    expect(labelsOf(read).refs).toEqual(['1']);
    expect(read.childCount).toBe(2);
    expect(read.child(1).type.name).toBe('code_block');
  });

  it('a label the fragment defines itself is not stubbed, and duplicate labels stub once', () => {
    const own = parseFragment('Text[^1].\n\n[^1]: Its own note.', ['1', '1', '2']);
    expect(labelsOf(own)).toEqual({ refs: ['1'], notes: ['1'] });
  });

  it('`insertionOf` inserts the marker inline, and a rewritten note as its text', () => {
    const inline = insertionOf('Rewritten[^1] sentence. ', caotangSchema, ['1']);
    expect(inline.openStart).toBe(0);
    const names: string[] = [];
    inline.content.forEach((node) => names.push(node.type.name));
    expect(names).toEqual(['text', 'footnote_reference', 'text']);
    const note = insertionOf('[^1]: A better note.', caotangSchema, ['1']);
    const blocks: string[] = [];
    note.content.forEach((node) => blocks.push(node.type.name));
    expect(blocks).toEqual(['text']);
    expect(note.content.textBetween(0, note.content.size)).toBe('A better note.');
  });

  it('an anchor whose range holds a marker resolves, and a store-side splice keeps the footnote', async () => {
    const body = 'The ferry was late[^1], as always. She counted the boats.\n\n[^1]: The Marta.\n';
    const exact = 'The ferry was late[^1], as always.';
    const from = body.indexOf(exact);
    const anchor = { from, to: from + exact.length, exact, prefix: '', suffix: body.slice(from + exact.length, from + exact.length + 32), capturedRevision: 1 };
    const resolution = resolveAnchor(anchor, body, 1);
    expect(resolution.status).toBe('ok');
    if (resolution.status !== 'ok') return;
    const replaced = `${body.slice(0, resolution.range.from)}The ferry came in late[^1], on the second bell.${body.slice(resolution.range.to)}`;
    const { doc, dialect } = await parseWithDiagnostics(replaced);
    expect(labelsOf(doc)).toEqual({ refs: ['1'], notes: ['1'] });
    expect(dialect).toEqual([]);
    expect(serialize(doc)).toBe(replaced);
  });

  it('the projection map clamps on a marker and a note label, and maps the text around them exactly', async () => {
    const body = 'Before[^1] after.\n\n[^1]: Note text.\n';
    const doc = await parse(body);
    const map = buildProjectionMap(doc);
    expect(map.body).toBe(body);
    expect(map.unlocated).toEqual([]);
    const texts = map.runs.map((run) => body.slice(run.bodyStart, run.bodyEnd));
    expect(texts).toEqual(['Before', ' after.', 'Note text.']);
  });
});
