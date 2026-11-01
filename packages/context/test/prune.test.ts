/**
 * Prune determinism (context-assembly §2 and §4, codex.md §6 step 5). The drop list is part
 * of the prompt preview and of the eval fixtures, so it must be a function of the entries and
 * the budget alone: the same entries in any order give the same list, every time.
 */
import { describe, expect, it } from 'vitest';

import { assemble, type AgentTask, type AppSnapshot, type AssembledPrompt, type ContextConfig, type LayerId } from '../src/index.js';
import { buildApp, CODEX, FOCUS_ID, heavyAlwaysApp } from './fixtures.js';
import { textOf } from '@caotang/gateway';

const CONTINUE: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene: Elena argues with Captain Hale about the lighthouse light.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

function layer(assembled: AssembledPrompt, id: LayerId) {
  const report = assembled.layers.find((candidate) => candidate.id === id);
  if (report === undefined) throw new Error(`no ${id} report`);
  return report;
}

/** The app with its codex in a rotated order. The entries are the same; only their order moves. */
function rotatedApp(by: number): AppSnapshot {
  const app = buildApp();
  const codex = app.state.manifest.codex ?? [];
  const rotated = [...codex.slice(by), ...codex.slice(0, by)];
  return { ...app, state: { ...app.state, manifest: { ...app.state.manifest, codex: rotated } } };
}

describe('a tiny codex budget gives one stable drop list', () => {
  const TINY: ContextConfig = { layerBudgets: { L2: 30 } };

  it('keeps the always entry and names each budget cut, in rank order, after the suppressions', () => {
    const codex = layer(assemble(CONTINUE, buildApp(), TINY), 'L2');
    expect(codex.kept.map((item) => item.label)).toEqual(['Harbor']);
    expect(codex.dropped).toEqual([
      'Silver Gull: manual policy, not attached to the focus',
      'Wolf: disabled by include policy (never)',
      'Fog Law: empty description',
      'Captain Hale: dropped budget (L2, 30 tokens, rank 2)',
      'Elena: dropped budget (L2, 30 tokens, rank 3)',
      'Lighthouse: dropped budget (L2, 30 tokens, rank 4)',
      'Mara: dropped budget (L2, 30 tokens, rank 5)',
    ]);
  });

  it('gives the same list on every run', () => {
    const first = layer(assemble(CONTINUE, buildApp(), TINY), 'L2').dropped;
    for (let run = 0; run < 3; run += 1) {
      expect(layer(assemble(CONTINUE, buildApp(), TINY), 'L2').dropped).toEqual(first);
    }
  });

  it('gives the same list however the codex was written', () => {
    const expected = layer(assemble(CONTINUE, buildApp(), TINY), 'L2').dropped;
    expect(layer(assemble(CONTINUE, buildApp({ shuffled: true }), TINY), 'L2').dropped).toEqual(expected);
    for (const by of [1, 2, 3, CODEX.length - 1]) {
      expect(layer(assemble(CONTINUE, rotatedApp(by), TINY), 'L2').dropped).toEqual(expected);
    }
  });

  it('gives the same prompt bytes however the codex was written', () => {
    const expected = assemble(CONTINUE, buildApp(), TINY).messages;
    expect(assemble(CONTINUE, buildApp({ shuffled: true }), TINY).messages).toEqual(expected);
    expect(assemble(CONTINUE, rotatedApp(4), TINY).messages).toEqual(expected);
  });
});

describe('the total-budget pass (§2): what goes first when the whole prompt is over', () => {
  const full = assemble(CONTINUE, buildApp());
  const total = full.estimate.promptTokens;

  it('takes the recent turns whole before anything else, and keeps their section to say so', () => {
    const budget = total - 1;
    const assembled = assemble(CONTINUE, buildApp(), { contextBudget: budget });
    // The section stays, with no turn in it: the model is told the turns were not sent.
    expect(layer(assembled, 'L6').included).toBe(true);
    expect(layer(assembled, 'L6').kept).toEqual([]);
    expect(textOf(assembled.messages[1]?.content ?? '')).toContain('# Recent turns\n\n(older turns were not sent)');
    // Reports list drops in rank order: the newest turn is rank 1.
    expect(layer(assembled, 'L6').drops.map((drop) => [drop.label, drop.reason])).toEqual([
      ['turn t_3', { kind: 'total-budget', layer: 'L6', total: budget, rank: 1 }],
      ['turn t_2', { kind: 'total-budget', layer: 'L6', total: budget, rank: 2 }],
    ]);
    expect(layer(assembled, 'L6').notes).toEqual([
      "1 earlier turn is not sent; the agent's tools can read them back.",
      '2 turns are not sent: the total prompt budget was reached.',
    ]);
    expect(layer(assembled, 'L2').kept).toHaveLength(layer(full, 'L2').kept.length);
    expect(assembled.overBudget).toBe(false);
  });

  it('then takes the codex from the bottom, attached entries before detected ones', () => {
    // The turns' section stays after they are cut, and its line counts toward the prompt. So the
    // prompt with the turns cut is the base, and the budget sits a few tokens under it: the pass
    // has to go on into the codex, and the attached entry is the first one it reaches.
    const afterTurns = assemble(CONTINUE, buildApp(), { contextBudget: total - 1 }).estimate.promptTokens;
    const budget = afterTurns - 4;
    const assembled = assemble(CONTINUE, buildApp(), { contextBudget: budget });
    expect(layer(assembled, 'L6').kept).toEqual([]);
    const codexCuts = layer(assembled, 'L2').drops.filter((drop) => drop.reason.kind === 'total-budget');
    expect(codexCuts.map((drop) => drop.label)).toEqual(['Mara']);
    expect(layer(assembled, 'L2').kept.map((item) => item.label)).toEqual(['Harbor', 'Captain Hale', 'Elena', 'Lighthouse']);
    expect(assembled.estimate.promptTokens).toBeLessThanOrEqual(budget);
  });

  it('at the lowest budget it can meet, keeps the always entry and nothing droppable beyond it', () => {
    let low = 0;
    let high = total;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (assemble(CONTINUE, buildApp(), { contextBudget: middle }).overBudget) low = middle + 1;
      else high = middle;
    }
    const floor = assemble(CONTINUE, buildApp(), { contextBudget: low });
    expect(floor.overBudget).toBe(false);
    expect(layer(floor, 'L6').kept).toEqual([]);
    expect(layer(floor, 'L2').kept.map((item) => item.label)).toEqual(['Harbor']);
    expect(layer(floor, 'L4').kept).toEqual([]);
    expect(layer(floor, 'L3').kept).toEqual([]);
    // The fixed layers are never touched by the pass.
    for (const id of ['L0', 'L1', 'L5', 'L7'] as const) {
      expect(layer(floor, id).included).toBe(true);
      expect(layer(floor, id).tokens).toBe(layer(full, id).tokens);
    }
  });

  it('removes nothing when the lowest reachable budget is still not met, and says the prompt is over', () => {
    const assembled = assemble(CONTINUE, buildApp(), { contextBudget: 300 });
    expect(assembled.overBudget).toBe(true);
    expect(assembled.estimate.promptTokens).toBeGreaterThan(300);
    for (const report of assembled.layers) {
      expect(report.drops.some((drop) => drop.reason.kind === 'total-budget')).toBe(false);
    }
    expect(layer(assembled, 'L6').included).toBe(true);
    expect(layer(assembled, 'L2').kept).toHaveLength(layer(full, 'L2').kept.length);
  });
});

describe('the reserved fit is the flat prune when the always entries fit (context-assembly A3)', () => {
  it('keeps the same entries, drop list and prompt bytes as the flat fit at every budget where Harbor fits', () => {
    // 25 tokens is the fewest the layer can hold with Harbor in it; below that the always entry overflows.
    for (const budget of [25, 30, 40, 60, 90, 130, 200, 1_000, 2_500]) {
      const assembled = assemble(CONTINUE, buildApp(), { layerBudgets: { L2: budget } });
      const codex = layer(assembled, 'L2');
      expect(codex.drops.some((drop) => drop.reason.kind === 'reserve-overflow'), `budget ${budget}`).toBe(false);
      expect(codex.tokens, `budget ${budget}`).toBeLessThanOrEqual(budget);
      // The flat prune keeps the longest rank prefix that fits: every cut entry ranks below every kept one.
      const cuts = codex.drops.filter((drop) => drop.reason.kind === 'budget');
      const ranks = cuts.map((drop) => (drop.reason.kind === 'budget' ? drop.reason.rank : 0));
      expect(ranks, `budget ${budget}`).toEqual(Array.from({ length: ranks.length }, (_, index) => codex.kept.length + index + 1));
    }
  });

  it('fits the detected and manual entries into what the always entries leave', () => {
    const app = () => heavyAlwaysApp(1, 400);
    // A budget of one token cannot hold the always entries, so the layer is exactly the reservation.
    const reserved = layer(assemble(CONTINUE, app(), { layerBudgets: { L2: 1 } }), 'L2');
    expect(reserved.kept.map((item) => item.reason)).toEqual(['always', 'always']);
    const budget = reserved.tokens + 30;
    const fitted = layer(assemble(CONTINUE, app(), { layerBudgets: { L2: budget } }), 'L2');
    expect(fitted.kept.slice(0, 2)).toEqual(reserved.kept);
    expect(fitted.kept.length).toBeGreaterThan(2);
    expect(fitted.tokens).toBeLessThanOrEqual(budget);
    expect(fitted.drops.some((drop) => drop.reason.kind === 'reserve-overflow')).toBe(false);
  });
});

describe('the overflow case is deterministic', () => {
  const heavy = (rotate = 0) => heavyAlwaysApp(4, 1_200, rotate);

  it('gives the same kept set, notes and prompt bytes on every run', () => {
    const first = assemble(CONTINUE, heavy());
    const again = assemble(CONTINUE, heavy());
    expect(again.messages).toEqual(first.messages);
    expect(layer(again, 'L2').notes).toEqual(layer(first, 'L2').notes);
    expect(layer(again, 'L2').dropped).toEqual(layer(first, 'L2').dropped);
  });

  it('gives the same result however the codex was written', () => {
    const expected = assemble(CONTINUE, heavy());
    for (const by of [1, 2, 5, 9]) {
      const rotated = assemble(CONTINUE, heavy(by));
      expect(rotated.messages).toEqual(expected.messages);
      expect(layer(rotated, 'L2').notes).toEqual(layer(expected, 'L2').notes);
      expect(layer(rotated, 'L2').dropped).toEqual(layer(expected, 'L2').dropped);
      expect(layer(rotated, 'L2').kept).toEqual(layer(expected, 'L2').kept);
    }
  });
});
