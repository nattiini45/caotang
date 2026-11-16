/**
 * The two halves composed: EncryptedRemoteArtifactFs sealing through createHttpBlobStore over a real HTTP server.
 * The encrypted adapter's own tests use the in-memory contract fake and the HTTP client's tests move raw bytes;
 * this proves the whole path — a project is sealed, uploaded over HTTP, and read back on a second device, with no
 * plaintext on the wire or the server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { generateProjectKey, type SecretKey } from '@caotang/crypto';
import { addDocument, addFolder, createEmptyManifest, createProjectState, readProject, writeProject } from '@caotang/store';
import { EncryptedRemoteArtifactFs, RemoteConflictError, RemoteIntegrityError } from '../src/index.js';
import { createHttpBlobStore } from '../src/http-blob-store.js';
import { HttpFake, TEST_ORIGIN } from './http-fake.js';

const PROJECT_ID = 'p_testproject';
const opened: HttpFake[] = [];

async function start(): Promise<{ server: HttpFake; address: string }> {
  const server = new HttpFake();
  opened.push(server);
  return { server, address: await server.start() };
}

function device(address: string, key: SecretKey): Promise<EncryptedRemoteArtifactFs> {
  const store = createHttpBlobStore({
    origin: TEST_ORIGIN,
    projectId: PROJECT_ID,
    attempts: 3,
    fetch: (url, init) => fetch(String(url).replace(TEST_ORIGIN, address), init),
  });
  return EncryptedRemoteArtifactFs.open({ store, projectId: PROJECT_ID, projectKey: key });
}

afterEach(async () => { await Promise.all(opened.splice(0).map((server) => server.stop())); });

function buildProject() {
  const openedAt = new Date('2026-10-01T09:00:00.000Z');
  const state = createProjectState(createEmptyManifest('The Salt Road', openedAt));
  const chapter = addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: openedAt, id: 'n_CHAPTRS01A' });
  addDocument(state, {
    parentId: chapter.id,
    title: 'The Crossing',
    body: 'The road ran white to the horizon.\n\nMara walked it anyway, counting the milestones she could not read.',
    status: 'draft',
    keywords: ['journey'],
    synopsis: 'Mara leaves the coast for the interior.',
    notes: 'Tighten the second paragraph.',
    now: openedAt,
    id: 'n_3W8RN2TQ6C',
  });
  return state;
}

describe('sealed objects over the HTTP blob client', () => {
  it('uploads a sealed project and a second device reads it back byte-identical', async () => {
    const { address } = await start();
    const key = generateProjectKey();
    const one = await device(address, key);
    const now = new Date('2026-10-01T09:30:00.000Z');
    await writeProject(one, buildProject(), { now });

    const two = await device(address, key);
    const loaded = await readProject(two);
    expect([...loaded.state.documents.values()].map((d) => d.body)).toContain(
      'The road ran white to the horizon.\n\nMara walked it anyway, counting the milestones she could not read.',
    );
    expect(loaded.state.manifest.project.name).toBe('The Salt Road');
    expect(await two.listFiles('docs')).toEqual(await one.listFiles('docs'));
    expect(await two.read('docs/n_3W8RN2TQ6C.md')).toBe(await one.read('docs/n_3W8RN2TQ6C.md'));
  });

  it('puts no document text, title or file name on the server, in any live or deleted version', async () => {
    const { server, address } = await start();
    const fs = await device(address, generateProjectKey());
    const now = new Date('2026-10-01T09:30:00.000Z');
    await writeProject(fs, buildProject(), { now });
    await writeProject(fs, buildProject(), { now: new Date('2026-10-01T10:00:00.000Z') });
    await fs.remove('docs/n_3W8RN2TQ6C.md');

    const planted = ['road ran white', 'Mara walked', 'The Salt Road', 'The Crossing', 'Chapter 1', 'n_3W8RN2TQ6C', 'docs/', 'caotang.json'];
    const dump = server.fake.dump();
    expect(dump.some((o) => o.deleted)).toBe(true);
    for (const object of dump) {
      expect(object.name.includes('.md')).toBe(false);
      for (const version of object.versions) {
        const haystack = Buffer.concat([Buffer.from(object.name), Buffer.from('\0'), Buffer.from(version)]);
        for (const needle of planted) expect(haystack.includes(Buffer.from(needle)), `"${needle}" in ${object.name}`).toBe(false);
      }
    }
  });

  it('refuses a second device with the wrong project key', async () => {
    const { address } = await start();
    await (await device(address, generateProjectKey())).writeAtomic('a.md', 'x');
    await expect(device(address, generateProjectKey())).rejects.toBeInstanceOf(RemoteIntegrityError);
  });

  it('surfaces a conflicting edit as the conflict error, over HTTP 412', async () => {
    const { address } = await start();
    const key = generateProjectKey();
    const one = await device(address, key);
    const two = await device(address, key);
    await one.writeAtomic('docs/a.md', 'v1');
    await one.writeAtomic('docs/a.md', 'edited on one');
    await expect(two.writeAtomic('docs/a.md', 'edited on two')).rejects.toBeInstanceOf(RemoteConflictError);
    await two.refresh();
    expect(await two.read('docs/a.md')).toBe('edited on one');
  });
});