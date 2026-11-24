// @vitest-environment jsdom

/**
 * The queue a hosted project keeps, and the one thing only the device can know (hosted.md §7): an edit held while the server was
 * away is only the latest one if the file has not moved since. The adapter can tell that a path moved since *this device read the
 * index*, and a reload always reads it fresh, so the replay itself has to refuse an edit whose file another device has written.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EncryptedRemoteArtifactFs } from '@caotang/remote-store';

import { deviceQueue } from '../src/app/hosted-project.js';
import { loadHostedQueue, saveHostedQueue } from '../src/app/hosted-queue.js';
import type { HostedProjectSource } from '../src/app/studio-host.js';
import { setStorageScope } from '../src/app/storage-scope.js';

const SOURCE: HostedProjectSource = {
  projectId: 'p_lighthouse',
  origin: 'https://studio.example',
  device: 'tab_one',
  key: {} as never,
};

/** The account as this device last read it: a version per path, and a commit that records what it was sent. */
function account(versions: Record<string, number>) {
  const committed: string[][] = [];
  const fs = {
    versionOf: (path: string) => versions[path] ?? 0,
    highWater: { entries: () => [] as [string, number][] },
    commitChanges: async (changes: readonly { readonly path: string }[]) => {
      committed.push(changes.map((change) => change.path));
      for (const change of changes) versions[change.path] = (versions[change.path] ?? 0) + 1;
    },
  };
  return { fs, committed, versions };
}

beforeEach(() => {
  localStorage.clear();
  setStorageScope(null);
});

describe('the queue a hosted project keeps on this device', () => {
  it('sends an edit whose file has not moved since this device read it', async () => {
    const one = account({ 'docs/a.md': 2 });
    const queue = await deviceQueue(SOURCE, one.fs as unknown as EncryptedRemoteArtifactFs);
    queue.hold([{ path: 'docs/a.md', bytes: new Uint8Array([1]) }]);

    expect(await queue.replay()).toEqual({ kind: 'sent', count: 1, paths: ['docs/a.md'] });
    expect(one.committed).toEqual([['docs/a.md']]);
    expect(queue.held()).toEqual([]);
  });

  it('refuses an edit whose file another device wrote while this one was away', async () => {
    const one = account({ 'docs/a.md': 2 });
    const queue = await deviceQueue(SOURCE, one.fs as unknown as EncryptedRemoteArtifactFs);
    queue.hold([{ path: 'docs/a.md', bytes: new Uint8Array([1]) }]);

    // They wrote it: the account moved on, and this device's held text is the older one.
    one.versions['docs/a.md'] = 3;
    expect(await queue.replay()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
    expect(one.committed).toEqual([]);
    expect(queue.held()).toEqual(['docs/a.md']);
  });

  it('keeps the versions across a reload, so a reloaded queue refuses the same way', async () => {
    const one = account({ 'docs/a.md': 2 });
    const first = await deviceQueue(SOURCE, one.fs as unknown as EncryptedRemoteArtifactFs);
    first.hold([{ path: 'docs/a.md', bytes: new Uint8Array([1]) }]);

    one.versions['docs/a.md'] = 3;
    const reloaded = await deviceQueue(SOURCE, one.fs as unknown as EncryptedRemoteArtifactFs);
    expect(reloaded.held()).toEqual(['docs/a.md']);
    expect(await reloaded.replay()).toEqual({ kind: 'conflict', paths: ['docs/a.md'] });
  });

  it('drops a queue text this build cannot read rather than failing the open', async () => {
    saveHostedQueue(SOURCE.projectId, 'not what this build wrote');
    const one = account({});
    const queue = await deviceQueue(SOURCE, one.fs as unknown as EncryptedRemoteArtifactFs);
    expect(queue.held()).toEqual([]);
    expect(loadHostedQueue(SOURCE.projectId)).toBeNull();
  });
});
