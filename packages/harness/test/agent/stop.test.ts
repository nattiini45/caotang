/**
 * The writer's Stop (agent-harness §2, "Stop and steer"): one `AbortSignal` per turn reaches every model call and every awaited
 * step, and the turn ends as `cancelled` with `stop.by === 'user'`. A stop takes effect at a boundary — a model call, a card,
 * the gap between two steps — and never inside a bus command that has started. Each test drives the real session on the real
 * bus, with the model supplied by mock scripts.
 */

import { describe, expect, it } from 'vitest';

import type { CoherenceModel, ModelRequest } from '@caotang/coherence';
import type { ApplyContext } from '@caotang/bus';
import type { ChatChunk } from '@caotang/gateway';
import { isPlannerCall, userTextOf, type MockScript } from '@caotang/gateway/mock';
import { createProjectCommandRegistry, type ProjectState } from '@caotang/store';

import {
  createAgentPorts,
  createAgentSession,
  createContextPort,
  createHarness,
  type AgentEvent,
  type AgentSession,
  type Decision,
  type PendingCard,
  type TurnReport,
} from '../../src/index.js';
import { FRIEND, STORM, clock, makeState, snapshotOf } from '../fixtures.js';
import { mockGateway } from './gateway.js';
import { prose, steps, transcript } from './scripts.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A planner reply that streams its text in pieces, calling `onDelta` after each so a test can stop the turn mid-stream. */
function streamingPlanner(intent: string, pieces: readonly string[], onDelta: (index: number) => void): MockScript {
  return {
    match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`),
    respond: () =>
      (async function* (): AsyncGenerator<ChatChunk> {
        for (const [index, piece] of pieces.entries()) {
          yield { delta: piece };
          onDelta(index);
          await tick();
        }
        yield { finishReason: 'stop' };
      })(),
  };
}

/** A draft that streams in pieces, calling `onDelta` after each. */
function streamingDraft(marker: string, pieces: readonly string[], onDelta: (index: number) => void): MockScript {
  return {
    match: (req) => req.responseFormat === 'text' && userTextOf(req).includes(marker),
    respond: () =>
      (async function* (): AsyncGenerator<ChatChunk> {
        for (const [index, piece] of pieces.entries()) {
          yield { delta: piece };
          onDelta(index);
          await tick();
        }
        yield { finishReason: 'stop' };
      })(),
  };
}

interface Fixture {
  readonly session: AgentSession;
  readonly state: ProjectState;
  readonly events: AgentEvent[];
  readonly pending: PendingCard[];
  readonly stop: AbortController;
  readonly gateway: Awaited<ReturnType<typeof mockGateway>>;
}

interface FixtureOptions {
  readonly state?: ProjectState;
  readonly registry?: ReturnType<typeof createProjectCommandRegistry>;
  readonly decide?: (card: PendingCard, stop: AbortController) => Promise<Decision> | Decision;
  readonly coherence?: { readonly model: () => CoherenceModel };
}

async function fixture(scripts: readonly MockScript[], options: FixtureOptions = {}): Promise<Fixture> {
  const state = options.state ?? makeState();
  const gateway = await mockGateway(scripts);
  const harness = createHarness({
    state,
    ports: createAgentPorts(),
    clock: clock.now,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.coherence === undefined ? {} : { coherence: options.coherence }),
  });
  const stop = new AbortController();
  const events: AgentEvent[] = [];
  const pending: PendingCard[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => {
      pending.push(card);
      return options.decide === undefined ? { action: 'approve' } : options.decide(card, stop);
    },
    emit: (event) => events.push(event),
    sessionId: 'stop',
  });
  return { session, state, events, pending, stop, gateway };
}

const submit = (f: Fixture, intent: string): Promise<TurnReport> => f.session.submit(intent, { signal: f.stop.signal });

describe('stopping a turn', () => {
  it('ends a planner stream as cancelled by the writer, not as a provider failure, and the ledger still records the request', async () => {
    const intent = 'Tag The Storm and say why.';
    const f = await fixture([streamingPlanner(intent, ['{"reply": "I will ', 'think about ', 'it first"}'], (index) => { if (index === 0) f.stop.abort(); })]);
    const before = snapshotOf(f.state);
    const report = await submit(f, intent);

    expect(report.status).toBe('cancelled');
    expect(report.stop).toEqual({ by: 'user', during: 'planning' });
    expect(report.askBack).toBeUndefined();
    expect(report.summary).toBe('Stopped by you. Nothing was written.');
    expect(report.summary).not.toContain('model stopped');
    expect(report.trace).toEqual([]);
    expect(report.cards).toEqual([]);
    expect(snapshotOf(f.state)).toBe(before);
    // The aborted request's usage was still accounted: the stream is read to its terminal chunk.
    expect(report.tokens.requests).toBe(1);
    expect(report.tokens.promptTokens).toBeGreaterThan(0);
    // The turn closes as a cancelled one, in order.
    const phases = f.events.flatMap((event) => (event.type === 'turn' ? [event.phase] : []));
    expect(phases.at(-1)).toBe('cancelled');
    expect(f.events.at(-1)).toMatchObject({ type: 'report' });
  });

  it('makes no model call when the signal has fired before the turn starts', async () => {
    const intent = 'Tag The Storm.';
    const f = await fixture([transcript(intent, [steps({ tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'tagged' })])]);
    f.stop.abort();
    const report = await submit(f, intent);
    expect(report.status).toBe('cancelled');
    expect(report.stop).toEqual({ by: 'user', during: 'started' });
    expect(report.modelCalls).toBe(0);
    expect(report.tokens.requests).toBe(0);
  });

  it('clears a scene draft that was streaming, and writes nothing', async () => {
    const intent = 'Draft the friend.';
    const f = await fixture([
      transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'a draft' })]),
      streamingDraft('Open the friend.', ['The friend ', 'came in from ', 'the rain.'], (index) => { if (index === 1) f.stop.abort(); }),
    ]);
    const before = snapshotOf(f.state);
    const report = await submit(f, intent);

    expect(report.status).toBe('cancelled');
    expect(report.stop?.by).toBe('user');
    expect(snapshotOf(f.state)).toBe(before);
    expect(f.state.documents.get(FRIEND)?.body).toBe('');
    // The draft streamed (the ghost region was emptied and fed), and was never staged: no ghost, no card.
    const draftEvents = f.events.filter((event) => event.type === 'draft.delta');
    expect(draftEvents.length).toBeGreaterThan(0);
    expect(draftEvents[0]).toMatchObject({ start: true });
    expect(f.events.some((event) => event.type === 'ghost' || event.type === 'plan')).toBe(false);
    expect(report.cards).toEqual([]);
  });

  it('cancels a waiting card exactly as Cancel does, even when the decider never answers', async () => {
    const intent = 'Tag The Storm and The Friend.';
    const plan = steps(
      { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
      { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' },
    );

    const cancelled = await fixture([transcript(intent, [plan])], { decide: () => ({ action: 'cancel' }) });
    const byCancel = await cancelled.session.submit(intent);

    const stopped = await fixture([transcript(intent, [plan])], {
      decide: (_card, stop) => {
        // The writer presses Stop while the card is on screen; the decider is never answered.
        queueMicrotask(() => stop.abort());
        return new Promise<Decision>(() => {});
      },
    });
    const byStop = await submit(stopped, intent);

    expect(byStop.status).toBe('cancelled');
    expect(byStop.stop).toEqual({ by: 'user', during: 'awaiting-approval' });
    expect(byStop.cards).toEqual(byCancel.cards);
    expect(byStop.steps).toEqual(byCancel.steps);
    expect(byStop.trace).toEqual(byCancel.trace);
    expect(JSON.stringify(stopped.state.manifest.tree)).toBe(JSON.stringify(cancelled.state.manifest.tree));
    const last = stopped.events.filter((event) => event.type === 'card').at(-1);
    expect(last).toMatchObject({ card: { status: 'cancelled' } });
  });

  it('treats an approval that arrives with the signal already fired as a cancel', async () => {
    const intent = 'Tag The Storm and The Friend.';
    const f = await fixture(
      [
        transcript(intent, [
          steps(
            { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'tagged' },
            { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'labelled' },
          ),
        ]),
      ],
      {
        decide: (_card, stop) => {
          stop.abort();
          return { action: 'approve' };
        },
      },
    );
    const before = snapshotOf(f.state);
    const report = await submit(f, intent);
    expect(report.status).toBe('cancelled');
    expect(report.cards[0]?.decision).toBe('cancelled');
    expect(snapshotOf(f.state)).toBe(before);
  });
});

/** A registry whose `binder.setMeta` fires `onApply` as it starts, and then applies as it always does. */
function registryFiring(onApply: (calls: number) => void) {
  const registry = createProjectCommandRegistry({ clock });
  const real = registry['binder.setMeta'];
  let calls = 0;
  const apply = (state: ProjectState, params: never, context: ApplyContext): unknown => {
    calls += 1;
    onApply(calls);
    return (real.apply as (s: ProjectState, p: never, c: ApplyContext) => unknown)(state, params, context);
  };
  return { ...registry, 'binder.setMeta': { descriptor: real.descriptor, apply } } as typeof registry;
}

describe('stopping between steps', () => {
  const intent = 'Label The Friend and tag The Storm.';
  const plan = steps(
    { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
    { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
  );

  it('keeps the step that started, marks the rest not-run, says what was written, and restores the applied step', async () => {
    const held: { stop?: AbortController } = {};
    // The stop fires while the first step's apply is running: the apply is not interrupted, and the second step does not start.
    const registry = registryFiring((calls) => {
      if (calls === 1) held.stop?.abort();
    });
    const f = await fixture([transcript(intent, [plan])], { registry });
    held.stop = f.stop;
    const before = snapshotOf(f.state);

    const report = await submit(f, intent);

    expect(report.status).toBe('cancelled');
    expect(report.stop).toEqual({ by: 'user', during: 'running' });
    expect(report.trace.map((entry) => entry.outcome)).toEqual(['ok', 'not-run']);
    expect(report.steps.map((step) => step.status)).toEqual(['done', 'cancelled']);
    expect(f.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
    expect(f.state.manifest.tree.find((node) => node.id === STORM)?.keywords).not.toContain('storm');
    expect(report.summary).toMatch(/^Stopped by you\. Written before the stop: /);
    expect(report.undoGroupId).toBeDefined();
    expect(f.events.some((event) => event.type === 'checkpoint')).toBe(true);

    const restored = f.session.restore(report.turnId);
    expect(restored.ok).toBe(true);
    expect(snapshotOf(f.state)).toBe(before);
  });

  it('never interrupts a bus command that has started: a slow apply still lands in the undo group', async () => {
    const lone = 'Label The Friend.';
    const held: { stop?: AbortController } = {};
    const registry = registryFiring(() => held.stop?.abort());
    const f = await fixture(
      [transcript(lone, [steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' })])],
      { registry },
    );
    held.stop = f.stop;
    const report = await submit(f, lone);

    // The signal fired inside the command; the command completed, so there is nothing left for the stop to stop.
    expect(report.status).toBe('applied');
    expect(f.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBe('act-2');
    expect(report.undoGroupId).toBeDefined();
    expect(f.session.restore(report.turnId).ok).toBe(true);
    expect(f.state.manifest.tree.find((node) => node.id === FRIEND)?.label).toBeNull();
  });

  it('never interrupts export.compile once it has started', async () => {
    const exporting = 'Export the manuscript.';
    const state = makeState();
    const stop = new AbortController();
    const base = createProjectCommandRegistry({ clock });
    let compiled = 0;
    const registry = {
      ...base,
      'export.compile': {
        descriptor: base['export.compile'].descriptor,
        apply: (_state: unknown, params: Record<string, unknown>, context: ApplyContext) => {
          stop.abort();
          compiled += 1;
          context.undo.compensate('delete the exported file', () => {});
          context.report({ affected: [], summary: `compiled to ${String(params['format'])}` });
          return { artifact: 'export.md' };
        },
      },
    } as typeof base;
    const f = await fixture([transcript(exporting, [steps({ tool: 'export.compile', params: { selection: { root: 'manuscript' }, format: 'md' }, expect: 'compiled' })])], {
      state,
      registry,
    });
    const report = await f.session.submit(exporting, { signal: stop.signal });
    expect(compiled).toBe(1);
    expect(report.trace).toEqual([expect.objectContaining({ tool: 'export.compile', outcome: 'ok' })]);
    expect(report.steps[0]?.status).toBe('done');
  });
});

describe('the signal reaches the awaited steps', () => {
  it('hands the turn’s signal to the coherence review’s model calls', async () => {
    const intent = 'Review the storm for problems';
    const seen: (AbortSignal | undefined)[] = [];
    const model: CoherenceModel = {
      model: 'signal-test',
      complete: async (request: ModelRequest) => {
        seen.push(request.signal);
        return { content: '{"spans": []}', usage: { promptTokens: 4, completionTokens: 2 } };
      },
    };
    const f = await fixture(
      [transcript(intent, [steps({ tool: 'coherence.review', params: { scope: { mode: 'doc', docIds: [STORM] } }, expect: 'the storm is reviewed' })])],
      { coherence: { model: () => model } },
    );
    const report = await submit(f, intent);
    expect(report.status).toBe('applied');
    expect(seen.length).toBeGreaterThan(0);
    for (const signal of seen) expect(signal).toBe(f.stop.signal);
  });

  it('forwards the signal on every model request of a turn: the planner and a draft', async () => {
    const intent = 'Draft the friend.';
    const f = await fixture([
      transcript(intent, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'Open the friend.', mode: 'draft' }, expect: 'a draft' })]),
      prose('Open the friend.', 'The friend came in.'),
    ]);
    const signals: (AbortSignal | undefined)[] = [];
    const complete = f.gateway.complete.bind(f.gateway);
    const spied = { ...f.gateway, complete: (request: Parameters<typeof complete>[0], signal?: AbortSignal) => (signals.push(signal), complete(request, signal)) };
    const harness = createHarness({ state: f.state, ports: createAgentPorts(), clock: clock.now });
    const session = createAgentSession({ harness, gateway: spied, context: createContextPort({ state: f.state }), decide: async () => ({ action: 'approve' }), sessionId: 'sig' });
    const report = await session.submit(intent, { signal: f.stop.signal });
    expect(report.status).toBe('applied');
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal === f.stop.signal)).toBe(true);
  });
});
