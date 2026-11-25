import { describe, expect, it } from 'vitest';
import { addDocument, createEmptyManifest, createProjectState, MemoryArtifactFs } from '@caotang/store';
import { picturesOnProjectFs, stagedProjectChanges } from '../src/app/hosted-project.js';

/**
 * A hosted project's pictures travel with it. The copy this browser keeps is what the next save is measured against, so the
 * read has to bring every file under `assets/` across, including a name the app has no record of yet.
 */
describe('the pictures a hosted project carries', () => {
  it('reads every file under assets/, and nothing outside it', async () => {
    const fs = new MemoryArtifactFs();
    await fs.ensureDir('assets');
    await fs.writeBytesAtomic('assets/cover.png', new Uint8Array([1, 2, 3]));
    await fs.writeBytesAtomic('assets/map.png', new Uint8Array([4, 5]));
    await fs.ensureDir('docs');
    await fs.writeAtomic('docs/a-scene.md', 'Words.');

    expect(await picturesOnProjectFs(fs)).toEqual({
      'assets/cover.png': new Uint8Array([1, 2, 3]),
      'assets/map.png': new Uint8Array([4, 5]),
    });
  });

  it('reads nothing from a project that holds no pictures', async () => {
    const fs = new MemoryArtifactFs();
    await fs.ensureDir('docs');
    await fs.writeAtomic('docs/a-scene.md', 'Words.');
    expect(await picturesOnProjectFs(fs)).toEqual({});
  });
});

describe('the words a save made while a question stands carries', () => {
  const COVER = 'assets/c_2K4Q9WJ1TT.png';

  it('builds them without reading the account, pictures included', async () => {
    // The account is what cannot be reached while a question waits to be answered, so the held words are built from a copy in memory:
    // the project as this session has it, and the pictures as it holds them.
    const state = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'Five words, written offline.', now: new Date(0), id: 'n_3W8RN2TQ6C' });
    const bytes = new Uint8Array([7, 7, 7]);

    // The adapter's own listing is what a deletion is named from; this staging reads nothing else of the account.
    const account = new MemoryArtifactFs();
    await account.ensureDir('docs');
    const changes = await stagedProjectChanges(account, state, { assets: { files: { [COVER]: bytes } } });
    const paths = changes.map((change) => change.path);
    expect(paths).toContain('docs/n_3W8RN2TQ6C.md');
    expect(paths).toContain('caotang.json');
    expect(changes.find((change) => change.path === COVER)?.bytes).toEqual(bytes);
    expect(new TextDecoder().decode(changes.find((change) => change.path === 'docs/n_3W8RN2TQ6C.md')?.bytes)).toContain('Five words, written offline.');
  });

  it('names the deletions the same save would carry', async () => {
    const state = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'Words.', now: new Date(0), id: 'n_3W8RN2TQ6C' });
    const account = new MemoryArtifactFs();
    await account.ensureDir('docs');
    const changes = await stagedProjectChanges(account, state, { assets: { files: {}, removed: [COVER] } });
    expect(changes.find((change) => change.path === COVER)?.bytes).toBeNull();
  });

  it('names a deleted scene’s own file, which the staging copy never held', async () => {
    // The copy this staging writes into never held the scene, so the write path's pruning has nothing to remove there. Without this the
    // deletion would be nothing at all: the account keeps the file, and a later send brings the scene back beside a manifest that no
    // longer names it. The name comes from the account's listing, which is what the adapter answers from the index it read at open.
    const state = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'Words.', now: new Date(0), id: 'n_3W8RN2TQ6C' });
    const account = new MemoryArtifactFs();
    await account.ensureDir('docs');
    await account.writeAtomic('docs/n_5HQ9ZK2V7B.md', 'A scene this device deleted.');
    await account.writeAtomic('docs/n_3W8RN2TQ6C.md', 'Words.');

    const changes = await stagedProjectChanges(account, state, { removed: ['n_5HQ9ZK2V7B'] });
    expect(changes.find((change) => change.path === 'docs/n_5HQ9ZK2V7B.md')?.bytes).toBeNull();
    // The scene the state still holds is written, not removed.
    expect(changes.find((change) => change.path === 'docs/n_3W8RN2TQ6C.md')?.bytes).not.toBeNull();
  });

  it('leaves a document this device cannot read exactly as the account holds it', async () => {
    // A body whose bytes are not UTF-8 is declined by the load: the state holds the node and no text for it. Writing that state into a blank
    // copy makes the write path fall back to the empty placeholder the browser shows, and sending that would put nothing over the writer's
    // own document. The copy starts from the account's listing, so the file is already there and the write path leaves it alone.
    const state = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: '', now: new Date(0), id: 'n_3W8RN2TQ6C' });
    // A declined document is one the load kept a node for and no text: there is no record, which is why the write path cannot write it.
    state.documents.delete('n_3W8RN2TQ6C');
    state.declinedDocFiles.add('n_3W8RN2TQ6C.md');
    const account = new MemoryArtifactFs();
    await account.ensureDir('docs');
    await account.writeAtomic('docs/n_3W8RN2TQ6C.md', 'the bytes this device could not read');

    const changes = await stagedProjectChanges(account, state, {});
    expect(changes.map((change) => change.path)).not.toContain('docs/n_3W8RN2TQ6C.md');
  });

  it('names a deleted codex entry’s file, so the account does not keep it as an orphan', async () => {
    // A codex file is pruned by what the copy holds: seeded with the account's listing, a file this device deleted is found and pruned, and
    // the manifest that stops naming it lands in the same save. Without the listing the file stayed on the account, and the next open
    // imported it as an orphan — undoing the deletion.
    const state = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'Words.', now: new Date(0), id: 'n_3W8RN2TQ6C' });
    const account = new MemoryArtifactFs();
    await account.ensureDir('codex');
    await account.writeAtomic('codex/c_9KX2M4ZBQ7.md', 'An entry this device deleted.');
    const changes = await stagedProjectChanges(account, state, {});
    expect(changes.find((change) => change.path === 'codex/c_9KX2M4ZBQ7.md')?.bytes).toBeNull();
  });

  it('leaves another device’s scene alone', async () => {
    // A document this device never had is not one it deleted: naming it would drop work the writer has not seen.
    const state = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'Words.', now: new Date(0), id: 'n_3W8RN2TQ6C' });
    const account = new MemoryArtifactFs();
    await account.ensureDir('docs');
    await account.writeAtomic('docs/n_8TY3PL4XQ9.md', 'Another device’s scene.');
    const changes = await stagedProjectChanges(account, state, { removed: [] });
    expect(changes.map((change) => change.path)).not.toContain('docs/n_8TY3PL4XQ9.md');
  });
});
