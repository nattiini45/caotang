/**
 * The Ink compiler loads on demand (dialogue-narrative.md §2.2), and a Node host loads it before it opens a project: `openProject` does,
 * so the dialogue tools and the branch checks of an agent run have a compiler. The vitest setup file preloads it for every other test, so
 * this one starts from fresh modules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FRIEND, seedProject } from './fixture.js';
import { removeDir, tempDir } from './support.js';

let root = '';
beforeEach(async () => {
  root = tempDir('ink');
  await seedProject(root);
});
afterEach(() => {
  vi.resetModules();
  removeDir(root);
});

describe('openProject and the Ink compiler', () => {
  it('loads the compiler before it opens the folder', async () => {
    vi.resetModules();
    const dialogue = await import('../../dialogue/src/ink-loader.js');
    const { openProject } = await import('../src/index.js');
    expect(dialogue.inkCompilerLoaded()).toBe(false);
    await using project = await openProject({ root, provider: 'mock' });
    expect(dialogue.inkCompilerLoaded()).toBe(true);
    expect(project.state.documents.has(FRIEND)).toBe(true);
  });
});
