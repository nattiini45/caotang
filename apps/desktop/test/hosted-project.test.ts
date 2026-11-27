import { describe, expect, it } from 'vitest';
import { addDocument, createEmptyManifest, createProjectState, MemoryArtifactFs, type ProjectState } from '@caotang/store';
import type { EncryptedRemoteArtifactFs } from '@caotang/remote-store';
import { hostedBaseline, picturesOnProjectFs } from '../src/app/hosted-project.js';

const A = 'n_3W8RN2TQ6C';
const B = 'n_5HQ9ZK2V7B';
const COVER = 'assets/c_2K4Q9WJ1TT.png';
const doc = (id: string) => `docs/${id}.md`;

function project(): ProjectState {
  const now = new Date(0);
  const state = createProjectState(createEmptyManifest('The Lighthouse', now));
  for (const id of [A, B]) addDocument(state, { id, parentId: 'manuscript', title: id, body: 'Original', now });
  return state;
}

function index(versions: [string, number][] = []) {
  return { versionSnapshot: () => new Map(versions), exists: async (path: string) => new Map(versions).has(path) } as EncryptedRemoteArtifactFs;
}

describe('the pictures a hosted project carries', () => {
  it('reads every file under assets/, and nothing outside it', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeBytesAtomic('assets/cover.png', new Uint8Array([1, 2, 3]));
    await fs.writeBytesAtomic('assets/map.png', new Uint8Array([4, 5]));
    await fs.writeAtomic('docs/a-scene.md', 'Words.');
    expect(await picturesOnProjectFs(fs)).toEqual({
      'assets/cover.png': new Uint8Array([1, 2, 3]),
      'assets/map.png': new Uint8Array([4, 5]),
    });
  });

  it('reads nothing from a project that holds no pictures', async () => {
    const fs = new MemoryArtifactFs();
    await fs.writeAtomic('docs/a-scene.md', 'Words.');
    expect(await picturesOnProjectFs(fs)).toEqual({});
  });
});

it('builds only changed files without reading the account, pictures included', async () => {
  const state = project();
  const baseline = await hostedBaseline(index([[doc(A), 3], [doc(B), 4], [COVER, 2]]), state, { [COVER]: new Uint8Array([0]) });
  state.documents.get(A)!.body = 'Five words, written offline.';
  const bytes = new Uint8Array([7, 7, 7]);
  const { changes } = await baseline.prepare(state, { [COVER]: bytes });
  expect(changes.map(({ path, base }) => [path, base])).toEqual([[doc(A), 3], [COVER, 2]]);
  expect(new TextDecoder().decode(changes[0]?.bytes ?? undefined)).toContain('Five words, written offline.');
  expect(changes[1]?.bytes).toEqual(bytes);
});

it('names explicit scene, codex and picture deletions alongside the structural manifest edit', async () => {
  const state = project();
  const entry = { id: 'c_9KX2M4ZBQ7', name: 'Light', type: 'lore', description: 'Lore', aliases: [], includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], origin: 'manual', sources: [] } satisfies NonNullable<ProjectState['manifest']['codex']>[number];
  state.manifest.codex = [entry];
  const codexPath = `codex/${entry.id}.md`;
  const baseline = await hostedBaseline(index([[doc(A), 3], [codexPath, 4], [COVER, 2], ['caotang.json', 5]]), state, { [COVER]: new Uint8Array([1]) });
  state.documents.delete(A);
  state.manifest.tree = state.manifest.tree.filter((node) => node.id !== A);
  state.manifest.codex = [];
  const { changes } = await baseline.prepare(state, {});
  expect(changes.filter((change) => change.bytes === null)).toEqual([
    { path: codexPath, base: 4, bytes: null }, { path: doc(A), base: 3, bytes: null }, { path: COVER, base: 2, bytes: null },
  ]);
  expect(changes.find((change) => change.path === 'caotang.json')?.base).toBe(5);
});

it('leaves unreadable document bytes untouched', async () => {
  const state = project();
  state.documents.delete(A);
  state.declinedDocFiles.add(`${A}.md`);
  const baseline = await hostedBaseline(index([[doc(A), 3]]), state, {});
  state.documents.get(B)!.body = 'Revised';
  expect((await baseline.prepare(state, {})).changes.map((change) => change.path)).toEqual([doc(B)]);
});

it('removes an opened screenplay’s legacy body when the writer deletes that scene', async () => {
  const state = project();
  const node = state.manifest.tree.find(({ id }) => id === A)!;
  node.kind = 'screenplay';
  const baseline = await hostedBaseline(index([[doc(A), 6]]), state, {});
  state.documents.delete(A);
  state.manifest.tree = state.manifest.tree.filter(({ id }) => id !== A);
  const first = await baseline.prepare(state, {});
  const removal = { path: doc(A), base: 6, bytes: null };
  expect(first.changes).toContainEqual(removal);
  const retry = await baseline.prepare(state, {});
  expect(retry.changes).toContainEqual(removal);
  retry.staged();
  expect((await baseline.prepare(state, {})).changes).toEqual([]);
});
