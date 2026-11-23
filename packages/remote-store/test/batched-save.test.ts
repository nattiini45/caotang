/**
 * A save scope over the encrypted store: the store's own write path writes a project file by file, and the whole save
 * reaches the server as one index swap. This is the shape the hosted app needs — it assembles a project in memory and
 * calls the same `writeProject` the folder binding runs.
 */
import { describe, expect, it } from 'vitest';
import { generateProjectKey, type SecretKey } from '@caotang/crypto';
import {
  MemoryArtifactFs,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  readProject,
  writeProject,
  type ProjectState,
} from '@caotang/store';
import { BatchedSave, EncryptedRemoteArtifactFs, RemoteConflictError, type RemoteBlobStore } from '../src/index.js';
import { FakeBlobServer } from './fake-blob-server.js';

const PROJECT_ID = 'p_LIGHTHOUSE';

async function device(server: FakeBlobServer, key: SecretKey): Promise<EncryptedRemoteArtifactFs> {
  return EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: PROJECT_ID, projectKey: key });
}

/** The server as this device sees it, with every successful write name kept so a test can count the index swaps. */
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

function buildProject(): ProjectState {
  const opened = new Date('2026-09-28T01:00:00.000Z');
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', opened));
  const chapter = addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: opened, id: 'n_CHAPTRS01A' });
  addDocument(state, {
    parentId: chapter.id,
    title: 'The Landing',
    body: 'The ferry was late, as always.\n\nElena counted the seconds between the horn and the swell.',
    status: 'draft',
    keywords: ['sea'],
    synopsis: 'Elena returns to the island.',
    notes: 'Fix pacing.',
    now: opened,
    id: 'n_3W8RN2TQ6C',
  });
  return state;
}

describe('a save through the batch scope', () => {
  it('writes a whole project as one index swap, and another device reads it back', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const { store, writes } = watched(server);
    const fs = await EncryptedRemoteArtifactFs.open({ store, projectId: PROJECT_ID, projectKey: key });
    const now = new Date('2026-09-28T01:30:00.000Z');
    const state = buildProject();
    const memory = new MemoryArtifactFs();
    await writeProject(memory, state, { now });

    const save = new BatchedSave(fs);
    await writeProject(save, state, { now });
    // Nothing reached the server while the save was being assembled.
    expect(writes).toEqual([]);
    await save.commit();

    expect(writes.filter((name) => name === 'manifest')).toHaveLength(1);
    expect(writes).toHaveLength(Object.keys(memory.snapshot()).length + 1);

    const loaded = await readProject(await device(server, key));
    expect(loaded.state.manifest.project.name).toBe('The Lighthouse Keeper');
    expect(await (await device(server, key)).read('docs/n_3W8RN2TQ6C.md')).toContain('The ferry was late');
    for (const dir of ['', 'docs', 'codex']) {
      expect(await fs.listFiles(dir)).toEqual(await memory.listFiles(dir));
      expect(await fs.listDirs(dir)).toEqual(await memory.listDirs(dir));
    }
  });

  it('reads back what it staged, hides what it removed, and fills a directory a file lands in', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    await fs.commitChanges([
      { path: 'docs/a.md', bytes: new TextEncoder().encode('first') },
      { path: 'docs/gone.md', bytes: new TextEncoder().encode('here for now') },
    ]);
    const save = new BatchedSave(fs);

    await save.writeAtomic('docs/a.md', 'second');
    await save.remove('docs/gone.md');
    await save.ensureDir('assets/covers');

    expect(await save.read('docs/a.md')).toBe('second');
    expect(await save.exists('docs/gone.md')).toBe(false);
    expect(await save.listFiles('docs')).toEqual(['a.md']);
    expect(await save.listDirs('')).toEqual(['assets', 'docs']);
    expect(await save.listDirs('assets')).toEqual(['covers']);
    expect(await save.exists('assets')).toBe(true);
    // The staged view never leaks into the store itself.
    expect(await fs.read('docs/a.md')).toBe('first');
    expect(await fs.exists('docs/gone.md')).toBe(true);

    await save.commit();
    expect(await fs.read('docs/a.md')).toBe('second');
    expect(await fs.exists('docs/gone.md')).toBe(false);
    expect(await fs.listDirs('')).toEqual(['assets', 'docs']);
    expect(await fs.listDirs('assets')).toEqual(['covers']);
  });

  it('costs nothing when it is discarded, and refuses to be used after it is spent', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const { store, writes } = watched(server);
    const fs = await EncryptedRemoteArtifactFs.open({ store, projectId: PROJECT_ID, projectKey: key });

    const save = new BatchedSave(fs);
    await save.writeAtomic('docs/a.md', 'never mind');
    save.discard();
    expect(writes).toEqual([]);
    expect(await fs.exists('docs/a.md')).toBe(false);
    expect(() => save.changes()).toThrow(/committed or discarded/);

    const again = new BatchedSave(fs);
    await again.writeAtomic('docs/a.md', 'this one lands');
    await again.commit();
    expect(() => again.discard()).toThrow(/committed or discarded/);
    expect(await fs.read('docs/a.md')).toBe('this one lands');
  });

  it('keeps the overlay when the commit is refused, so the writer\'s answer is one call away', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    await one.writeAtomic('docs/a.md', 'theirs');
    const two = await device(server, key);

    const save = new BatchedSave(two);
    await save.writeAtomic('docs/a.md', 'mine');
    await one.writeAtomic('docs/a.md', 'theirs again');

    await expect(save.commit()).rejects.toBeInstanceOf(RemoteConflictError);
    expect(save.changes()).toEqual([{ path: 'docs/a.md', bytes: expect.any(Uint8Array) }]);

    // Keep mine: refresh, then commit the same save again on top of what the other device wrote.
    await two.refresh();
    await save.commit();
    await one.refresh();
    expect(await one.read('docs/a.md')).toBe('mine');
  });

  it('touches nothing for an empty save', async () => {
    const server = new FakeBlobServer();
    const { store, writes } = watched(server);
    const fs = await EncryptedRemoteArtifactFs.open({ store, projectId: PROJECT_ID, projectKey: generateProjectKey() });
    const save = new BatchedSave(fs);
    expect(save.isEmpty).toBe(true);
    await save.commit();
    expect(writes).toEqual([]);
  });
});
