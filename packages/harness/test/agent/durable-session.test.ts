import { describe, expect, it } from 'vitest';

import type { RecentTurn } from '@caotang/context';
import type { ChatRequest, Gateway } from '@caotang/gateway';
import { userTextOf } from '@caotang/gateway/mock';

import { createAgentPorts, createAgentSession } from '../../src/index.js';
import { checkedHarness, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, transcript } from './scripts.js';

describe('the durable session planner history', () => {
  it.each<readonly [string, readonly RecentTurn[]]>([
    ['empty', []],
    ['rewound', [{ turnId: 'panel.turn-1', intent: 'The forgotten request.', rewound: true }]],
    ['hidden', [{ turnId: 'panel.turn-1', intent: 'The hidden request.', hidden: true }]],
  ])('omits the empty conversation layer when earlier history is %s', async (_name, history) => {
    const gateway = await mockGateway([transcript('Name the ferryman.', [answer('Hale.')])]);
    const sent: ChatRequest[] = [];
    const recording: Gateway = { ...gateway, complete: (request, signal) => {
      sent.push(request);
      return gateway.complete(request, signal);
    } };
    const session = createAgentSession({
      harness: checkedHarness({ state: makeState(), ports: createAgentPorts() }),
      gateway: recording,
      decide: async () => ({ action: 'approve' }),
      sessionId: 'panel',
      history,
    });

    expect((await session.submit('Name the ferryman.')).status).toBe('replied');
    expect(sent).toHaveLength(1);
    expect(userTextOf(sent[0]!)).not.toContain('# Recent turns');
    expect(userTextOf(sent[0]!)).not.toContain('The forgotten request.');
    expect(userTextOf(sent[0]!)).not.toContain('The hidden request.');
  });

  it('reads a rehydrated answer without reusing a discarded turn ID', async () => {
    const gateway = await mockGateway([transcript('What is his name?', [answer('Hale.')])]);
    const sent: ChatRequest[] = [];
    const recording: Gateway = { ...gateway, complete: (request, signal) => {
      sent.push(request);
      return gateway.complete(request, signal);
    } };
    const session = createAgentSession({
      harness: checkedHarness({ state: makeState(), ports: createAgentPorts() }),
      gateway: recording,
      decide: async () => ({ action: 'approve' }),
      sessionId: 'panel',
      history: [{ turnId: 'panel.turn-2', intent: 'Name the ferryman.', outcome: 'His name is Hale.' }],
      nextTurn: 10,
    });

    const report = await session.submit('What is his name?');
    expect(report.status).toBe('replied');
    expect(report.turnId).toBe('panel.turn-10');
    expect(sent).toHaveLength(1);
    expect(userTextOf(sent[0]!)).toContain('# Recent turns');
    expect(userTextOf(sent[0]!)).toContain('Intent: Name the ferryman.');
    expect(userTextOf(sent[0]!)).toContain('Outcome: His name is Hale.');
  });
});
