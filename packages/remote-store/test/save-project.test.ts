import { describe, expect, it } from 'vitest';
import { generateProjectKey, type SecretKey } from '@caotang/crypto';
import { addDocument, createEmptyManifest, createProjectState, DOCS_DIR, MANIFEST_FILE, type ProjectState } from '@caotang/store';
import { EncryptedRemoteArtifactFs, saveProjectToAccount } from '../src/index.js';
import { FakeBlobServer } from './fake-blob-server.js';

const PROJECT_ID = 'p_LIGHTHOUSE';

async function device(server: FakeBlobServer, key: SecretKey): Promise<EncryptedRemoteArtifactFs> {
  return EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: PROJECT_ID, projectKey: key });
}

const T0 = new Date('2026-11-24T09:00:00.000Z');

/** A project of one document, and the state a save writes from it. */
function project(body: string): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse', T0));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body, now: T0, id: 'n_3W8RN2TQ6C' });
  return state;
}

describe('a project save into the account', () => {
  it('writes the whole project as one index swap', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);

    const outcome = await saveProjectToAccount(fs, project('The first words.'));
    expect(outcome.kind).toBe('written');

    const reader = await device(server, key);
    expect(await reader.read(`${DOCS_DIR}/n_3W8RN2TQ6C.md`)).toContain('The first words.');
    expect(await reader.read(MANIFEST_FILE)).toContain('The Lighthouse');
  });

  it('names every path another device changed, and writes nothing', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const mine = await device(server, key);
    const theirs = await device(server, key);
    expect((await saveProjectToAccount(mine, project('Mine.'))).kind).toBe('written');
    // Their device reads the index, saves, and this device's copy is now behind it.
    await theirs.refresh();
    expect((await saveProjectToAccount(theirs, project('Theirs.'))).kind).toBe('written');

    const outcome = await saveProjectToAccount(mine, project('Mine again.'));
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') throw new Error('expected a conflict');
    expect(outcome.paths.length).toBeGreaterThan(0);
    // The staged save is handed back, so the writer's answer is a replay rather than a second pass over the project.
    expect(outcome.changes.length).toBeGreaterThan(0);

    await mine.refresh();
    expect(await mine.read(`${DOCS_DIR}/n_3W8RN2TQ6C.md`)).toContain('Theirs.');
  });

  it('hands back the save when the server cannot be reached', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    server.goOffline();

    const outcome = await saveProjectToAccount(fs, project('Queued.'));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('expected the save to wait');
    expect(outcome.changes.map((change) => change.path)).toContain(`${DOCS_DIR}/n_3W8RN2TQ6C.md`);
  });
});
