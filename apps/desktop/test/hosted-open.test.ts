/**
 * What a hosted open does with the words that were not delivered and with the browser's own copy (hosted.md §7, §11). The words
 * an earlier tab could not send reach the project the writer opens, and opening the same account project twice is the same
 * project each time rather than a second copy of itself whose id the next save would write into the account's manifest.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryArtifactFs, MemoryIndexedDb, openRuntimeStore, removeNode, writeProject, type ProjectState, type RuntimeStore } from '@caotang/store';

import { setActiveAppDb } from '../src/app/app-db.js';
import { openHostedProject, type Opened } from '../src/app/lifecycle.js';
import { forgetHostedTarget, HostedTarget, hostedTargetFor, type HostedQueuePort, type HostedReplay } from '../src/app/hosted-target.js';
import type { HostedProjectSource } from '../src/app/studio-host.js';
import { IDS, project } from '../../../e2e/unit/fixtures.js';

/** One project for the whole file: a fixture built twice makes a second project id, and these tests are about one project. */
const BOOK = project();

const SOURCE: HostedProjectSource = {
  projectId: 'p_fixture',
  origin: 'https://studio.example',
  device: 'tab_one',
  key: {} as never,
};

let store: RuntimeStore;
let opened: Opened[];

beforeEach(async () => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  store = await openRuntimeStore(new MemoryIndexedDb());
  opened = [];
});

afterEach(async () => {
  for (const one of opened) await one.session.closeSafely();
  forgetHostedTarget(SOURCE.projectId);
  store.close();
  vi.unstubAllGlobals();
});

/** A queue that holds one scene's words and replays them into the same filesystem the open reads. */
function queueHolding(fs: MemoryArtifactFs, replayedBody: string | undefined, outcome: HostedReplay = { kind: 'sent', count: 1, paths: [`docs/${IDS.sceneA}.md`] }): HostedQueuePort {
  const held = new Set([`docs/${IDS.sceneA}.md`]);
  return {
    hold: (changes) => {
      for (const change of changes) held.add(change.path);
    },
    replay: async () => {
      if (outcome.kind !== 'sent') return outcome;
      const state = project();
      state.manifest.project = BOOK.manifest.project;
      if (replayedBody !== undefined) state.documents.get(IDS.sceneA)!.body = replayedBody;
      await writeProject(fs, state);
      held.clear();
      return outcome;
    },
    forget: (paths) => {
      if (paths === undefined) held.clear();
      else for (const path of paths) held.delete(path);
    },
    rebase: (paths) => { for (const path of paths) held.add(path); },
    held: () => [...held],
    marks: () => {},
  };
}

async function targetFor(replayedBody: string | undefined, outcome?: HostedReplay): Promise<HostedTarget> {
  const fs = new MemoryArtifactFs();
  await writeProject(fs, BOOK);
  const queue = queueHolding(fs, replayedBody, outcome);
  // The adapter under this file is a memory one: what these tests ask of it is reads, and a re-read after a refusal.
  Object.assign(fs, { refresh: async () => undefined });
  return new HostedTarget(
    SOURCE.projectId,
    fs as never,
    (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never,
    queue,
  );
}

/** Opens through the lifecycle, closing whatever it opened when the test ends. The target is kept for the assertions on it. */
let lastTarget: HostedTarget | null = null;
async function open(body?: string, outcome?: HostedReplay): Promise<Opened> {
  const target = await targetFor(body, outcome);
  lastTarget = target;
  const result = await openHostedProject(store, SOURCE, async () => target);
  opened.push(result);
  return result;
}

it('opens the words an earlier tab queued instead of the account’s older version', async () => {
  expect((await open('Five words, written offline')).session.state.documents.get(IDS.sceneA)?.body).toBe('Five words, written offline');
});

it('opens the account’s version when the replayed words lose to another device, and keeps them queued', async () => {
  const result = await open('Five words, written offline', { kind: 'conflict', paths: [`docs/${IDS.sceneA}.md`] });
  expect(result.session.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
});

it('opens the account’s project under its own id', async () => {
  const first = await open('Four little words here');
  expect(first.session.projectId).toBe(BOOK.manifest.project.id);
  expect(first.copiedFrom).toBeNull();
});

it('opens the same project again under its own id, not as a copy of itself', async () => {
  const first = await open('Four little words here');
  expect(first.session.projectId).toBe(BOOK.manifest.project.id);
  await first.session.closeSafely();
  opened = opened.filter((one) => one !== first);

  // The two copies are the same book, so the account's version takes the browser's place under the same id.
  const second = await open('Four little words here');
  expect(second.session.projectId).toBe(BOOK.manifest.project.id);
  expect(second.copiedFrom).toBeNull();
  expect(second.session.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
});

/** The account's project with one node's kind changed, and the browser's copy holding a different body for it. */
async function diverged(setup: (state: ProjectState) => void): Promise<Opened> {
  const first = await open();
  setup(first.session.state);
  await first.session.persistence.settle();
  await first.session.closeSafely();
  opened = opened.filter((one) => one !== first);
  return await open();
}

it('holds a screenplay’s words at the file its kind gives them, not at a .md it does not use', async () => {
  const second = await diverged((state) => {
    const node = state.manifest.tree.find((candidate) => candidate.id === IDS.sceneA);
    if (node !== undefined) node.kind = 'screenplay';
    state.documents.get(IDS.sceneA)!.body = 'INT. HARBOUR - NIGHT';
  });
  const held = lastTarget?.queue?.held() ?? [];
  expect(second.session.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
  expect(held).toContain(`docs/${IDS.sceneA}.fountain`);
  expect(held).not.toContain(`docs/${IDS.sceneA}.md`);
});

it('holds a page this browser deleted as a deletion, so the writer can keep it gone', async () => {
  await diverged((state) => { removeNode(state, IDS.sceneB); });
  expect(lastTarget?.queue?.held()).toContain(`docs/${IDS.sceneB}.md`);
});

it('asks about the book’s own settings when the browser’s manifest differs, not only its pages', async () => {
  await diverged((state) => { state.manifest.project.name = 'The Lighthouse'; });
  expect(lastTarget?.queue?.held()).toContain('caotang.json');
});

it('keeps this browser’s task data when the same book is opened again', async () => {
  // The writer's recurring tasks are this browser's, keyed by the project's id: replacing the copy must not sweep them away for a
  // difference the book does not have.
  const rows = new Map<string, unknown>([[`task:${BOOK.manifest.project.id}:task_one`, { id: 'task_one' }]]);
  const db = {
    get: async (key: string) => rows.get(key) as never,
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    list: async (prefix: string) => [...rows.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key, value: rows.get(key) })),
    delete: async (key: string) => { rows.delete(key); },
    close: () => undefined,
  };
  setActiveAppDb(db as never);
  try {
    const first = await open();
    await first.session.closeSafely();
    opened = opened.filter((one) => one !== first);
    await open();
    expect([...rows.keys()]).toEqual([`task:${BOOK.manifest.project.id}:task_one`]);
  } finally {
    setActiveAppDb(null);
  }
});

it('asks about words a browser copy holds and the account does not, instead of picking one of them silently', async () => {
  const first = await open();
  // The writer typed here and the browser kept it; the account never got it.
  first.session.state.documents.get(IDS.sceneA)!.body = 'Five words, written offline';
  await first.session.persistence.settle();
  await first.session.closeSafely();
  opened = opened.filter((one) => one !== first);

  // The account's version opens, the browser's differing text is held as this device's version, and the writer is asked which one the
  // account should keep.
  const second = await open();
  const path = `docs/${IDS.sceneA}.md`;
  expect(second.session.projectId).toBe(BOOK.manifest.project.id);
  expect(second.copiedFrom).toBeNull();
  expect(second.session.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
  expect(lastTarget?.state()).toEqual({ kind: 'conflict', paths: [path] });
  expect(lastTarget?.queue?.held()).toContain(path);
  expect(hostedTargetFor(SOURCE.projectId)?.state()).toEqual({ kind: 'conflict', paths: [path] });
});

it('keeps this browser’s task data when the same book is opened again', async () => {
  // The writer's recurring tasks are this browser's, keyed by the project's id: replacing the copy must not sweep them away for a
  // difference the book does not have.
  const rows = new Map<string, unknown>([[`task:${BOOK.manifest.project.id}:task_one`, { id: 'task_one' }]]);
  const db = {
    get: async (key: string) => rows.get(key) as never,
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    list: async (prefix: string) => [...rows.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key, value: rows.get(key) })),
    delete: async (key: string) => { rows.delete(key); },
    close: () => undefined,
  };
  setActiveAppDb(db as never);
  try {
    const first = await open();
    await first.session.closeSafely();
    opened = opened.filter((one) => one !== first);
    await open();
    expect([...rows.keys()]).toEqual([`task:${BOOK.manifest.project.id}:task_one`]);
  } finally {
    setActiveAppDb(null);
  }
});
