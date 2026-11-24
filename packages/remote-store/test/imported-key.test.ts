/**
 * The hosted store opened from an imported project key: the same project, opened by a device that never holds the key's
 * bytes. The frame gets the key from the shell this way, so every path this test walks is the path the studio walks.
 */
import { describe, expect, it } from 'vitest';
import { generateProjectKey, importProjectKey } from '@caotang/crypto';
import { EncryptedRemoteArtifactFs, RemoteConflictError } from '../src/index.js';
import { FakeBlobServer } from './fake-blob-server.js';

const PROJECT_ID = 'p_LIGHTHOUSE';

describe('a project opened with an imported key', () => {
  it('reads and writes the same project another device holds the bytes for', async () => {
    const server = new FakeBlobServer();
    const key = generateProjectKey();
    const writer = await EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: PROJECT_ID, projectKey: key });
    await writer.commitChanges([
      { path: 'caotang.json', bytes: new TextEncoder().encode('{"format":1}') },
      { path: 'docs/a.md', bytes: new TextEncoder().encode('from the shell') },
    ]);

    const studio = await EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: PROJECT_ID, projectKey: await importProjectKey(key) });
    expect(await studio.read('docs/a.md')).toBe('from the shell');
    await studio.writeAtomic('docs/b.md', 'from the studio');
    await studio.ensureDir('assets');

    await writer.refresh();
    expect(await writer.read('docs/b.md')).toBe('from the studio');
    expect(await writer.listDirs('')).toEqual(['assets', 'docs']);

    // The same rules hold through the imported key: a changed file is still asked about, not overwritten.
    await studio.writeAtomic('docs/b.md', 'edited on the studio');
    await expect(writer.writeAtomic('docs/b.md', 'edited on the shell')).rejects.toBeInstanceOf(RemoteConflictError);
  });

  it('refuses a project this key does not belong to', async () => {
    const server = new FakeBlobServer();
    await (await EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: PROJECT_ID, projectKey: generateProjectKey() })).writeAtomic('a.md', 'x');
    await expect(
      EncryptedRemoteArtifactFs.open({ store: server.client(), projectId: PROJECT_ID, projectKey: await importProjectKey(generateProjectKey()) }),
    ).rejects.toMatchObject({ name: 'RemoteIntegrityError' });
  });
});
