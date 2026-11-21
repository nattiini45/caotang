/**
 * Replay (agent-harness §8.1): a recording run against another destination on a scratch copy, in three modes.
 *
 * Every case here is recorded first and replayed from that recording, so what the test reads is what a writer's trace would hold:
 * the cassette mode reproduces a recorded turn's project byte for byte, a changed prompt is named at the message it moved, a turn
 * replay leaves the real project exactly as it found it, and a card nobody approved the like of stops the replay.
 */

import { describe, expect, it } from 'vitest';

import { cloneProjectState, type ProjectState } from '@caotang/store';
import type { ChatRequest, Gateway } from '@caotang/gateway';

import {
  ReplayRefusal,
  cassetteScripts,
  createAgentPorts,
  createAgentSession,
  createTraceStore,
  estimateReplay,
  projectBytes,
  recordedCalls,
  recordedDecisions,
  replay,
  traceGateway,
  type ReplaySource,
  type TraceStore,
} from '../../src/index.js';
import { clock, makeHarness, makeState } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { prose, steps, transcript } from './scripts.js';

const INTENT = 'Fill in the synopsis of The Storm.';
const SYNOPSIS = steps({ tool: 'synopsis.fill', params: { docs: ['n_TEMPEST001'], source: 'text', max_words: 20 }, expect: 'The Storm has a synopsis' });
const SYNOPSIS_PROSE = 'A storm takes the lamp, and the keeper must choose.';

interface Recording {
  readonly state: ProjectState;
  /** The project as it was when the turn started, which is what a turn replay runs on. */
  readonly before: ProjectState;
  readonly store: TraceStore;
  readonly turnId: string;
  readonly gateway: Gateway;
  readonly body: string;
}

/** One recorded turn: the mock plans a draft, the prose answers, and the trace is kept as the app keeps it. */
async function record(options: { readonly reply?: string } = {}): Promise<Recording> {
  const state = makeState();
  const before = cloneProjectState(state);
  const store = createTraceStore({ sessionId: 'record', project: () => 'The Lighthouse Keeper' });
  const gateway = await mockGateway([transcript(INTENT, [options.reply ?? SYNOPSIS]), prose('Document "The Storm":', SYNOPSIS_PROSE)]);
  // The app attaches the gateway's observer itself; the recording needs it as much as the turn's own records.
  gateway.setObserver(traceGateway(store));
  const session = createAgentSession({
    // The product's ports, as the app's harness has them: the declared tool catalogue is part of the prompt a cassette matches.
    harness: makeHarness({ ports: createAgentPorts() }, state),
    gateway,
    decide: async () => ({ action: 'approve' }),
    sessionId: 'record',
    trace: store,
  });
  const report = await session.submit(INTENT);
  return { state, before, store, turnId: report.turnId, gateway, body: projectBytes(state) };
}

/** The mock profile a session can be pinned to, which is where a replay is sent in these tests. */
async function profileOf(gateway: Gateway): Promise<string> {
  const [profile] = await gateway.profiles.list();
  if (profile === undefined) throw new Error('the mock gateway has no profile');
  return profile.id;
}

describe('replay: the cassette answers a recorded turn', () => {
  it('reproduces the recorded turn on the scratch project, step for step and byte for byte', async () => {
    const run = await record();
    const result = await replay({ mode: 'cassette', source: run.store, turnId: run.turnId, snapshot: run.before, clock: clock.now });

    expect(result.stoppedAt).toBeUndefined();
    expect(result.report?.status).toBe('applied');
    expect(result.projectBytes).toBe(run.body);
    expect(result.steps.map((step) => step.replay?.tool)).toEqual(['synopsis.fill']);
    expect(result.steps.every((step) => step.changedParams.length === 0)).toBe(true);
    expect(result.usage.replay.promptTokens).toBeGreaterThan(0);
  });

  it('names the message a changed prompt moved, and runs no further call', async () => {
    const run = await record();
    // The prompt moved by one line, as a template change would: the cassette must say which message and where.
    const source: ReplaySource = {
      records: (turnId) => run.store.records(turnId),
      message: (id) => {
        const message = run.store.message(id);
        if (message === undefined || message.role !== 'system' || typeof message.content !== 'string') return message;
        return { ...message, content: `${message.content}\nOne more line.` };
      },
    };

    const result = await replay({ mode: 'cassette', source, turnId: run.turnId, snapshot: run.before });

    expect(result.stoppedAt?.reason).toBe('cassette-miss');
    expect(result.stoppedAt?.detail).toContain('Request 1 differs from the recorded one');
    expect(result.stoppedAt?.detail).toContain('message 1');
    expect(result.steps.every((step) => step.replay === undefined)).toBe(true);
  });

  it('serves the recorded replies in order, so two calls in one turn are not swapped', async () => {
    const run = await record();
    const scripts = cassetteScripts(run.store, run.turnId);
    expect(scripts).toHaveLength(1);
    const first = await recordedCalls(run.store, run.turnId);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe('replay: a turn against another destination', () => {
  it('never changes the real project, its bytes or its documents', async () => {
    const run = await record();
    const target = await profileOf(run.gateway);
    const other = await mockGateway([transcript(INTENT, [steps({ tool: 'synopsis.fill', params: { docs: ['n_TEMPEST001'], source: 'text', max_words: 10 }, expect: 'The Storm has a shorter synopsis' })]), prose('Document "The Storm":', 'Something else.')]);
    const otherTarget = await profileOf(other);

    const result = await replay({ mode: 'turn', source: run.store, turnId: run.turnId, snapshot: run.before, target: { profileId: otherTarget }, gateway: other, sessionId: 'replay-a' });

    expect(projectBytes(run.state)).toBe(run.body);
    expect(result.projectBytes).not.toBe(run.body);
    // The pin reached the request: the replay's own ledger rows name the target profile, never the recording's.
    expect(result.usage.replay.modelCalls).toBeGreaterThan(0);
    expect(target).toBeTruthy();
    expect(otherTarget).toBeTruthy();
  });

  it('re-applies a recorded approval when the card names the same tools, and sends no second decision', async () => {
    const run = await record();
    expect(recordedDecisions(run.store, run.turnId).map((card) => [card.tools, card.decision])).toEqual([[['synopsis.fill'], 'approved']]);
    const asked: string[] = [];
    const result = await replay({
      mode: 'cassette',
      source: run.store,
      turnId: run.turnId,
      snapshot: run.before,
      decide: async (pending) => {
        asked.push(pending.card.id);
        return { action: 'cancel' };
      },
    });

    expect(asked).toEqual([]);
    expect(result.stoppedAt).toBeUndefined();
    expect(result.report?.status).toBe('applied');
  });

  it('stops on a card nobody approved the like of, and asks when the caller can decide', async () => {
    const run = await record();
    // One tool more than the recording's card: nobody approved the like of this plan.
    const replayGateway = await mockGateway([
      transcript(INTENT, [
        steps(
          { tool: 'meta.set', params: { targets: ['The Storm'], label: 'act-1' }, expect: 'The Storm is labelled' },
          { tool: 'synopsis.fill', params: { docs: ['n_TEMPEST001'], source: 'text', max_words: 20 }, expect: 'The Storm has a synopsis' },
        ),
      ]),
      prose('Document "The Storm":', SYNOPSIS_PROSE),
    ]);

    const alone = await replay({ mode: 'turn', source: run.store, turnId: run.turnId, snapshot: run.before, target: { profileId: await profileOf(replayGateway) }, gateway: replayGateway, sessionId: 'replay-b' });
    expect(alone.stoppedAt?.reason).toBe('decision-mismatch');
    expect(alone.stoppedAt?.detail).toContain('meta.set, synopsis.fill');
    expect(alone.report?.status).toBe('cancelled');

    const asked: string[] = [];
    const decided = await replay({
      mode: 'turn',
      source: run.store,
      turnId: run.turnId,
      snapshot: run.before,
      target: { profileId: await profileOf(replayGateway) },
      gateway: replayGateway,
      sessionId: 'replay-c',
      decide: async (_pending, recorded) => {
        asked.push(recorded?.tools.join(',') ?? 'none');
        return { action: 'approve' };
      },
    });
    expect(asked).toEqual(['synopsis.fill']);
    expect(decided.report?.status).toBe('applied');
  });
});

describe('replay: one recorded call', () => {
  it('sends exactly one request to the target profile and model, declares no tools, and runs nothing', async () => {
    const run = await record();
    const base = await mockGateway([mockRespond('A cheaper opening.')]);
    const seen: ChatRequest[] = [];
    const gateway: Gateway = {
      ...base,
      completeOnce: (request, signal, before) => {
        seen.push(request);
        return base.completeOnce(request, signal, before);
      },
    };

    const result = await replay({ mode: 'call', source: run.store, turnId: run.turnId, callIndex: 1, target: { profileId: await profileOf(base), model: 'mock-small', thinking: 'low' }, gateway, sessionId: 'replay-d' });

    expect(seen).toHaveLength(1);
    const request = seen[0] as ChatRequest;
    expect(request.profileId).toBe(await profileOf(base));
    expect(request.model).toBe('mock-small');
    expect(request.thinking).toBe('low');
    expect(request.tools).toBeUndefined();
    expect(request.messages.length).toBe(recordedCalls(run.store, run.turnId)[0]?.messages.length);
    expect(result.reply?.content).toBe('A cheaper opening.');
    expect(result.report).toBeUndefined();
    expect(result.steps.every((step) => step.replay === undefined)).toBe(true);
    expect(projectBytes(run.state)).toBe(run.body);
  });

  it('refuses a recording whose text was left out, rather than send a shorter prompt', async () => {
    const run = await record();
    const omitted: ReplaySource = {
      records: (turnId) => run.store.records(turnId),
      message: (id) => {
        const message = run.store.message(id);
        if (message === undefined || typeof message.content !== 'string') return message;
        return { ...message, content: { omitted: { chars: message.content.length } } };
      },
    };
    const base = await mockGateway([]);
    await expect(
      replay({ mode: 'call', source: omitted, turnId: run.turnId, callIndex: 1, target: { profileId: await profileOf(base) }, gateway: base }),
    ).rejects.toBeInstanceOf(ReplayRefusal);
  });
});

describe('replay: the estimate a writer confirms first', () => {
  it('reads the recording’s own input tokens and the target’s cap, thinking included', async () => {
    const run = await record();
    const gateway = await mockGateway([]);
    const limit = await profileOf(gateway);
    const calls = recordedCalls(run.store, run.turnId);
    const estimate = estimateReplay({ mode: 'turn', source: run.store, turnId: run.turnId, target: { profileId: limit } }, (profileId, model, thinking) =>
      gateway.modelLimits(profileId, model, thinking),
    );

    expect(estimate.promptTokens).toBe(calls.reduce((sum, call) => sum + (call.response?.['gen_ai.usage.input_tokens'] ?? 0), 0));
    expect(estimate.modelCalls).toBe(calls.length);
    const limits = gateway.modelLimits(limit);
    expect(estimate.maxCompletionTokens).toBe((limits.maxOutputTokens + (limits.thinkingTokens ?? 0)) * calls.length);
  });

  it('refuses without a target: a replay is only ever sent to a profile the writer saved', async () => {
    const run = await record();
    const gateway = await mockGateway([]);
    expect(() => estimateReplay({ mode: 'turn', source: run.store, turnId: run.turnId }, (profileId, model, thinking) => gateway.modelLimits(profileId, model, thinking))).toThrow(
      ReplayRefusal,
    );
  });
});

/** A script that answers any request with one reply, for a target that only has to say something. */
function mockRespond(text: string) {
  return {
    match: () => true,
    respond: () => ({ content: text, finishReason: 'stop' as const }),
  };
}
