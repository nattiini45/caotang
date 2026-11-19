/**
 * `codex.write` — write-confirm, one undo group, a batch validated before anything
 * runs, and the over-long description refused with a proposal rather than cut.
 */

import { describe, expect, it } from 'vitest';

import { ENTRY, LANDING, STORM, makeHarness, makeState, refusalOf, run, snapshotOf, valueOf } from './fixtures.js';

const CONFIRMED = { confirmed: true } as const;

function entryOf(state: ReturnType<typeof makeState>, id: string) {
  const entry = (state.manifest.codex ?? []).find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no codex entry ${id}`);
  return entry;
}

describe('codex.write', () => {
  it('validates external references without changing the entry’s provenance', () => {
    const state = makeState();
    const entry = entryOf(state, ENTRY);
    const before = { origin: entry.origin, sources: structuredClone(entry.sources) };
    const harness = makeHarness({}, state);
    const outcome = valueOf(run(harness, 'codex.write', {
      entries: [{ action: 'update', id: ENTRY, referenceEdits: [{
        action: 'create', title: 'The Tidemaker', url: 'https://example.org/tides', publisher: 'Gull Press',
        date: '2024-02-29', quote: 'The harbour keeps a separate tide log.',
      }] }],
    }, { permission: CONFIRMED }));
    expect(entry).toMatchObject(before);
    expect(entry.references).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^ref_/), title: 'The Tidemaker', publisher: 'Gull Press',
    })]);
    expect(outcome.data['diffs']).toEqual([expect.objectContaining({
      changes: [expect.objectContaining({ field: 'references', to: expect.stringContaining('The Tidemaker') })],
    })]);
    const refused = refusalOf(run(harness, 'codex.write', { entries: [
      { action: 'update', id: ENTRY, referenceEdits: [{ action: 'create', title: 'A refused link', url: 'data:text/plain,no' }] },
    ] }, { permission: CONFIRMED }));
    expect(refused.details?.failures?.[0]?.message).toContain('url must be an HTTP or HTTPS address without credentials');
    expect(entry.references).toHaveLength(1);
    harness.undo.undo(outcome.undoGroupId ?? '');
    expect(entry.references).toBeUndefined();
    expect(entry).toMatchObject(before);
  });

  it('validates a custom entry’s detail values by key without losing other saved detail values', () => {
    const state = makeState();
    const entry = entryOf(state, ENTRY);
    entry.type = 'Guest';
    entry.details = { futureValue: { keep: true } };
    state.manifest.codexDetailFields = [{ type: 'Guest', key: 'episode', label: 'Episode', kind: 'number' }];
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const bad = refusalOf(run(harness, 'codex.write', { entries: [{ action: 'update', id: ENTRY, details: { episode: 'one' } }] }, { permission: CONFIRMED }));
    expect(bad.details?.failures?.[0]?.message).toContain('details field "episode"');
    expect(snapshotOf(state)).toBe(before);
    const outcome = valueOf(run(harness, 'codex.write', { entries: [{ action: 'update', id: ENTRY, details: { episode: 1 } }] }, { permission: CONFIRMED }));
    expect(entry.details).toEqual({ futureValue: { keep: true }, episode: 1 });
    expect(outcome.data['diffs']).toEqual([expect.objectContaining({ changes: [{ field: 'details.episode', from: 'null', to: '1' }] })]);
    harness.undo.undo(outcome.undoGroupId ?? '');
    expect(snapshotOf(state)).toBe(before);
  });

  it('validates detail values on create and clears only the named detail on update', () => {
    const state = makeState();
    state.manifest.codexDetailFields = [
      { type: 'character', key: 'debut', label: 'Debut', kind: 'date' },
      { type: 'character', key: 'narrator', label: 'Narrator', kind: 'boolean' },
    ];
    const harness = makeHarness({}, state);
    const bad = refusalOf(run(harness, 'codex.write', {
      entries: [{ action: 'create', type: 'character', name: 'Neri', details: { debut: '2025-02-29' } }],
    }, { permission: CONFIRMED }));
    expect(bad.details?.failures?.[0]?.message).toContain('details field "debut"');
    const outcome = valueOf(run(harness, 'codex.write', {
      entries: [{ action: 'create', type: 'character', name: 'Neri', details: { debut: '2024-02-29', narrator: false } }],
    }, { permission: CONFIRMED }));
    const [id] = outcome.data['created'] as string[];
    expect(entryOf(state, id ?? '').details).toEqual({ debut: '2024-02-29', narrator: false });
    valueOf(run(harness, 'codex.write', {
      entries: [{ action: 'update', id, details: { debut: null } }],
    }, { permission: CONFIRMED }));
    expect(entryOf(state, id ?? '').details).toEqual({ narrator: false });
  });

  it('creates an entry attached to a node, and undoes it back to the byte-identical prior codex', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const outcome = valueOf(
      run(harness, 'codex.write', { entries: [{ action: 'create', name: 'Mara', type: 'character', description: 'The ferry pilot.', attachTo: [LANDING] }] }, { permission: CONFIRMED }),
    );
    const created = outcome.data['created'] as string[];
    expect(created).toHaveLength(1);
    expect(entryOf(state, created[0] ?? '')).toMatchObject({ name: 'Mara', type: 'character', attachments: [LANDING], origin: 'agent' });
    harness.undo.undo(outcome.undoGroupId ?? '');
    expect(snapshotOf(state)).toBe(before);
  });

  it('updates an existing entry, and attaches it to another node through codex.attach', () => {
    const state = makeState();
    const outcome = valueOf(
      run(makeHarness({}, state), 'codex.write', { entries: [{ action: 'update', id: ENTRY, description: 'The keeper of the light.', attachTo: [STORM] }] }, { permission: CONFIRMED }),
    );
    expect(entryOf(state, ENTRY)).toMatchObject({ description: 'The keeper of the light.', attachments: [STORM] });
    expect(outcome.data['updated']).toEqual([ENTRY]);
    expect(outcome.data['attachmentChanges']).toBe(1);
  });

  it('gives a diff for every entry, so the plan card can show old and new', () => {
    const outcome = valueOf(
      run(makeHarness(), 'codex.write', { entries: [{ action: 'update', id: ENTRY, description: 'New text.' }] }, { permission: CONFIRMED }),
    );
    const diffs = outcome.data['diffs'] as { changes: { field: string; from: string; to: string }[] }[];
    expect(diffs[0]?.changes).toEqual([{ field: 'description', from: '"The keeper."', to: '"New text."' }]);
  });

  it('refuses a create with no name, because codex.md §2 requires one', () => {
    const error = refusalOf(run(makeHarness(), 'codex.write', { entries: [{ action: 'create', description: 'Nameless.' }] }, { permission: CONFIRMED }));
    expect(error.details?.['failures']).toEqual([expect.objectContaining({ target: 'entries[0]', message: 'entries[0].name is required on a create' })]);
  });

  it('refuses a create that carries an id, because a create mints its own', () => {
    const error = refusalOf(run(makeHarness(), 'codex.write', { entries: [{ action: 'create', id: ENTRY, name: 'Twin' }] }, { permission: CONFIRMED }));
    expect(JSON.stringify(error.details)).toContain('a create mints its own id');
  });

  it('refuses an update of an entry that does not exist, and names codex.read', () => {
    const error = refusalOf(run(makeHarness(), 'codex.write', { entries: [{ action: 'update', id: 'c_MSSNG00001', name: 'Ghost' }] }, { permission: CONFIRMED }));
    expect(JSON.stringify(error.details)).toContain('use codex.read with a query to find the entry');
  });

  it('refuses a name that collides case-insensitively with an existing entry, and names that entry', () => {
    const error = refusalOf(run(makeHarness(), 'codex.write', { entries: [{ action: 'create', name: 'elena' }] }, { permission: CONFIRMED }));
    expect(error.details?.['failures']).toEqual([expect.objectContaining({ message: expect.stringContaining(`collides with the existing entry "Elena" (${ENTRY})`) })]);
  });

  it('refuses a description over 2000 characters with a proposed truncation, and cuts nothing silently', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const long = 'a'.repeat(2100);
    const error = refusalOf(run(makeHarness({}, state), 'codex.write', { entries: [{ action: 'update', id: ENTRY, description: long }] }, { permission: CONFIRMED }));
    expect(error.details?.['failures']).toEqual([expect.objectContaining({ code: 'limit-exceeded' })]);
    const proposals = error.details?.['proposals'] as { length: number; proposedDescription: string }[];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.length).toBe(2100);
    expect(proposals[0]?.proposedDescription).toBe('a'.repeat(2000));
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses more than twenty entries, and says to split the batch', () => {
    const entries = Array.from({ length: 21 }, (_, index) => ({ action: 'create', name: `Name ${index}` }));
    const error = refusalOf(run(makeHarness(), 'codex.write', { entries }, { permission: CONFIRMED }));
    expect(error.code).toBe('limit-exceeded');
    expect(error.message).toBe('params.entries has 21 entries, at most 20 allowed');
  });

  it('refuses an entry that both attaches and detaches the same node, because the two asks contradict', () => {
    const error = refusalOf(
      run(makeHarness(), 'codex.write', { entries: [{ action: 'update', id: ENTRY, attachTo: [STORM], detachFrom: [STORM] }] }, { permission: CONFIRMED }),
    );
    expect(JSON.stringify(error.details)).toContain('both attachTo and detachFrom');
  });

  it('writes nothing when any entry in the batch fails, and lists every failure', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(
      run(
        makeHarness({}, state),
        'codex.write',
        { entries: [{ action: 'create', name: 'Fine' }, { action: 'create' }, { action: 'update', id: 'c_MSSNG00001' }] },
        { permission: CONFIRMED },
      ),
    );
    expect(error.details?.['failures']).toHaveLength(2);
    expect(snapshotOf(state)).toBe(before);
  });

  it('leaves an update with nothing to change untouched, not even its updatedAt stamp', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const outcome = valueOf(run(makeHarness({}, state), 'codex.write', { entries: [{ action: 'update', id: ENTRY }] }, { permission: CONFIRMED }));
    expect(snapshotOf(state)).toBe(before);
    expect(outcome.undoGroupId).toBeUndefined();
  });

  it('is refused without a plan or a confirmation, because it is write-confirm', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const error = refusalOf(run(makeHarness({}, state), 'codex.write', { entries: [{ action: 'create', name: 'Mara' }] }));
    expect(error.code).toBe('permission-denied');
    expect(snapshotOf(state)).toBe(before);
  });

  it('answers a replay of a create from the cache, rather than refusing it as a collision with its own first run', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const first = valueOf(run(harness, 'codex.write', { entries: [{ action: 'create', name: 'Mara' }] }, { permission: CONFIRMED, callId: 'create-mara', turnId: 'turn-cw' }));
    const countAfterFirst = state.manifest.codex?.length ?? 0;
    const replay = valueOf(run(harness, 'codex.write', { entries: [{ action: 'create', name: 'Mara' }] }, { permission: CONFIRMED, callId: 'create-mara', turnId: 'turn-cw' }));
    expect(replay.data).toEqual(first.data);
    expect(state.manifest.codex?.length).toBe(countAfterFirst);
  });
});

/** The plan-card diffs of a batch, as a preflight shows them: the card the writer approves, before anything runs. */
function cardOf(entries: unknown[]): { entries: Record<string, unknown>[] } {
  const preview = makeHarness().previewPlan({ steps: [{ tool: 'codex.write', params: { entries }, expect: 'write the entries' }] });
  if (!preview.ok) throw new Error('expected a preflight');
  return preview.value.steps[0]?.preview as { entries: Record<string, unknown>[] };
}

const ALWAYS = 'always-include affects every generation call';

describe('codex.write plan cards (codex.md §7)', () => {
  it('shows every field a create will hold, so the writer approves what is actually written', () => {
    const card = cardOf([
      {
        action: 'create',
        name: 'Mara',
        aliases: ['Ferrywoman'],
        type: 'character',
        description: 'The ferry pilot.',
        includePolicy: 'manual',
        caseSensitive: true,
        exclude: ['ferry boat'],
        attachTo: [LANDING],
      },
    ]);
    expect(card.entries[0]).toEqual({
      action: 'create',
      name: 'Mara',
      aliases: ['Ferrywoman'],
      type: 'character',
      description: 'The ferry pilot.',
      includePolicy: 'manual',
      caseSensitive: true,
      exclude: ['ferry boat'],
      attach: [LANDING],
    });
  });

  it('flags a create whose policy is always, because it reaches every generation call', () => {
    const card = cardOf([{ action: 'create', name: 'House rules', includePolicy: 'always' }]);
    expect(card.entries[0]?.['flags']).toEqual([ALWAYS]);
  });

  it('flags an update that sets always, or moves an entry off it, and leaves other updates unflagged', () => {
    const state = makeState();
    state.manifest.codex?.push({ ...entryOf(state, ENTRY), id: 'c_ALWAYS0001', name: 'Rules', includePolicy: 'always' });
    const harness = makeHarness({}, state);
    const preview = (entries: unknown[]) => {
      const result = harness.previewPlan({ steps: [{ tool: 'codex.write', params: { entries }, expect: 'write' }] });
      if (!result.ok) throw new Error('expected a preflight');
      return (result.value.steps[0]?.preview as { entries: Record<string, unknown>[] }).entries;
    };

    const setAlways = preview([{ action: 'update', id: ENTRY, includePolicy: 'always' }]);
    expect(setAlways[0]?.['flags']).toEqual([ALWAYS]);
    const moveOff = preview([{ action: 'update', id: 'c_ALWAYS0001', includePolicy: 'detected' }]);
    expect(moveOff[0]?.['flags']).toEqual([ALWAYS]);
    const describeOnly = preview([{ action: 'update', id: 'c_ALWAYS0001', description: 'Still the house rules.' }]);
    expect(describeOnly[0]).not.toHaveProperty('flags');
  });
});
