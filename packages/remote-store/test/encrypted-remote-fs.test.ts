import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  HighWaterMarks,
  RollbackError,
  generateProjectKey,
  type SecretKey,
} from '@caotang/crypto';
import {
  ArtifactNotFoundError,
  MemoryArtifactFs,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  readProject,
  writeProject,
} from '@caotang/store';
import {
  EncryptedRemoteArtifactFs,
  RemoteConflictError,
  RemoteIntegrityError,
  RemoteUnavailableError,
} from '../src/index.js';
import { artifactFsContract } from './artifact-fs-contract.js';
import { FakeBlobServer } from './fake-blob-server.js';

const PROJECT_ID = 'p_LIGHTHOUSE';

async function device(server: FakeBlobServer, key: SecretKey, highWater?: HighWaterMarks): Promise<EncryptedRemoteArtifactFs> {
  return EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: PROJECT_ID, projectKey: key, ...(highWater ? { highWater } : {}) });
}

artifactFsContract('MemoryArtifactFs', async () => new MemoryArtifactFs());
artifactFsContract('EncryptedRemoteArtifactFs', () => device(new FakeBlobServer(), generateProjectKey()));

describe('a second device', () => {
  it('sees what the first wrote once it opens, and not before it refreshes', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    const two = await device(server, key);
    await one.writeAtomic('docs/a.md', 'from one');
    await one.ensureDir('assets');

    expect(await two.exists('docs/a.md')).toBe(false);
    await two.refresh();
    expect(await two.read('docs/a.md')).toBe('from one');
    expect(await two.listDirs('')).toEqual(['assets', 'docs']);
    expect(await (await device(server, key)).read('docs/a.md')).toBe('from one');
  });

  it('is refused a wrong project key, as an index that does not authenticate', async () => {
    const server = new FakeBlobServer();
    await (await device(server, generateProjectKey())).writeAtomic('a.md', 'x');
    await expect(device(server, generateProjectKey())).rejects.toBeInstanceOf(RemoteIntegrityError);
  });

  it('is refused another project\'s index, which authenticates only under its own project id', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    await (await device(server, key)).writeAtomic('a.md', 'x');
    await expect(
      EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: 'p_OTHER', projectKey: key }),
    ).rejects.toBeInstanceOf(RemoteIntegrityError);
  });
});

describe('a conflicting edit (HTTP 412)', () => {
  it('names the file, overwrites nothing, and goes through after a refresh', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    await one.writeAtomic('docs/a.md', 'v1');
    const two = await device(server, key);

    await one.writeAtomic('docs/a.md', 'edited on one');
    const refused = await two.writeAtomic('docs/a.md', 'edited on two').then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(RemoteConflictError);
    expect((refused as RemoteConflictError).path).toBe('docs/a.md');
    expect((refused as RemoteConflictError).message).toContain('Nothing was overwritten');

    await one.refresh();
    expect(await one.read('docs/a.md')).toBe('edited on one');
    // The old version is gone from the server, so the stale device is told and not handed a made-up answer.
    await expect(two.read('docs/a.md')).rejects.toMatchObject({ name: 'RemoteConflictError', path: 'docs/a.md' });

    await two.refresh();
    expect(await two.read('docs/a.md')).toBe('edited on one');
    await two.writeAtomic('docs/a.md', 'merged by two');
    await one.refresh();
    expect(await one.read('docs/a.md')).toBe('merged by two');
  });

  it('refuses a stale write to a different file, because the index moved', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    const two = await device(server, key);
    await one.writeAtomic('docs/a.md', 'a');

    await expect(two.writeAtomic('docs/b.md', 'b')).rejects.toMatchObject({ name: 'RemoteConflictError', path: 'docs/b.md' });
    await two.refresh();
    expect(await two.listFiles('docs')).toEqual(['a.md']);
    await two.writeAtomic('docs/b.md', 'b');
  });

  it('refuses a stale remove and a stale ensureDir the same way', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    await one.writeAtomic('a.md', 'a');
    const two = await device(server, key);
    await one.writeAtomic('b.md', 'b');

    await expect(two.remove('a.md')).rejects.toMatchObject({ name: 'RemoteConflictError', path: 'a.md' });
    await expect(two.ensureDir('exports')).rejects.toMatchObject({ name: 'RemoteConflictError', path: 'exports' });
    expect(await one.read('a.md')).toBe('a');
  });

  it('lets two first writes to an empty project race, and one loses', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    const two = await device(server, key);
    await one.writeAtomic('a.md', 'one');
    await expect(two.writeAtomic('a.md', 'two')).rejects.toBeInstanceOf(RemoteConflictError);
  });

  it('serialises writes started together on one device, so none of them conflicts', async () => {
    const fs = await device(new FakeBlobServer(), generateProjectKey());
    await Promise.all(Array.from({ length: 8 }, (_, i) => fs.writeAtomic(`docs/${i}.md`, `body ${i}`)));
    expect(await fs.listFiles('docs')).toEqual(Array.from({ length: 8 }, (_, i) => `${i}.md`));
  });

  it('leaves an unreferenced blob behind from a lost race, and never reads it', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const one = await device(server, key);
    const two = await device(server, key);
    await one.writeAtomic('a.md', 'one');
    const before = (await server.client().list()).length;
    await expect(two.writeAtomic('b.md', 'two')).rejects.toBeInstanceOf(RemoteConflictError);
    expect((await server.client().list()).length).toBe(before + 1);
    await two.refresh();
    expect(await two.listFiles('')).toEqual(['a.md']);
  });
});

describe('offline', () => {
  it('rejects a write with a typed error and changes nothing, then writes once the server is back', async () => {
    const server = new FakeBlobServer();
    const fs = await device(server, generateProjectKey());
    await fs.writeAtomic('a.md', 'kept');

    server.goOffline();
    await expect(fs.writeAtomic('a.md', 'lost')).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(fs.writeAtomic('b.md', 'lost')).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(fs.remove('a.md')).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(fs.read('a.md')).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(fs.refresh()).rejects.toBeInstanceOf(RemoteUnavailableError);
    expect(await fs.listFiles('')).toEqual(['a.md']);

    server.goOnline();
    expect(await fs.read('a.md')).toBe('kept');
    await fs.writeAtomic('b.md', 'now');
    expect(await fs.listFiles('')).toEqual(['a.md', 'b.md']);
  });

  it('does not lose the queue after a failure: the next write on the same device still goes through', async () => {
    const server = new FakeBlobServer();
    const fs = await device(server, generateProjectKey());
    server.goOffline();
    const failed = fs.writeAtomic('a.md', 'x');
    server.goOnline();
    await failed.catch(() => undefined);
    await fs.writeAtomic('b.md', 'y');
    expect(await fs.read('b.md')).toBe('y');
  });
});

describe('rollback and tampering', () => {
  it('refuses an index the server replays from before a version this device has seen', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const marks = new HighWaterMarks();
    const fs = await device(server, key, marks);
    await fs.writeAtomic('a.md', 'one');
    await fs.writeAtomic('a.md', 'two');

    server.replay('manifest', 1);
    await expect(fs.refresh()).rejects.toBeInstanceOf(RollbackError);
    expect(await fs.read('a.md')).toBe('two');
  });

  it('remembers across a restart: a new session with the saved marks refuses the replayed index', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const first = await device(server, key, new HighWaterMarks());
    await first.writeAtomic('a.md', 'one');
    await first.writeAtomic('a.md', 'two');
    const saved = first.highWater.entries();

    server.replay('manifest', 1);
    await expect(device(server, key, new HighWaterMarks(saved))).rejects.toBeInstanceOf(RollbackError);
    // A device with no memory of the later state cannot tell, which is why the marks are kept.
    expect(await (await device(server, key)).listFiles('')).toEqual(['a.md']);
  });

  it('refuses a server that forgets the index after this device has seen one', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    await fs.writeAtomic('a.md', 'one');
    server.drop('manifest');
    await expect(fs.refresh()).rejects.toBeInstanceOf(RollbackError);
  });

  it('refuses an older file served under the current version\'s name', async () => {
    const server = new FakeBlobServer();
    const fs = await device(server, generateProjectKey());
    await fs.writeAtomic('a.md', 'first');
    const [firstBlob] = (await server.client().list()).filter((b) => b.name !== 'manifest');
    await fs.writeAtomic('a.md', 'second');
    const current = (await server.client().list()).find((b) => b.name !== 'manifest' && b.name !== firstBlob?.name);

    server.swap(current?.name ?? '', firstBlob?.name ?? '');
    await expect(fs.read('a.md')).rejects.toBeInstanceOf(RemoteIntegrityError);
  });

  it('refuses a file served under another file\'s name', async () => {
    const server = new FakeBlobServer();
    const fs = await device(server, generateProjectKey());
    await fs.writeAtomic('a.md', 'aaa');
    await fs.writeAtomic('b.md', 'bbb');
    const blobs = (await server.client().list()).filter((b) => b.name !== 'manifest');
    const [x, y] = blobs;
    server.swap(x?.name ?? '', y?.name ?? '');
    server.swap(y?.name ?? '', x?.name ?? '');
    await expect(Promise.all([fs.read('a.md'), fs.read('b.md')])).rejects.toBeInstanceOf(RemoteIntegrityError);
  });

  it('refuses a file the server has lost, and an index with a flipped bit', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    await fs.writeAtomic('a.md', 'aaa');
    const blob = (await server.client().list()).find((b) => b.name !== 'manifest');
    server.drop(blob?.name ?? '');
    await expect(fs.read('a.md')).rejects.toMatchObject({ name: 'RemoteIntegrityError', path: 'a.md' });

    const store = server.client();
    const index = await store.get('manifest');
    const altered = (index?.bytes ?? new Uint8Array()).slice();
    altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 1;
    await store.put('manifest', altered, { ifMatch: index?.etag ?? '' });
    const refreshed = fs.refresh().then(
      () => null,
      (error: unknown) => error,
    );
    const error = await refreshed;
    expect(error).toBeInstanceOf(RemoteIntegrityError);
    expect((error as RemoteIntegrityError).cause).toBeInstanceOf(CryptoError);
  });
});

describe('what the server holds', () => {
  it('keeps one live blob per file and one index, and soft-deletes what an overwrite or a remove replaces', async () => {
    const server = new FakeBlobServer();
    const fs = await device(server, generateProjectKey());
    await fs.writeAtomic('docs/a.md', 'one');
    await fs.writeAtomic('docs/a.md', 'two');
    await fs.writeAtomic('docs/b.md', 'bee');
    expect((await server.client().list()).length).toBe(3);
    await fs.remove('docs/b.md');
    expect((await server.client().list()).length).toBe(2);
    expect(server.dump().filter((o) => o.deleted).length).toBe(2);
  });

  it('shows no name, size or version that tells files of one bucket apart', async () => {
    const server = new FakeBlobServer();
    const fs = await device(server, generateProjectKey());
    await fs.writeAtomic('docs/short.md', 'a');
    await fs.writeAtomic('docs/longer.md', 'a longer scene body, still small');
    const sizes = server.dump().filter((o) => o.name !== 'manifest').map((o) => o.versions[0]?.length);
    expect(new Set(sizes).size).toBe(1);
    for (const o of server.dump()) expect(o.name === 'manifest' || /^[0-9a-f]{32}$/.test(o.name)).toBe(true);
  });
});

/** A project with real shape, the one the store's own round-trip test builds. */
function buildProject() {
  const opened = new Date('2026-09-28T01:00:00.000Z');
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', opened));
  const chapter = addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: opened, id: 'n_CHAPTRS01A' });
  addDocument(state, {
    parentId: chapter.id,
    title: 'The Landing',
    body: 'The ferry was late, as always.\n\nElena counted the seconds between the horn and the swell.',
    status: 'draft',
    keywords: ['sea', 'grief'],
    synopsis: 'Elena returns to the island after nine years.',
    notes: 'Fix pacing in the last three paragraphs.',
    now: opened,
    id: 'n_3W8RN2TQ6C',
  });
  state.manifest.codex = [
    {
      id: 'c_5H8QK2M9RT',
      name: 'Elena Voss',
      aliases: ['Lena'],
      type: 'character',
      description: "The lighthouse keeper's daughter; returns after nine years abroad.",
      includePolicy: 'detected',
      caseSensitive: false,
      exclude: [],
      attachments: ['n_3W8RN2TQ6C'],
      keywords: ['protagonist'],
      origin: 'manual',
      sources: [],
      createdAt: opened.toISOString(),
      updatedAt: opened.toISOString(),
    },
  ];
  return state;
}

describe('a real project over the encrypted store', () => {
  it('is written by the store, read back by it, and byte-identical to the same write to memory', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const fs = await device(server, key);
    const memory = new MemoryArtifactFs();
    const now = new Date('2026-09-28T01:30:00.000Z');
    const state = buildProject();
    await writeProject(fs, state, { now });
    await writeProject(memory, state, { now });

    for (const dir of ['', 'docs', 'codex']) {
      expect(await fs.listFiles(dir)).toEqual(await memory.listFiles(dir));
      expect(await fs.listDirs(dir)).toEqual(await memory.listDirs(dir));
    }
    for (const [path, text] of Object.entries(memory.snapshot())) expect(await fs.read(path), path).toBe(text);

    // Another device with the key opens the same project from the server alone.
    const loaded = await readProject(await device(server, key));
    expect([...loaded.state.documents.values()].map((d) => d.body)).toContain(
      'The ferry was late, as always.\n\nElena counted the seconds between the horn and the swell.',
    );
    expect(loaded.state.manifest.codex?.[0]?.name).toBe('Elena Voss');
  });

  it('puts no document text, codex text or file name on the server, in any live or deleted version', async () => {
    const server = new FakeBlobServer();
    const fs = await device(server, generateProjectKey());
    const state = buildProject();
    await writeProject(fs, state, { now: new Date('2026-09-28T01:30:00.000Z') });
    // Rewrite and remove, so superseded and deleted versions are in the dump too.
    await writeProject(fs, state, { now: new Date('2026-09-28T02:00:00.000Z') });
    await fs.writeAtomic('docs/n_3W8RN2TQ6C.md', 'The ferry was late, as always.');
    await fs.remove('docs/n_3W8RN2TQ6C.md');

    const planted = [
      'ferry was late',
      'Elena counted',
      'Elena Voss',
      "keeper's daughter",
      'Lena',
      'Chapter 1',
      'The Landing',
      'The Lighthouse Keeper',
      'nine years',
      'pacing in the last',
      'caotang.json',
      'coherence.json',
      'n_3W8RN2TQ6C',
      'c_5H8QK2M9RT',
      'docs/',
      'codex/',
    ];
    const dump = server.dump();
    expect(dump.length).toBeGreaterThan(4);
    expect(dump.some((o) => o.deleted)).toBe(true);
    for (const object of dump) {
      // Three bytes turn up in random ciphertext by chance (about once in a few hundred runs of this dump), so the
      // extension is looked for in the plaintext object name only; the file names above cover it inside the blobs.
      expect(object.name.includes('.md'), `".md" in ${object.name}`).toBe(false);
      for (const version of object.versions) {
        const haystack = Buffer.concat([Buffer.from(object.name), Buffer.from('\0'), Buffer.from(version)]);
        for (const needle of planted) {
          expect(haystack.includes(Buffer.from(needle)), `"${needle}" in ${object.name}`).toBe(false);
        }
      }
    }
  });

  it('refuses to read a file whose path was never written', async () => {
    const fs = await device(new FakeBlobServer(), generateProjectKey());
    await expect(fs.read('caotang.json')).rejects.toBeInstanceOf(ArtifactNotFoundError);
  });
});
