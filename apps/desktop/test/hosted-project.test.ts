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

    const changes = await stagedProjectChanges(state, { assets: { files: { [COVER]: bytes } } });
    const paths = changes.map((change) => change.path);
    expect(paths).toContain('docs/n_3W8RN2TQ6C.md');
    expect(paths).toContain('caotang.json');
    expect(changes.find((change) => change.path === COVER)?.bytes).toEqual(bytes);
    expect(new TextDecoder().decode(changes.find((change) => change.path === 'docs/n_3W8RN2TQ6C.md')?.bytes)).toContain('Five words, written offline.');
  });

  it('names the deletions the same save would carry', async () => {
    const state = createProjectState(createEmptyManifest('The Lighthouse', new Date(0)));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'Words.', now: new Date(0), id: 'n_3W8RN2TQ6C' });
    const changes = await stagedProjectChanges(state, { assets: { files: {}, removed: [COVER] } });
    expect(changes.find((change) => change.path === COVER)?.bytes).toBeNull();
  });
});
