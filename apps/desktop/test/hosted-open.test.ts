/**
 * What a hosted open does with the two copies it could confuse (hosted.md §7): the account's project is the project, and the browser's
 * copy of it is a cache that is refreshed in place — under the same id, keeping the records this browser keys by that id — whatever the
 * two hold. The only device-local state a hosted project has is the queue of saves the account has not taken, and an open sends nothing.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryArtifactFs, MemoryIndexedDb, openRuntimeStore, writeProject, type ProjectState, type RuntimeStore } from '@caotang/store';

import { setActiveAppDb } from '../src/app/app-db.js';
import { type Opened } from '../src/app/lifecycle.js';
import { openHostedProject } from '../src/app/hosted-open.js';
import { HostedTarget, type HostedQueuePort, type HostedReplay } from '../src/app/hosted-target.js';
import { forgetHostedTarget, hostedTargetFor } from '../src/app/hosted-target-registry.js';
import type { HostedProjectSource } from '../src/app/studio-host.js';
import { IDS, project } from '../../../e2e/unit/fixtures.js';

/** One project for the whole file: a fixture built twice makes a second project id, and these tests are about one project. */
const BOOK = project();
const COVER = `assets/p_2K4Q9WJ1TT.png`;

const SOURCE: HostedProjectSource = {
  projectId: 'p_fixture',
  origin: 'https://studio.example',
  device: 'tab_one',
  key: {} as never,
};

let store: RuntimeStore;
let opened: Opened[];
let lastTarget: HostedTarget | null = null;

beforeEach(async () => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  store = await openRuntimeStore(new MemoryIndexedDb());
  opened = [];
  lastTarget = null;
});

afterEach(async () => {
  for (const one of opened) await one.session.closeSafely();
  forgetHostedTarget(SOURCE.projectId);
  store.close();
  vi.unstubAllGlobals();
});

/**
 * A queue that counts what it is asked: an open holds nothing and sends nothing, so a test that found a `send` here would have found the
 * app writing to the account without the writer asking.
 */
function queue(startingWith: readonly string[] = []): HostedQueuePort & { calls: string[] } {
  const held = new Set(startingWith);
  const calls: string[] = [];
  return {
    calls,
    hold: (changes) => {
      calls.push(`hold:${changes.map((change) => change.path).join(',')}`);
      for (const change of changes) held.add(change.path);
    },
    replay: async (): Promise<HostedReplay> => {
      calls.push('send');
      held.clear();
      return { kind: 'sent', count: 1 };
    },
    forget: (paths) => {
      calls.push(`forget:${paths === undefined ? 'all' : paths.join(',')}`);
      if (paths === undefined) held.clear();
      else for (const path of paths) held.delete(path);
    },
    rebase: (paths) => calls.push(`rebase:${paths.join(',')}`),
    held: () => [...held],
    marks: () => calls.push('marks'),
  };
}

/** The account as the app reaches it: one project, its pictures, and the queue this device keeps. */
async function targetFor(state: ProjectState = BOOK, holding: readonly string[] = []): Promise<HostedTarget & { port: ReturnType<typeof queue> }> {
  const fs = new MemoryArtifactFs();
  await writeProject(fs, state);
  await fs.writeBytesAtomic(COVER, new Uint8Array([7, 7, 7]));
  Object.assign(fs, { refresh: async () => undefined });
  const port = queue(holding);
  const target = new HostedTarget(
    SOURCE.projectId,
    fs as never,
    (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never,
    port,
  );
  return Object.assign(target, { port });
}

async function open(state: ProjectState = BOOK, holding: readonly string[] = []): Promise<Opened> {
  const target = await targetFor(state, holding);
  lastTarget = target;
  const result = await openHostedProject(store, SOURCE, async () => target);
  opened.push(result);
  return result;
}

/** The account's project with one document's kind changed, as another device's save would leave it. */
function asScreenplay(): ProjectState {
  const state = project();
  const node = state.manifest.tree.find((candidate) => candidate.id === IDS.sceneA);
  if (node !== undefined) node.kind = 'screenplay';
  state.documents.get(IDS.sceneA)!.body = 'INT. HARBOUR - NIGHT';
  return state;
}

it('opens the account’s project under its own id, with its pictures', async () => {
  const result = await open();
  expect(result.session.projectId).toBe(BOOK.manifest.project.id);
  expect(result.copiedFrom).toBeNull();
  expect(result.session.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
  expect(Object.keys(await result.session.assets.snapshot())).toContain(COVER);
});

it('opens the same project again in place, not as a second copy of itself whose id it would save into the account', async () => {
  const first = await open();
  await first.session.closeSafely();
  opened = opened.filter((one) => one !== first);

  const second = await open();
  expect(second.session.projectId).toBe(BOOK.manifest.project.id);
  expect(second.copiedFrom).toBeNull();
});

it('takes the account’s words over this browser’s copy without asking, because the account is where the project lives', async () => {
  const first = await open();
  first.session.state.documents.get(IDS.sceneA)!.body = 'Five words, written offline';
  await first.session.persistence.settle();
  await first.session.closeSafely();
  opened = opened.filter((one) => one !== first);

  // The account never took those words, and it is not asked about them: an unsent change is the queue's business, and this one never
  // reached it, so the account's text is what the writer sees.
  const second = await open();
  expect(second.session.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
  expect(lastTarget?.state()).toEqual({ kind: 'idle' });
  expect(lastTarget?.port.held()).toEqual([]);
});

it('opens the account’s kind change as the account’s own, with nothing of the copy left to compete with it', async () => {
  const first = await open();
  await first.session.closeSafely();
  opened = opened.filter((one) => one !== first);

  const second = await open(asScreenplay());
  expect(second.session.state.documents.get(IDS.sceneA)?.body).toBe('INT. HARBOUR - NIGHT');
  expect(second.session.state.manifest.tree.find((node) => node.id === IDS.sceneA)?.kind).toBe('screenplay');
  expect(lastTarget?.port.held()).toEqual([]);
});

it('keeps every record this browser keys by the project’s id when the account’s words replace the copy’s', async () => {
  // The writer's recurring tasks, their run history, the consents they gave and the skills they pinned are this browser's, keyed by the
  // project's id: refreshing the copy must not sweep them away.
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
    first.session.state.documents.get(IDS.sceneA)!.body = 'Five words, written offline';
    await first.session.persistence.settle();
    await first.session.closeSafely();
    opened = opened.filter((one) => one !== first);

    await open();
    expect([...rows.keys()]).toEqual([`task:${BOOK.manifest.project.id}:task_one`]);
  } finally {
    setActiveAppDb(null);
  }
});

it('says the words a save could not deliver are still here, and sends nothing on its own', async () => {
  const path = `docs/${IDS.sceneA}.md`;
  const result = await open(BOOK, [path]);

  // The account's book opens, and the queue is left exactly as the last session left it: an open that replayed on its own would write to
  // the account without the writer asking.
  expect(result.session.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
  expect(hostedTargetFor(SOURCE.projectId)?.state()).toEqual({ kind: 'unsaved', paths: [path] });
  expect(lastTarget?.port.held()).toEqual([path]);
  expect(lastTarget?.port.calls.filter((call) => call === 'send')).toEqual([]);
});
