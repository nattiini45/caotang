import { describe, expect, it } from 'vitest';
import { generateProjectKey, type SecretKey } from '@caotang/crypto';
import {
  EncryptedRemoteArtifactFs,
  PendingEdits,
  RemoteConflictError,
  RemoteUnavailableError,
  replayPending,
  saveOrQueue,
  type RemoteBlobStore,
} from '../src/index.js';
import { FakeBlobServer } from './fake-blob-server.js';

const PROJECT_ID = 'p_LIGHTHOUSE';

async function device(server: FakeBlobServer, key: SecretKey): Promise<EncryptedRemoteArtifactFs> {
  return EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: PROJECT_ID, projectKey: key });
}

/** The server as this device sees it, with every write name kept so a test can count the index swaps. */
function watched(server: FakeBlobServer): { store: RemoteBlobStore; writes: string[] } {
  const client = server.client();
  const writes: string[] = [];
  return {
    writes,
    store: {
      get: (name) => client.get(name),
      delete: (name) => client.delete(name),
      list: () => client.list(),
      put: async (name, bytes, precondition) => {
        const result = await client.put(name, bytes, precondition);
        writes.push(name);
        return result;
      },
    },
  };
}

async function watchedDevice(server: FakeBlobServer, key: SecretKey): Promise<{ fs: EncryptedRemoteArtifactFs; writes: string[] }> {
  const { store, writes } = watched(server);
  const fs = await EncryptedRemoteArtifactFs.open({ store, projectId: PROJECT_ID, projectKey: key });
  return { fs, writes };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('a project save in one commit', () => {
  it('moves the index once for every file of the save', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    const two = await device(server, key);
    const { fs, writes } = await watchedDevice(server, key);
    await fs.refresh();

    await fs.commitChanges([
      { path: 'caotang.json', bytes: text('{"format":1}') },
      { path: 'docs/a.md', bytes: text('a') },
      { path: 'docs/b.md', bytes: text('b') },
      { path: 'codex/place.md', bytes: text('c') },
    ]);

    expect(writes.filter((name) => name === 'manifest')).toHaveLength(1);
    expect(writes).toHaveLength(5);
    await two.refresh();
    expect(await two.listFiles('docs')).toEqual(['a.md', 'b.md']);
    expect(await two.listFiles('codex')).toEqual(['place.md']);
    await one.refresh();
    expect(await one.read('caotang.json')).toBe('{"format":1}');
  });

  it('tombstones a removed file and discards its bytes', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    await one.writeAtomic('docs/gone.md', 'here for now');
    const { fs, writes } = await watchedDevice(server, key);
    await fs.refresh();

    await fs.commitChanges([{ path: 'docs/gone.md', bytes: null }]);

    expect(writes).toEqual(['manifest']);
    expect(await fs.exists('docs/gone.md')).toBe(false);
    await one.refresh();
    expect(await one.exists('docs/gone.md')).toBe(false);
  });

  it('touches nothing for an empty save or a removal of a file that is not there', async () => {
    const { fs, writes } = await watchedDevice(new FakeBlobServer(), generateProjectKey());
    await fs.commitChanges([]);
    await fs.commitChanges([{ path: 'docs/absent.md', bytes: null }]);
    expect(writes).toEqual([]);
  });

  it('refuses one path staged twice and a path that escapes the project', async () => {
    const { fs, writes } = await watchedDevice(new FakeBlobServer(), generateProjectKey());
    await expect(
      fs.commitChanges([
        { path: 'docs/a.md', bytes: text('x') },
        { path: 'docs/a.md', bytes: text('y') },
      ]),
    ).rejects.toThrow(/one path once/);
    await expect(fs.commitChanges([{ path: '../outside.md', bytes: text('x') }])).rejects.toThrow(/project-relative|escape/);
    expect(writes).toEqual([]);
  });
});

describe('a save against another device', () => {
  it('names every file of the save that changed elsewhere, and writes none of them', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    await one.commitChanges([
      { path: 'docs/a.md', bytes: text('a1') },
      { path: 'docs/b.md', bytes: text('b1') },
      { path: 'docs/c.md', bytes: text('c1') },
    ]);
    const two = await device(server, key);

    await one.commitChanges([
      { path: 'docs/a.md', bytes: text('a2') },
      { path: 'docs/b.md', bytes: text('b2') },
    ]);

    const refused = await two
      .commitChanges([
        { path: 'docs/a.md', bytes: text('mine a') },
        { path: 'docs/b.md', bytes: text('mine b') },
        { path: 'docs/c.md', bytes: text('mine c') },
      ])
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(RemoteConflictError);
    expect((refused as RemoteConflictError).path).toBe('docs/a.md');
    expect((refused as RemoteConflictError).paths).toEqual(['docs/a.md', 'docs/b.md']);
    expect((refused as RemoteConflictError).message).toContain('Nothing was overwritten');

    await two.refresh();
    expect(await two.read('docs/a.md')).toBe('a2');
    expect(await two.read('docs/c.md')).toBe('c1');
    // The question answered "keep mine" is another save, now on top of the other device's version.
    await two.commitChanges([
      { path: 'docs/a.md', bytes: text('mine a') },
      { path: 'docs/b.md', bytes: text('mine b') },
    ]);
    await one.refresh();
    expect(await one.read('docs/a.md')).toBe('mine a');
    expect(await one.read('docs/b.md')).toBe('mine b');
  });

  it('merges a save onto a file another device wrote, instead of asking about a conflict it does not have', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    await one.writeAtomic('docs/a.md', 'a1');
    const two = await device(server, key);

    await one.writeAtomic('docs/b.md', 'from one');
    await two.commitChanges([{ path: 'docs/a.md', bytes: text('from two') }]);

    await one.refresh();
    expect(await one.read('docs/a.md')).toBe('from two');
    expect(await one.read('docs/b.md')).toBe('from one');
    expect(await two.read('docs/b.md')).toBe('from one');
  });
});

describe('the offline queue', () => {
  it('keeps the latest state of each path, in the order it was first staged', () => {
    const edits = new PendingEdits();
    edits.stage('docs/a.md', 'one');
    edits.stage('docs/b.md', 'two');
    edits.stage('docs/a.md', 'one again');
    edits.stageRemoval('docs/b.md');

    expect(edits.size).toBe(2);
    expect(edits.paths).toEqual(['docs/a.md', 'docs/b.md']);
    expect(new TextDecoder().decode(edits.changes()[0]!.bytes!)).toBe('one again');
    expect(edits.changes()[1]!.bytes).toBeNull();

    edits.clear(['docs/a.md']);
    expect(edits.paths).toEqual(['docs/b.md']);
    edits.clear();
    expect(edits.isEmpty).toBe(true);
  });

  it('survives being written out and read back, bytes, words and removals alike', () => {
    const edits = new PendingEdits();
    edits.stage('docs/a.md', 'the words');
    edits.stage('assets/cover.png', Uint8Array.from([0, 1, 2, 254, 255]));
    edits.stageRemoval('docs/old.md');

    const restored = PendingEdits.parse(edits.serialize());

    expect(restored.paths).toEqual(edits.paths);
    const changes = restored.changes();
    expect(new TextDecoder().decode(changes[0]!.bytes!)).toBe('the words');
    expect([...changes[1]!.bytes!]).toEqual([0, 1, 2, 254, 255]);
    expect(changes[2]!.bytes).toBeNull();
  });

  it('refuses text that is not a queue', () => {
    expect(() => PendingEdits.parse('not json')).toThrow(/unreadable/);
    expect(() => PendingEdits.parse('{"format":9,"edits":[]}')).toThrow(/unreadable/);
    expect(() => PendingEdits.parse('{"format":1,"edits":[["a.md"]]}')).toThrow(/unreadable/);
    expect(() => PendingEdits.parse('{"format":1,"edits":[["../escape.md",null]]}')).toThrow();
  });

  it('holds a save made offline and replays it when the server is back, in one commit', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    await one.writeAtomic('docs/a.md', 'before');
    const { fs, writes } = await watchedDevice(server, key);
    await fs.refresh();
    const edits = new PendingEdits();

    server.goOffline();
    const outcome = await saveOrQueue(fs, edits, [
      { path: 'docs/a.md', bytes: text('written offline') },
      { path: 'docs/b.md', bytes: text('also offline') },
      { path: 'docs/old.md', bytes: null },
    ]);
    expect(outcome).toBe('queued');
    expect(edits.paths).toEqual(['docs/a.md', 'docs/b.md', 'docs/old.md']);
    expect(writes).toEqual([]);

    await expect(replayPending(fs, edits)).rejects.toBeInstanceOf(RemoteUnavailableError);
    expect(edits.size).toBe(3);

    server.goOnline();
    expect(await replayPending(fs, edits)).toBe(3);
    expect(edits.isEmpty).toBe(true);
    expect(writes.filter((name) => name === 'manifest')).toHaveLength(1);

    await one.refresh();
    expect(await one.read('docs/a.md')).toBe('written offline');
    expect(await one.read('docs/b.md')).toBe('also offline');
  });

  it('keeps the queued words while the writer answers a conflict, and both answers work', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    const two = await device(server, key);
    await one.writeAtomic('docs/a.md', 'first');

    const refused = await (async () => {
      server.goOffline();
      const edits = new PendingEdits();
      expect(await saveOrQueue(two, edits, [{ path: 'docs/a.md', bytes: text('written offline') }])).toBe('queued');
      server.goOnline();
      await one.writeAtomic('docs/a.md', 'from the other device');
      return { edits, error: await replayPending(two, edits).then(() => null, (error: unknown) => error) };
    })();

    expect(refused.error).toBeInstanceOf(RemoteConflictError);
    expect(refused.edits.paths).toEqual(['docs/a.md']);

    // Take theirs: the path leaves the queue and the other device's words stay.
    refused.edits.clear((refused.error as RemoteConflictError).paths);
    expect(refused.edits.isEmpty).toBe(true);
    expect(await one.read('docs/a.md')).toBe('from the other device');
  });

  it('writes the queued words over the other device when the writer keeps their own', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    const two = await device(server, key);
    await one.writeAtomic('docs/a.md', 'first');
    const edits = new PendingEdits();
    server.goOffline();
    await saveOrQueue(two, edits, [{ path: 'docs/a.md', bytes: text('mine') }]);
    server.goOnline();
    await one.writeAtomic('docs/a.md', 'theirs');

    await expect(replayPending(two, edits)).rejects.toBeInstanceOf(RemoteConflictError);
    await two.refresh();
    expect(await two.read('docs/a.md')).toBe('theirs');
    expect(await replayPending(two, edits)).toBe(1);
    await one.refresh();
    expect(await one.read('docs/a.md')).toBe('mine');
  });
});
