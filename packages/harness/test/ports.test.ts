/**
 * The four port tools: their schemas are real, their calls are refused as not wired
 * until an implementation is injected, and an injected implementation runs under
 * the same gate and dispatches through the same bus as any other tool.
 */

import { ok, err } from '@caotang/bus';
import { describe, expect, it } from 'vitest';

import { type ToolPort } from '../src/index.js';
import { checkedHarness, LANDING, makeHarness, makeState, refusalOf, run, snapshotOf, STORM, valueOf } from './fixtures.js';

describe('a port tool with no implementation injected', () => {
  it('refuses codex.read as not wired, in the bus’s own words, and writes nothing', () => {
    const error = refusalOf(run(makeHarness(), 'codex.read', { query: 'Elena' }));
    expect(error.code).toBe('internal');
    expect(error.message).toContain('"codex.read" is registered but has no implementation in this build');
    expect(error.correctiveHint).toContain('do not retry codex.read');
  });

  it('validates the params before it reports not wired, so a malformed call says what is wrong with it', () => {
    const error = refusalOf(run(makeHarness(), 'codex.read', { limit: 500 }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('params.limit must be ≤ 100');
  });

  it('refuses scene.draft as not wired, after its cross-field rule has passed', () => {
    const error = refusalOf(run(makeHarness(), 'scene.draft', { doc: LANDING, instruction: 'Write the storm.' }));
    expect(error.message).toContain('"scene.draft" is registered but has no implementation in this build');
  });

  it('refuses rewrite_selection with no anchor, before it reaches the not-wired refusal', () => {
    const error = refusalOf(run(makeHarness(), 'scene.draft', { doc: LANDING, instruction: 'Tighten it.', mode: 'rewrite_selection' }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toBe('mode rewrite_selection needs a selection anchor, and none was given');
    expect(error.correctiveHint).toBe('select text in the editor first, or pass a selection anchor');
  });

  it('refuses an anchor whose exact text is not the length of its span', () => {
    const error = refusalOf(
      run(makeHarness(), 'scene.draft', {
        doc: LANDING,
        instruction: 'Tighten it.',
        mode: 'rewrite_selection',
        selection: { from: 0, to: 5, exact: 'abc', prefix: '', suffix: '', capturedRevision: 0 },
      }),
    );
    expect(error.message).toBe('selection.exact is 3 characters, but from to to spans 5');
  });

  it('refuses an anchor whose to is not past its from', () => {
    const error = refusalOf(
      run(makeHarness(), 'scene.draft', {
        doc: LANDING,
        instruction: 'Tighten it.',
        mode: 'rewrite_selection',
        selection: { from: 4, to: 4, exact: '', prefix: '', suffix: '', capturedRevision: 0 },
      }),
    );
    expect(error.message).toBe('selection.to (4) must be greater than selection.from (4)');
  });

  it('refuses synopsis.fill and continuity.scan as not wired, with their own names', () => {
    expect(refusalOf(run(makeHarness(), 'synopsis.fill', { docs: [LANDING] })).message).toContain('"synopsis.fill"');
    expect(refusalOf(run(makeHarness(), 'continuity.scan', {})).message).toContain('"continuity.scan"');
  });
});

describe('a port tool with an implementation injected', () => {
  it('runs the injected implementation and returns what it returns', () => {
    const codexRead: ToolPort = (params) => ok({ data: { entries: [{ name: params['query'] }], total: 1, truncated: false }, summary: 'read the codex', affected: [] });
    const harness = makeHarness({ ports: { 'codex.read': codexRead } });
    expect(valueOf(run(harness, 'codex.read', { query: 'Elena' })).data).toEqual({ entries: [{ name: 'Elena' }], total: 1, truncated: false });
    expect(harness.tools().find((tool) => tool.name === 'codex.read')?.wired).toBe(true);
  });

  it('gates a write-confirm port the same way as a native tool: refused without a confirmation', () => {
    let calls = 0;
    const synopsisFill: ToolPort = () => {
      calls += 1;
      return ok({ data: {}, summary: 'drafted', affected: [] });
    };
    const harness = makeHarness({ ports: { 'synopsis.fill': synopsisFill } });
    const error = refusalOf(run(harness, 'synopsis.fill', { docs: [LANDING] }));
    expect(error.code).toBe('permission-denied');
    expect(calls).toBe(0);
  });

  it('lets a port dispatch bus commands under the call’s own turn, so its writes are gated and undoable like any other', () => {
    const state = makeState();
    const writeSynopsis: ToolPort = (params, context) => {
      const result = context.dispatch('binder.setSynopsis', { nodeId: String((params['docs'] as string[])[0]), synopsis: 'Drafted by a port.' });
      if (!result.ok) return err(result.error);
      return ok({ data: { rows: [{ doc: { id: LANDING, title: 'The Landing' }, action: 'replace', words: 4 }], count: 1 }, summary: 'drafted', affected: [...result.value.affected], undoGroupId: result.value.undoGroupId });
    };
    const harness = checkedHarness({ state, ports: { 'synopsis.fill': writeSynopsis }, clock: () => 1 });
    const before = snapshotOf(state);
    const outcome = valueOf(run(harness, 'synopsis.fill', { docs: [LANDING] }, { permission: { confirmed: true }, turnId: 'turn-port' }));
    expect(state.manifest.tree.find((node) => node.id === LANDING)?.synopsis).toBe('Drafted by a port.');
    expect(harness.undo.undo(outcome.undoGroupId ?? '').ok).toBe(true);
    expect(snapshotOf(state)).toBe(before);
  });

  it('keeps the port’s params validated: an injected port never sees a call the closed-set check refused', () => {
    let seen = false;
    const harness = makeHarness({
      ports: {
        'continuity.scan': () => {
          seen = true;
          return ok({ data: {}, summary: '', affected: [] });
        },
      },
    });
    const error = refusalOf(run(harness, 'continuity.scan', { aspects: ['timeline', 'timeline'] }));
    expect(error.code).toBe('invalid-params');
    expect(seen).toBe(false);
    expect(STORM).toBeDefined();
  });
});

describe('a port that throws', () => {
  it('is an internal refusal, not an exception, and writes nothing when it throws before it dispatches', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const broken: ToolPort = () => {
      throw new Error('the connection dropped');
    };
    const harness = makeHarness({ ports: { 'codex.read': broken } }, state);
    const error = refusalOf(run(harness, 'codex.read', { query: 'Elena' }));
    expect(error.code).toBe('internal');
    expect(error.message).toContain('threw before it answered: the connection dropped');
    expect(error.message).toContain('Nothing was written');
    expect(error.details?.['undoGroupId']).toBeUndefined();
    expect(snapshotOf(state)).toBe(before);
    expect(harness.log.length).toBe(0);
  });

  it('names the undo group its write registered, and reversing that group restores the project', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const writeThenThrow: ToolPort = (_params, context) => {
      context.dispatch('binder.setSynopsis', { nodeId: LANDING, synopsis: 'Drafted before the throw.' });
      throw new Error('the model connection dropped');
    };
    const harness = checkedHarness({ state, ports: { 'synopsis.fill': writeThenThrow }, clock: () => 1 });
    const error = refusalOf(run(harness, 'synopsis.fill', { docs: [LANDING] }, { permission: { confirmed: true }, turnId: 'turn-port-throw' }));
    expect(error.code).toBe('internal');
    const group = error.details?.['undoGroupId'];
    expect(typeof group).toBe('string');
    expect(error.message).toContain(`registered for undo as ${String(group)}`);
    expect(state.manifest.tree.find((node) => node.id === LANDING)?.synopsis).toBe('Drafted before the throw.');
    expect(harness.undo.undo(String(group)).ok).toBe(true);
    expect(snapshotOf(state)).toBe(before);
  });

  it('answers a replay of the same call from the cache, and does not run the port a second time', () => {
    let runs = 0;
    const writeThenThrow: ToolPort = (_params, context) => {
      runs += 1;
      context.dispatch('binder.setSynopsis', { nodeId: LANDING, synopsis: 'Written once.' });
      throw new Error('late failure');
    };
    const harness = checkedHarness({ state: makeState(), ports: { 'synopsis.fill': writeThenThrow }, clock: () => 1 });
    const options = { permission: { confirmed: true }, turnId: 'turn-port-replay', callId: 'port-replay' } as const;
    const first = run(harness, 'synopsis.fill', { docs: [LANDING] }, options);
    const replay = run(harness, 'synopsis.fill', { docs: [LANDING] }, options);
    expect(runs).toBe(1);
    expect(replay).toEqual(first);
  });
});

describe('a refusal a port returns', () => {
  it('is annotated with the earlier write and its undo group, as a native refusal is', () => {
    const state = makeState();
    const writeThenRefuse: ToolPort = (_params, context) => {
      context.dispatch('binder.setSynopsis', { nodeId: LANDING, synopsis: 'Written first.' });
      return err({ code: 'internal', message: 'the second half failed', correctiveHint: 'try again later' });
    };
    const harness = checkedHarness({ state, ports: { 'synopsis.fill': writeThenRefuse }, clock: () => 1 });
    const error = refusalOf(run(harness, 'synopsis.fill', { docs: [LANDING] }, { permission: { confirmed: true }, turnId: 'turn-port-refuse' }));
    expect(error.message).toContain('ran 1 command before this one was refused');
    expect(error.message).toContain('registered in undo group');
    expect(error.message).toContain('the second half failed');
    expect(error.details?.['completedCommands']).toEqual(['binder.setSynopsis']);
    expect(error.details?.['undoGroupId']).toBeDefined();
    expect(error.correctiveHint).toBe('try again later');
  });

  it('is returned as the port made it when nothing was dispatched', () => {
    const refusing: ToolPort = () => err({ code: 'invalid-params', message: 'the draft brief is empty', correctiveHint: 'send a brief' });
    const harness = makeHarness({ ports: { 'synopsis.fill': refusing } });
    const error = refusalOf(run(harness, 'synopsis.fill', { docs: [LANDING] }, { permission: { confirmed: true } }));
    expect(error).toEqual({ code: 'invalid-params', message: 'the draft brief is empty', correctiveHint: 'send a brief' });
  });
});
