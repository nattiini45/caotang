/**
 * `meta.set` and `notes.append` — the two write-auto tools — and the properties
 * every write shares: validate-first, replay answered from the cache, and one undo
 * group that restores the project to its exact prior bytes.
 */

import { describe, expect, it } from 'vitest';

import { TICK, LANDING, STORM, CHAPTER_ONE, makeHarness, makeState, refusalOf, run, snapshotOf, valueOf } from './fixtures.js';

function nodeOf(state: ReturnType<typeof makeState>, id: string) {
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

describe('meta.set', () => {
  it('sets status, label and keywords on each target, and reports every node it changed', () => {
    const state = makeState();
    const outcome = valueOf(
      run(makeHarness({}, state), 'meta.set', {
        targets: [LANDING, STORM],
        status: 'revised',
        label: 'act-2',
        keywords_add: ['rain'],
        keywords_remove: ['grief'],
      }),
    );
    expect(nodeOf(state, LANDING)).toMatchObject({ status: 'revised', label: 'act-2' });
    expect(nodeOf(state, LANDING).keywords).toEqual(['sea', 'rain']);
    expect(nodeOf(state, STORM)).toMatchObject({ status: 'revised', label: 'act-2' });
    expect((outcome.data['changed'] as unknown[]).length).toBe(2);
    expect(outcome.affected.map((row) => row.nodeId)).toEqual([LANDING, STORM]);
    expect(outcome.undoGroupId).toBeDefined();
  });

  it('resolves a target by its title as well as by its id', () => {
    const state = makeState();
    valueOf(run(makeHarness({}, state), 'meta.set', { targets: ['The Storm'], status: 'final' }));
    expect(nodeOf(state, STORM).status).toBe('final');
  });

  it('refuses an unknown status, lists the valid ones, and changes nothing', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(run(makeHarness({}, state), 'meta.set', { targets: [LANDING], status: 'bogus' }));
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('batch refused');
    expect(error.details?.['failures']).toEqual([
      expect.objectContaining({ target: 'targets[0]', code: 'invalid-params' }),
    ]);
    expect(JSON.stringify(error.details)).toContain('valid status ids: draft, revised, final');
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses more than fifty targets, and says to split the call', () => {
    const targets = Array.from({ length: 51 }, () => LANDING);
    const error = refusalOf(run(makeHarness(), 'meta.set', { targets, status: 'draft' }));
    expect(error.code).toBe('limit-exceeded');
    expect(error.message).toBe('params.targets has 51 entries, at most 50 allowed');
    expect(error.correctiveHint).toContain('split the rest into another call');
  });

  it('refuses a whole batch when one target does not resolve, names that target, and writes nothing', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(run(makeHarness({}, state), 'meta.set', { targets: [LANDING, 'The Nowhere'], status: 'final' }));
    expect(error.code).toBe('invalid-params');
    expect(JSON.stringify(error.details)).toContain('targets[1]');
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a call that sets nothing, before it looks at a single target', () => {
    const error = refusalOf(run(makeHarness(), 'meta.set', { targets: [LANDING] }));
    expect(error.message).toContain('nothing to set');
  });

  it('refuses a target that names the project root', () => {
    const error = refusalOf(run(makeHarness(), 'meta.set', { targets: ['root'], status: 'draft' }));
    expect(error.code).toBe('invalid-params');
  });

  it('is idempotent: the same change applied twice leaves the same project', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    run(harness, 'meta.set', { targets: [LANDING], status: 'final', keywords_add: ['sea'] });
    const once = snapshotOf(state);
    run(harness, 'meta.set', { targets: [LANDING], status: 'final', keywords_add: ['sea'] });
    expect(snapshotOf(state)).toBe(once);
  });

  it('answers a replay of the same callId from the cache, with no second effect on the log', () => {
    const harness = makeHarness();
    const first = valueOf(run(harness, 'meta.set', { targets: [LANDING], status: 'final' }, { callId: 'replay-1', turnId: 'turn-r' }));
    const rows = harness.log.length;
    const replayed = valueOf(run(harness, 'meta.set', { targets: [LANDING], status: 'final' }, { callId: 'replay-1', turnId: 'turn-r' }));
    expect(harness.log.length).toBe(rows);
    expect(replayed.undoGroupId).toBe(first.undoGroupId);
    expect(replayed.data).toEqual(first.data);
  });

  it('refuses a replay whose callId was already used for a different call', () => {
    const harness = makeHarness();
    run(harness, 'meta.set', { targets: [LANDING], status: 'final' }, { callId: 'reuse-1', turnId: 'turn-m' });
    const error = refusalOf(run(harness, 'meta.set', { targets: [STORM], status: 'final' }, { callId: 'reuse-1', turnId: 'turn-m' }));
    expect(error.code).toBe('internal');
    expect(error.message).toContain('already used by a different call');
  });

  it('is undone, with the whole turn, back to the byte-identical prior project', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const outcome = valueOf(run(harness, 'meta.set', { targets: [LANDING, STORM], status: 'final', label: 'act-2', keywords_add: ['rain'] }, { turnId: 'turn-undo' }));
    expect(snapshotOf(state)).not.toBe(before);
    const undone = harness.undo.undo(outcome.undoGroupId ?? '');
    expect(undone.ok).toBe(true);
    expect(snapshotOf(state)).toBe(before);
  });

  it('needs no plan and no confirmation, because it is write-auto', () => {
    expect(valueOf(run(makeHarness(), 'meta.set', { targets: [LANDING], status: 'draft' })).summary).toContain('set metadata on 1 node');
  });
});

describe('notes.append', () => {
  it('appends under an agent date divider, after the notes already there', () => {
    const state = makeState();
    valueOf(run(makeHarness({}, state), 'notes.append', { doc: LANDING, text: 'Check the ferry timetable.' }));
    const day = new Date(TICK).toISOString().slice(0, 10);
    expect(nodeOf(state, LANDING).notes).toBe(
      `Fix pacing in the last three paragraphs.\n\n— agent, ${day}\nCheck the ferry timetable.`,
    );
  });

  it('refuses text over 2000 characters, and says how to split it, naming notes.replace as not yet available', () => {
    const error = refusalOf(run(makeHarness(), 'notes.append', { doc: LANDING, text: 'x'.repeat(2001) }));
    expect(error.code).toBe('limit-exceeded');
    expect(error.correctiveHint).toContain('2000 characters');
    expect(error.correctiveHint).toContain('v0.2');
  });

  it('refuses a folder as its target, because notes.append names a document', () => {
    const error = refusalOf(run(makeHarness(), 'notes.append', { doc: CHAPTER_ONE, text: 'Hello.' }));
    expect(error.message).toContain('is a folder, not a document');
  });

  it('refuses blank text, which would add a divider and nothing to say', () => {
    const error = refusalOf(run(makeHarness(), 'notes.append', { doc: LANDING, text: '   ' }));
    expect(error.code).toBe('invalid-params');
  });

  it('is undone, back to the byte-identical prior notes', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const outcome = valueOf(run(harness, 'notes.append', { doc: LANDING, text: 'A thought.' }));
    harness.undo.undo(outcome.undoGroupId ?? '');
    expect(snapshotOf(state)).toBe(before);
  });
});
