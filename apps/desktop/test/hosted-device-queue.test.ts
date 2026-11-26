// @vitest-environment jsdom

import { beforeEach, expect, it } from 'vitest';
import { generateProjectKey } from '../../../packages/crypto/src/index.js';
import { EncryptedRemoteArtifactFs, RemoteUnavailableError, saveProjectToAccount } from '@caotang/remote-store';
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

it('preserves an unverified legacy queue instead of offering to send it or replacing its local copy', async () => {
  const { source, open } = await devices();
  const fs = await open();
  const legacy = '{"format":1,"edits":"old payload"}';
  saveHostedQueue(PROJECT, legacy);
  await expect(deviceQueue(source, fs)).rejects.toThrow('unrecognized format');
  expect(loadHostedQueue(PROJECT)).toBe(legacy);
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
