/**
 * The reasoning channel (provider-gateway §3, §6/D12): what the model thinks streams as `reasoningDelta` chunks, and the
 * loop emits them as `model.reasoning` events for the panel's collapsed "Thinking" block. A reply's terminal `reasoning`
 * blocks are different data — replay material the next request carries verbatim — and never surface as panel events.
 *
 * The mock provider stands for the wire: `reasoning` on a reply without tool calls streams as a `reasoningDelta`; on a
 * reply with calls it rides the terminal chunk as the replay block, exactly as the adapters pack it.
 */

import { describe, expect, it } from 'vitest';

import { isDraftCall, isPlannerCall, userTextOf, type MockResponse, type MockScript } from '@caotang/gateway/mock';
import type { ChatRequest, Gateway } from '@caotang/gateway';

import { runScenario } from '../../src/agent/eval.js';
import { PLANNER_SYSTEM_PREFIX, type AgentEvent } from '../../src/index.js';
import { makeState, FRIEND } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, steps } from './scripts.js';
import { textOf } from '@caotang/gateway';

const INTENT = 'Draft the opening of The Friend.';
const DRAFT = 'The ferry came in with the tide.';

/** A planner whose replies stream thinking before their text: each reply is `{content, reasoning?}`. */
function thinkingTranscript(intent: string, replies: readonly { readonly content: string; readonly reasoning?: string }[]): MockScript {
  return {
    match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`),
    respond: (req): MockResponse => {
      const calls = req.messages.filter((message) => message.role === 'assistant').length;
      const reply = replies[Math.min(calls, replies.length - 1)] ?? replies[0];
      return { content: textOf(reply?.content ?? ''), ...(reply?.reasoning === undefined ? {} : { reasoning: reply.reasoning }) };
    },
  };
}

/** A drafting call that thinks first: the marker picks the call, the reply carries prose and reasoning. */
function thinkingProse(marker: string, text: string, reasoning: string): MockScript {
  return {
    match: (req) => isDraftCall(req) && userTextOf(req).includes(marker),
    respond: (): MockResponse => ({ content: text, reasoning }),
  };
}

/** A request on the native wire: the planner's system message with tools declared. */
function isNativePlanner(req: ChatRequest): boolean {
  const first = req.messages[0];
  return (req.tools?.length ?? 0) > 0 && first?.role === 'system' && textOf(first.content).startsWith(PLANNER_SYSTEM_PREFIX);
}

/** The mock gateway reporting a tool-capable model, which is all native mode asks of it (native.test.ts does the same). */
async function nativeGateway(scripts: readonly MockScript[]): Promise<Gateway> {
  const base = await mockGateway(scripts);
  return { ...base, modelCaps: () => ({ tools: true }) };
}

/** The `model.reasoning` text of a run, joined from its deltas. */
function reasoningOf(events: readonly AgentEvent[]): string {
  return events.flatMap((event) => (event.type === 'model.reasoning' ? [event.delta] : [])).join('');
}

describe('streamed reasoning (provider-gateway §3; ui-modules, the collapsed Thinking block)', () => {
  it('emits the planner’s thinking as model.reasoning, and a draft’s thinking too — while the draft’s prose stays draft.delta', async () => {
    const run = await runScenario({
      name: 'reasoning stream',
      category: 'streaming',
      intent: INTENT,
      project: makeState,
      gateway: () =>
        mockGateway([
          thinkingTranscript(INTENT, [
            { content: steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open.', mode: 'draft' }, expect: 'drafted' }), reasoning: 'weighing the openings' },
            // An applied write settles the turn without another call (loop.converse returns on it) — this reply is
            // a safety net if the loop is ever asked again, and it carries no reasoning either way.
            { content: answer('Drafted.') },
          ]),
          thinkingProse('Brief: Open.', DRAFT, 'the tide first'),
        ]),
      expect: { status: 'applied' },
    });

    // Every call's thinking lands in the one reasoning stream: the planner's first, then the drafting call's,
    // in the order the calls ran.
    expect(reasoningOf(run.events)).toBe('weighing the openings' + 'the tide first');
    // The draft's prose is its ghost stream, not the panel tail; its thinking never joined it.
    const draftDeltas = run.events.flatMap((event) => (event.type === 'draft.delta' ? [event.delta] : []));
    expect(draftDeltas.join('')).toBe(DRAFT);
    expect(draftDeltas.join('')).not.toContain('the tide first');
    // Reasoning stays out of the text channels entirely.
    const panelText = run.events.flatMap((event) => (event.type === 'model.delta' ? [event.delta] : [])).join('');
    expect(panelText).not.toContain('weighing');
    expect(panelText).not.toContain('the tide first');
  });

  it('emits nothing for a reply whose reasoning rides the terminal chunk as a replay block', async () => {
    const intent = 'Read The Friend.';
    const run = await runScenario({
      name: 'reasoning replay, not stream',
      category: 'single-op',
      intent,
      project: makeState,
      gateway: () =>
        nativeGateway([
          {
            match: (req) => isNativePlanner(req) && req.messages.filter((message) => message.role === 'assistant').length === 0,
            respond: (): MockResponse => ({
              content: '',
              toolCalls: [{ id: 'r1', name: 'doc.read', argumentsJson: JSON.stringify({ doc: FRIEND }) }],
              reasoning: 'checking which scene holds the friend',
            }),
          },
          {
            match: (req) => isNativePlanner(req) && userTextOf(req).includes(`Request: ${intent}`),
            respond: (): MockResponse => ({ content: 'The Friend is empty.' }),
          },
        ]),
      expect: { status: 'replied' },
    });

    // The block is replay data: the panel heard nothing, and the next request carries it verbatim on the
    // assistant message (the AG-replay contract native.test.ts checks from the other side).
    expect(reasoningOf(run.events)).toBe('');
    const second = run.requests.filter((req) => (req.tools?.length ?? 0) > 0)[1];
    const assistant = second?.messages.filter((message) => message.role === 'assistant').at(-1);
    expect(assistant?.reasoning).toEqual([
      { text: 'checking which scene holds the friend', raw: { type: 'mock-reasoning', text: 'checking which scene holds the friend' } },
    ]);
  });
});
