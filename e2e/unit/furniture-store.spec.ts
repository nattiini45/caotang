import { expect, test } from '@playwright/test';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type CommandName,
} from '../../packages/bus/src/index.js';
import { newId } from '../../packages/ids/src/index.js';
import { createProjectCommandRegistry, type ProjectState } from '../../packages/store/src/index.js';

import type { AppDb } from '../../apps/desktop/src/app/app-db.js';
import {
  EMPTY_DRAFT,
  FurnitureStore,
  criteriaOf,
  draftOf,
  filterResultFor,
  furnitureId,
  furnitureKey,
  isEmptyDraft,
  tagsOf,
  unknownTermsOf,
} from '../../apps/desktop/src/app/furniture-store.js';
import type { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { IDS, project } from './fixtures.js';

const PROJECT_ID = 'p_TESTPROJ01';
const NOW = Date.parse('2026-10-08T09:00:00.000Z');

test('a saved filter names the vocabulary terms the project no longer holds, and the row says so only for those', () => {
  const vocabulary = { statusIds: new Set(['s_KEEP']), labelIds: new Set(['l_KEEP']) };
  expect(unknownTermsOf({ statusId: 's_GONE' }, vocabulary)).toEqual(['Unknown status']);
  expect(unknownTermsOf({ labelId: 'l_GONE', statusId: 's_KEEP' }, vocabulary)).toEqual(['Unknown label']);
  expect(unknownTermsOf({ statusId: 's_GONE', labelId: 'l_GONE' }, vocabulary)).toEqual(['Unknown status', 'Unknown label']);
  expect(unknownTermsOf({ statusId: 's_KEEP', labelId: 'l_KEEP', text: 'lamp' }, vocabulary)).toEqual([]);
  expect(unknownTermsOf({}, vocabulary)).toEqual([]);
});

/** An in-memory app database: the same two calls the store makes, over a map. */
function memoryDb(): AppDb & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    get: async <T>(key: string): Promise<T | undefined> => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      rows.set(key, structuredClone(value));
    },
    list: async <T>(prefix: string) =>
      [...rows.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value: structuredClone(value) as T })),
    delete: async (key: string): Promise<void> => {
      rows.delete(key);
    },
    close: (): void => {},
  };
}

/**
 * The part of a session the furniture store reads, over the real bus: a dispatch runs through `execute()` and the store's own
 * registry, so a saved filter or goal is what the bus wrote into the manifest, and nothing is faked.
 */
function sessionOver(state: ProjectState): ProjectSession {
  const registry = createProjectCommandRegistry({ clock: { now: () => NOW } });
  const listeners = new Set<() => void>();
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo: createUndoStore({ dispatch: (command) => execute(command, bus, registry) }),
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  return {
    projectId: PROJECT_ID,
    state,
    undo: bus.undo,
    sittingWords: () => 0,
    // Nothing is pending in a test session: its saves settle at once, and the save state reads as saved.
    settle: async () => {},
    saveState: () => 'saved',
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (name: CommandName, params: Record<string, unknown>) => {
      const result = execute({ id: newId('cmd'), name, params, issuedBy: 'user', createdAt: NOW }, bus, registry);
      for (const listener of listeners) listener();
      return result;
    },
  } as unknown as ProjectSession;
}

test.describe('the filter bar draft (binder-filters §2, §5)', () => {
  test('an empty draft is the reset state and names no criterion', () => {
    expect(criteriaOf(EMPTY_DRAFT)).toEqual({});
    expect(isEmptyDraft({ ...EMPTY_DRAFT, text: '   ' })).toBe(true);
  });

  test('each filled field is one criterion, and an unreadable word count is no criterion at all', () => {
    expect(criteriaOf({ ...EMPTY_DRAFT, text: '  Elena ', statusId: 'draft', minWords: '300', maxWords: 'many' })).toEqual({
      text: 'Elena',
      statusId: 'draft',
      minWords: 300,
    });
  });

  test('keyword tags are one list each, de-duplicated without case, and the date windows are whole days (binder-filters §2, §2.1)', () => {
    expect(
      criteriaOf({ ...EMPTY_DRAFT, keywordsAll: 'sea, Sea, grief', keywordsAny: ' storm ', createdWithinDays: '30', modifiedWithinDays: '7' }),
    ).toEqual({ keywordsAll: ['sea', 'grief'], keywordsAny: ['storm'], createdWithinDays: 30, modifiedWithinDays: 7 });
    expect(criteriaOf({ ...EMPTY_DRAFT, modifiedWithinDays: '0', createdWithinDays: '2.5' })).toEqual({});
    expect(tagsOf(Array.from({ length: 40 }, (_, index) => `t${index}`).join(','))).toHaveLength(32);
  });

  test('a saved filter fills the bar with the criteria it holds, keywords and windows included', () => {
    const draft = draftOf({ text: 'lamp', minWords: 40, keywordsAll: ['sea', 'grief'], modifiedWithinDays: 7 });
    expect(draft).toMatchObject({ text: 'lamp', minWords: '40', maxWords: '', keywordsAll: 'sea, grief', modifiedWithinDays: '7' });
    expect(criteriaOf(draft)).toEqual({ text: 'lamp', minWords: 40, keywordsAll: ['sea', 'grief'], modifiedWithinDays: 7 });
  });

  test('a filter id is the furniture family: q_ and ten Crockford characters', () => {
    expect(furnitureId('q', () => new Uint8Array(10).fill(7))).toMatch(/^q_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(furnitureId('g', () => new Uint8Array(10).fill(31))).toBe('g_ZZZZZZZZZZ');
  });
});

test.describe('the furniture store (binder-filters §5, goals-progress §4)', () => {
  test('the binder shows what the bar matches, and the whole binder again when the bar is cleared', () => {
    const store = new FurnitureStore(sessionOver(project()), null);
    store.setDraft({ text: 'lamp' });
    expect(store.snapshot().applied?.criteria).toEqual({ text: 'lamp' });
    store.setDraft({ text: '' });
    expect(store.snapshot().applied).toBeNull();
    store.setDraft({ text: 'lamp' });
    store.clearFilter();
    expect(store.snapshot().applied).toBeNull();
    expect(store.snapshot().draft).toEqual(EMPTY_DRAFT);
  });

  test('a saved filter is a manifest entry, written by the bus and read back from the manifest; a blank name is refused', async () => {
    const session = sessionOver(project());
    const store = new FurnitureStore(session, null);
    await store.load();
    expect(store.snapshot().ready).toBe(true);

    store.setDraft({ text: 'lamp' });
    const refused = store.saveFilter('   ');
    expect(refused.ok).toBe(false);
    expect(session.state.manifest.filters ?? []).toHaveLength(0);
    expect(store.snapshot().failure).not.toBeNull();

    const saved = store.saveFilter('Lamp scenes');
    expect(saved.ok).toBe(true);
    expect(store.snapshot().failure).toBeNull();
    expect(store.snapshot().applied?.savedId).toBe(saved.ok ? saved.value.id : null);
    expect(session.state.manifest.filters).toMatchObject([{ name: 'Lamp scenes', criteria: { text: 'lamp' } }]);
    expect(store.snapshot().filters.map((filter) => filter.name)).toEqual(['Lamp scenes']);
  });

  test('deleting the applied saved filter clears the bar with it, so the bar and the binder agree', () => {
    const session = sessionOver(project());
    const store = new FurnitureStore(session, null);
    store.setDraft({ text: 'lamp' });
    const saved = store.saveFilter('Lamp scenes');
    expect(saved.ok).toBe(true);
    if (saved.ok) store.deleteFilter(saved.value.id);
    expect(store.snapshot().filters).toHaveLength(0);
    expect(store.snapshot().applied).toBeNull();
    expect(store.snapshot().draft).toEqual(EMPTY_DRAFT);
  });

  test('a goal is checked by the furniture rules, saved as a manifest goal, and removed by the bus', () => {
    const session = sessionOver(project());
    const store = new FurnitureStore(session, null);
    expect(store.saveGoal({ nodeId: IDS.chapterOne, comparator: 'at-least', target: 0 }).ok).toBe(false);
    expect(store.snapshot().failure).not.toBeNull();

    const goal = store.saveGoal({ nodeId: IDS.chapterOne, comparator: 'at-least', target: 1000, deadline: '2026-12-31' });
    expect(goal.ok).toBe(true);
    expect(session.state.manifest.goals).toMatchObject([{ nodeId: IDS.chapterOne, comparator: 'at-least', target: 1000, deadline: '2026-12-31' }]);
    expect(store.snapshot().goals).toHaveLength(1);
    expect(store.snapshot().failure).toBeNull();
    if (goal.ok) store.deleteGoal(goal.value.id);
    expect(store.snapshot().goals).toHaveLength(0);
  });

  test('the one-time move takes the app database copy into the manifest, marks it moved, and never copies it twice', async () => {
    const session = sessionOver(project());
    const db = memoryDb();
    db.rows.set(furnitureKey(PROJECT_ID), {
      filters: [
        { id: 'q_ABCDEFGHJK', name: 'Lamp scenes', criteria: { text: 'lamp' }, createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z' },
      ],
      goals: [
        {
          id: 'g_ABCDEFGHJK',
          nodeId: IDS.chapterOne,
          metric: 'words',
          comparator: 'at-least',
          target: 1000,
          createdAt: '2026-09-13T10:00:00.000Z',
          updatedAt: '2026-09-13T10:00:00.000Z',
        },
      ],
    });
    const first = new FurnitureStore(session, db);
    await first.load();
    expect(session.state.manifest.filters?.map((filter) => filter.id)).toEqual(['q_ABCDEFGHJK']);
    expect(session.state.manifest.goals?.map((goal) => goal.id)).toEqual(['g_ABCDEFGHJK']);
    // The copy is marked and keeps its lists, so it outlives the move whatever happens to the project afterwards.
    expect(db.rows.get(furnitureKey(PROJECT_ID))).toMatchObject({
      moved: true,
      filters: [{ id: 'q_ABCDEFGHJK' }],
      goals: [{ id: 'g_ABCDEFGHJK' }],
    });

    const again = new FurnitureStore(session, db);
    await again.load();
    expect(session.state.manifest.filters).toHaveLength(1);
    expect(session.state.manifest.goals).toHaveLength(1);
  });

  test('the one-time move leaves no undo group, so an undo of a later change takes back only that change and keeps the moved entries', async () => {
    const session = sessionOver(project());
    const db = memoryDb();
    db.rows.set(furnitureKey(PROJECT_ID), {
      filters: [
        { id: 'q_ABCDEFGHJK', name: 'Lamp scenes', criteria: { text: 'lamp' }, createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z' },
      ],
      goals: [
        {
          id: 'g_ABCDEFGHJK',
          nodeId: IDS.chapterOne,
          metric: 'words',
          comparator: 'at-least',
          target: 1000,
          createdAt: '2026-09-13T10:00:00.000Z',
          updatedAt: '2026-09-13T10:00:00.000Z',
        },
      ],
    });
    await new FurnitureStore(session, db).load();
    expect(session.state.manifest.filters?.map((filter) => filter.id)).toEqual(['q_ABCDEFGHJK']);
    // The move's saves registered nothing an undo could reach: the undo stack is empty after the move.
    expect(session.undo.groups()).toEqual([]);

    // A later change of the writer's own is one group, and undoing it takes back that change alone.
    const later = session.dispatch('project.saveGoal', { goal: { nodeId: IDS.chapterOne, comparator: 'at-least', target: 500 } });
    expect(later.ok).toBe(true);
    const newest = session.undo.groups().at(-1);
    expect(newest).toBeDefined();
    expect(session.undo.undo(newest!.id).ok).toBe(true);
    expect(session.state.manifest.goals?.map((goal) => goal.id)).toEqual(['g_ABCDEFGHJK']);
    expect(session.state.manifest.filters?.map((filter) => filter.id)).toEqual(['q_ABCDEFGHJK']);
  });

  test('a move the project has not saved is not marked, and the stored copy keeps its lists as they were', async () => {
    const session = sessionOver(project());
    const db = memoryDb();
    const copy = {
      filters: [
        { id: 'q_ABCDEFGHJK', name: 'Lamp scenes', criteria: { text: 'lamp' }, createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z' },
      ],
    };
    db.rows.set(furnitureKey(PROJECT_ID), copy);
    // The project's save fails after the entries are dispatched: they are in the manifest, but nothing says they are on disk.
    session.saveState = () => 'failed';
    const store = new FurnitureStore(session, db);
    await store.load();
    expect(session.state.manifest.filters?.map((filter) => filter.id)).toEqual(['q_ABCDEFGHJK']);
    expect(db.rows.get(furnitureKey(PROJECT_ID))).toEqual(copy);
    expect(store.snapshot().failure).toContain('has not saved');
  });

  test('a read that fails moves nothing, says so, and writes nothing', async () => {
    const session = sessionOver(project());
    const db = memoryDb();
    const failing: AppDb = {
      ...db,
      get: async () => {
        throw new Error('the database is closed');
      },
    };
    const store = new FurnitureStore(session, failing);
    await store.load();
    expect(store.snapshot().failure).toContain('could not be read');
    expect(session.state.manifest.filters ?? []).toHaveLength(0);
    expect(db.rows.size).toBe(0);
  });

  test('the sprint runs on the events the timer sends, and its reading is the time left', () => {
    const store = new FurnitureStore(sessionOver(project()), null);
    store.sprintEvent({ type: 'start', at: 1_000, words: 0 });
    expect(store.snapshot().sprint.status).toBe('running');
    store.sprintEvent({ type: 'pause', at: 61_000, words: 40 });
    expect(store.snapshot().sprint.status).toBe('paused');
    const reading = store.sprintReading(61_000);
    expect(reading.elapsedMs).toBe(60_000);
    expect(reading.remainingMs).toBe(25 * 60_000 - 60_000);
  });
});

test.describe('the binder filter over the project (binder-filters §3)', () => {
  test('a text match shows its document and the folder that holds it, and nothing else in the chapter', () => {
    const result = filterResultFor(project(), { text: 'Scene A' }, new Date('2026-10-08T09:00:00.000Z'));
    expect(result.matchCount).toBe(1);
    expect(result.matched).toEqual([IDS.sceneA]);
    expect(result.visible).toEqual(expect.arrayContaining([IDS.sceneA, IDS.chapterOne]));
    expect(result.visible).not.toContain(IDS.sceneD);
  });

  test('a filter that matches nothing has a count of zero', () => {
    expect(filterResultFor(project(), { text: 'zzz-no-such-text' }, new Date('2026-10-08T09:00:00.000Z')).matchCount).toBe(0);
  });
});
