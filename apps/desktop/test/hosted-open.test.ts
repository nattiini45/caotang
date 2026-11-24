/**
 * What a hosted open does with the words that were not delivered and with the browser's own copy (hosted.md §7, §11). The words
 * an earlier tab could not send reach the project the writer opens, and opening the same account project twice is the same
 * project each time rather than a second copy of itself whose id the next save would write into the account's manifest.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryArtifactFs, MemoryIndexedDb, openRuntimeStore, writeProject, type RuntimeStore } from '@caotang/store';

import { openHostedProject, type Opened } from '../src/app/lifecycle.js';
import { forgetHostedTarget, HostedTarget, type HostedQueuePort, type HostedReplay } from '../src/app/hosted-target.js';
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
function queueHolding(fs: MemoryArtifactFs, replayedBody: string, outcome: HostedReplay = { kind: 'sent', count: 1 }): HostedQueuePort {
  const held = new Set([`docs/${IDS.sceneA}.md`]);
  return {
    hold: (changes) => {
      for (const change of changes) held.add(change.path);
    },
    replay: async () => {
      if (outcome.kind !== 'sent') return outcome;
      const state = project();
      state.manifest.project = BOOK.manifest.project;
      state.documents.get(IDS.sceneA)!.body = replayedBody;
      await writeProject(fs, state);
      held.clear();
      return outcome;
    },
    forget: (paths) => {
      if (paths === undefined) held.clear();
      else for (const path of paths) held.delete(path);
    },
    held: () => [...held],
    marks: () => {},
  };
}

async function targetFor(replayedBody: string, outcome?: HostedReplay): Promise<HostedTarget> {
  const fs = new MemoryArtifactFs();
  await writeProject(fs, BOOK);
  const queue = queueHolding(fs, replayedBody, outcome);
  return new HostedTarget(
    SOURCE.projectId,
    fs as never,
    (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never,
    queue,
  );
}

/** Opens through the lifecycle, closing whatever it opened when the test ends. */
async function open(body: string, outcome?: HostedReplay): Promise<Opened> {
  const target = await targetFor(body, outcome);
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

it('keeps a browser copy that holds words the account does not, instead of deleting them', async () => {
  const first = await open();
  // The writer typed here and the browser kept it; the account never got it.
  first.session.state.documents.get(IDS.sceneA)!.body = 'Five words, written offline';
  await first.session.persistence.settle();
  await first.session.closeSafely();
  opened = opened.filter((one) => one !== first);

  const second = await open();
  expect(second.session.projectId).toBe(BOOK.manifest.project.id);
  expect(second.copiedFrom).toBeNull();
  expect(second.session.state.documents.get(IDS.sceneA)?.body).toBe('Five words, written offline');
});
