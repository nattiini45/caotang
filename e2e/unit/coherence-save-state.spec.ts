import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, writeProjectState } from '../../packages/store/src/index.js';
import { emptyCoherenceFile, type CoherenceFile } from '../../packages/coherence/src/index.js';

import { shadowOf } from '../../apps/desktop/src/app/persistence-plan.js';
import { CoherenceFolderError, ProjectSession } from '../../apps/desktop/src/app/session.js';
import { IDS, project } from './fixtures.js';

// The save indicator reads the store, and a findings write is not in the store until it lands. So the indicator must read saving
// while a findings write is queued or running, and a failed findings write must not read as saved (coherence.md §3, §8).

const globals = globalThis as unknown as Record<string, unknown>;
let previousGlobals: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previousGlobals = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previousGlobals === null) return;
  globals['document'] = previousGlobals.document;
  globals['window'] = previousGlobals.window;
});

/** A session on a fresh in-memory store that holds the fixture project, as the lifecycle makes one. */
async function sessionOf(): Promise<ProjectSession> {
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
}

const CHANGED: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneA]: { dayOffset: 4 } } };

test('only browser findings failures offer a save retry, not folder conflicts', async () => {
  for (const [error, retryable] of [[new Error('the disk is full'), true], [new CoherenceFolderError('changed by another program'), false]] as const) {
    const session = await sessionOf();
    session.attachCoherence(
      { file: emptyCoherenceFile(), writable: true, notices: [] },
      { save: async () => { throw error; }, attachFolder: async () => {} },
    );
    expect(session.coherenceStatus().canRetrySave).toBe(false);
    session.applyCoherenceFile(CHANGED);
    await session.settle();
    expect(session.coherenceStatus().saveFailure).toContain(error.message);
    expect(session.coherenceStatus().canRetrySave).toBe(retryable);
    await session.close();
  }
});

test.describe('the save indicator and a findings save (coherence.md §3)', () => {
  test('reads saving while a findings save is in flight, and saved only once the save has landed', async () => {
    const session = await sessionOf();
    let release!: () => void;
    const landing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saved: CoherenceFile[] = [];
    session.attachCoherence(
      { file: emptyCoherenceFile(), writable: true, notices: [] },
      {
        save: async (file) => {
          await landing;
          saved.push(file);
        },
        attachFolder: async () => {},
      },
    );

    session.applyCoherenceFile(CHANGED);
    // The project's own write lands in the store meanwhile; the findings write is still held.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saved).toHaveLength(0);
    expect(session.saveState()).toBe('saving');

    release();
    await session.settle();
    expect(saved).toEqual([CHANGED]);
    expect(session.saveState()).toBe('saved');
    await session.close();
  });

  test('a findings save that fails reads failed, not saved, and the findings tab says why', async () => {
    const session = await sessionOf();
    session.attachCoherence(
      { file: emptyCoherenceFile(), writable: true, notices: [] },
      {
        save: async () => {
          throw new Error('the disk is full');
        },
        attachFolder: async () => {},
      },
    );

    session.applyCoherenceFile(CHANGED);
    await session.settle();
    expect(session.saveState()).toBe('failed');
    expect(session.coherenceStatus().saveFailure).toContain('the disk is full');
    await session.close();
  });

  test('a later findings save that lands clears the failure and reads saved again', async () => {
    const session = await sessionOf();
    let attempts = 0;
    session.attachCoherence(
      { file: emptyCoherenceFile(), writable: true, notices: [] },
      {
        save: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('the disk is full');
        },
        attachFolder: async () => {},
      },
    );

    session.applyCoherenceFile(CHANGED);
    await session.settle();
    expect(session.saveState()).toBe('failed');

    session.applyCoherenceFile({ ...CHANGED, sceneMeta: { [IDS.sceneA]: { dayOffset: 6 } } });
    await session.settle();
    expect(session.coherenceStatus().saveFailure).toBeNull();
    expect(session.saveState()).toBe('saved');
    await session.close();
  });

  test('a failed findings save is tried again on the next change, even one that changes only text', async () => {
    const session = await sessionOf();
    const saved: CoherenceFile[] = [];
    let attempts = 0;
    session.attachCoherence(
      { file: emptyCoherenceFile(), writable: true, notices: [] },
      {
        save: async (file) => {
          attempts += 1;
          if (attempts === 1) throw new Error('the disk is full');
          saved.push(file);
        },
        attachFolder: async () => {},
      },
    );

    session.applyCoherenceFile(CHANGED);
    await session.settle();
    expect(session.saveState()).toBe('failed');

    // The findings are as they were; only the text changes, and the save that failed runs again.
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed after the failure.' });
    await session.settle();
    expect(attempts).toBe(2);
    expect(saved).toEqual([CHANGED]);
    expect(session.coherenceStatus().saveFailure).toBeNull();
    expect(session.saveState()).toBe('saved');
    await session.close();
  });

  test('a findings write to a folder that fails is named on the findings tab, and the save indicator still reads saved', async () => {
    const session = await sessionOf();
    session.attachCoherence(
      { file: CHANGED, writable: true, notices: [] },
      {
        save: async () => {},
        attachFolder: async () => {
          throw new Error('the folder is read-only');
        },
      },
    );

    await session.attachCoherenceFolder({} as never);
    await session.settle();
    expect(session.coherenceStatus().saveFailure).toContain('could not be saved to the folder');
    expect(session.saveState()).toBe('saved');
    await session.close();
  });
});
