/**
 * The offset bridge's two measured defects, and the mechanism that replaced the quadratic one.
 *
 * - **Offsets in a block's leading syntax**. `textPositionFor` returned a
 *   position before the first text run for such offsets: `-1` for `# Title`, a container
 *   position for `- one`. Every offset from 0 to the first run's start must now be a text
 *   position at that run's start.
 * - **Block spans from one render**. `buildProjectionMap` used to serialize every
 *   prefix of the document, which is quadratic. The spans now come from one save-path render
 *   and a single pass over the body. The prefix algorithm is kept as the oracle, and the two must
 *   agree wherever the document has no empty block (where the spans are defined differently, and
 *   the partition is asserted instead).
 */
import { describe, expect, it } from 'vitest';
import type { Node as PmNode } from '@tiptap/pm/model';
import { CORPUS } from '@caotang/editor-audit';
import { buildProjectionMap, parse, pmFromBodyOffset, serialize, textPositionFor } from '../src/index.js';
import type { ProjectionBlock } from '../src/index.js';
import { prefixBlockSpans } from '../src/seam.js';

/** The first run's start, and whether the position is one text can be inserted at. */
const isTextPosition = (doc: PmNode, pos: number): boolean => {
  if (pos < 0 || pos > doc.content.size) return false;
  return doc.resolve(pos).parent.inlineContent;
};

describe('an offset in a block’s leading syntax maps to the text it precedes', () => {
  it.each([
    ['heading-first', '# Title\n\nSome text.\n'],
    ['list-first', '- one\n- two\n'],
    ['blockquote-first', '> quoted line\n\nAfter.\n'],
    ['scene-separator-first', '***\n\nSome text.\n'],
  ])('%s: every offset before the first text is a text position at that text', async (_name, body) => {
    const doc = await parse(body);
    const map = buildProjectionMap(doc);
    const first = map.runs[0]!;
    expect(first.bodyStart).toBeGreaterThan(0);
    for (let offset = 0; offset <= first.bodyStart; offset++) {
      const pos = textPositionFor(map, offset);
      expect(pos, `offset ${offset} of ${JSON.stringify(body)}`).toBe(first.pmFrom);
      expect(isTextPosition(doc, pos!), `offset ${offset} is a text position`).toBe(true);
    }
  });

  it('the positions are never negative, which the arithmetic used to produce for `# Title`', async () => {
    const doc = await parse('# Title\n\nSome text.\n');
    const map = buildProjectionMap(doc);
    for (let offset = 0; offset < map.body.length; offset++) {
      const pos = textPositionFor(map, offset);
      expect(pos).not.toBeNull();
      expect(pos!).toBeGreaterThanOrEqual(0);
    }
  });
});

/** A top-level block's span must hold its own text, and the spans must tile the body. */
const expectPartition = (blocks: readonly ProjectionBlock[], body: string, label: string): void => {
  if (blocks.length === 0) return;
  expect(blocks[0]!.bodyStart, `${label}: first span starts at 0`).toBe(0);
  for (const [i, block] of blocks.entries()) {
    expect(block.bodyEnd, `${label}: block ${i} is not inverted`).toBeGreaterThanOrEqual(block.bodyStart);
    if (i > 0) expect(block.bodyStart, `${label}: block ${i} follows block ${i - 1}`).toBe(blocks[i - 1]!.bodyEnd);
  }
  expect(blocks[blocks.length - 1]!.bodyEnd, `${label}: last span ends at the body's end`).toBe(body.length);
};

/** Whether any top-level block of `doc` serializes to nothing at all. */
const hasEmptyBlock = (doc: PmNode): boolean => {
  let empty = false;
  doc.forEach((block) => {
    if (block.textContent.length === 0 && block.type.name !== 'horizontal_rule') empty = true;
  });
  return empty;
};

describe('block spans come from one render, and agree with the prefix algorithm', () => {
  it('the spans equal the prefix algorithm’s, block for block, on every corpus entry without an empty block', async () => {
    let compared = 0;
    for (const entry of CORPUS) {
      let doc: PmNode;
      try {
        doc = await parse(entry.input);
      } catch {
        continue;
      }
      const body = serialize(doc);
      const fast = buildProjectionMap(doc).blocks;
      expectPartition(fast, body, entry.name);
      if (hasEmptyBlock(doc)) continue;
      const oracle = prefixBlockSpans(doc, body);
      expect(
        fast.map(({ bodyStart, bodyEnd }) => ({ bodyStart, bodyEnd })),
        `${entry.name}: spans`,
      ).toEqual(oracle.map(({ bodyStart, bodyEnd }) => ({ bodyStart, bodyEnd })));
      compared += 1;
    }
    // The control: a comparison over nothing is green for no reason.
    expect(compared).toBeGreaterThan(20);
  });

  it('the spans equal the prefix algorithm’s on a longer document of mixed blocks, with adjacent lists', async () => {
    const parts: string[] = [];
    for (let i = 0; i < 60; i++) {
      parts.push(`# Heading ${i}`, `Paragraph ${i} with *emphasis* and **strong**.`, `- item ${i}a\n- item ${i}b`, `> quote ${i}`);
    }
    parts.push('- last list\n\n* adjacent list');
    const body = parts.join('\n\n') + '\n';
    const doc = await parse(body);
    const oracle = prefixBlockSpans(doc, serialize(doc));
    const fast = buildProjectionMap(doc).blocks;
    expect(fast.map(({ bodyStart, bodyEnd }) => ({ bodyStart, bodyEnd }))).toEqual(
      oracle.map(({ bodyStart, bodyEnd }) => ({ bodyStart, bodyEnd })),
    );
    expect(fast.length).toBeGreaterThan(200);
    // The oracle re-serialises every prefix, so it is quadratic by design: ~2 s alone,
    // past vitest's 5 s default when the whole suite shares the machine. Same budget
    // rule as the 400-block dialect fixtures.
  }, 30_000);

  it('empty blocks keep the partition, so an empty paragraph between two others is an empty span', async () => {
    // Built directly: a Markdown body cannot carry an empty paragraph, and the editor can make one.
    const doc = await parse('One.\n\nTwo.\n');
    const schema = doc.type.schema;
    const built = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, [schema.text('One.')]),
      schema.nodes.paragraph!.create(),
      schema.nodes.paragraph!.create(null, [schema.text('Two.')]),
    ]);
    const body = serialize(built);
    const blocks = buildProjectionMap(built).blocks;
    expectPartition(blocks, body, 'empty middle paragraph');
    expect(blocks[1]!.bodyEnd).toBe(blocks[1]!.bodyStart);
  });
});

describe('a backslash inside a fenced code block', () => {
  // §5's backslash is an inline Markdown escape; remark writes fenced content
  // literally, so `a\b` in a fence is three body characters and three text
  // characters. Segmenting it as an escape consumes a body character with no text
  // character, so every run after it maps one character to the left — a
  // self-consistent wrong range that the anchor ladder cannot detect, because it
  // verifies the anchor against the same shifted map.
  it('maps 1:1 across the backslash, so a round trip returns the offset it started from', async () => {
    const body = '```\na\\b c\n```\n';
    const doc = await parse(body);
    const map = buildProjectionMap(doc);
    expect(map.body).toContain('a\\b c');
    for (const run of map.runs) {
      expect(run.bodyEnd - run.bodyStart, 'run lengths agree').toBe(run.pmTo - run.pmFrom);
    }
    const start = map.body.indexOf('a\\b');
    for (let offset = start; offset < start + 'a\\b c'.length; offset++) {
      // The character at this body offset and the character at the PM position it
      // maps to must be the same one. A round trip through `bodyOffsetFromPmPos`
      // would be ambiguous at a character boundary (the position *before* `b` is
      // also the position *after* the backslash), so the character is compared.
      const pos = pmFromBodyOffset(map, offset);
      expect(doc.textBetween(pos, pos + 1), `offset ${offset} of ${JSON.stringify(map.body)}`).toBe(
        map.body[offset],
      );
    }
  });

  it('covers an inline code mark the same way: backslashes are literal there too', async () => {
    // The identity rule (`spelling === text` means no escapes were consumed) is
    // what the fix rests on, so it must hold for both fenced blocks and `code`
    // marks — remark writes neither's backslashes as escapes.
    const body = 'intro `a\\bc def` outro\n';
    const doc = await parse(body);
    const map = buildProjectionMap(doc);
    const start = map.body.indexOf('a\\bc');
    expect(start).toBeGreaterThan(0);
    for (let offset = start; offset < start + 'a\\bc def'.length; offset++) {
      const pos = pmFromBodyOffset(map, offset);
      expect(doc.textBetween(pos, pos + 1), `offset ${offset} of ${JSON.stringify(map.body)}`).toBe(
        map.body[offset],
      );
    }
  });

  it('still segments an escaped leaf outside a fence, where the backslash is syntax', async () => {
    // The control: the same characters in a paragraph are an escape, so the body
    // holds four characters for three text characters and the runs must skip it.
    const doc = await parse('a\\*b\n');
    const map = buildProjectionMap(doc);
    expect(map.body).toContain('a\\*b');
    const runs = map.runs.filter((run) => run.bodyStart >= map.body.indexOf('a\\*b'));
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) expect(run.bodyEnd - run.bodyStart).toBe(run.pmTo - run.pmFrom);
  });
});
