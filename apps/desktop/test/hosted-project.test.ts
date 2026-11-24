import { describe, expect, it } from 'vitest';
import { MemoryArtifactFs } from '@caotang/store';
import { picturesOnProjectFs } from '../src/app/hosted-project.js';

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
