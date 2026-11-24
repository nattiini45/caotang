import { describe, expect, it } from 'vitest';
import { generateProjectKey, type SecretKey } from '@caotang/crypto';
import { addDocument, createEmptyManifest, createProjectState, DOCS_DIR, MANIFEST_FILE, type ProjectState } from '@caotang/store';
import { EncryptedRemoteArtifactFs, saveProjectToAccount, stageProjectForAccount } from '../src/index.js';
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

  it('hands the staged words back when the commit itself fails, rather than losing them', async () => {
    // A refusal with no name of its own — a full account, an index that would not take the swap — is not the server being away, so the
    // save cannot answer `unavailable`; the caller still gets what this device staged, because nothing reached the account.
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    const refused = async (): Promise<void> => { throw new Error('the index would not take it'); };
    fs.commitChanges = refused;
    try {
      const outcome = await saveProjectToAccount(fs, project('Staged.'));
      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') throw new Error('expected the save to fail');
      expect(outcome.changes.map((change) => change.path)).toContain(`${DOCS_DIR}/n_3W8RN2TQ6C.md`);
    } finally {
      delete (fs as { commitChanges?: unknown }).commitChanges;
    }
  });
});

describe('a save staged and thrown away', () => {
  it('names what the save would write without writing any of it', async () => {
    // The words a writer types while a question about the account stands are held in the queue, and the queue holds what the save
    // would have sent: staging it is that list, and nothing reaches the account.
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);

    const changes = await stageProjectForAccount(fs, project('Staged.'));
    expect(changes.map((change) => change.path)).toContain(`${DOCS_DIR}/n_3W8RN2TQ6C.md`);
    expect(server.dump()).toEqual([]);

    const reader = await device(server, key);
    expect(await reader.exists(`${DOCS_DIR}/n_3W8RN2TQ6C.md`)).toBe(false);
  });
});

describe('a project’s pictures travel with the save that names them', () => {
  const COVER = 'assets/c_2K4Q9WJ1TT.png';

  it('writes a picture the account does not hold, in the same commit as the files', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    const bytes = new Uint8Array([7, 7, 7]);

    expect((await saveProjectToAccount(fs, project('With a cover.'), { assets: { files: { [COVER]: bytes } } })).kind).toBe('written');

    const reader = await device(server, key);
    expect(await reader.readBytes(COVER)).toEqual(bytes);
  });

  it('leaves a picture the account already holds byte for byte as it is', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    const bytes = new Uint8Array([7, 7, 7]);
    await saveProjectToAccount(fs, project('With a cover.'), { assets: { files: { [COVER]: bytes } } });

    const second = await saveProjectToAccount(fs, project('With a cover, edited.'), { assets: { files: { [COVER]: bytes } } });
    expect(second.kind).toBe('written');
    // The picture was not staged again: the paths this save wrote are the project's files, not the unchanged picture.
    expect(second.kind === 'written' ? second.report.written : []).not.toContain(COVER);
  });

  it('removes the picture this device says it deleted, and only that one', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    const THEIRS = 'assets/c_9W1ZK4Q7MM.png';
    await saveProjectToAccount(fs, project('With two covers.'), { assets: { files: { [COVER]: new Uint8Array([7]), [THEIRS]: new Uint8Array([9]) } } });

    await saveProjectToAccount(fs, project('Without mine.'), { assets: { files: {}, removed: [COVER] } });
    const reader = await device(server, key);
    expect(await reader.exists(COVER)).toBe(false);
    // The other device's picture is not this save's to remove: it was never in this device's list of deletions.
    expect(await reader.exists(THEIRS)).toBe(true);
  });

  it('keeps every picture the account holds when this device deleted none', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    await saveProjectToAccount(fs, project('With a cover.'), { assets: { files: { [COVER]: new Uint8Array([7]) } } });

    await saveProjectToAccount(fs, project('A browser with no asset store.'), { assets: { files: {} } });
    const reader = await device(server, key);
    expect(await reader.exists(COVER)).toBe(true);
  });
});
