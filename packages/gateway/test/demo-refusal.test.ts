/**
 * The zero-key demo answers its three intents and refuses every other request (context-assembly §6). A drafting call the demo did
 * not script gets an error and no text, so no draft can reach a card or a scene (coherence.md §6.3). The app's list is the demo's
 * scripts, then the echo fallback; the planner's own fallback (providers.ts) sits between them and is not part of the gateway.
 */

import { describe, expect, it } from 'vitest';

import { ProviderError } from '../src/index.js';
import type { ChatRequest } from '../src/types.js';
import { CRITIC_PREFIX, DEMO_PROSE, DEMO_REFUSAL, DRAFT_PREFIX, PLANNER_PREFIX, createMockProvider, demoScripts, echo, isCriticCall, isDraftCall, plannerScript, userTextOf } from '../src/mock/index.js';
import { collect } from './helpers.js';

/** The app's script list for the demo provider, without the planner fallback the app puts after the demo scripts. */
const appScripts = [...demoScripts, echo];

/** A drafting call the way the harness sends one: the role text as the system message, and the assembled task as the user message. */
function draftingCall(brief: string): ChatRequest {
  return {
    messages: [
      { role: 'system', content: `${DRAFT_PREFIX} Write the prose for the scene described below. Output the prose only.` },
      { role: 'user', content: `Document "The Ferry":\nMode: rewrite_selection\nBrief: ${brief}` },
    ],
    responseFormat: 'text',
  };
}

/** A planner call the way the harness sends one: its system message names the agent, and it asks for a JSON object. */
function plannerCall(intent: string): ChatRequest {
  return {
    messages: [
      { role: 'system', content: `${PLANNER_PREFIX} Plan the steps.` },
      { role: 'user', content: `Request: ${intent}` },
    ],
    responseFormat: { jsonSchemaHint: { title: 'Plan', description: 'A JSON object.' } },
  };
}

describe('the zero-key demo refuses what its three intents do not answer', () => {
  it('refuses a drafting call for any other brief with the demo words, and no text', async () => {
    const { chunks, error } = await collect(createMockProvider({ scripts: appScripts }).complete(draftingCall('Name the POV character.')));
    expect(chunks.map((chunk) => chunk.delta ?? '').join('')).toBe('');
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('provider');
    expect((error as ProviderError).message).toBe(DEMO_REFUSAL);
  });

  it('never answers a drafting call with the echo of its prompt, so a project overview cannot become a draft', async () => {
    const call = draftingCall('Rewrite the passage about the ferry.');
    const { chunks, error } = await collect(createMockProvider({ scripts: appScripts }).complete(call));
    const text = chunks.map((chunk) => chunk.delta ?? '').join('');
    expect(text).not.toContain('Document "The Ferry"');
    expect(text).toBe('');
    expect(error).toBeDefined();
  });

  it('still answers the opening-scene brief of its own intent with its draft', async () => {
    const own: ChatRequest = {
      messages: [
        { role: 'system', content: `${DRAFT_PREFIX} Write the prose for the scene described below.` },
        { role: 'user', content: 'Document "The Friend":\nMode: draft\nBrief: The friend arrives by boat, soaked, with news of Elena.' },
      ],
      responseFormat: 'text',
    };
    const { chunks, error } = await collect(createMockProvider({ scripts: appScripts }).complete(own));
    expect(error).toBeUndefined();
    expect(chunks.map((chunk) => chunk.delta ?? '').join('')).toContain('The ferry came in on the evening tide');
  });

  it('answers the synopsis of its own chapters, and refuses a scene draft of one of them', async () => {
    const synopsis: ChatRequest = {
      messages: [
        { role: 'system', content: `${DRAFT_PREFIX} Write a synopsis of the document below.` },
        { role: 'user', content: 'Document "The Landing":\nBrief: write the synopsis of this document.' },
      ],
      responseFormat: 'text',
    };
    const answered = await collect(createMockProvider({ scripts: appScripts }).complete(synopsis));
    expect(answered.chunks.map((chunk) => chunk.delta ?? '').join('')).toContain('Elena comes back');

    const scene: ChatRequest = {
      messages: [
        { role: 'system', content: `${DRAFT_PREFIX} Write the prose for the scene described below.` },
        { role: 'user', content: 'Document "The Landing":\nMode: draft\nBrief: Open with the storm.' },
      ],
      responseFormat: 'text',
    };
    const refused = await collect(createMockProvider({ scripts: appScripts }).complete(scene));
    expect(refused.chunks.map((chunk) => chunk.delta ?? '').join('')).toBe('');
    expect((refused.error as ProviderError | undefined)?.message).toBe(DEMO_REFUSAL);
  });

  it('matches no demo script for a planner call it does not know, so the planner fallback the app adds is what answers it', async () => {
    // The app answers such a planner call with a plain reply (providers.ts, its own test is in e2e/unit/agent-demo-provider.spec.ts).
    // Here: the demo scripts take no such call, and the refusal must not take it either, or the reply would be an error.
    const planner = plannerCall('Something the demo does not know.');
    expect(userTextOf(planner)).toContain('Something the demo does not know.');
    expect(demoScripts.some((script) => script.match(planner))).toBe(false);
    const fallback = plannerScript(() => JSON.stringify({ reply: DEMO_REFUSAL }));
    const { chunks, error } = await collect(createMockProvider({ scripts: [...demoScripts, fallback, echo] }).complete(planner));
    expect(error).toBeUndefined();
    expect(chunks.map((chunk) => chunk.delta ?? '').join('')).toBe(JSON.stringify({ reply: DEMO_REFUSAL }));
  });

  // The demo's continuity intent runs the deterministic coherence.scan, a read with no model call, so the model-backed continuity.scan
  // is not one of its intents any more: its call is refused like any other the demo did not script.
  it('refuses a model-backed continuity scan, which none of its intents sends, whichever aspects it names', async () => {
    const scan = (aspects: string): ChatRequest => ({
      messages: [
        { role: 'system', content: `${DRAFT_PREFIX} Check the documents below for continuity problems.` },
        { role: 'user', content: `Check these documents for continuity problems in these aspects: ${aspects}.\nDocument "The Storm":` },
      ],
      responseFormat: { jsonSchemaHint: { title: 'Continuity findings', description: 'Exactly one JSON object with a "findings" list.' } },
    });
    for (const aspects of ['timeline', 'timeline, characters']) {
      const { chunks, error } = await collect(createMockProvider({ scripts: appScripts }).complete(scan(aspects)));
      expect(chunks.map((chunk) => chunk.delta ?? '').join('')).toBe('');
      expect((error as ProviderError | undefined)?.message).toBe(DEMO_REFUSAL);
    }
  });

  it('rewrites a demo statement in its own demo document for Fix with agent, and refuses any other rewrite', async () => {
    // The focus frame of a rewrite_selection call (context-assembly, the focus layer): the document line, then the selection.
    const rewrite = (title: string, passage: string): ChatRequest => ({
      messages: [
        { role: 'system', content: `${DRAFT_PREFIX} Rewrite the selected passage. Output the prose only.` },
        {
          role: 'user',
          content: `Document: ${title} (rewrite selection; 40 characters of preceding text, then the selection of ${passage.length} characters)\n\nPreceding text:\nThe ferry was late, as always.\n\nSelection to rewrite:\n${passage}\n\n# Task\n\nRewrite this passage so it no longer conflicts with the rest of the story.`,
        },
      ],
      responseFormat: 'text',
    });
    const answer = (call: ChatRequest) => collect(createMockProvider({ scripts: appScripts }).complete(call));
    const own = await answer(rewrite('The Landing', 'The ferry was late, as always.'));
    expect(own.error).toBeUndefined();
    // Each statement gets its own rewrite, about the same event: the Landing's is about the ferry, the Storm's about the lamp.
    expect(own.chunks.map((chunk) => chunk.delta ?? '').join('')).toBe('The ferry was late, held at the mainland until the storm had passed.');
    const storm = await answer(rewrite('The Storm', 'The lamp failed.'));
    expect(storm.error).toBeUndefined();
    expect(storm.chunks.map((chunk) => chunk.delta ?? '').join('')).toBe('The lamp failed once the ferry was already in.');
    const other = await answer(rewrite('The Landing', 'the lamp stayed dark'));
    expect(other.chunks.map((chunk) => chunk.delta ?? '').join('')).toBe('');
    expect((other.error as ProviderError | undefined)?.message).toBe(DEMO_REFUSAL);
  });

  it('refuses a rewrite of the same demo sentence in a document that is not the demo manuscript', async () => {
    // The writer's own scene can hold the sentence the demo rewrites. Only its own document gets the demo's rewrite, so this is refused.
    const ownScene: ChatRequest = {
      messages: [
        { role: 'system', content: `${DRAFT_PREFIX} Rewrite the selected passage. Output the prose only.` },
        {
          role: 'user',
          content: 'Document: The Lamp (rewrite selection; 0 characters of preceding text, then the selection of 16 characters)\n\nPreceding text:\n(none)\n\nSelection to rewrite:\nThe lamp failed.\n\n# Task\n\nRewrite this passage so it no longer conflicts with the rest of the story.',
        },
      ],
      responseFormat: 'text',
    };
    const { chunks, error } = await collect(createMockProvider({ scripts: appScripts }).complete(ownScene));
    expect(chunks.map((chunk) => chunk.delta ?? '').join('')).toBe('');
    expect((error as ProviderError | undefined)?.message).toBe(DEMO_REFUSAL);
  });

  it('refuses a structured drafting call the demo did not script, too', async () => {
    const structured: ChatRequest = {
      messages: [
        { role: 'system', content: `${DRAFT_PREFIX} Reply with one JSON object.` },
        { role: 'user', content: 'Document "The Ferry":\nBrief: Check the timeline.' },
      ],
      responseFormat: { jsonSchemaHint: { title: 'x', description: 'x' } },
    };
    const { chunks, error } = await collect(createMockProvider({ scripts: appScripts }).complete(structured));
    expect(chunks.length === 0 || chunks.every((chunk) => (chunk.delta ?? '') === '')).toBe(true);
    expect((error as ProviderError | undefined)?.message).toBe(DEMO_REFUSAL);
  });
});

describe('the zero-key demo draft, after the loop refuses its step', () => {
  // The loop calls the planner again after a refused step, with the refusal as its last message (harness loop: "Step 1 (...) was
  // refused"). The demo's reply must say no draft was made: it used to say "Drafted the opening scene of The Friend." unconditionally.
  it('answers a refused opening-scene step with the words that no draft was made, never with a success', async () => {
    const afterRefusal: ChatRequest = {
      messages: [
        { role: 'system', content: `${PLANNER_PREFIX} Plan the steps.` },
        { role: 'user', content: 'Request: Draft the opening scene of The Friend.' },
        { role: 'assistant', content: JSON.stringify({ steps: [{ tool: 'scene.draft', params: { doc: 'The Friend' }, expect: 'x' }] }) },
        { role: 'user', content: 'Step 1 (scene.draft) was refused: no document is called The Friend.' },
      ],
      responseFormat: { jsonSchemaHint: { title: 'Plan', description: 'A JSON object.' } },
    };
    const { chunks, error } = await collect(createMockProvider({ scripts: appScripts }).complete(afterRefusal));
    expect(error).toBeUndefined();
    const reply = (JSON.parse(chunks.map((chunk) => chunk.delta ?? '').join('')) as { reply: string }).reply;
    expect(reply).not.toContain('Drafted');
    expect(reply).toContain('No draft was made');
    expect(reply).toContain('The Friend');
  });

  it('answers a refused synopsis step with the words that no synopses were written, never with a success', async () => {
    const afterRefusal: ChatRequest = {
      messages: [
        { role: 'system', content: `${PLANNER_PREFIX} Plan the steps.` },
        { role: 'user', content: 'Request: Fill in the synopses for Chapter 1.' },
        { role: 'assistant', content: JSON.stringify({ steps: [{ tool: 'synopsis.fill', params: { docs: ['The Landing', 'The Storm'] }, expect: 'x' }] }) },
        { role: 'user', content: 'Step 1 (synopsis.fill) was refused: no document is called The Landing.' },
      ],
      responseFormat: { jsonSchemaHint: { title: 'Plan', description: 'A JSON object.' } },
    };
    const { chunks, error } = await collect(createMockProvider({ scripts: appScripts }).complete(afterRefusal));
    expect(error).toBeUndefined();
    const reply = (JSON.parse(chunks.map((chunk) => chunk.delta ?? '').join('')) as { reply: string }).reply;
    expect(reply).not.toContain('Filled');
    expect(reply).toContain('No synopses were written');
    expect(reply).toContain('The Landing');
  });

  it('keeps the wording of the refusal on the Settings page the writer uses, not the first-run card that can be dismissed', () => {
    expect(DEMO_REFUSAL).toContain('Settings > Providers');
    expect(DEMO_REFUSAL).not.toContain('first-run card');
  });
});

describe('the draft review’s critic on the demo (agent-harness §8)', () => {
  const criticCall = (draft: string): ChatRequest => ({
    messages: [
      { role: 'system', content: `${CRITIC_PREFIX} You read one drafted scene cold.` },
      { role: 'user', content: `Document "The Friend":\nThe draft to review:\n${draft}` },
    ],
    responseFormat: { jsonSchemaHint: { title: 'Draft critique', description: 'A JSON object.' } },
  });

  it('answers the demo’s own draft with one scripted note, and no other', async () => {
    const own = await collect(createMockProvider({ scripts: appScripts }).complete(criticCall(DEMO_PROSE)));
    expect(own.error).toBeUndefined();
    const notes = (JSON.parse(own.chunks.map((chunk) => chunk.delta ?? '').join('')) as { notes: { quote: string }[] }).notes;
    expect(notes.map((note) => note.quote)).toEqual(['Elena was not on it.']);
  });

  it('refuses the critic call for a draft of the writer’s own, with the demo words, and never calls it a drafting call', async () => {
    const other = await collect(createMockProvider({ scripts: appScripts }).complete(criticCall('Some other scene.')));
    expect((other.error as ProviderError).message).toBe(DEMO_REFUSAL);
    expect(isCriticCall(criticCall('x'))).toBe(true);
    expect(isDraftCall(criticCall('x'))).toBe(false);
  });
});
