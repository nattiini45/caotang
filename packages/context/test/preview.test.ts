/**
 * The prompt preview (context-assembly §5 and §7). The central claim is "zero drift between
 * preview and execution", and the strongest test of it sends the preview's payload through
 * the gateway's mock provider and checks what the provider recorded.
 */
import { modelRowFor, presetFor } from '@caotang/gateway';
import { createMockProvider } from '@caotang/gateway/mock';
import { describe, expect, it } from 'vitest';

import { assemble, buildPreview, toChatMessages, type AgentTask, type ContextConfig } from '../src/index.js';
import { FOCUS_ID, IDS, TAIL, buildApp, scopeApp } from './fixtures.js';

const CONTINUE: AgentTask = {
  tool: 'scene.draft',
  instruction: 'Write the next scene: Elena argues with Captain Hale about the lighthouse light.',
  mode: 'continue',
  focus: FOCUS_ID,
  params: { doc: FOCUS_ID, mode: 'continue' },
};

/** context-assembly §7's number: 1.3k, 8k, 12k. Written out here, not imported, so the test states it. */
function kTokens(tokens: number): string {
  const tenths = Math.round(tokens / 100) / 10;
  return Number.isInteger(tenths) ? `${tenths}k` : `${tenths.toFixed(1)}k`;
}

describe('zero drift between preview and execution (§5)', () => {
  it('the payload the gateway receives is the payload the preview shows, byte for byte', async () => {
    const assembled = assemble(CONTINUE, buildApp());
    const preview = buildPreview(assembled);

    const provider = createMockProvider();
    for await (const chunk of provider.complete({ messages: toChatMessages(assembled) })) {
      expect(chunk).toBeDefined();
    }
    const sent = provider.calls[0]?.messages;
    expect(sent).toBeDefined();
    expect(JSON.stringify(sent)).toBe(JSON.stringify(preview.payload));
  });

  it('the preview reads the assembly and nothing else: the same object gives the same preview', () => {
    const assembled = assemble(CONTINUE, buildApp());
    expect(buildPreview(assembled)).toEqual(buildPreview(assembled));
  });

  it('the preview token counts are the assembly’s', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const preview = buildPreview(assembled);
    expect(preview.promptTokens).toBe(assembled.estimate.promptTokens);
    expect(preview.layers.map((layer) => layer.tokens)).toEqual(assembled.layers.map((layer) => layer.tokens));
    expect(preview.layers.map((layer) => layer.included)).toEqual(assembled.layers.map((layer) => layer.included));
  });

  it('shows each budgeted layer against its budget, as a fraction', () => {
    const assembled = assemble(CONTINUE, buildApp());
    const preview = buildPreview(assembled);
    const codex = preview.layers.find((layer) => layer.id === 'L2');
    expect(codex?.budget).toBe(assembled.layers[2]?.budget);
    expect(codex?.fraction).toBeCloseTo((codex?.tokens ?? 0) / (codex?.budget ?? 1), 10);
    expect(preview.layers.find((layer) => layer.id === 'L0')?.budget).toBeUndefined();
    expect(preview.layers.find((layer) => layer.id === 'L7')?.fraction).toBeUndefined();
  });
});

describe('the codex and story sections (§5)', () => {
  it('names each codex entry that was sent, with its reason, and each dropped one with its reason', () => {
    const preview = buildPreview(assemble(CONTINUE, buildApp()));
    expect(preview.codex.included).toContainEqual({ name: 'Harbor', reason: 'always' });
    expect(preview.codex.included).toContainEqual({ name: 'Mara', reason: 'attached to Act I' });
    expect(preview.codex.dropped).toContainEqual({ name: 'Wolf', reason: 'disabled by include policy (never)' });
    expect(preview.codex.dropped).toContainEqual({ name: 'Fog Law', reason: 'empty description' });
  });

  it('lists the earlier scenes that were sent, and counts none omitted when the budget held them', () => {
    const preview = buildPreview(assemble(CONTINUE, buildApp()));
    expect(preview.storySoFar).toEqual({ included: ['Chapter 1', 'Chapter 2'], omittedOlder: 0 });
  });

  it('counts the older scenes a budget dropped, and not the later ones withheld by policy', () => {
    const preview = buildPreview(assemble(CONTINUE, buildApp(), { layerBudgets: { L3: 0, L4: 0 } }));
    expect(preview.storySoFar).toEqual({ included: [], omittedOlder: 2 });
  });
});

describe('the focus summary (§5)', () => {
  it('shows the first 120 characters of the text sent, then the count', () => {
    const preview = buildPreview(assemble(CONTINUE, buildApp()));
    expect(preview.focus?.summary).toBe(`${TAIL.slice(0, 120)}… (3,000 chars)`);
    expect(preview.focus?.head).toBe(TAIL.slice(0, 120));
  });

  it('says so when no document text was sent', () => {
    const draft = assemble({ tool: 'scene.draft', instruction: 'x', mode: 'draft', focus: IDS.ch4 }, buildApp());
    expect(buildPreview(draft).focus?.summary).toBe('no document text sent; the synopsis and notes stand in');
  });

  it('is absent when there is no single focus', () => {
    expect(buildPreview(assemble({ tool: 'meta', instruction: 'x' }, buildApp())).focus).toBeUndefined();
  });
});

describe('the window warning (§7)', () => {
  it('warns when the prompt is larger than the model window, with the numbers', () => {
    const config: ContextConfig = { model: { contextWindow: 1_000 } };
    const assembled = assemble(CONTINUE, buildApp(), config);
    const preview = buildPreview(assembled);
    const expected = `prompt ≈ ${kTokens(assembled.estimate.promptTokens)} tokens; model window 1k — trim codex or raise budget`;
    expect(preview.window).toEqual({ contextWindow: 1_000, warning: expected });
  });

  it('does not warn when the prompt fits, and says the window it was measured against', () => {
    const preview = buildPreview(assemble(CONTINUE, buildApp(), { model: { contextWindow: 128_000 } }));
    expect(preview.window).toEqual({ contextWindow: 128_000 });
  });

  it('measures a Claude profile’s prompt against the 1M window its preset row states, and warns past it with the numbers', () => {
    const row = modelRowFor(presetFor('anthropic')!, 'claude-sonnet-5-5');
    const config: ContextConfig = { model: { contextWindow: row?.contextWindow } };
    expect(buildPreview(assemble(CONTINUE, buildApp(), config)).window).toEqual({ contextWindow: 1_000_000 });

    // The instruction is not a budgeted layer, so a long one is what carries a prompt past the window.
    const oversize: AgentTask = { ...CONTINUE, instruction: 'word '.repeat(900_000) };
    const assembled = assemble(oversize, buildApp(), config);
    const expected = `prompt ≈ ${kTokens(assembled.estimate.promptTokens)} tokens; model window 1000k — trim codex or raise budget`;
    expect(assembled.estimate.promptTokens).toBeGreaterThan(1_000_000);
    expect(buildPreview(assembled).window).toEqual({ contextWindow: 1_000_000, warning: expected });
  });

  it('has no window section when the model reports no window', () => {
    expect(buildPreview(assemble(CONTINUE, buildApp())).window).toBeUndefined();
  });
});

describe('the drops and notes of every layer (§5, D8)', () => {
  it('carries every layer’s drops and notes, and says nothing where nothing was cut', () => {
    const preview = buildPreview(assemble(CONTINUE, buildApp()));
    expect(preview.layers.find((layer) => layer.id === 'L0')).toMatchObject({ drops: [], notes: [] });
    expect(preview.layers.find((layer) => layer.id === 'L5')).toMatchObject({ drops: [], notes: [] });
  });

  it('a continuity scope past the document limit names the limit, with each document left out', () => {
    const { app, ids } = scopeApp(22);
    const preview = buildPreview(assemble({ tool: 'continuity.scan', instruction: 'Find drift.', scope: ids }, app));
    const focus = preview.layers.find((layer) => layer.id === 'L5');
    expect(focus?.notes).toEqual(['The scope holds 22 documents; the first 20 are sent. Split the scope to cover the rest.']);
    expect(focus?.drops).toEqual([
      { label: 'Part 21', text: 'beyond the 20-document scope limit; split the scope', reason: { kind: 'scope-limit', limit: 20 } },
      { label: 'Part 22', text: 'beyond the 20-document scope limit; split the scope', reason: { kind: 'scope-limit', limit: 20 } },
    ]);
  });

  it('a total-budget cut of the recent turns is in the preview, and the prompt says the turns were not sent', () => {
    const full = assemble(CONTINUE, buildApp());
    const assembled = assemble(CONTINUE, buildApp(), { contextBudget: full.estimate.promptTokens - 1 });
    const preview = buildPreview(assembled);
    const turns = preview.layers.find((layer) => layer.id === 'L6');
    expect(turns?.included).toBe(true);
    expect(turns?.drops.map((drop) => [drop.label, drop.reason.kind])).toEqual([
      ['turn t_3', 'total-budget'],
      ['turn t_2', 'total-budget'],
    ]);
    expect(turns?.notes).toContain('2 turns are not sent: the total prompt budget was reached.');
    expect(preview.payload[1]?.content).toContain('(older turns were not sent)');
  });

  it('a budget cut in the structure layer reaches the preview with the budget named', () => {
    const preview = buildPreview(assemble(CONTINUE, buildApp(), { layerBudgets: { L3: 10 } }));
    const structure = preview.layers.find((layer) => layer.id === 'L3');
    expect(structure?.drops.length).toBeGreaterThan(0);
    for (const drop of structure?.drops ?? []) {
      expect(drop.reason).toMatchObject({ kind: 'budget', layer: 'L3', budget: 10 });
      expect(drop.text).toMatch(/^dropped budget \(L3, 10 tokens, rank \d+\)$/);
    }
  });
});

describe('the cost estimate (§5, display only)', () => {
  it('prices the prompt and the completion from pricePer1k', () => {
    const assembled = assemble(CONTINUE, buildApp(), {
      model: { pricePer1k: { prompt: 0.003, completion: 0.015 } },
    });
    const preview = buildPreview(assembled);
    const promptUsd = (assembled.estimate.promptTokens / 1_000) * 0.003;
    const completionUsd = (4_096 / 1_000) * 0.015;
    expect(preview.cost?.promptUsd).toBeCloseTo(promptUsd, 12);
    expect(preview.cost?.completionUsd).toBeCloseTo(completionUsd, 12);
    expect(preview.cost?.totalUsd).toBeCloseTo(promptUsd + completionUsd, 12);
    expect(preview.completionTokens).toBe(4_096);
  });

  it('estimates the completion from the model limit when the harness supplies one', () => {
    const assembled = assemble(CONTINUE, buildApp(), {
      model: { pricePer1k: { prompt: 0, completion: 1 }, maxOutputTokens: 1_000 },
    });
    expect(buildPreview(assembled).cost).toEqual({ promptUsd: 0, completionUsd: 1, totalUsd: 1 });
  });

  it('has no cost section without a price', () => {
    expect(buildPreview(assemble(CONTINUE, buildApp())).cost).toBeUndefined();
  });
});
