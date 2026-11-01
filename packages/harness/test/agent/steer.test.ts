/**
 * Steering notes (agent-harness §2, "Stop and steer"): a note the writer sends to a running turn reaches the model at the next
 * planner request, as one user message of its own, and never in the middle of a stream. A note sent while a card waits lands after
 * the decision; a note the turn ends without delivering is reported, for the caller to send as a turn of its own.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest } from '@caotang/gateway';

import { createAgentPorts, createAgentSession, createContextPort, createHarness, type AgentEvent, type AgentSession, type Decision, type PendingCard } from '../../src/index.js';
import { FRIEND, STORM, clock, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { answer, steps, transcript } from './scripts.js';
import { textOf } from '@caotang/gateway';

const NOTE = 'Note from the writer, sent while you were working: ';

interface Fixture {
  readonly session: AgentSession;
  readonly seen: ChatRequest[];
  readonly events: AgentEvent[];
  readonly state: ReturnType<typeof makeState>;
}

/** A session on the mock gateway. `onEvent` runs as each event is emitted, with the session, so a test can steer at a fixed point. */
async function fixture(
  intent: string,
  replies: readonly string[],
  options: { readonly decide?: (card: PendingCard, session: AgentSession) => Decision; readonly onEvent?: (event: AgentEvent, session: AgentSession) => void } = {},
): Promise<Fixture> {
  const state = makeState();
  const seen: ChatRequest[] = [];
  const gateway = await mockGateway([transcript(intent, replies, seen)]);
  const harness = createHarness({ state, ports: createAgentPorts(), clock: clock.now });
  const events: AgentEvent[] = [];
  const holder: { session?: AgentSession } = {};
  holder.session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => (options.decide === undefined ? { action: 'approve' } : options.decide(card, holder.session as AgentSession)),
    emit: (event) => {
      events.push(event);
      options.onEvent?.(event, holder.session as AgentSession);
    },
    sessionId: 'steer',
  });
  return { session: holder.session, seen, events, state };
}

const notesIn = (request: ChatRequest | undefined): string[] =>
  (request?.messages ?? []).filter((message) => message.role === 'user' && textOf(message.content).startsWith(NOTE)).map((message) => textOf(message.content));

const READ = steps({ tool: 'binder.read_tree', params: { root: 'manuscript' }, expect: 'the binder is read' });

describe('steering a running turn', () => {
  it('adds exactly one user message before the next planner request, and none to the one in flight', async () => {
    const intent = 'What is in the manuscript?';
    const f = await fixture(intent, [READ, answer('Two chapters.')], {
      onEvent: (event, session) => {
        // The first request is on its way: the note is sent now, mid-turn.
        if (event.type === 'model.call' && event.used === 1) expect(session.steer(event.turnId, 'Keep Elena out of the answer.').ok).toBe(true);
      },
    });
    const report = await f.session.submit(intent);

    expect(report.status).toBe('replied');
    const [first, second] = f.seen;
    expect(notesIn(first)).toEqual([]);
    expect(notesIn(second)).toEqual([`${NOTE}Keep Elena out of the answer.`]);
    // The note follows the results the model asked for, so it reads as an answer to them.
    const results = second?.messages.findIndex((message) => message.role === 'user' && textOf(message.content).startsWith('Tool results:')) ?? -1;
    const noted = second?.messages.findIndex((message) => textOf(message.content).startsWith(NOTE)) ?? -1;
    expect(noted).toBeGreaterThan(results);
    expect(report.steering).toEqual([{ noteId: 'steer.turn-1.note-1', text: 'Keep Elena out of the answer.', deliveredAtCall: 2 }]);
    expect(f.events.filter((event) => event.type === 'steer')).toEqual([
      { type: 'steer', turnId: 'steer.turn-1', note: { noteId: 'steer.turn-1.note-1', text: 'Keep Elena out of the answer.', deliveredAtCall: 2 } },
    ]);
  });

  it('keeps two notes as two messages, in the order they were sent', async () => {
    const intent = 'What is in the manuscript?';
    const f = await fixture(intent, [READ, answer('Done.')], {
      onEvent: (event, session) => {
        if (event.type === 'model.call' && event.used === 1) {
          session.steer(event.turnId, 'First note.');
          session.steer(event.turnId, 'Second note.');
        }
      },
    });
    const report = await f.session.submit(intent);
    expect(notesIn(f.seen[1])).toEqual([`${NOTE}First note.`, `${NOTE}Second note.`]);
    expect(report.steering?.map((note) => note.deliveredAtCall)).toEqual([2, 2]);
  });

  it('refuses a note for a turn that is not running, and an empty one', async () => {
    const intent = 'What is in the manuscript?';
    const f = await fixture(intent, [answer('Nothing.')], {
      onEvent: (event, session) => {
        if (event.type === 'model.call') {
          const empty = session.steer(event.turnId, '   ');
          expect(empty.ok).toBe(false);
          expect(!empty.ok && empty.error.code).toBe('invalid-params');
        }
      },
    });
    const report = await f.session.submit(intent);
    const late = f.session.steer(report.turnId, 'Too late.');
    expect(late.ok).toBe(false);
    expect(!late.ok && late.error.code).toBe('not-found');
    expect(report.steering).toBeUndefined();
  });

  it('reports a note the turn ended without delivering', async () => {
    const intent = 'What is in the manuscript?';
    const f = await fixture(intent, [answer('Nothing.')], {
      onEvent: (event, session) => {
        if (event.type === 'model.call') session.steer(event.turnId, 'Also check the ending.');
      },
    });
    const report = await f.session.submit(intent);
    // The only request was already on its way; the answer ended the turn, so the note never reached the model.
    expect(f.seen).toHaveLength(1);
    expect(notesIn(f.seen[0])).toEqual([]);
    expect(report.steering).toEqual([{ noteId: 'steer.turn-1.note-1', text: 'Also check the ending.' }]);
    expect(f.events.some((event) => event.type === 'steer')).toBe(false);
  });
});

describe('a note sent while a card waits', () => {
  const intent = 'Tag The Storm and The Friend.';
  const plan = steps(
    { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
    { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' },
  );

  it('lands after the decision, and neither approves nor drops the card', async () => {
    const receipts: string[] = [];
    const f = await fixture(intent, [plan], {
      decide: (card, session) => {
        const receipt = session.steer(card.turnId, 'Skip The Friend.');
        if (receipt.ok) receipts.push(receipt.value.lands);
        return { action: 'approve' };
      },
    });
    const report = await f.session.submit(intent);
    expect(receipts).toEqual(['after-decision']);
    // The card was decided by the writer as asked: approved, and applied. The note had no later request to reach.
    expect(report.status).toBe('applied');
    expect(report.cards).toEqual([expect.objectContaining({ kind: 'plan', decision: 'approved' })]);
    expect(report.steering).toEqual([{ noteId: 'steer.turn-1.note-1', text: 'Skip The Friend.' }]);
  });

  it('goes back to the model with the note when the writer cancels the card with it', async () => {
    const f = await fixture(intent, [plan, answer('Understood, leaving The Friend alone.')], {
      decide: (card, session) => {
        session.steer(card.turnId, 'Skip The Friend.');
        return { action: 'cancel' };
      },
    });
    const before = JSON.stringify(f.state.manifest.tree);
    const report = await f.session.submit(intent);

    // The card was cancelled as Cancel does: nothing ran. The turn did not end there: the model heard the cancel and the note.
    expect(report.cards).toEqual([expect.objectContaining({ kind: 'plan', decision: 'cancelled' })]);
    expect(JSON.stringify(f.state.manifest.tree)).toBe(before);
    expect(report.status).toBe('replied');
    expect(f.seen).toHaveLength(2);
    const second = f.seen[1]?.messages ?? [];
    const cancelled = second.findIndex((message) => message.role === 'user' && textOf(message.content).startsWith('The writer cancelled the plan'));
    const noted = second.findIndex((message) => textOf(message.content) === `${NOTE}Skip The Friend.`);
    expect(cancelled).toBeGreaterThan(-1);
    expect(noted).toBeGreaterThan(cancelled);
    expect(report.steering).toEqual([{ noteId: 'steer.turn-1.note-1', text: 'Skip The Friend.', deliveredAtCall: 2 }]);
  });

  it('ends a plain Cancel with no note as it always did', async () => {
    const f = await fixture(intent, [plan], { decide: () => ({ action: 'cancel' }) });
    const report = await f.session.submit(intent);
    expect(report.status).toBe('cancelled');
    expect(report.stop).toBeUndefined();
    expect(report.summary).toBe('Cancelled. Nothing was written.');
    expect(f.seen).toHaveLength(1);
  });
});
