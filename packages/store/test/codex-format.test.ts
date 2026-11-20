import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FILE,
  RUNTIME_DB_VERSION,
  MemoryArtifactFs,
  MemoryIndexedDb,
  ProjectWriteConflictError,
  RuntimeStoreStaleError,
  ProjectRefusedError,
  commitRecovery,
  commitProject,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
  importProjectZip,
  migrateToCurrent,
  openRuntimeStore,
  readProject,
  readProjectState,
  recoverProject,
  serializeManifest,
  writeProject,
  writeProjectState,
  type CodexEntry,
} from '../src/index.js';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const v1Reader = { current: 1, registry: [] };
const v2Reader = { current: 2, registry: [] };
const reference = { id: 'ref_00000001', title: 'Tide tables', url: 'https://example.org/tides', publisher: 'Harbour Office', date: '2026-03-04', quote: 'Spring tides run six hours.' };
const entry: CodexEntry = {
  id: 'c_0000000001',
  name: 'Kestrel',
  aliases: [],
  type: 'character',
  description: 'A keeper.',
  includePolicy: 'detected',
  caseSensitive: false,
  exclude: [],
  attachments: [],
  keywords: [],
  origin: 'manual',
  sources: [],
};

function openUnprotectedVersion(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, RUNTIME_DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('the codex browser rollback boundary', () => {
  it('leaves an ordinary database at v6 and commits the first protected row as it upgrades', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory);
    const manifest = createEmptyManifest('The Lantern', NOW);
    await writeProjectState(store, createProjectState(manifest));
    const id = manifest.project.id;
    expect(store.db.version).toBe(RUNTIME_DB_VERSION);
    (await openUnprotectedVersion(factory, store.name)).close();

    const other = await openRuntimeStore(factory);
    manifest.codex = [{ ...entry, details: { age: 0, unknown: ['keep'] } }];
    await commitProject(store, { projectId: id, manifest });
    expect(store.db.version).toBe(RUNTIME_DB_VERSION + 1);
    await expect(openUnprotectedVersion(factory, store.name)).rejects.toMatchObject({ name: 'VersionError' });
    await expect(readProjectState(other, id)).rejects.toBeInstanceOf(RuntimeStoreStaleError);
    store.close();
    const reopened = await openRuntimeStore(factory);
    expect(await readProjectState(reopened, id)).toMatchObject({
      manifest: { formatVersion: 2, codex: manifest.codex },
    });
    reopened.close();
  });

  it('leaves the database rollback-compatible when the first protected write is refused', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory);
    const manifest = createEmptyManifest('The Lantern', NOW);
    const id = manifest.project.id;
    const state = createProjectState(manifest);
    await writeProjectState(store, state);
    const stale = structuredClone(state);
    stale.manifest.project.name = 'A different draft';
    manifest.codexDetailFields = [{ type: 'character', key: 'age', label: 'Age', kind: 'number' }];
    await expect(writeProjectState(store, state, { expected: stale })).rejects.toBeInstanceOf(ProjectWriteConflictError);
    (await openUnprotectedVersion(factory, store.name)).close();
    expect((await readProjectState(store, id)).manifest).not.toHaveProperty('codexDetailFields');

    await writeProjectState(store, state);
    expect(store.db.version).toBe(RUNTIME_DB_VERSION + 1);
    expect((await readProjectState(store, id)).manifest.codexDetailFields).toEqual(manifest.codexDetailFields);
    store.close();
  });

  it('does not perform a refused upgrade after the blocking tab leaves', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory);
    const state = createProjectState(createEmptyManifest('The Lantern', NOW));
    await writeProjectState(store, state);
    const blocker = await openUnprotectedVersion(factory, store.name);
    state.manifest.codex = [{ ...entry, details: { age: 24 } }];
    try {
      await expect(writeProjectState(store, state)).rejects.toThrow('blocking browser storage');
    } finally {
      blocker.close();
    }
    const reopened = await openRuntimeStore(factory);
    expect(reopened.db.version).toBe(RUNTIME_DB_VERSION);
    expect((await readProjectState(reopened, state.manifest.project.id)).manifest.codex).toEqual([]);
    store.close();
    reopened.close();
  });
});

describe('the codex artifact format boundary', () => {
  it('opens and saves legacy v1 with the same bytes and no migration', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    manifest.codex = [entry];
    expect(manifest.formatVersion).toBe(1);
    expect(migrateToCurrent(manifest)).toEqual({ manifest, applied: [] });
    const legacyText = serializeManifest(manifest, v1Reader);
    const fs = new MemoryArtifactFs();
    fs.putFile(MANIFEST_FILE, legacyText);
    const loaded = await readProject(fs, { now: NOW });
    expect(loaded.report.migrations).toEqual([]);
    expect(loaded.notices).toEqual([]);
    await writeProject(fs, loaded.state, { now: NOW });
    expect(await fs.read(MANIFEST_FILE)).toBe(legacyText);
    expect((await readProject(fs, { format: v1Reader })).state.manifest.formatVersion).toBe(1);
  });

  it('protects field definitions even before the first value is set', () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    manifest.codexDetailFields = [{ type: 'character', key: 'age', label: 'Age', kind: 'number' }];
    expect(JSON.parse(serializeManifest(manifest))).toMatchObject({
      formatVersion: 2,
      codexDetailFields: manifest.codexDetailFields,
    });
    expect(manifest.formatVersion).toBe(1);
  });

  it('raises an artifact with external references to v3, and a v2 build refuses it', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    manifest.codex = [{ ...entry, references: [reference] }];
    expect(JSON.parse(serializeManifest(manifest))).toMatchObject({ formatVersion: 3, codex: [{ references: [reference] }] });
    const fs = new MemoryArtifactFs();
    await writeProject(fs, createProjectState(manifest), { now: NOW });
    const before = fs.snapshot();
    await expect(readProject(fs, { format: v2Reader })).rejects.toBeInstanceOf(ProjectRefusedError);
    expect(fs.snapshot()).toEqual(before);
    expect((await readProject(fs, { now: NOW })).state.manifest.codex?.[0]?.references).toEqual([reference]);
  });

  it('commits external references at the browser version that refuses a typed-details build', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory);
    const manifest = createEmptyManifest('The Lantern', NOW);
    await writeProjectState(store, createProjectState(manifest));
    manifest.codex = [{ ...entry, references: [reference] }];
    await commitProject(store, { projectId: manifest.project.id, manifest });
    expect(store.db.version).toBe(RUNTIME_DB_VERSION + 2);
    await expect(openUnprotectedVersion(factory, store.name)).rejects.toMatchObject({ name: 'VersionError' });
    expect((await readProjectState(store, manifest.project.id)).manifest).toMatchObject({
      formatVersion: 3,
      codex: [{ references: [reference] }],
    });
    store.close();
  });

  it('commits entry relations at the browser version that refuses a references build', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory);
    const manifest = createEmptyManifest('The Lantern', NOW);
    await writeProjectState(store, createProjectState(manifest));
    const relation = { id: 'rel_7K3M2Q8XZC', targetId: 'c_0000000002', label: 'ally' };
    manifest.codex = [{ ...entry, relations: [relation] }];
    await commitProject(store, { projectId: manifest.project.id, manifest });
    expect(store.db.version).toBe(RUNTIME_DB_VERSION + 3);
    await expect(openUnprotectedVersion(factory, store.name)).rejects.toMatchObject({ name: 'VersionError' });
    expect((await readProjectState(store, manifest.project.id)).manifest).toMatchObject({
      formatVersion: 4,
      codex: [{ relations: [relation] }],
    });
    store.close();
  });

  it('refuses protected folders and bundles at the v1 gate and reopens them intact in production', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    const details = { age: 0, unused: { keep: [false, null] } };
    manifest.codex = [{ ...entry, details }];
    manifest.codexDetailFields = [{ type: 'character', key: 'age', label: 'Age', kind: 'number' }];
    const state = createProjectState(manifest);
    const fs = new MemoryArtifactFs();
    await writeProject(fs, state, { now: NOW });
    const zip = await exportProjectZip(state, { now: NOW });
    const bundle = await importProjectZip(zip.bytes);
    for (const artifact of [fs, bundle.fs]) {
      const before = artifact.snapshot();
      await expect(readProject(artifact, { format: v1Reader })).rejects.toThrow(ProjectRefusedError);
      await expect(recoverProject(artifact, { format: v1Reader })).rejects.toThrow(ProjectRefusedError);
      expect(artifact.snapshot()).toEqual(before);

      const opened = await readProject(artifact, { now: NOW });
      expect(opened.report.migrations).toEqual([]);
      expect(opened.state.manifest).toMatchObject({
        formatVersion: 2,
        codexDetailFields: manifest.codexDetailFields,
        codex: [{ details }],
      });
      delete opened.state.manifest.codexDetailFields;
      delete opened.state.manifest.codex?.[0]?.details;
      expect(JSON.parse(serializeManifest(opened.state.manifest))).toMatchObject({ formatVersion: 2 });
    }
  });

  it('accepts an unstamped v1 manifest with detail values and protects them on the next write', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    const details = { unknown: false };
    manifest.codex = [{ ...entry, details }];
    const fs = new MemoryArtifactFs();
    fs.putFile(MANIFEST_FILE, JSON.stringify(manifest));
    const loaded = await readProject(fs, { now: NOW });
    expect(loaded.report.migrations).toEqual([]);
    await writeProject(fs, loaded.state, { now: NOW });
    expect(JSON.parse(await fs.read(MANIFEST_FILE))).toMatchObject({ formatVersion: 2, codex: [{ details }] });
  });

  it('protects values recovered from front matter even without definitions', async () => {
    const manifest = createEmptyManifest('The Lantern', NOW);
    const details = { unknown: true };
    manifest.codex = [{ ...entry, details }];
    const fs = new MemoryArtifactFs();
    await writeProject(fs, createProjectState(manifest), { now: NOW });
    fs.putFile(MANIFEST_FILE, '{');
    const recovered = await recoverProject(fs, { now: NOW });
    expect(recovered.status).toBe('needs-consent');
    if (recovered.status !== 'needs-consent') throw new Error('Expected a rebuild offer');
    await commitRecovery(fs, recovered.offer, { now: NOW });
    expect(JSON.parse(await fs.read(MANIFEST_FILE))).toMatchObject({ formatVersion: 2, codex: [{ details }] });
  });
});
