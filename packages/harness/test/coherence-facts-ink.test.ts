/**
 * The coherence scan's dialogue facts fail closed without the Ink compiler (dialogue-narrative.md §2.2): a project with a container
 * and no loaded compiler throws `InkCompilerNotLoaded` and never yields "no findings"; a project with no container needs none.
 */

import { addDocument, createEmptyManifest, createProjectState } from '@caotang/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const INK = '-> tavern\n=== tavern ===\nInnkeeper: Ah, a traveller.\n* [Order an ale] -> END\n';

afterEach(() => vi.resetModules());

/** The facts module and the loader from one fresh copy of the modules, so the compiler the setup file loaded is not in it. */
async function fresh() {
  vi.resetModules();
  const dialogue = await import('@caotang/dialogue');
  const facts = await import('../src/coherence-facts.js');
  return { dialogue, facts };
}

function projectWith(containers: number) {
  const state = createProjectState(createEmptyManifest('Test', NOW));
  for (let i = 0; i < containers; i += 1) {
    addDocument(state, { id: `n_TAVERN000${i}`, parentId: 'manuscript', title: `Tavern ${i}`, type: 'dialogue', body: INK, now: NOW });
  }
  return state;
}

describe('dialogueFactsOf without the compiler', () => {
  it('throws InkCompilerNotLoaded for a project with a dialogue container', async () => {
    const { dialogue, facts } = await fresh();
    expect(() => facts.dialogueFactsOf(projectWith(1))).toThrow(dialogue.InkCompilerNotLoaded);
  });

  it('needs no compiler for a project with none, and reads the container once it is loaded', async () => {
    const { dialogue, facts } = await fresh();
    expect(facts.dialogueFactsOf(projectWith(0)).containerIds).toEqual([]);
    await dialogue.loadInkCompiler();
    expect(facts.dialogueFactsOf(projectWith(1)).containerIds).toEqual(['n_TAVERN0000']);
  });
});
