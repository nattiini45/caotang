/**
 * The two axes of a checkpoint (agent-harness §5, context-assembly §2 L6): the writer can rewind the conversation, take the
 * project's changes back while keeping the conversation, or both. Each test drives the real session on the real bus with a
 * mock model, and reads what the planner is shown from the requests the gateway receives.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest } from '@caotang/gateway';
import { draftScript, userTextOf } from '@caotang/gateway/mock';

import { TOOL_NAMES, createAgentPorts, createAgentSession, createContextPort, createHarness, type AgentSession } from '../src/index.js';
import { makeState, snapshotOf } from './fixtures.js';
import { mockGateway } from './agent/gateway.js';
import { steps, transcript } from './agent/scripts.js';

const ONE = 'Continue The Landing once.';
const TWO = 'Continue The Landing twice.';
const THREE = 'Continue The Landing thrice.';
/** L6 is read by the drafting calls, so each turn continues a scene and the draft request is the one that is inspected. */
const continuing = (brief: string) =>
  steps({ tool: 'scene.draft', params: { doc: 'The Landing', instruction: brief, mode: 'continue' }, expect: 'The Landing continues' });

async function fixture(options: { formatTime?: (at: number) => string } = {}) {
  const harness = createHarness({ state: makeState(), ports: createAgentPorts() });
  const seen: Record<string, ChatRequest[]> = { [ONE]: [], [TWO]: [], [THREE]: [] };
  const drafting = (brief: string, intent: string) =>
    draftScript((req) => {
      if (req.responseFormat !== 'text' || !userTextOf(req).includes(`Brief: ${brief}`)) return undefined;
      if (seen[intent]![seen[intent]!.length - 1] !== req) seen[intent]!.push(req);
      return 'The tide turned.';
    });
  const gateway = await mockGateway([
    transcript(ONE, [continuing('First brief.')]),
    transcript(TWO, [continuing('Second brief.')]),
    transcript(THREE, [continuing('Third brief.')]),
    drafting('First brief.', ONE),
    drafting('Second brief.', TWO),
    drafting('Third brief.', THREE),
  ]);
  const session: AgentSession = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state: harness.state, ...(options.formatTime === undefined ? {} : { config: { formatTime: options.formatTime } }) }),
    decide: async () => ({ action: 'approve' }),
  });
  /** The recent-turns section of the planner request the last submit of `intent` sent. */
  const recentTurns = (intent: string): string => {
    const text = userTextOf(seen[intent]![seen[intent]!.length - 1]!);
    return text.slice(text.indexOf('# Recent turns'), text.indexOf('# Task'));
  };
  return { harness, session, recentTurns };
}

describe('rewinding the conversation', () => {
  it('drops the turn and every later one from the next prompt, returns the intent, and touches no project state', async () => {
    const f = await fixture();
    const first = await f.session.submit(ONE);
    const second = await f.session.submit(TWO);
    const before = snapshotOf(f.harness.state);
    const groups = f.harness.undo.groups().map((group) => group.id);

    const rewound = f.session.rewindConversation(second.turnId);

    expect(rewound).toEqual({ intent: TWO, rewound: [second.turnId] });
    expect(snapshotOf(f.harness.state)).toBe(before);
    expect(f.harness.undo.groups().map((group) => group.id)).toEqual(groups);
    expect(f.session.reports()).toHaveLength(2);

    await f.session.submit(THREE);
    const shown = f.recentTurns(THREE);
    expect(shown).toContain(`- Turn ${first.turnId}`);
    expect(shown).not.toContain(second.turnId);
  });

  it('rewinds from an earlier turn through the latest, and keeps the window full from the turns before it', async () => {
    const f = await fixture();
    const first = await f.session.submit(ONE);
    const second = await f.session.submit(TWO);
    const third = await f.session.submit(THREE);

    const rewound = f.session.rewindConversation(second.turnId);
    expect(rewound.rewound).toEqual([second.turnId, third.turnId]);

    await f.session.submit(ONE);
    const shown = f.recentTurns(ONE);
    expect(shown).toContain(`- Turn ${first.turnId}`);
    expect(shown).not.toContain(second.turnId);
    expect(shown).not.toContain(third.turnId);
  });

  it('returns nothing for a turn it does not know', async () => {
    const f = await fixture();
    await f.session.submit(ONE);
    expect(f.session.rewindConversation('no.such.turn')).toEqual({ intent: '', rewound: [] });
  });
});

describe('restoring the project and keeping the conversation', () => {
  it('makes the turn’s outcome line say the writer took the changes back', async () => {
    const f = await fixture({ formatTime: () => '14:02' });
    const first = await f.session.submit(ONE);
    expect(f.session.restore(first.turnId).ok).toBe(true);
    f.session.markRestored([first.turnId], Date.UTC(2026, 9, 22, 14, 2));

    await f.session.submit(TWO);
    expect(f.recentTurns(TWO)).toContain('restored by the writer at 14:02; these changes are no longer in the project');
  });

  it('marks every turn it is given, and a partial restore names its step on the first only', async () => {
    const f = await fixture({ formatTime: () => '09:30' });
    const first = await f.session.submit(ONE);
    const second = await f.session.submit(TWO);
    f.session.markRestored([first.turnId, second.turnId], 0, 2);

    await f.session.submit(THREE);
    const shown = f.recentTurns(THREE);
    expect(shown).toContain('steps 2 onward restored by the writer at 09:30;');
    expect(shown.match(/restored by the writer/g)).toHaveLength(2);
    expect(shown.match(/steps 2 onward/g)).toHaveLength(1);
  });

  it('does not mark a turn that was rewound', async () => {
    const f = await fixture();
    const first = await f.session.submit(ONE);
    f.session.rewindConversation(first.turnId);
    f.session.markRestored([first.turnId], 0);
    await f.session.submit(TWO);
    expect(f.recentTurns(TWO)).not.toContain('restored by the writer');
  });
});

describe('the agent has no way to rewind', () => {
  it('registers no tool for a rewind or a restore', () => {
    expect(TOOL_NAMES.filter((name) => /rewind|restore|checkpoint/i.test(name))).toEqual([]);
    expect(TOOL_NAMES).toHaveLength(36);
  });
});
