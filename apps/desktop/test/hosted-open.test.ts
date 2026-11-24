/**
 * The words an earlier tab could not deliver reach the open project (hosted.md §7). A save made while the server was away is
 * held in the device's queue, and the open replays it before the project is read, so a writer who closed the tab comes back to
 * the text they wrote rather than to the account's older version.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryArtifactFs, MemoryIndexedDb, openRuntimeStore, writeProject, type RuntimeStore } from '@caotang/store';

import { openHostedProject } from '../src/app/lifecycle.js';
import { HostedTarget, type HostedQueuePort, type HostedReplay } from '../src/app/hosted-target.js';
import { forgetHostedTarget } from '../src/app/hosted-target.js';
import type { HostedProjectSource } from '../src/app/studio-host.js';
import { IDS, project } from '../../../e2e/unit/fixtures.js';

const SOURCE: HostedProjectSource = {
  projectId: 'p_fixture',
  origin: 'https://studio.example',
  device: 'tab_one',
  key: {} as never,
};

let store: RuntimeStore;

beforeEach(async () => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  store = await openRuntimeStore(new MemoryIndexedDb());
});

afterEach(() => {
  forgetHostedTarget(SOURCE.projectId);
  store.close();
  vi.unstubAllGlobals();
});

/** A queue that holds one scene's words and replays them into the same filesystem the open reads. */
function queueHolding(fs: MemoryArtifactFs, replayedBody: string, outcome: HostedReplay = { kind: 'sent', count: 1 }): HostedQueuePort {
  const held = new Set(['docs/' + IDS.sceneA + '.md']);
  return {
    hold: (changes) => {
      for (const change of changes) held.add(change.path);
    },
    replay: async () => {
      if (outcome.kind !== 'sent') return outcome;
      const state = project();
      state.documents.get(IDS.sceneA)!.body = replayedBody;
      await writeProject(fs, state);
      held.clear();
      return outcome;
    },
    forget: () => held.clear(),
    held: () => [...held],
    marks: () => {},
  };
}

async function opened(replayedBody: string, outcome?: HostedReplay): Promise<string | undefined> {
  const fs = new MemoryArtifactFs();
  await writeProject(fs, project());
  const queue = queueHolding(fs, replayedBody, outcome);
  const target = new HostedTarget(SOURCE.projectId, fs as never, (async () => ({ kind: 'written', report: { written: [], rotated: [], dropped: [], pruned: [] } })) as never, queue);
  const result = await openHostedProject(store, SOURCE, async () => target);
  return result.session.state.documents.get(IDS.sceneA)?.body;
}

it('opens the words an earlier tab queued instead of the account’s older version', async () => {
  expect(await opened('Five words, written offline')).toBe('Five words, written offline');
});

it('opens the account’s version when the replayed words lose to another device, and keeps them queued', async () => {
  expect(await opened('Five words, written offline', { kind: 'conflict', paths: ['docs/' + IDS.sceneA + '.md'] })).toBe('Four little words here');
});
