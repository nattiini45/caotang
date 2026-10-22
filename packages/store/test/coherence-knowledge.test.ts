/**
 * The knowledge facts and the scene declarations of who learns and knows them, through the store's registry
 * (coherence.md §4.4, §7.1): a fact is added, changed and removed; a removal takes the pairs that name it; each is one undo
 * group; and `coherence.setSceneMeta` refuses a character or fact it does not hold, listing the valid ones.
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
  type Result,
  type UndoStore,
} from '@caotang/bus';
import { newId } from '@caotang/ids';

import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  emptyCoherenceState,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-01T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-08T10:00:00.000Z') };

const CHAPTER = 'n_CHAPTER001';
const SCENE_THREE = 'n_SCENE00003';
const SCENE_SEVEN = 'n_SCENE00007';
const ANNA = 'c_ANNA000001';
const PLACE = 'c_PLACE00001';
const HEIR = 'k_SECRET0001';
const RULE = 'w_9Q8WRN2TQ6';

function codexEntry(id: string, name: string, type: string) {
  return {
    id,
    name,
    aliases: [],
    type,
    description: `${name}.`,
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

/** Two scenes, a character and a place, one world rule, and one knowledge fact that Anna learns in scene seven. */
function fixture(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'Scene 3', body: 'Anna crossed the yard.', now: OPENED, id: SCENE_THREE });
  addDocument(state, { parentId: CHAPTER, title: 'Scene 7', body: 'The letter came.', now: OPENED, id: SCENE_SEVEN });
  state.manifest.codex?.push(codexEntry(ANNA, 'Anna', 'character'), codexEntry(PLACE, 'The Lighthouse', 'location'));
  const file = emptyCoherenceState();
  file.worldRules.push({ id: RULE });
  file.knowledge.push({ id: HEIR, text: 'Mara is the heir', createdAt: OPENED.toISOString(), updatedAt: OPENED.toISOString() });
  file.sceneMeta[SCENE_SEVEN] = { dayOffset: 4, learns: [{ entryId: ANNA, factId: HEIR }] };
  state.coherence = file;
  return state;
}

interface Harness {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  send(name: CommandName, params: Record<string, unknown>, options?: { issuedBy?: 'user' | 'agent' }): Result<ExecutionOutcome, CommandError>;
}

function harness(state: ProjectState = fixture()): Harness {
  const registry = createProjectCommandRegistry({ clock });
  const log = createActivityLog();
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
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
    send(name, params, options = {}) {
      const command: Command = { id: newId('cmd'), name, params, issuedBy: options.issuedBy ?? 'user', createdAt: clock.now() };
      return execute(command, bus, registry);
    },
  };
}

function expectOk(result: Result<ExecutionOutcome, CommandError>): ExecutionOutcome {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function refusal(result: Result<ExecutionOutcome, CommandError>): CommandError {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

describe('coherence.addKnowledgeFact', () => {
  it('adds a fact with a k_ id, the trimmed text and the links it was given, and one undo removes it', () => {
    const h = harness();
    const outcome = expectOk(h.send('coherence.addKnowledgeFact', { text: '  The map is a forgery  ', ruleId: RULE, entryId: ANNA }));
    const added = h.state.coherence?.knowledge[1];
    expect(added).toMatchObject({ text: 'The map is a forgery', ruleId: RULE, entryId: ANNA });
    expect(added?.id).toMatch(/^k_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(added?.createdAt).toBe('2026-10-08T10:00:00.000Z');
    expect(h.undo.undo(outcome.undoGroupId!).ok).toBe(true);
    expect(h.state.coherence?.knowledge.map((fact) => fact.id)).toEqual([HEIR]);
  });

  it('refuses blank text, text over the limit, an unknown key, and a link to nothing, naming what is valid', () => {
    const h = harness();
    expect(refusal(h.send('coherence.addKnowledgeFact', { text: '   ' })).message).toContain('must not be blank');
    expect(refusal(h.send('coherence.addKnowledgeFact', { text: 'x'.repeat(301) })).message).toContain('at most 300 characters; this one is 301');
    expect(refusal(h.send('coherence.addKnowledgeFact', { text: 'a fact', colour: 'red' })).message).toContain('colour');
    expect(refusal(h.send('coherence.addKnowledgeFact', { text: 'a fact', ruleId: 'w_GONE000001' })).message).toContain(`valid world rules are ${RULE}`);
    expect(refusal(h.send('coherence.addKnowledgeFact', { text: 'a fact', entryId: 'c_GONE000001' })).message).toContain('valid codex entries are Anna');
    expect(h.state.coherence?.knowledge).toHaveLength(1);
  });

  it('is refused for a project with no coherence file', () => {
    const state = fixture();
    delete state.coherence;
    expect(harness(state).send('coherence.addKnowledgeFact', { text: 'a fact' }).ok).toBe(false);
  });

  it('is write-confirm for the agent, so an agent call alone is refused', () => {
    const h = harness();
    expect(h.send('coherence.addKnowledgeFact', { text: 'a fact' }, { issuedBy: 'agent' }).ok).toBe(false);
    expect(h.state.coherence?.knowledge).toHaveLength(1);
  });
});

describe('coherence.editKnowledgeFact', () => {
  it('changes the text and the links it names, clears a link with null, and one undo puts the fact back as it was', () => {
    const h = harness();
    const before = JSON.stringify(h.state.coherence);
    const linked = expectOk(h.send('coherence.editKnowledgeFact', { factId: HEIR, entryId: ANNA, ruleId: RULE }));
    expect(h.state.coherence?.knowledge[0]).toMatchObject({ entryId: ANNA, ruleId: RULE, text: 'Mara is the heir' });
    const cleared = expectOk(h.send('coherence.editKnowledgeFact', { factId: HEIR, text: 'Mara is the rightful heir', ruleId: null }));
    expect(h.state.coherence?.knowledge[0]).toMatchObject({ entryId: ANNA, text: 'Mara is the rightful heir' });
    expect(h.state.coherence?.knowledge[0]?.ruleId).toBeUndefined();
    expect(h.undo.undo(cleared.undoGroupId!).ok).toBe(true);
    expect(h.state.coherence?.knowledge[0]).toMatchObject({ ruleId: RULE, text: 'Mara is the heir' });
    expect(h.undo.undo(linked.undoGroupId!).ok).toBe(true);
    expect(JSON.stringify(h.state.coherence)).toBe(before);
  });

  it('refuses a fact the file does not hold, naming the valid ones, and a call that names nothing to change', () => {
    const h = harness();
    expect(refusal(h.send('coherence.editKnowledgeFact', { factId: 'k_GONE000001', text: 'x' })).message).toContain(`valid facts are "Mara is the heir" (${HEIR})`);
    expect(refusal(h.send('coherence.editKnowledgeFact', { factId: HEIR })).message).toContain('names nothing to change');
    expect(refusal(h.send('coherence.editKnowledgeFact', { factId: HEIR, text: '' })).message).toContain('must not be blank');
  });
});

describe('coherence.removeKnowledgeFact', () => {
  it('removes the fact and every pair that names it, and one undo puts all of it back', () => {
    const state = fixture();
    state.coherence!.sceneMeta[SCENE_THREE] = { knows: [{ entryId: ANNA, factId: HEIR }] };
    const h = harness(state);
    const before = JSON.stringify(h.state.coherence);
    const outcome = expectOk(h.send('coherence.removeKnowledgeFact', { factId: HEIR }));
    expect(h.state.coherence?.knowledge).toEqual([]);
    // The scene that only declared the pair has no record left; the one with another declaration keeps it.
    expect(h.state.coherence?.sceneMeta).toEqual({ [SCENE_SEVEN]: { dayOffset: 4 } });
    expect(h.undo.undo(outcome.undoGroupId!).ok).toBe(true);
    expect(h.state.coherence?.knowledge.map((fact) => fact.id)).toEqual([HEIR]);
    expect(h.state.coherence?.sceneMeta[SCENE_THREE]).toEqual({ knows: [{ entryId: ANNA, factId: HEIR }] });
    expect(h.state.coherence?.sceneMeta[SCENE_SEVEN]).toEqual({ dayOffset: 4, learns: [{ entryId: ANNA, factId: HEIR }] });
    expect(JSON.parse(JSON.stringify(h.state.coherence))).toEqual(JSON.parse(before));
  });

  it('undoes in one group, whatever the number of scenes it took pairs from', () => {
    const state = fixture();
    state.coherence!.sceneMeta[SCENE_THREE] = { knows: [{ entryId: ANNA, factId: HEIR }] };
    const h = harness(state);
    expectOk(h.send('coherence.removeKnowledgeFact', { factId: HEIR }));
    expect(h.undo.groups()).toHaveLength(1);
  });

  it('leaves out the pairs of a scene that was deleted before the undo, and puts back the rest', () => {
    const state = fixture();
    state.coherence!.sceneMeta[SCENE_THREE] = { knows: [{ entryId: ANNA, factId: HEIR }] };
    const h = harness(state);
    const outcome = expectOk(h.send('coherence.removeKnowledgeFact', { factId: HEIR }));
    // Scene three is deleted between the removal and the undo.
    state.manifest.tree = state.manifest.tree.filter((node) => node.id !== SCENE_THREE);
    expect(h.undo.undo(outcome.undoGroupId!).ok).toBe(true);
    expect(state.coherence?.sceneMeta[SCENE_THREE]).toBeUndefined();
    expect(state.coherence?.sceneMeta[SCENE_SEVEN]?.learns).toEqual([{ entryId: ANNA, factId: HEIR }]);
  });

  it('refuses a fact the file does not hold, and says how many declarations it took in the activity row', () => {
    const h = harness();
    expect(h.send('coherence.removeKnowledgeFact', { factId: 'k_GONE000001' }).ok).toBe(false);
    const outcome = expectOk(h.send('coherence.removeKnowledgeFact', { factId: HEIR }));
    expect(outcome.result).toEqual({ factId: HEIR, removedDeclarations: 1 });
  });
});

describe('coherence.setSceneMeta learns and knows', () => {
  it('declares who learns and who knows a fact, and the undo is the exact inverse', () => {
    const h = harness();
    const before = JSON.stringify(h.state.coherence);
    const outcome = expectOk(
      h.send('coherence.setSceneMeta', {
        docId: SCENE_THREE,
        patch: { knows_add: [{ entryId: ANNA, factId: HEIR }], learns_add: [{ entryId: ANNA, factId: HEIR }], dayOffset: 2 },
      }),
    );
    expect(h.state.coherence?.sceneMeta[SCENE_THREE]).toEqual({
      dayOffset: 2,
      learns: [{ entryId: ANNA, factId: HEIR }],
      knows: [{ entryId: ANNA, factId: HEIR }],
    });
    expect(h.undo.undo(outcome.undoGroupId!).ok).toBe(true);
    expect(JSON.stringify(h.state.coherence)).toBe(before);
  });

  it('removes a pair, then adds, so one patch can swap, and ignores a pair that was never declared', () => {
    const h = harness();
    expectOk(
      h.send('coherence.setSceneMeta', {
        docId: SCENE_SEVEN,
        patch: { learns_remove: [{ entryId: ANNA, factId: HEIR }, { entryId: ANNA, factId: 'k_NEVERDECL0' }], knows_add: [{ entryId: ANNA, factId: HEIR }] },
      }),
    );
    expect(h.state.coherence?.sceneMeta[SCENE_SEVEN]).toEqual({ dayOffset: 4, knows: [{ entryId: ANNA, factId: HEIR }] });
  });

  it('refuses a character or a fact the file does not hold, listing the valid ones, and a pair that is not one', () => {
    const h = harness();
    const unknownCharacter = refusal(h.send('coherence.setSceneMeta', { docId: SCENE_THREE, patch: { learns_add: [{ entryId: 'c_GONE000001', factId: HEIR }] } }));
    expect(unknownCharacter.message).toContain('learns_add[0].entryId "c_GONE000001" is not a codex entry; valid characters are Anna (c_ANNA000001)');
    const notCharacter = refusal(h.send('coherence.setSceneMeta', { docId: SCENE_THREE, patch: { knows_add: [{ entryId: PLACE, factId: HEIR }] } }));
    expect(notCharacter.message).toContain('The Lighthouse, which is not a character; valid characters are Anna');
    const unknownFact = refusal(h.send('coherence.setSceneMeta', { docId: SCENE_THREE, patch: { knows_add: [{ entryId: ANNA, factId: 'k_GONE000001' }] } }));
    expect(unknownFact.message).toContain('knows_add[0].factId "k_GONE000001" is not a knowledge fact; valid facts are "Mara is the heir" (k_SECRET0001)');
    expect(refusal(h.send('coherence.setSceneMeta', { docId: SCENE_THREE, patch: { knows_add: [{ entryId: ANNA }] } })).message).toContain('knows_add[0].factId');
    expect(refusal(h.send('coherence.setSceneMeta', { docId: SCENE_THREE, patch: { knows_add: 'everyone' } })).message).toContain('knows_add must be a list');
    expect(h.state.coherence?.sceneMeta[SCENE_THREE]).toBeUndefined();
  });

  it('refuses a folder, since what a character learns happens in a scene', () => {
    const h = harness();
    const refused = refusal(h.send('coherence.setSceneMeta', { docId: CHAPTER, patch: { learns_add: [{ entryId: ANNA, factId: HEIR }] } }));
    expect(refused.message).toContain('declared on a scene, not a folder');
  });

  it('says there is nothing to pick when the codex has no character or the file no fact', () => {
    const state = fixture();
    state.manifest.codex = [];
    state.coherence!.knowledge = [];
    const refused = refusal(harness(state).send('coherence.setSceneMeta', { docId: SCENE_THREE, patch: { learns_add: [{ entryId: ANNA, factId: HEIR }] } }));
    expect(refused.message).toContain('the codex has no character; create the entry first');
  });
});
