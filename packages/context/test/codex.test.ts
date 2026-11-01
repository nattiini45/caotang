/**
 * The codex layer as the prompt shows it (codex.md §5–§6, context-assembly §2 L2): which
 * entries a call sends, why, and why the others are not sent.
 */
import { describe, expect, it } from 'vitest';
import { textOf } from '@caotang/gateway';

import { assemble, type AgentTask, type AssembledPrompt, type LayerId } from '../src/index.js';
import { TAIL, buildApp, FOCUS_ID, IDS, heavyAlwaysApp } from './fixtures.js';

const CONTINUE: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene: Elena argues with Captain Hale about the lighthouse light.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

const DRAFT_EMPTY: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Draft the storm chapter.',
  mode: 'draft',
  focus: IDS.ch4,
};

function layer(assembled: AssembledPrompt, id: LayerId) {
  const report = assembled.layers.find((candidate) => candidate.id === id);
  if (report === undefined) throw new Error(`no ${id} report`);
  return report;
}

function codexSection(text: string): string {
  return text.slice(text.indexOf('# Codex'), text.indexOf('# Structure'));
}

describe('the include policies, as the prompt shows them (codex.md §5)', () => {
  it('always: sent with no mention at all', () => {
    const assembled = assemble(DRAFT_EMPTY, buildApp());
    expect(layer(assembled, 'L2').kept.map((item) => [item.label, item.reason])).toEqual([['Harbor', 'always']]);
    expect(codexSection(textOf(assembled.messages[1]?.content ?? ''))).toContain('## Harbor (location)');
  });

  it('detected: sent when a name or alias is mentioned, with the surfaces and the count', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const reasons = Object.fromEntries(layer(assembled, 'L2').kept.map((item) => [item.label, item.reason]));
    // The count is the surviving occurrences in the instruction and the tail (codex.md §4, rule 6).
    // The tail is the last 3,000 characters of the chapter, so a mention earlier in the chapter is
    // not counted: the one "lighthouse" in CH3 is in its opening, outside the tail.
    const inTail = (word: RegExp) => (TAIL.match(word) ?? []).length;
    expect(reasons['Elena']).toBe(`matched ×${inTail(/Elena/g) + 1} in instruction, tail`);
    expect(reasons['Captain Hale']).toBe(`matched ×${inTail(/Captain Hale/g) + 1} in instruction, tail`);
    expect(inTail(/\blighthouse\b/gi)).toBe(0);
    expect(reasons['Lighthouse']).toBe('matched ×1 in instruction');
  });

  it('detected: a name mentioned only before the tail, and not in the instruction, sends nothing', () => {
    // The chapter's one "lighthouse" is in its opening, outside the tail, and the instruction does
    // not name it. So the entry is not detected; Elena, in the tail, still is.
    const assembled = assemble({ ...CONTINUE, instruction: 'Write the next scene.' }, buildApp());
    const sent = layer(assembled, 'L2').kept.map((item) => item.label);
    expect(sent).not.toContain('Lighthouse');
    expect(sent).toContain('Elena');
  });

  it('detected: not sent when nothing in its detection surfaces names it', () => {
    const assembled = assemble(DRAFT_EMPTY, buildApp());
    expect(layer(assembled, 'L2').kept.map((item) => item.label)).not.toContain('Elena');
    expect(layer(assembled, 'L2').dropped).toEqual([]);
  });

  it('never: never sent, and named as dropped when it was mentioned', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const text = assembled.messages[1]?.content ?? '';
    expect(layer(assembled, 'L2').dropped).toContain('Wolf: disabled by include policy (never)');
    expect(text).not.toContain('## Wolf');
    expect(text).not.toContain('PRIVATE');
  });

  it('manual: sent only when attached to the focus scope, and the reason says where', () => {
    const assembled = assemble(CONTINUE, buildApp());
    expect(layer(assembled, 'L2').kept.find((item) => item.label === 'Mara')?.reason).toBe('attached to Act I');
  });

  it('manual: not sent, and named as dropped, when mentioned outside the focus scope', () => {
    const assembled = assemble(CONTINUE, buildApp());
    expect(layer(assembled, 'L2').dropped).toContain('Silver Gull: manual policy, not attached to the focus');
    expect(assembled.messages[1]?.content ?? '').not.toContain('## Silver Gull');
  });

  it('manual: an entry attached elsewhere is simply absent when the focus is not in its scope', () => {
    const assembled = assemble(DRAFT_EMPTY, buildApp());
    expect(assembled.messages[1]?.content ?? '').not.toContain('## Mara');
  });

  it('an empty description is dropped even when the entry matched (codex.md §2)', () => {
    const assembled = assemble(CONTINUE, buildApp());
    expect(layer(assembled, 'L2').dropped).toContain('Fog Law: empty description');
    expect(assembled.messages[1]?.content ?? '').not.toContain('## Fog Law');
  });

  it('renders entries in codex order: always first, then type, then name', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const headings = codexSection(textOf(assembled.messages[1]?.content ?? '')).match(/^## .+$/gm) ?? [];
    expect(headings).toEqual([
      '## Harbor (location)',
      '## Captain Hale (character)',
      '## Elena (character)',
      '## Mara (character)',
      '## Lighthouse (location)',
    ]);
  });

  it('never sends aliases: they are detection keys, not payload (codex.md §6 step 4)', () => {
    const assembled = assemble(CONTINUE, buildApp());
    expect(assembled.messages[1]?.content ?? '').not.toContain('Ellie');
  });
});

describe('the scope of a continuity scan', () => {
  it('reaches a manual entry attached to any scoped folder, and names that folder', () => {
    const assembled = assemble(
      { tool: 'continuity.scan', instruction: 'Find drift.', scope: [IDS.ch3, IDS.ch5] },
      buildApp(),
    );
    const reasons = Object.fromEntries(layer(assembled, 'L2').kept.map((item) => [item.label, item.reason]));
    expect(reasons['Mara']).toBe('attached to Act I');
    expect(reasons['Silver Gull']).toBe('attached to Chapter 5');
  });

  it('does not reach an entry attached to a folder the scope never touches', () => {
    const assembled = assemble(
      { tool: 'continuity.scan', instruction: 'Find drift.', scope: [IDS.ch4, IDS.ch5] },
      buildApp(),
    );
    expect(layer(assembled, 'L2').kept.map((item) => item.label)).not.toContain('Mara');
  });
});

describe('the mention cache (codex.md §4)', () => {
  it('gives the same prompt whether or not the call reads the cache', () => {
    const cold = assemble(CONTINUE, buildApp());
    const warm = assemble(CONTINUE, buildApp({ mentions: true }));
    expect(warm.messages).toEqual(cold.messages);
  });

  it('gives the same continuity prompt when the scope bodies come from the cache', () => {
    const task: AgentTask = {
      tool: 'continuity.scan',
      instruction: 'Find drift in Act I.',
      scope: [IDS.ch1, IDS.ch2, IDS.ch3],
    };
    const cold = assemble(task, buildApp());
    const warm = assemble(task, buildApp({ mentions: true }));
    expect(warm.messages).toEqual(cold.messages);
    expect(layer(warm, 'L2').kept).toEqual(layer(cold, 'L2').kept);
  });
});

describe('the always entries are reserved before the rest of the layer is fitted (context-assembly A3)', () => {
  // Four always rules of 1,200 characters, about 300 tokens each, with Harbor: well over the 1,000-token budget.
  const OVER = 1_000;

  it('sends every always entry whole when they alone exceed the layer, and says so in a note', () => {
    const assembled = assemble(CONTINUE, heavyAlwaysApp(4, 1_200));
    const codex = layer(assembled, 'L2');
    const always = codex.kept.filter((item) => item.reason === 'always').map((item) => item.label);
    expect(always.sort()).toEqual(['Harbor', 'Rule 1', 'Rule 2', 'Rule 3', 'Rule 4']);
    const text = codexSection(textOf(assembled.messages[1]?.content ?? ''));
    for (const label of always) expect(text).toContain(`## ${label} (`);
    expect(text).toContain(`Rule 4: ${'w'.repeat(1_200)}`);
    expect(codex.tokens).toBeGreaterThan(OVER);
    expect(codex.notes).toEqual([
      expect.stringMatching(/^the codex's always entries need [\d,]+ tokens; the layer's budget is 1,000\. They are sent whole, and no other codex entry is\.$/),
    ]);
  });

  it('names the overflow in the drop list, once, and not as a bare budget cut of an always entry', () => {
    const codex = layer(assemble(CONTINUE, heavyAlwaysApp(4, 1_200)), 'L2');
    const overflow = codex.drops.filter((drop) => drop.reason.kind === 'reserve-overflow');
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.label).toBe('always entries');
    expect(overflow[0]?.reason).toMatchObject({ kind: 'reserve-overflow', layer: 'L2', budget: OVER });
    const budgetCuts = codex.drops.filter((drop) => drop.reason.kind === 'budget').map((drop) => drop.label);
    expect(budgetCuts).toEqual(['Captain Hale', 'Elena', 'Lighthouse', 'Mara']);
  });

  it('cuts the detected and manual entries for the budget, with the existing reason', () => {
    const codex = layer(assemble(CONTINUE, heavyAlwaysApp(4, 1_200)), 'L2');
    expect(codex.dropped).toContain('Elena: dropped budget (L2, 1000 tokens, rank 7)');
  });

  it('adds no overflow when the always entries fit', () => {
    const codex = layer(assemble(CONTINUE, buildApp()), 'L2');
    expect(codex.notes).toEqual([]);
    expect(codex.drops.some((drop) => drop.reason.kind === 'reserve-overflow')).toBe(false);
  });

  it('leaves the always entries in the prompt when the whole prompt is over, and reports it', () => {
    const assembled = assemble(CONTINUE, heavyAlwaysApp(4, 1_200), { contextBudget: 500 });
    expect(assembled.overBudget).toBe(true);
    const codex = layer(assembled, 'L2');
    expect(codex.kept.filter((item) => item.reason === 'always')).toHaveLength(5);
    expect(codex.notes.at(-1)).toBe('The prompt is over the total budget: the always entries are never cut to reach it.');
  });
});
