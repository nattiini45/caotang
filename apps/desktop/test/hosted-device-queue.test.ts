// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest';
import { generateProjectKey } from '../../../packages/crypto/src/index.js';
import { EncryptedRemoteArtifactFs, PendingEdits, RemoteUnavailableError, saveProjectToAccount } from '@caotang/remote-store';
import { addDocument, countBody, createEmptyManifest, createProjectState, readProject } from '@caotang/store';
import { FakeBlobServer } from '../../../packages/remote-store/test/fake-blob-server.js';
import { deviceQueue, hostedBaseline } from '../src/app/hosted-project.js';
import { HostedTarget } from '../src/app/hosted-target.js';
import { loadHostedQueue, saveHostedQueue } from '../src/app/hosted-queue.js';
import { setStorageScope } from '../src/app/storage-scope.js';

const PROJECT = 'p_lighthouse';
const A = 'n_3W8RN2TQ6C';
const B = 'n_5HQ9ZK2V7B';
const path = (id: string) => `docs/${id}.md`;

beforeEach(() => {
  localStorage.clear();
  setStorageScope(null);
});

async function devices() {
  const server = new FakeBlobServer();
  const key = generateProjectKey();
  const open = (store = server.client()) => EncryptedRemoteArtifactFs.open({ store, projectId: PROJECT, projectKey: key });
  const source = { projectId: PROJECT, origin: 'https://studio.example', device: 'test', key: {} as CryptoKey };
  const seed = await open();
  const project = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
  for (const id of [A, B]) addDocument(project, { id, parentId: 'manuscript', title: id, body: 'Original', now: new Date(0) });
  expect((await saveProjectToAccount(seed, project)).kind).toBe('written');
  const session = async (fs: EncryptedRemoteArtifactFs, scope: string) => {
    setStorageScope(scope);
    const { state } = await readProject(fs);
    const queue = await deviceQueue(source, fs);
    const target = new HostedTarget(PROJECT, fs, queue, (project, pictures) => hostedBaseline(fs, project, pictures));
    await target.rememberOpened(state, {});
    return {
      target,
      edit: async (id: string, body: string) => {
        setStorageScope(scope);
        state.documents.get(id)!.body = body;
        state.manifest.tree.find((node) => node.id === id)!.updatedAt = new Date().toISOString();
        state.manifest.derived.wordCounts[id] = countBody(body).words;
        await target.save(state);
      },
      send: async () => {
        setStorageScope(scope);
        return await target.sendQueued();
      },
      state,
    };
  };
  const bodies = async () => {
    const { state } = await readProject(await open());
    return [state.documents.get(A)?.body, state.documents.get(B)?.body];
  };
  return { server, source, open, session, bodies };
}

it('two devices merge disjoint scene edits without queuing the other scene or the manifest', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  const two = await session(await open(), 'two');

  server.goOffline();
  await one.edit(A, 'Written offline');
  expect(one.target.state()).toEqual({ kind: 'unsaved', paths: [path(A)], persisted: true });
  server.goOnline();
  await two.edit(B, 'Written on two');
  expect(await one.send()).toEqual({ kind: 'stale' });
  expect(await bodies()).toEqual(['Written offline', 'Written on two']);
});

it('two devices ask about a same-file conflict and require a new answer when it moves again', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  const two = await session(await open(), 'two');

  server.goOffline();
  await one.edit(A, 'Written offline');
  server.goOnline();
  await two.edit(A, 'Written on two');
  expect(await one.send()).toEqual({ kind: 'conflict', paths: [path(A)], persisted: true });
  expect(await bodies()).toEqual(['Written on two', 'Original']);
  await two.edit(A, 'A newer edit on two');
  setStorageScope('one');
  expect(await one.target.keepMine()).toEqual({ kind: 'conflict', paths: [path(A)], persisted: true });
  expect(await bodies()).toEqual(['A newer edit on two', 'Original']);
  expect(await one.target.keepMine()).toEqual({ kind: 'stale' });
  expect(await bodies()).toEqual(['Written offline', 'Original']);
});

it('reopening with pending work retains it while staging a new edit against the account baseline', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  const two = await session(await open(), 'two');
  server.goOffline();
  await one.edit(A, 'Pending from the earlier tab');
  server.goOnline();
  await two.edit(B, 'Written on two');

  const reopened = await session(await open(), 'one');
  expect(reopened.state.documents.get(A)?.body).toBe('Original');
  expect(reopened.target.state()).toEqual({ kind: 'unsaved', paths: [path(A)], persisted: true });
  await reopened.edit(B, 'Updated after reopening');
  expect(reopened.target.state()).toEqual({ kind: 'unsaved', paths: [path(A), path(B)], persisted: true });
  expect(await bodies()).toEqual(['Original', 'Written on two']);
  expect(await reopened.send()).toEqual({ kind: 'stale' });
  expect(await bodies()).toEqual(['Pending from the earlier tab', 'Updated after reopening']);
});

it('retains a path’s exact approved version when another path moves, including across reopen', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  const two = await session(await open(), 'two');
  server.goOffline();
  await one.edit(A, 'Offline A');
  await one.edit(B, 'Offline B');
  server.goOnline();
  await two.edit(A, 'Account A');
  expect(await one.send()).toMatchObject({ kind: 'conflict', paths: [path(A)] });
  await two.edit(B, 'Account B');
  expect(await one.target.keepMine()).toMatchObject({ kind: 'conflict', paths: [path(B)] });
  expect(await bodies()).toEqual(['Account A', 'Account B']);
  const reopened = await session(await open(), 'one');
  expect(await reopened.send()).toMatchObject({ kind: 'conflict', paths: [path(B)] });
  await two.edit(A, 'Account A moved again');
  expect(await reopened.target.keepMine()).toMatchObject({ kind: 'conflict', paths: [path(A)] });
  expect(await bodies()).toEqual(['Account A moved again', 'Account B']);
  expect(await reopened.target.keepMine()).toMatchObject({ kind: 'stale' });
  expect(await bodies()).toEqual(['Offline A', 'Offline B']);
});

it('holds newer edits to a file sent from an earlier open until read, while sending unrelated edits', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  server.goOffline();
  await one.edit(A, 'From the earlier tab');
  server.goOnline();
  const reopened = await session(await open(), 'one');
  expect(await reopened.send()).toMatchObject({ kind: 'stale' });
  expect(reopened.state.documents.get(A)?.body).toBe('Original');

  await reopened.edit(A, 'Written before reading');
  expect(await reopened.send()).toMatchObject({ kind: 'stale' });
  expect(reopened.target.canReread()).toBe(true);
  await reopened.edit(B, 'Unrelated edit');
  expect(await reopened.send()).toMatchObject({ kind: 'stale' });
  expect(await bodies()).toEqual(['From the earlier tab', 'Unrelated edit']);

  const read = await session(await open(), 'one');
  expect(read.state.documents.get(A)?.body).toBe('From the earlier tab');
  expect(read.target.state()).toEqual({ kind: 'unsaved', paths: [path(A)], persisted: true });
  expect(await bodies()).toEqual(['From the earlier tab', 'Unrelated edit']);
  expect(await read.send()).toMatchObject({ kind: 'stale' });
  expect(await bodies()).toEqual(['Written before reading', 'Unrelated edit']);
});

it('holds a manifest change with the unread file it changes', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  server.goOffline();
  await one.edit(A, 'From the earlier tab');
  server.goOnline();
  const reopened = await session(await open(), 'one');
  await reopened.send();

  reopened.state.manifest.tree.find((node) => node.id === A)!.title = 'A revised title';
  await reopened.edit(A, 'New text and a new title');
  expect(reopened.target.state()).toMatchObject({
    kind: 'stale', waiting: { paths: expect.arrayContaining([path(A), 'caotang.json']) },
  });
  await reopened.edit(B, 'Unrelated edit');
  await reopened.send();
  const account = await open();
  expect((await readProject(account)).state.manifest.tree.find((node) => node.id === A)?.title).toBe(A);
  expect(await bodies()).toEqual(['From the earlier tab', 'Unrelated edit']);

  const read = await session(await open(), 'one');
  await read.send();
  await account.refresh();
  expect((await readProject(account)).state.manifest.tree.find((node) => node.id === A)?.title).toBe('A revised title');
  expect(await bodies()).toEqual(['New text and a new title', 'Unrelated edit']);
});

it('does not treat reading a newer account version as permission to overwrite it', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  server.goOffline();
  await one.edit(A, 'From the earlier tab');
  server.goOnline();
  const reopened = await session(await open(), 'one');
  await reopened.send();
  await reopened.edit(A, 'Written before reading');
  const two = await session(await open(), 'two');
  await two.edit(A, 'Written by device two');

  const read = await session(await open(), 'one');
  expect(read.state.documents.get(A)?.body).toBe('Written by device two');
  expect(await read.send()).toMatchObject({ kind: 'conflict', paths: [path(A)] });
  expect(await bodies()).toEqual(['Written by device two', 'Original']);
});

it('settles an accepted batch by its receipt after a lost reply and another device edit', async () => {
  const { server, open, session, bodies } = await devices();
  const store = server.client();
  const one = await session(await open({
    ...store,
    put: async (name, bytes, condition) => {
      const reply = await store.put(name, bytes, condition);
      if (name === 'manifest') throw new RemoteUnavailableError();
      return reply;
    },
  }), 'one');
  await one.edit(A, 'This did land');
  expect(one.target.state().kind).toBe('unsaved');
  const two = await session(await open(), 'two');
  await two.edit(A, 'Written after the lost reply');

  const reopened = await session(await open(), 'one');
  expect(reopened.target.state()).toEqual({ kind: 'idle' });
  expect(loadHostedQueue(PROJECT)).toBeNull();
  expect(await bodies()).toEqual(['Written after the lost reply', 'Original']);
});

it.each([false, true])('keeps the attempted id when newer edits follow a lost reply (reopen: %s)', async (reopen) => {
  const { server, open, session, bodies } = await devices();
  const store = server.client();
  let loseReply = true;
  const one = await session(await open({
    ...store,
    put: async (name, bytes, condition) => {
      const result = await store.put(name, bytes, condition);
      if (name === 'manifest' && loseReply) {
        loseReply = false;
        throw new RemoteUnavailableError();
      }
      return result;
    },
  }), 'one');
  await one.edit(A, 'Accepted before the reply failed');
  expect(await bodies()).toEqual(['Accepted before the reply failed', 'Original']);
  const attempted = JSON.parse(loadHostedQueue(PROJECT)!);
  await one.edit(B, 'New and unrelated');
  await one.edit(A, 'Continued in the same editor');
  expect(JSON.parse(loadHostedQueue(PROJECT)!).attempt).toEqual(attempted.attempt);
  expect(await bodies()).toEqual(['Accepted before the reply failed', 'Original']);

  const writer = reopen ? await session(await open(), 'one') : one;
  expect(await writer.send()).toMatchObject({ kind: 'stale' });
  expect(await bodies()).toEqual(['Continued in the same editor', 'New and unrelated']);
  expect(loadHostedQueue(PROJECT)).toBeNull();
});

it('waits for a read when a newer edit overlaps an unresolved attempt from another tab', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  server.goOffline();
  await one.edit(A, 'From the earlier tab');
  server.goOnline();
  const reopened = await session(await open(), 'one');
  await reopened.edit(A, 'Newer text, before reading');
  await reopened.edit(B, 'Unrelated text');
  expect(await reopened.send()).toMatchObject({ kind: 'stale', waiting: { paths: [path(A)] } });
  expect(await bodies()).toEqual(['From the earlier tab', 'Unrelated text']);

  const read = await session(await open(), 'one');
  expect(read.state.documents.get(A)?.body).toBe('From the earlier tab');
  expect(await read.send()).toMatchObject({ kind: 'stale' });
  expect(await bodies()).toEqual(['Newer text, before reading', 'Unrelated text']);
});

it('retains the newer payload if the attempted write is refused', async () => {
  const { server, open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  const two = await session(await open(), 'two');
  server.goOffline();
  await one.edit(A, 'The first draft');
  await one.edit(A, 'The newer draft');
  server.goOnline();
  await two.edit(A, 'Written by device two');

  expect(await one.send()).toMatchObject({ kind: 'conflict', paths: [path(A)] });
  expect(await bodies()).toEqual(['Written by device two', 'Original']);
  expect(await one.target.keepMine()).toMatchObject({ kind: 'stale' });
  expect(await bodies()).toEqual(['The newer draft', 'Original']);
});

it('retries the original delta if the first attempt to stage it failed', async () => {
  const { open, session, bodies } = await devices();
  const one = await session(await open(), 'one');
  vi.spyOn(one.target.queue, 'stage').mockImplementationOnce(() => { throw new Error('Cannot stage yet'); });
  await one.edit(A, 'Not lost on retry');
  expect(one.target.state()).toMatchObject({ kind: 'unsaved', paths: [], stageFailed: true });
  await one.target.save(one.state);
  expect(one.target.state()).toMatchObject({ kind: 'unsaved', paths: [path(A)] });
  expect(await bodies()).toEqual(['Original', 'Original']);
  await one.send();
  expect(await bodies()).toEqual(['Not lost on retry', 'Original']);
});

it('preserves an unverified legacy queue instead of offering to send it or replacing its local copy', async () => {
  const { source, open } = await devices();
  const fs = await open();
  const legacy = '{"format":1,"edits":"old payload"}';
  saveHostedQueue(PROJECT, legacy);
  await expect(deviceQueue(source, fs)).rejects.toThrow('unrecognized format');
  expect(loadHostedQueue(PROJECT)).toBe(legacy);
});

it('keeps the batch identity when opening the earlier verified queue format', async () => {
  const { source, open } = await devices();
  const fs = await open();
  const edits = new PendingEdits();
  edits.stage(path(A), 'Already accepted');
  const id = 'a'.repeat(32);
  const bases = [[path(A), fs.versionOf(path(A))]];
  saveHostedQueue(PROJECT, JSON.stringify({ format: 2, id, edits: edits.serialize(), bases }));
  await fs.commitEditBatch(id, edits.changes().map((change) => ({ ...change, base: fs.versionOf(change.path) })));
  const queue = await deviceQueue(source, fs);
  expect(queue.held()).toEqual([]);
  expect(loadHostedQueue(PROJECT)).toBeNull();
});

it('keeps an in-flight device’s queue in its original account scope', async () => {
  const { server, source, open } = await devices();
  const fs = await open();
  setStorageScope('writer-one');
  const queue = await deviceQueue(source, fs);
  server.goOffline();
  setStorageScope('writer-two');
  queue.stage([{ path: path(A), bytes: new Uint8Array([1]), base: fs.versionOf(path(A)) }]);
  expect(await queue.send(true)).toEqual({ kind: 'unavailable' });
  expect(loadHostedQueue(PROJECT)).toBeNull();
  expect(loadHostedQueue(PROJECT, 'writer-one')).not.toBeNull();
});
