import { describe, expect, it } from 'vitest';

import { DRAFT_BROKEN, DRAFT_OK, DRAFT_WARNS, LOOSE_AND_DEAD, TAVERN } from './fixtures.js';
import { printedOnAnyPath } from './play.js';
import { beatIds, checkDraft, compileInk, findNode, layoutGraph, parseInk, planDraft, LAYOUT_COLUMN_WIDTH, LAYOUT_ROW_HEIGHT } from '../src/index.js';

describe('placing a draft', () => {
  it('writes into an empty container as the whole body', () => {
    const result = planDraft('', DRAFT_OK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe('empty');
    expect(result.plan.body).toBe(`${DRAFT_OK}\n`);
    expect(result.plan.newBeats).toEqual(['reply']);
  });

  it('places a draft after the named stitch, before the next knot, with a blank line either side', () => {
    const result = planDraft(TAVERN, DRAFT_OK, ['tavern.ale']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe('after-beat');
    expect(result.plan.anchor).toBe('tavern.ale');
    expect(result.plan.body).toContain(`-> tavern\n\n=== reply ===\nThanks for the drink.\n-> END\n\n=== leave ===`);
    expect(compileInk(result.plan.body).ok).toBe(true);
  });

  it('lands a drafted knot after its anchor knot section, so no stitch of that knot moves under the new knot', () => {
    const result = planDraft(TAVERN, DRAFT_OK, ['tavern']);
    if (!result.ok) throw new Error('the placement should succeed');
    const after = parseInk(result.plan.body).graph;
    expect(beatIds(after)).toEqual(['tavern', 'tavern.ale', 'reply', 'leave']);
    expect(findNode(after, 'tavern.ale')?.knot).toBe('tavern');
    expect(compileInk(result.plan.body).ok).toBe(true);
  });

  it('refuses content-only text after a beat, since it would sit in that beat\'s flow and not play', () => {
    const result = planDraft(TAVERN, 'A new line of talk.', ['tavern']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no-beat');
    expect(result.message).toMatch(/"tavern"/);
    expect(result.correctiveHint).toMatch(/=== name ===/);
  });

  it('refuses content-only text appended to a container that already has beats', () => {
    const result = planDraft(TAVERN, 'A new line of talk.');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no-beat');
  });

  it('accepts content-only text in an empty container, where it is the opening flow', () => {
    const result = planDraft('', 'A new line of talk.\n-> END');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe('empty');
  });

  it('appends at the end of the body when no beat is named', () => {
    const result = planDraft(TAVERN, DRAFT_OK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.mode).toBe('append');
    expect(result.plan.body.endsWith(`${DRAFT_OK}\n`)).toBe(true);
  });

  it('refuses an unknown beat and lists the knots and stitches that exist', () => {
    const result = planDraft(TAVERN, DRAFT_OK, ['missing']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown-beats');
    expect(result.message).toMatch(/"missing"/);
    expect(result.correctiveHint).toMatch(/tavern, tavern\.ale, leave/);
    expect(result.beats).toEqual(['tavern', 'tavern.ale', 'leave']);
  });

  it('plays a drafted knot that the text before it names, and prints its line', () => {
    const result = planDraft('', '-> reply\n=== reply ===\nThanks for the drink.\n-> END');
    if (!result.ok) throw new Error('the placement should succeed');
    expect(printedOnAnyPath(result.plan.body).has('Thanks for the drink.')).toBe(true);
  });

  it('appends after the last non-space character, whatever whitespace trails the body', () => {
    for (const tail of ['', '\n', '\r\n\r\n', ' \t \n ', '  ﻿ ', '   ']) {
      const body = `Hello there.${tail}`;
      const result = planDraft(body, DRAFT_OK);
      if (!result.ok) throw new Error('the placement should succeed');
      expect(result.plan.mode).toBe('append');
      expect(result.plan.insertedAt).toBe('Hello there.'.length);
      expect(result.plan.body.startsWith(`Hello there.\n\n${DRAFT_OK}`)).toBe(true);
    }
  });

  it('finds the end of a body with a very long run of spaces in linear time', () => {
    const body = `${' '.repeat(50_000)}x${' '.repeat(50_000)}y${' '.repeat(50_000)}`;
    const started = performance.now();
    const result = planDraft(body, DRAFT_OK);
    const elapsed = performance.now() - started;
    if (!result.ok) throw new Error('the placement should succeed');
    expect(result.plan.insertedAt).toBe(100_002);
    expect(elapsed).toBeLessThan(500);
  });
});

describe('checking a draft before the card', () => {
  it('blocks a candidate with a compile error, and carries the error verbatim', () => {
    const planned = planDraft(TAVERN, DRAFT_BROKEN, []);
    if (!planned.ok) throw new Error('the placement should succeed');
    const check = checkDraft(TAVERN, planned.plan.body);
    expect(check.ok).toBe(false);
    expect(check.errors[0]?.text).toMatch(/^ERROR: line \d+:/);
  });

  it('shows a warning the draft adds as a new warning, which needs approval, and lets the candidate through', () => {
    const planned = planDraft(TAVERN, DRAFT_WARNS, []);
    if (!planned.ok) throw new Error('the placement should succeed');
    const check = checkDraft(TAVERN, planned.plan.body);
    expect(check.ok).toBe(true);
    expect(check.newWarnings).toHaveLength(1);
    expect(check.newWarnings[0]).toMatch(/Apparent loose end/);
    expect(check.existingWarnings).toEqual([]);
  });

  it('does not charge a draft for a warning the base already had', () => {
    const planned = planDraft(LOOSE_AND_DEAD, DRAFT_OK, []);
    if (!planned.ok) throw new Error('the placement should succeed');
    const check = checkDraft(LOOSE_AND_DEAD, planned.plan.body);
    expect(check.ok).toBe(true);
    expect(check.newWarnings).toEqual([]);
    expect(check.existingWarnings).toHaveLength(1);
  });

  it('reports a base that already fails to compile, so the draft is not blamed for it', () => {
    const check = checkDraft(DRAFT_BROKEN, `${DRAFT_OK}\n`);
    expect(check.ok).toBe(false);
    expect(check.baseErrors.length).toBeGreaterThan(0);
  });
});

describe('the graph layout', () => {
  const layout = layoutGraph(parseInk(TAVERN).graph);

  it('puts the root on the top row and every node one row below the node that names it', () => {
    const row = (id: string): number | undefined => layout.placements.find((p) => p.id === id)?.layer;
    expect(row('(root)')).toBe(0);
    expect(row('tavern')).toBe(1);
    expect(row('tavern.ale')).toBe(2);
    expect(row('leave')).toBe(2);
  });

  it('orders the nodes within a row by body order, and places them on the grid', () => {
    expect(layout.layers[2]).toEqual(['tavern.ale', 'leave']);
    const ale = layout.placements.find((p) => p.id === 'tavern.ale');
    expect(ale).toMatchObject({ column: 0, x: 0, y: 2 * LAYOUT_ROW_HEIGHT, reached: true });
    expect(layout.placements.find((p) => p.id === 'leave')?.x).toBe(LAYOUT_COLUMN_WIDTH);
  });

  it('is deterministic: the same body lays out the same way', () => {
    expect(layoutGraph(parseInk(TAVERN).graph)).toEqual(layout);
  });

  it('places a node no path reaches in a row below the rest, marked unreached', () => {
    const dead = layoutGraph(parseInk(LOOSE_AND_DEAD).graph);
    const orphan = dead.placements.find((p) => p.id === 'orphan');
    expect(orphan?.reached).toBe(false);
    expect(orphan?.layer).toBe(Math.max(...dead.placements.filter((p) => p.reached).map((p) => p.layer)) + 1);
  });
});
