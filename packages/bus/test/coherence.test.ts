/**
 * The coherence rules the bus shares with the store (coherence.md §5.2, §5.2.1, §6.3, §7.1), and the
 * two descriptors that validate them. Pure: each assertion is over the rule or the descriptor's validate.
 */

import { describe, expect, it } from 'vitest';

import {
  COHERENCE_NOTE_LIMIT,
  COHERENCE_STATUSES,
  DISMISSAL_REASON_IDS,
  SCENE_PATCH_KEYS,
  TIMELINE_MODES,
  applySceneMetaPatch,
  findingTransition,
  inverseScenePatch,
  isEmptySceneMeta,
  COMMAND_REGISTRY,
  type ValidationSnapshot,
} from '../src/index.js';

const SCENE = 'n_SCENE00001';
const ENTRY = 'c_ENTRY00001';
const FINDING = 'f_AAAAAAAAAA';

const context = {
  entries: [{ id: ENTRY, name: 'Elena' }],
  documentIds: new Set([SCENE, 'n_OTHER00001']),
};

/** A snapshot with one scene, one codex entry and one open finding, and a coherence file open. */
function snapshot(overrides: Partial<ValidationSnapshot> = {}): ValidationSnapshot {
  return {
    manifest: {
      tree: [
        { id: 'manuscript', parentId: 'root', type: 'folder', title: 'Manuscript', status: null, label: null, keywords: [], synopsis: '', notes: '' },
        { id: SCENE, parentId: 'manuscript', type: 'document', title: 'The Storm', status: null, label: null, keywords: [], synopsis: '', notes: '' },
        { id: 'n_OTHER00001', parentId: 'manuscript', type: 'document', title: 'The Letter', status: null, label: null, keywords: [], synopsis: '', notes: '' },
      ],
      vocabulary: { statuses: [], labels: [] },
      codex: [{ id: ENTRY, name: 'Elena' }],
    },
    documents: new Map([
      [SCENE, { body: 'The gale arrived at dawn.', revision: 1 }],
      ['n_OTHER00001', { body: 'A letter.', revision: 1 }],
    ]),
    coherence: { findings: [{ id: FINDING, status: 'open' }], sceneMeta: {} },
    ...overrides,
  };
}

describe('the scene-metadata patch rule (coherence.md §5.2, §5.2.1)', () => {
  it('sets each declared field, and a clear with null removes it', () => {
    const set = applySceneMetaPatch(SCENE, undefined, { pov: ENTRY, dayOffset: 4, durationDays: 2, timelineMode: 'flashback' }, context);
    expect(set).toEqual({ ok: true, meta: { pov: ENTRY, dayOffset: 4, durationDays: 2, timelineMode: 'flashback' } });
    const cleared = applySceneMetaPatch(SCENE, set.ok ? set.meta : undefined, { pov: null, dayOffset: null }, context);
    expect(cleared.ok && cleared.meta).toEqual({ durationDays: 2, timelineMode: 'flashback' });
  });

  it('accepts a day offset before day 0, down to −10,000,000 (§5.2.2)', () => {
    for (const day of [-1, -3650, -10_000_000, 10_000_000, 0]) {
      const result = applySceneMetaPatch(SCENE, undefined, { dayOffset: day }, context);
      expect(result.ok && result.meta, String(day)).toEqual({ dayOffset: day });
    }
  });

  it('refuses a day offset out of range or not a whole number, naming the range (§5.2.2)', () => {
    for (const bad of [-10_000_001, 10_000_001, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, '3' as unknown as number, '-3' as unknown as number, '\u22123' as unknown as number]) {
      const result = applySceneMetaPatch(SCENE, undefined, { dayOffset: bad }, context);
      expect(result.ok, String(bad)).toBe(false);
      if (!result.ok) expect(result.error).toContain('a whole number of days between −10,000,000 and 10,000,000');
    }
    const quoted = applySceneMetaPatch(SCENE, undefined, { dayOffset: '-3' as unknown as number }, context);
    expect(quoted.ok === false && quoted.error).toContain('got "-3"');
  });

  it('still refuses a negative duration (§5.2.2 keeps durationDays ≥ 0)', () => {
    for (const bad of [-1, -3650, 1.5]) {
      const result = applySceneMetaPatch(SCENE, undefined, { durationDays: bad }, context);
      expect(result.ok, String(bad)).toBe(false);
      if (!result.ok) expect(result.error).toContain('zero or more');
    }
  });

  it('declares a story part, clears it with null, and refuses an unknown part listing the valid ones (§5.2.2)', () => {
    const prologue = applySceneMetaPatch(SCENE, { dayOffset: -14 }, { storyPart: 'prologue' }, context);
    expect(prologue.ok && prologue.meta).toEqual({ dayOffset: -14, storyPart: 'prologue' });
    const epilogue = applySceneMetaPatch(SCENE, { storyPart: 'prologue' }, { storyPart: 'epilogue' }, context);
    expect(epilogue.ok && epilogue.meta).toEqual({ storyPart: 'epilogue' });
    const cleared = applySceneMetaPatch(SCENE, { storyPart: 'epilogue', dayOffset: 4000 }, { storyPart: null }, context);
    expect(cleared.ok && cleared.meta).toEqual({ dayOffset: 4000 });
    for (const bad of ['coda', 'main', 'Prologue', '', 3 as unknown as string]) {
      const result = applySceneMetaPatch(SCENE, undefined, { storyPart: bad }, context);
      expect(result.ok, String(bad)).toBe(false);
      if (!result.ok) expect(result.error).toContain('valid parts are prologue, epilogue, or null for the main story');
    }
  });

  it('inverts a story part and a negative day back to what they were (§5.2.2)', () => {
    const before = { dayOffset: 3 };
    const forward = { dayOffset: -3650, storyPart: 'prologue' };
    const applied = applySceneMetaPatch(SCENE, before, forward, context);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const inverse = inverseScenePatch(before, forward, applied.meta);
    expect(inverse).toEqual({ dayOffset: 3, storyPart: null });
    const restored = applySceneMetaPatch(SCENE, applied.meta, inverse, context);
    expect(restored.ok && restored.meta).toEqual(before);
  });

  it('keeps linear as absence, and refuses a timeline mode outside the §5.2.1 enum', () => {
    const linear = applySceneMetaPatch(SCENE, { timelineMode: 'flashback' }, { timelineMode: 'linear' }, context);
    expect(linear.ok && linear.meta).toEqual({});
    const unknown = applySceneMetaPatch(SCENE, undefined, { timelineMode: 'montage' }, context);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('valid modes are');
    // `time-skip` is in the enum since `timeline.gap` consumes it (coherence.md §5.2.1).
    const skip = applySceneMetaPatch(SCENE, undefined, { timelineMode: 'time-skip' }, context);
    expect(skip.ok && skip.meta).toEqual({ timelineMode: 'time-skip' });
  });

  it('refuses a scene that follows itself, and a dependency or codex id the project does not hold', () => {
    expect(applySceneMetaPatch(SCENE, undefined, { after_add: [SCENE] }, context).ok).toBe(false);
    expect(applySceneMetaPatch(SCENE, undefined, { after_add: ['n_NOPE000000'] }, context).ok).toBe(false);
    const expected = applySceneMetaPatch(SCENE, undefined, { expectedPresent_add: ['c_NOPE000000'] }, context);
    expect(expected.ok).toBe(false);
    if (!expected.ok) expect(expected.error).toContain('valid codex entries are Elena');
  });

  it('refuses a key outside the closed set, and names the keys that are valid', () => {
    const result = applySceneMetaPatch(SCENE, undefined, { mood: 'grim' } as never, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(SCENE_PATCH_KEYS.join(', '));
  });

  it('drops an emptied record, so a file never holds an empty declaration', () => {
    const cleared = applySceneMetaPatch(SCENE, { dayOffset: 2 }, { dayOffset: null }, context);
    expect(cleared.ok && isEmptySceneMeta(cleared.meta)).toBe(true);
  });
});

describe('dialogueContainer in the scene-metadata patch (coherence.md §5.1 medium.speaker-parity)', () => {
  const withDialogue = { ...context, dialogueIds: new Set(['n_COURT00001']) };

  it('sets the link, clears it with null, and names the field when the id is not a dialogue container', () => {
    const set = applySceneMetaPatch(SCENE, undefined, { dialogueContainer: 'n_COURT00001' }, withDialogue);
    expect(set).toEqual({ ok: true, meta: { dialogueContainer: 'n_COURT00001' } });
    expect(applySceneMetaPatch(SCENE, set.ok ? set.meta : undefined, { dialogueContainer: null }, withDialogue)).toEqual({ ok: true, meta: {} });
    const unknown = applySceneMetaPatch(SCENE, undefined, { dialogueContainer: SCENE }, withDialogue);
    expect(!unknown.ok && unknown.error).toContain('dialogueContainer names');
    const blank = applySceneMetaPatch(SCENE, undefined, { dialogueContainer: '  ' }, withDialogue);
    expect(!blank.ok && blank.error).toContain('dialogueContainer must be the id of a dialogue container');
  });

  it('makes no check of the id when the caller supplied no dialogue ids, as for documentIds', () => {
    expect(applySceneMetaPatch(SCENE, undefined, { dialogueContainer: 'n_ANY0000000' }, context).ok).toBe(true);
  });

  it('undoes a set to the prior link, or to a clear when there was none', () => {
    const prior = { dialogueContainer: 'n_COURT00001' };
    expect(inverseScenePatch(undefined, { dialogueContainer: 'n_COURT00001' }, prior)).toEqual({ dialogueContainer: null });
    expect(inverseScenePatch(prior, { dialogueContainer: null }, {})).toEqual({ dialogueContainer: 'n_COURT00001' });
  });

  it('is one of the closed patch keys, and the descriptor refuses it on a folder', () => {
    expect(SCENE_PATCH_KEYS).toContain('dialogueContainer');
    const validate = COMMAND_REGISTRY['coherence.setSceneMeta'].descriptor.validate;
    const folder = validate({ docId: 'manuscript', patch: { dialogueContainer: 'n_COURT00001' } }, snapshot());
    expect(!folder.ok && folder.error.message).toContain('a dialogue container is linked to a scene, not a folder');
  });
});

describe('threads in the scene-metadata patch (coherence.md §5.5)', () => {
  const OTHER = 'n_OTHER00001';
  const lamp = { id: 'the lamp', payoff: OTHER, note: 'it is lit again' };

  it('declares a thread, trims its handle, and keeps the threads sorted by handle', () => {
    const first = applySceneMetaPatch(SCENE, undefined, { threads_add: [{ id: '  the map ', payoff: OTHER }, lamp] }, context);
    expect(first.ok && first.meta.threads).toEqual([lamp, { id: 'the map', payoff: OTHER }]);
  });

  it('refuses an empty or whitespace-only handle, naming the field', () => {
    for (const id of ['', '   ']) {
      const result = applySceneMetaPatch(SCENE, undefined, { threads_add: [{ id, payoff: OTHER }] }, context);
      expect(result).toEqual({ ok: false, error: 'threads_add[0].id must be a handle that is not blank' });
    }
  });

  it('refuses a payoff that is not a document, one that is the scene itself, and one that is blank', () => {
    const gone = applySceneMetaPatch(SCENE, undefined, { threads_add: [{ id: 'x', payoff: 'n_MISSING001' }] }, context);
    expect(!gone.ok && gone.error).toContain('threads_add[0].payoff names "n_MISSING001", which is not a document');
    const self = applySceneMetaPatch(SCENE, undefined, { threads_add: [{ id: 'x', payoff: SCENE }] }, context);
    expect(!self.ok && self.error).toContain('threads_add[0].payoff cannot be the scene that sets the thread up');
    const blank = applySceneMetaPatch(SCENE, undefined, { threads_add: [{ id: 'x', payoff: ' ' }] }, context);
    expect(!blank.ok && blank.error).toContain('threads_add[0].payoff must be the id of the document');
  });

  it('refuses a handle already on the scene, in any case, unless the same patch removes it', () => {
    const current = { threads: [lamp] };
    const twice = applySceneMetaPatch(SCENE, current, { threads_add: [{ id: 'The Lamp', payoff: OTHER }] }, context);
    expect(!twice.ok && twice.error).toContain('is already a thread on this scene');
    const within = applySceneMetaPatch(SCENE, undefined, { threads_add: [lamp, { ...lamp, id: 'THE LAMP' }] }, context);
    expect(within.ok).toBe(false);
    const edit = applySceneMetaPatch(SCENE, current, { threads_remove: ['the lamp'], threads_add: [{ id: 'the lamp', payoff: OTHER, note: 'lit' }] }, context);
    expect(edit.ok && edit.meta.threads).toEqual([{ id: 'the lamp', payoff: OTHER, note: 'lit' }]);
  });

  it('refuses an over-long handle or note, and entries that are not threads', () => {
    const longId = applySceneMetaPatch(SCENE, undefined, { threads_add: [{ id: 'x'.repeat(81), payoff: OTHER }] }, context);
    expect(!longId.ok && longId.error).toContain('threads_add[0].id is 81 characters; the limit is 80');
    const longNote = applySceneMetaPatch(SCENE, undefined, { threads_add: [{ id: 'x', payoff: OTHER, note: 'n'.repeat(201) }] }, context);
    expect(!longNote.ok && longNote.error).toContain('threads_add[0].note is 201 characters; the limit is 200');
    const notThread = applySceneMetaPatch(SCENE, undefined, { threads_add: ['x'] as never }, context);
    expect(!notThread.ok && notThread.error).toContain('threads_add[0] must be an object');
  });

  it('removes by handle without regard to case, drops a blank note, and drops the key when none are left', () => {
    const noted = applySceneMetaPatch(SCENE, undefined, { threads_add: [{ id: 'x', payoff: OTHER, note: '  ' }] }, context);
    expect(noted.ok && noted.meta.threads).toEqual([{ id: 'x', payoff: OTHER }]);
    const gone = applySceneMetaPatch(SCENE, { threads: [lamp] }, { threads_remove: ['THE LAMP'] }, context);
    expect(gone.ok && isEmptySceneMeta(gone.meta)).toBe(true);
  });

  it('undoes an add, a removal and an edit to the threads that were there before', () => {
    const before = { threads: [lamp, { id: 'the map', payoff: OTHER }] };
    const patches = [
      { threads_add: [{ id: 'a key', payoff: OTHER }] },
      { threads_remove: ['the lamp'] },
      { threads_remove: ['the map'], threads_add: [{ id: 'the map', payoff: OTHER, note: 'found' }] },
      { threads_remove: ['the map'], threads_add: [{ id: 'the chart', payoff: OTHER }] },
    ];
    for (const forward of patches) {
      const after = applySceneMetaPatch(SCENE, before, forward, context);
      expect(after.ok).toBe(true);
      if (!after.ok) continue;
      const restored = applySceneMetaPatch(SCENE, after.meta, inverseScenePatch(before, forward, after.meta), context);
      expect(restored.ok && restored.meta, JSON.stringify(forward)).toEqual(before);
    }
    const first = applySceneMetaPatch(SCENE, undefined, patches[0] as never, context);
    expect(first.ok && applySceneMetaPatch(SCENE, first.meta, inverseScenePatch(undefined, patches[0] as never, first.meta), context)).toEqual({ ok: true, meta: {} });
  });
});

describe('inverseScenePatch (undo, command-bus §5)', () => {
  it('restores a scalar to its prior value, or to a clear when there was none', () => {
    const before = { dayOffset: 2 };
    const forward = { dayOffset: 5, pov: ENTRY };
    const after = applySceneMetaPatch(SCENE, before, forward, context);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const inverse = inverseScenePatch(before, forward, after.meta);
    expect(inverse).toEqual({ dayOffset: 2, pov: null });
    const restored = applySceneMetaPatch(SCENE, after.meta, inverse, context);
    expect(restored.ok && restored.meta).toEqual(before);
  });

  it('restores a list by membership: what was removed comes back, and what was added goes', () => {
    // A dependency is removed, so the undo must add it back.
    const removed = { after: ['n_OTHER00001'] };
    const dropping = { after_remove: ['n_OTHER00001'] };
    const afterRemove = applySceneMetaPatch(SCENE, removed, dropping, context);
    expect(afterRemove.ok).toBe(true);
    if (!afterRemove.ok) return;
    expect(isEmptySceneMeta(afterRemove.meta)).toBe(true);
    expect(inverseScenePatch(removed, dropping, afterRemove.meta)).toEqual({ after_add: ['n_OTHER00001'], after_remove: [] });

    // A dependency is added, so the undo must remove it again.
    const adding = { after_add: ['n_OTHER00001'] };
    const afterAdd = applySceneMetaPatch(SCENE, undefined, adding, context);
    expect(afterAdd.ok).toBe(true);
    if (!afterAdd.ok) return;
    expect(inverseScenePatch(undefined, adding, afterAdd.meta)).toEqual({ after_add: [], after_remove: ['n_OTHER00001'] });
  });
});

describe('finding transitions (coherence.md §6.3, the lifecycle)', () => {
  it('lets a dismissal, a fix and a re-open through from the states the lifecycle allows', () => {
    expect(findingTransition('open', 'dismissed')).toEqual({ ok: true });
    expect(findingTransition('open', 'fixed')).toEqual({ ok: true });
    expect(findingTransition('dismissed', 'open')).toEqual({ ok: true });
    expect(findingTransition('fixed', 'open')).toEqual({ ok: true });
  });

  it('refuses a move to the status a finding already holds, and a fix or dismissal of a finding not open', () => {
    expect(findingTransition('open', 'open').ok).toBe(false);
    expect(findingTransition('dismissed', 'fixed').ok).toBe(false);
    expect(findingTransition('fixed', 'dismissed').ok).toBe(false);
  });

  it('keeps the vocabulary the validator reads', () => {
    expect(COHERENCE_STATUSES).toEqual(['open', 'dismissed', 'fixed']);
    expect(DISMISSAL_REASON_IDS).toEqual(['flashback', 'in-world-lie', 'unreliable-narrator', 'intentional', 'false-positive']);
    expect(TIMELINE_MODES).toHaveLength(11);
    expect(COHERENCE_NOTE_LIMIT).toBe(500);
  });
});

describe('coherence.setSceneMeta descriptor (coherence.md §7.1)', () => {
  const validate = COMMAND_REGISTRY['coherence.setSceneMeta'].descriptor.validate;

  it('accepts a patch the rule accepts, and returns the params it will apply', () => {
    const result = validate({ docId: SCENE, patch: { pov: ENTRY, dayOffset: 1 } }, snapshot());
    expect(result).toEqual({ ok: true, value: { docId: SCENE, patch: { pov: ENTRY, dayOffset: 1 } } });
  });

  it('accepts a folder as well as a document, since a folder carries a window span (coherence.md §5.2, §5.1)', () => {
    // `manuscript` is a folder in the snapshot, and `timeline.window` reads its dayOffset and durationDays.
    const folder = validate({ docId: 'manuscript', patch: { dayOffset: 0, durationDays: 30 } }, snapshot());
    expect(folder.ok).toBe(true);
  });

  it('refuses a node the tree does not hold, and a project with no coherence file open', () => {
    const missing = validate({ docId: 'n_MISSING001', patch: { dayOffset: 1 } }, snapshot());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not-found');
    const noFile = validate({ docId: SCENE, patch: { dayOffset: 1 } }, snapshot({ coherence: undefined }));
    expect(noFile.ok).toBe(false);
    if (!noFile.ok) expect(noFile.error.message).toContain('no coherence file is open');
  });

  it('refuses a list key that is not a list of ids, before the shared rule iterates it', () => {
    const result = validate({ docId: SCENE, patch: { after_add: 'n_OTHER00001' } }, snapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('after_add must be a list of ids');
  });

  it('accepts a thread on a document, and refuses one on a folder or a list that is not a list', () => {
    const thread = { id: 'the lamp', payoff: 'n_OTHER00001' };
    expect(validate({ docId: SCENE, patch: { threads_add: [thread] } }, snapshot()).ok).toBe(true);
    const folder = validate({ docId: 'manuscript', patch: { threads_add: [thread] } }, snapshot());
    expect(!folder.ok && folder.error.message).toContain('a thread is declared on a scene, not a folder');
    const notList = validate({ docId: SCENE, patch: { threads_add: thread } }, snapshot());
    expect(!notList.ok && notList.error.message).toContain('threads_add must be a list of threads');
    const handles = validate({ docId: SCENE, patch: { threads_remove: 'the lamp' } }, snapshot());
    expect(!handles.ok && handles.error.message).toContain('threads_remove must be a list of ids');
    const blank = validate({ docId: SCENE, patch: { threads_add: [{ id: ' ', payoff: 'n_OTHER00001' }] } }, snapshot());
    expect(!blank.ok && blank.error.message).toContain('threads_add[0].id');
  });

  it('refuses a parameter outside the declared set', () => {
    const result = validate({ docId: SCENE, patch: {}, status: 'draft' }, snapshot());
    expect(result.ok).toBe(false);
  });
});

describe('coherence.setFindingStatus descriptor (coherence.md §6.3, §7.1)', () => {
  const validate = COMMAND_REGISTRY['coherence.setFindingStatus'].descriptor.validate;

  it('accepts a dismissal with a picker reason, and a fix of an open finding', () => {
    expect(validate({ findingId: FINDING, status: 'dismissed', reason: 'intentional' }, snapshot()).ok).toBe(true);
    expect(validate({ findingId: FINDING, status: 'fixed', note: 'Reworded.' }, snapshot()).ok).toBe(true);
  });

  it('refuses a dismissal without a reason from the picker, and a reason on any other status', () => {
    const noReason = validate({ findingId: FINDING, status: 'dismissed' }, snapshot());
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.message).toContain('a dismissal needs a reason from the picker');
    const freeText = validate({ findingId: FINDING, status: 'dismissed', reason: 'felt wrong' }, snapshot());
    expect(freeText.ok).toBe(false);
    const stray = validate({ findingId: FINDING, status: 'fixed', reason: 'intentional' }, snapshot());
    expect(stray.ok).toBe(false);
  });

  it('refuses an id the file does not hold, a status outside the enum, and an over-long note', () => {
    const unknown = validate({ findingId: 'f_BBBBBBBBBB', status: 'fixed' }, snapshot());
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('not-found');
    expect(validate({ findingId: FINDING, status: 'archived' }, snapshot()).ok).toBe(false);
    const long = validate({ findingId: FINDING, status: 'fixed', note: 'x'.repeat(COHERENCE_NOTE_LIMIT + 1) }, snapshot());
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.code).toBe('limit-exceeded');
  });

  it('refuses a move the lifecycle does not allow, such as fixing a finding already fixed', () => {
    const already = validate({ findingId: FINDING, status: 'fixed' }, snapshot({ coherence: { findings: [{ id: FINDING, status: 'fixed' }], sceneMeta: {} } }));
    expect(already.ok).toBe(false);
    if (!already.ok) expect(already.error.message).toContain('already fixed');
  });
});
