/**
 * Slash commands in whole turns (agent-harness §2, "Slash commands"; §9): a command builds the plan a planner would have proposed and the
 * trace of its turn is that plan, step for step. The model is the mock provider; nothing here needs a key.
 */

import { describe, expect, it } from 'vitest';

import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { FRIEND, STORM, makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { answer, prose, steps, transcript } from '../agent/scripts.js';

const scenarios: Scenario[] = [
  {
    name: '/draft builds one scene.draft call with the exact params, and the planner is never asked',
    category: 'single-op',
    intent: 'Open The Friend.',
    slash: '/draft "The Friend" -- Open.',
    project: makeState,
    gateway: () => mockGateway([prose('Brief: Open.', 'The ferry came in.')]),
    expect: {
      status: 'applied',
      command: 'draft',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok', params: { doc: FRIEND, instruction: 'Open.' } }] },
      // The only model call is the draft itself: no planner request, so no slash text reaches a model.
      maxModelCalls: 1,
      requests: [{ includes: ['Brief: Open.'], excludes: ['/draft'] }],
      restores: true,
      state: (state) => (state.documents.get(FRIEND)?.body === '' ? [] : ['The Friend kept the draft after the restore']),
    },
  },
  {
    name: '/draft with a continue and a length carries both to the call',
    category: 'single-op',
    intent: 'Continue The Storm.',
    slash: '/draft "The Storm" continue 120',
    project: makeState,
    gateway: () => mockGateway([prose('Brief: Continue the scene from where it stops.', 'The sea went on.')]),
    expect: {
      status: 'applied',
      command: 'draft',
      trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok', params: { doc: STORM, mode: 'continue', target_words: 120 } }] },
    },
  },
  {
    name: '/plan sends the request without the slash, and a single reversible step still shows a card',
    category: 'single-op',
    intent: 'Label The Friend.',
    slash: '/plan label The Friend as act-2',
    project: makeState,
    gateway: () =>
      mockGateway([
        transcript('label The Friend as act-2', [steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'labelled' }), answer('Done.')]),
      ]),
    expect: {
      status: 'applied',
      command: 'plan',
      cards: { matcher: 'strict', items: [{ kind: 'plan', tools: ['meta.set'], decision: 'approved' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'meta.set', outcome: 'ok' }] },
      requests: [{ includes: ['Request: label The Friend as act-2'], excludes: ['/plan'] }],
    },
  },
  {
    name: 'the same request without /plan runs the single reversible step at once',
    category: 'single-op',
    intent: 'label The Friend as act-2',
    project: makeState,
    gateway: () =>
      mockGateway([
        transcript('label The Friend as act-2', [steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'labelled' }), answer('Done.')]),
      ]),
    expect: {
      status: 'applied',
      command: null,
      cards: { matcher: 'strict', items: [{ kind: 'auto', tools: ['meta.set'], decision: 'auto' }] },
    },
  },
  {
    name: '/scan reads at once, behind no card the writer decides, and makes no model call',
    category: 'single-op',
    intent: 'Scan the manuscript.',
    slash: '/scan',
    project: makeState,
    gateway: () => mockGateway([]),
    expect: {
      status: 'applied',
      command: 'scan',
      cards: { matcher: 'strict', items: [{ kind: 'auto', tools: ['coherence.scan'], decision: 'auto' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'coherence.scan', outcome: 'ok', params: { scope: { mode: 'full' } } }] },
      reached: { 'coherence.scan': 'preflight' },
      maxModelCalls: 0,
      ledgerRequests: 0,
    },
  },
  {
    name: '/compile still stops at its confirm card, and cancelling it writes nothing',
    category: 'permission',
    intent: 'Compile the manuscript.',
    slash: '/compile md',
    project: makeState,
    gateway: () => mockGateway([]),
    decisions: [{ action: 'cancel' }],
    expect: {
      status: 'cancelled',
      command: 'compile',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['export.compile'], decision: 'cancelled' }] },
      maxModelCalls: 0,
      ledgerRequests: 0,
      restores: false,
    },
  },
];

describe('slash commands in a turn', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const result = await evaluate(scenario);
      expect(result.failures).toEqual([]);
    });
  }
});
