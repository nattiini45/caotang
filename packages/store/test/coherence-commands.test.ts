/**
 * The coherence commands and the codex provenance branch, through the store's registry.
 *
 * What these pin, and what would fail without it:
 * - `coherence.setSceneMeta` and `coherence.setFindingStatus` change the held coherence file, and
 *   refuse what the bus's rules refuse before anything changes (zero partial effects).
 * - Undo is exact for the values the command changed: a scalar goes back, a record that was absent
 *   is absent again, and a list goes back by membership (coherence.md §5, command-bus §5).
 * - The agent path to a dismissal is refused at the gate, through every flow the gate reads.
 * - `codex.upsert` stamps `origin` from the envelope's provenance first, then from `issuedBy`, so an
 *   import is `'import'` and nothing else can name that origin (codex.md §2).
 */

import { describe, expect, it } from 'vitest';

import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type CommandError,
  type CommandName,
  type ExecutionOutcome,
  type PermissionContext,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import { newId } from '@caotang/ids';

import {
  MemoryArtifactFs,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  emptyCoherenceState,
  readProject,
  writeProject,
  type CoherenceState,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-01T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-08T10:00:00.000Z') };

// Node ids are `n_` plus ten Crockford characters (no I, L, O or U): the loader checks the shape on every reload.
const CHAPTER = 'n_CHAPTER001';
const STORM = 'n_TEMPEST001';
const STORM_BODY = 'The gale arrived at dawn. Elena watched the sea.';
const LETTER = 'n_DRAFT00001';
const ENTRY = 'c_ENTRY00000';
const ENTRY_TWO = 'c_ENTRY00002';
const FINDING = 'f_AAAAAAAAAA';

function codexEntry(id: string, name: string, aliases: string[] = []) {
  return {
    id,
    name,
    aliases,
    type: 'character' as const,
    description: `${name} is a keeper.`,
    includePolicy: 'detected' as const,
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual' as const,
    sources: [],
    createdAt: OPENED.toISOString(),
    updatedAt: OPENED.toISOString(),
  };
}

/** A project with a manuscript folder, two documents, two codex entries, and a coherence file holding one finding. */
function fixture(withCoherence: boolean = true): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'The Storm', body: STORM_BODY, now: OPENED, id: STORM });
  addDocument(state, { parentId: CHAPTER, title: 'The Letter', body: 'A letter, sealed.', now: OPENED, id: LETTER });
  state.manifest.codex?.push(codexEntry(ENTRY, 'Elena', ['the keeper']), codexEntry(ENTRY_TWO, 'Marek'));
  if (withCoherence) {
    const file: CoherenceState = emptyCoherenceState();
    file.findings.push({
      id: FINDING,
      status: 'open',
      updatedAt: OPENED.toISOString(),
      evidence: [{ docId: STORM }],
    });
    state.coherence = file;
  }
  return state;
}

interface Harness {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly log: ReturnType<typeof createActivityLog>;
  /** Sends one command as `issuedBy`, optionally with the flow facts the gate reads and extra envelope fields. */
  send(
    name: CommandName,
    params: Record<string, unknown>,
    options?: { issuedBy?: 'user' | 'agent'; permission?: PermissionContext; provenance?: Command['provenance'] },
  ): Result<ExecutionOutcome, CommandError>;
}

function harness(state: ProjectState = fixture()): Harness {
  const registry = createProjectCommandRegistry({ clock });
  const log = createActivityLog();
  const undo: UndoStore = createUndoStore({
    dispatch: (command) => execute(command, bus, registry),
  });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log,
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  return {
    state,
    undo,
    log,
    send(name, params, options = {}) {
      const command: Command = {
        id: newId('cmd'),
        name,
        params,
        issuedBy: options.issuedBy ?? 'user',
        createdAt: clock.now(),
        ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
      };
      const dispatchBus: BusContext<ProjectState> = options.permission === undefined ? bus : { ...bus, permission: options.permission };
      return execute(command, dispatchBus, registry);
    },
  };
}

/** A JSON copy of the coherence file, for a byte-level comparison after an undo. */
function snapshotOf(state: ProjectState): string {
  return JSON.stringify(state.coherence ?? null);
}

function expectOk(result: Result<ExecutionOutcome, CommandError>): ExecutionOutcome {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe('coherence.setSceneMeta (coherence.md §5.2, §7.1)', () => {
  it('sets the declarations, and undo puts the file back byte for byte, record and all', () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const outcome = expectOk(
      h.send('coherence.setSceneMeta', { docId: STORM, patch: { dayOffset: 3, timelineMode: 'flashback', expectedPresent_add: [ENTRY] } }),
    );
    expect(h.state.coherence?.sceneMeta[STORM]).toEqual({ dayOffset: 3, timelineMode: 'flashback', expectedPresent: [ENTRY] });
    expect(outcome.undoGroupId).toBeDefined();

    expect(h.undo.undo(outcome.undoGroupId!).ok).toBe(true);
    expect(snapshotOf(h.state)).toBe(before);
    expect(h.state.coherence?.sceneMeta[STORM]).toBeUndefined();
  });

  it('drops a record whose last declaration is cleared, so the file holds no empty record', () => {
    const h = harness();
    expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { dayOffset: 2 } }));
    expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { dayOffset: null } }));
    expect(Object.prototype.hasOwnProperty.call(h.state.coherence?.sceneMeta ?? {}, STORM)).toBe(false);
  });

  it('undoes a membership change by membership: what was added is removed, and what was removed comes back', () => {
    const h = harness();
    expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { after_add: [LETTER] } }));
    const removal = expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { after_remove: [LETTER] } }));
    expect(h.state.coherence?.sceneMeta[STORM]).toBeUndefined();
    expect(h.undo.undo(removal.undoGroupId!).ok).toBe(true);
    expect(h.state.coherence?.sceneMeta[STORM]?.after).toEqual([LETTER]);
  });

  it('declares a thread through the bus, and undo restores the threads that were there, byte for byte', () => {
    const h = harness();
    expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { threads_add: [{ id: 'the map', payoff: LETTER }] } }));
    const before = snapshotOf(h.state);
    const edit = expectOk(
      h.send('coherence.setSceneMeta', {
        docId: STORM,
        patch: { threads_add: [{ id: 'the lamp', payoff: LETTER, note: 'lit again' }, { id: 'the key', payoff: LETTER }], threads_remove: ['the map'] },
      }),
    );
    expect(h.state.coherence?.sceneMeta[STORM]?.threads?.map((thread) => thread.id)).toEqual(['the key', 'the lamp']);
    expect(h.undo.undo(edit.undoGroupId!).ok).toBe(true);
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('refuses a blank handle and a payoff that is not a document, naming the field, and changes nothing', () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const blank = h.send('coherence.setSceneMeta', { docId: STORM, patch: { threads_add: [{ id: '  ', payoff: LETTER }] } });
    expect(!blank.ok && blank.error.message).toContain('threads_add[0].id');
    const gone = h.send('coherence.setSceneMeta', { docId: STORM, patch: { threads_add: [{ id: 'the lamp', payoff: 'n_NOPE000000' }] } });
    expect(!gone.ok && gone.error.message).toContain('threads_add[0].payoff');
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('refuses a pov that is not a codex entry, naming the valid ones, and changes nothing', () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const refused = h.send('coherence.setSceneMeta', { docId: STORM, patch: { pov: 'c_NOPE000000' } });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('invalid-params');
    expect(refused.error.message).toContain('valid codex entries are Elena');
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('refuses a patch key the rule does not know, and an after that names the scene itself', () => {
    const h = harness();
    const unknownKey = h.send('coherence.setSceneMeta', { docId: STORM, patch: { mood: 'grim' } });
    expect(unknownKey.ok).toBe(false);
    const self = h.send('coherence.setSceneMeta', { docId: STORM, patch: { after_add: [STORM] } });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.message).toContain('cannot be declared to follow itself');
  });

  it('refuses when no coherence file is open, rather than creating one as a side effect of a scene edit', () => {
    const h = harness(fixture(false));
    const refused = h.send('coherence.setSceneMeta', { docId: STORM, patch: { dayOffset: 1 } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('no coherence file is open');
    expect(h.state.coherence).toBeUndefined();
  });
});

describe('coherence.setSceneMeta dialogueContainer (coherence.md §5.1 medium.speaker-parity)', () => {
  const COURT = 'n_COURT00001';

  /** A project with a dialogue container beside the scenes. The store writes a body only for a document, so the node is retyped. */
  function withContainer(): ProjectState {
    const state = fixture();
    addDocument(state, { parentId: 'manuscript', title: 'The court', body: 'Zed: Hello.', now: OPENED, id: COURT });
    const node = state.manifest.tree.find((candidate) => candidate.id === COURT);
    if (node === undefined) throw new Error('fixture: the container was not added');
    Object.assign(node, { type: 'dialogue' });
    return state;
  }

  it('links a scene to a dialogue container, clears the link with null, and undo restores the prior link', () => {
    const h = harness(withContainer());
    expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { dialogueContainer: COURT } }));
    expect(h.state.coherence?.sceneMeta[STORM]).toEqual({ dialogueContainer: COURT });

    const cleared = expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { dialogueContainer: null } }));
    expect(h.state.coherence?.sceneMeta[STORM]).toBeUndefined();
    expect(h.undo.undo(cleared.undoGroupId!).ok).toBe(true);
    expect(h.state.coherence?.sceneMeta[STORM]).toEqual({ dialogueContainer: COURT });
  });

  it('undoes a first link by clearing it, byte for byte', () => {
    const h = harness(withContainer());
    const before = snapshotOf(h.state);
    const linked = expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { dialogueContainer: COURT } }));
    expect(h.undo.undo(linked.undoGroupId!).ok).toBe(true);
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('refuses an id the tree does not hold and an id that is not a dialogue container, and changes nothing', () => {
    const h = harness(withContainer());
    const before = snapshotOf(h.state);
    const unknown = h.send('coherence.setSceneMeta', { docId: STORM, patch: { dialogueContainer: 'n_NOPE000000' } });
    expect(!unknown.ok && unknown.error.message).toContain('not a dialogue container');
    const document = h.send('coherence.setSceneMeta', { docId: STORM, patch: { dialogueContainer: LETTER } });
    expect(!document.ok && document.error.message).toContain('not a dialogue container');
    const blank = h.send('coherence.setSceneMeta', { docId: STORM, patch: { dialogueContainer: ' ' } });
    expect(blank.ok).toBe(false);
    expect(snapshotOf(h.state)).toBe(before);
  });

  it('refuses a link on a folder, and still lets a link to an archived container be set and undone', () => {
    const h = harness(withContainer());
    const folder = h.send('coherence.setSceneMeta', { docId: CHAPTER, patch: { dialogueContainer: COURT } });
    expect(!folder.ok && folder.error.message).toContain('linked to a scene, not a folder');
    const node = h.state.manifest.tree.find((candidate) => candidate.id === COURT);
    if (node !== undefined) Object.assign(node, { status: 'archived' });
    expectOk(h.send('coherence.setSceneMeta', { docId: STORM, patch: { dialogueContainer: COURT } }));
    expect(h.state.coherence?.sceneMeta[STORM]?.dialogueContainer).toBe(COURT);
  });
});

describe('coherence.setFindingStatus (coherence.md §6.3, §7.1)', () => {
  it('dismisses with a reason, and undo restores the open finding with no stale reason', () => {
    const h = harness();
    const outcome = expectOk(
      h.send('coherence.setFindingStatus', { findingId: FINDING, status: 'dismissed', reason: 'false-positive', note: 'Checked.' }),
    );
    const dismissed = h.state.coherence?.findings[0];
    expect(dismissed?.status).toBe('dismissed');
    expect(dismissed?.dismissedReason).toBe('false-positive');
    expect(dismissed?.note).toBe('Checked.');
    expect(dismissed?.touchedAt).toBeDefined();

    expect(h.undo.undo(outcome.undoGroupId!).ok).toBe(true);
    const restored = h.state.coherence?.findings[0];
    expect(restored?.status).toBe('open');
    expect(restored?.dismissedReason).toBeUndefined();
    expect(restored?.note).toBeUndefined();
  });

  it('refuses a dismissal with no reason, and a reason that is not on the picker', () => {
    const h = harness();
    const none = h.send('coherence.setFindingStatus', { findingId: FINDING, status: 'dismissed' });
    expect(none.ok).toBe(false);
    const unknown = h.send('coherence.setFindingStatus', { findingId: FINDING, status: 'dismissed', reason: 'vibes' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.message).toContain('a dismissal needs a reason from the picker');
    expect(h.state.coherence?.findings[0]?.status).toBe('open');
  });

  it('refuses a move the lifecycle does not allow: dismissing a finding that is already dismissed', () => {
    const h = harness();
    expectOk(h.send('coherence.setFindingStatus', { findingId: FINDING, status: 'dismissed', reason: 'intentional' }));
    const again = h.send('coherence.setFindingStatus', { findingId: FINDING, status: 'dismissed', reason: 'intentional' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.message).toContain('already dismissed');
  });

  it('hard-refuses an agent dismissal through every flow, and lets the agent mark a finding fixed through an approved plan', () => {
    const h = harness();
    const dismiss = { findingId: FINDING, status: 'dismissed', reason: 'false-positive' };
    for (const permission of [{}, { approvedPlan: true }, { inheritedGrant: 'write-confirm' as const }]) {
      const refused = h.send('coherence.setFindingStatus', dismiss, { issuedBy: 'agent', permission });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe('hard-denied');
    }
    expect(h.state.coherence?.findings[0]?.status).toBe('open');

    const fixed = expectOk(
      h.send('coherence.setFindingStatus', { findingId: FINDING, status: 'fixed', note: 'Reworded.' }, { issuedBy: 'agent', permission: { approvedPlan: true } }),
    );
    expect(fixed.grant.via).toBe('approved-plan');
    expect(h.state.coherence?.findings[0]?.status).toBe('fixed');
    expect(h.state.coherence?.findings[0]?.note).toBe('Reworded.');
  });
});

describe('codex.upsert provenance (codex.md §2)', () => {
  const create = (name: string, extra: Record<string, unknown> = {}) => ({ entries: [{ action: 'create', name, ...extra }] });

  it('stamps manual for the writer, agent for an agent with no provenance, and import when the envelope carries it', () => {
    const h = harness();
    // An agent's write-confirm command runs only inside an approved plan (command-bus §4).
    const plan = { approvedPlan: true };
    expectOk(h.send('codex.upsert', create('Alpha')));
    expectOk(h.send('codex.upsert', create('Beta'), { issuedBy: 'agent', permission: plan }));
    // The quote is the verbatim text at [from, to) of the storm body, as the bus's citation check reads it.
    const from = STORM_BODY.indexOf('Elena');
    const quote = 'Elena watched the sea.';
    expect(STORM_BODY.slice(from, from + quote.length)).toBe(quote);
    const sources = [{ docId: STORM, quote, from, to: from + quote.length, extractedAt: OPENED.toISOString() }];
    expectOk(
      h.send('codex.upsert', create('Gamma', { attachTo: [STORM], sources }), { issuedBy: 'agent', permission: plan, provenance: 'import' }),
    );

    const byName = new Map((h.state.manifest.codex ?? []).map((entry) => [entry.name, entry]));
    expect(byName.get('Alpha')?.origin).toBe('manual');
    expect(byName.get('Beta')?.origin).toBe('agent');
    expect(byName.get('Gamma')?.origin).toBe('import');
    expect(byName.get('Gamma')?.sources).toHaveLength(1);
  });

  it('keeps the import origin and its citation through a save and a reload, in the manifest and the entry file', async () => {
    const state = fixture();
    const quote = 'Elena watched the sea.';
    const from = STORM_BODY.indexOf('Elena');
    const sources = [{ docId: STORM, quote, from, to: from + quote.length, extractedAt: OPENED.toISOString() }];
    expectOk(
      harness(state).send(
        'codex.upsert',
        { entries: [{ action: 'create', name: 'Gamma', attachTo: [STORM], sources }] },
        { issuedBy: 'agent', permission: { approvedPlan: true }, provenance: 'import' },
      ),
    );

    // A reload that read `import` as anything but a known origin would coerce it to `agent` (codex.md §2),
    // so the reloaded origin is the check that the enum carries it through the file.
    const fs = new MemoryArtifactFs();
    await writeProject(fs, state, { now: OPENED });
    expect(fs.snapshot()[`codex/${state.manifest.codex!.find((e) => e.name === 'Gamma')!.id}.md`]).toContain('origin: import\n');
    const loaded = await readProject(fs);
    const gamma = loaded.state.manifest.codex?.find((entry) => entry.name === 'Gamma');
    expect(gamma?.origin).toBe('import');
    expect(gamma?.sources).toEqual(sources);
  });

  it('refuses an op that names its own origin: the closed key set holds, so provenance can only come from the envelope', () => {
    const h = harness();
    const refused = h.send('codex.upsert', create('Delta', { origin: 'import' }), { issuedBy: 'agent', permission: { approvedPlan: true } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('origin');
    expect((h.state.manifest.codex ?? []).some((entry) => entry.name === 'Delta')).toBe(false);
  });
});
