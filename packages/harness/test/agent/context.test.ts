/**
 * The context port (context-assembly §2–§5): what the harness adds to `@caotang/context`, and nothing the package
 * already owns. The layers' own rules (budgets, codex policies, drop wording) are `@caotang/context`'s and are
 * tested there. What is asserted here is the port's contract with the loop:
 *
 * - the role text is the system message, and L0 is measured on it, so the request and the card are one prompt;
 * - the earlier turns are L6, with their intents and their activity outcomes;
 * - the project is read as it is at each call, and the model's limits reach the card;
 * - a batch of calls is one card entry, summed, with its messages in order.
 */

import { describe, expect, it } from 'vitest';

import type { ActivityEntry } from '@caotang/bus';
import { DEFAULT_MAX_OUTPUT_TOKENS, tokensForChars } from '@caotang/context';
import type { CodexEntry, ProjectState } from '@caotang/store';

import { estimateTokens as codexEstimate } from '@caotang/codex';

import { createContextPort, dropLinesOf, estimateTokens, mergePreviews } from '../../src/index.js';
import { FRIEND, LANDING, STORM, makeState } from '../fixtures.js';

describe('one token estimator for the app (context-assembly §3)', () => {
  it('the harness’s estimate is the codex estimate itself, not a copy of it, and so is the context package’s', () => {
    // Identity, not equality: a second copy of `ceil(chars / 4)` would agree on every value and still be a second rule.
    expect(estimateTokens).toBe(codexEstimate);
    expect(estimateTokens('abcde')).toBe(2);
    expect(tokensForChars(5)).toBe(codexEstimate('abcde'));
  });
});

function entry(partial: Partial<CodexEntry> & Pick<CodexEntry, 'id' | 'name' | 'type' | 'description'>): CodexEntry {
  return { aliases: [], includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], origin: 'manual', sources: [], ...partial } as CodexEntry;
}

function withEntries(...entries: CodexEntry[]): ProjectState {
  const state = makeState();
  for (const item of entries) state.manifest.codex?.push(item);
  return state;
}

const ROLE = 'ROLE: the harness text that is this call’s system message.';

const meta = (instruction: string) => ({ tool: 'meta' as const, instruction });

describe('the role text is the system message, and L0 is measured on it (context-assembly §2, §5)', () => {
  it('the request is the role text, then the assembled user message, and the payload is those two messages', () => {
    const call = createContextPort({ state: makeState() }).assemble({ task: meta('Request: hello'), role: ROLE });

    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]).toEqual({ role: 'system', content: ROLE });
    expect(call.messages[1]?.role).toBe('user');
    expect(call.messages[1]?.content).toContain('Request: hello');
    expect(call.preview.payload).toEqual(call.messages);
  });

  it('L0 is measured on the role text that is sent, and the prompt estimate is the estimate of the messages sent', () => {
    const call = createContextPort({ state: makeState() }).assemble({ task: meta('Request: hello'), role: ROLE });
    const sent = call.messages.reduce((sum, message) => sum + message.content.length, 0);

    expect(call.prompt.layers.find((layer) => layer.id === 'L0')?.tokens).toBe(tokensForChars(ROLE.length));
    expect(call.prompt.estimate.byLayer.L0).toBe(tokensForChars(ROLE.length));
    expect(call.preview.promptTokens).toBe(tokensForChars(sent));
  });

  it('the completion estimate on the card is the output cap, since the reply is not known before it is sent (§5)', () => {
    const call = createContextPort({ state: makeState() }).assemble({ task: meta('Request: hello'), role: ROLE });

    expect(call.preview.completionTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});

describe('the port is the product assembler: a scene draft carries L3 and L4 (context-assembly §2)', () => {
  it('assembles the structure and the story so far, from @caotang/context and not from a local assembler', () => {
    const call = createContextPort({ state: makeState() }).assemble({
      task: { tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' },
      role: ROLE,
    });
    const layers = call.prompt.layers;
    expect(layers.filter((layer) => layer.included).map((layer) => layer.id)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
    expect(layers.find((layer) => layer.id === 'L3')?.kept.length).toBeGreaterThan(0);
    expect(layers.find((layer) => layer.id === 'L4')?.kept.map((item) => item.label)).toContain('The Landing');
    expect(call.messages[1]?.content).toContain('Elena returns to the island.');
  });
});

describe('the earlier turns are L6 (context-assembly §2)', () => {
  it('the last two earlier turns reach the call with their intents, and an older one does not', () => {
    const turns = [
      { turnId: 't-1', intent: 'Reorder the first act.' },
      { turnId: 't-2', intent: 'Tighten the storm.' },
      { turnId: 't-3', intent: 'Name the ferryman.' },
    ];
    const call = createContextPort({ state: makeState() }).assemble({
      task: { tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' },
      role: ROLE,
      turns,
    });

    expect(call.messages[1]?.content).toContain('Tighten the storm.');
    expect(call.messages[1]?.content).toContain('Name the ferryman.');
    expect(call.messages[1]?.content).not.toContain('Reorder the first act.');
  });

  it('a turn’s outcome comes from its activity rows, and a turn with none says so', () => {
    // Only `turnId` and `summary` are read here; the rest of an activity row is the bus's own shape.
    const activity = [{ turnId: 't-2', summary: 'Tightened the storm.' }] as unknown as ActivityEntry[];
    const call = createContextPort({ state: makeState() }).assemble({
      task: { tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' },
      role: ROLE,
      turns: [
        { turnId: 't-1', intent: 'Reorder the first act.' },
        { turnId: 't-2', intent: 'Tighten the storm.' },
      ],
      activity,
    });

    expect(call.messages[1]?.content).toContain('Outcome: Tightened the storm.');
    expect(call.messages[1]?.content).toContain('Intent: Reorder the first act.');
  });
});

describe('the codex and the focus, as the card shows them (codex.md §6, context-assembly §5)', () => {
  it('a mentioned entry is included with the reason it is there, and a never entry is left out with the reason it is not', () => {
    const state = withEntries(
      entry({ id: 'c_ELENA00001', name: 'Elena', type: 'character', description: 'The keeper.' }),
      entry({ id: 'c_FERRY00001', name: 'Ferryman', type: 'character', description: 'Secret.', includePolicy: 'never' }),
    );
    const call = createContextPort({ state }).assemble({
      task: { tool: 'scene.draft', instruction: 'Brief: Elena meets the Ferryman.', focus: LANDING, mode: 'continue' },
      role: ROLE,
    });

    expect(call.preview.codex.included).toEqual([expect.objectContaining({ name: 'Elena', reason: expect.stringContaining('matched') })]);
    expect(call.preview.codex.dropped).toContainEqual({ name: 'Ferryman', reason: 'disabled by include policy (never)' });
    expect(dropLinesOf(call.prompt)).toContain('Ferryman: disabled by include policy (never)');
  });

  it('the focus document is sent as its tail, and the card shows the head of that tail and its size', () => {
    const state = makeState();
    const body = `${'Old opening. '.repeat(400)}The lamp fails here.`;
    state.documents.get(STORM)!.body = body;
    const call = createContextPort({ state }).assemble({
      task: { tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' },
      role: ROLE,
    });

    expect(call.messages[1]?.content).toContain('The lamp fails here.');
    expect(call.preview.focus?.head.length).toBeGreaterThan(0);
    expect(call.preview.focus?.summary).toContain('chars');
  });
});

describe('the project is read as it is at each call, and the model’s limits reach the card (context-assembly §5)', () => {
  it('a state given as a function is read at each call, so a session follows the project as it changes', () => {
    let current = makeState();
    const port = createContextPort({ state: () => current });
    const before = port.assemble({ task: meta('Request: hello'), role: ROLE });
    current = makeState();
    current.manifest.project.name = 'A renamed project';
    const after = port.assemble({ task: meta('Request: hello'), role: ROLE });

    expect(before.messages[1]?.content).not.toContain('A renamed project');
    expect(after.messages[1]?.content).toContain('A renamed project');
  });

  it('the window, the price and the output cap in the config reach the card, and a prompt over the window is warned', () => {
    const port = createContextPort({
      state: makeState(),
      config: { model: { contextWindow: 10, pricePer1k: { prompt: 1, completion: 2 }, maxOutputTokens: 100 } },
    });
    const call = port.assemble({ task: meta('Request: hello'), role: ROLE });

    expect(call.preview.window?.contextWindow).toBe(10);
    expect(call.preview.window?.warning).toContain('model window');
    expect(call.preview.completionTokens).toBe(100);
    expect(call.preview.cost?.completionUsd).toBeCloseTo((100 / 1000) * 2);
  });

  it('a thinking allowance in the limits reaches the card’s reply estimate and its cost', () => {
    const port = createContextPort({
      state: makeState(),
      config: { model: { pricePer1k: { prompt: 0, completion: 2 }, maxOutputTokens: 100, thinkingTokens: 400 } },
    });
    const call = port.assemble({ task: meta('Request: hello'), role: ROLE });
    expect(call.preview.completionTokens).toBe(500);
    expect(call.preview.cost?.completionUsd).toBeCloseTo((500 / 1000) * 2);
    expect(call.preview.cost?.includesThinking).toBe(true);
  });

  it('with no limits in the config the card has no window and no price, and no guessed number', () => {
    const call = createContextPort({ state: makeState() }).assemble({ task: meta('Request: hello'), role: ROLE });

    expect(call.preview.window).toBeUndefined();
    expect(call.preview.cost).toBeUndefined();
  });
});

describe('a batch of calls is one card entry (mergePreviews)', () => {
  it('sums the tokens and the drops, and keeps every call’s messages in order', () => {
    const port = createContextPort({ state: makeState() });
    const first = port.assemble({ task: { tool: 'synopsis.fill', instruction: 'Brief: one.', focus: LANDING }, role: 'ROLE-A' }).preview;
    const second = port.assemble({ task: { tool: 'synopsis.fill', instruction: 'Brief: two.', focus: FRIEND }, role: 'ROLE-B' }).preview;

    const merged = mergePreviews([first, second]);

    expect(merged?.promptTokens).toBe(first.promptTokens + second.promptTokens);
    expect(merged?.completionTokens).toBe(first.completionTokens + second.completionTokens);
    expect(merged?.payload.map((message) => message.content)).toEqual([...first.payload, ...second.payload].map((message) => message.content));
    expect(merged?.layers.find((layer) => layer.id === 'L5')?.tokens).toBe(
      (first.layers.find((layer) => layer.id === 'L5')?.tokens ?? 0) + (second.layers.find((layer) => layer.id === 'L5')?.tokens ?? 0),
    );
  });

  it('a single call is returned as it is, and no calls are no view at all', () => {
    const preview = createContextPort({ state: makeState() }).assemble({ task: meta('Request: hello'), role: ROLE }).preview;

    expect(mergePreviews([preview])).toBe(preview);
    expect(mergePreviews([])).toBeUndefined();
  });
});
