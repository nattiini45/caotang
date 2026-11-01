/**
 * `binder.importTree`'s apply (import-preview.md §5, issue #267): the shared import preview's commit through the shipped bus, with
 * the asset port injected as the desktop injects it.
 *
 * The issue's "done when", pinned here: the commit is one undo group; Undo restores the project exactly (the manifest's bytes and
 * every body), pictures and codex entries included; nothing is written when the batch is refused; the agent cannot dispatch it.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  executeAsync,
  type BusContext,
  type Command,
  type UndoStore,
} from '@caotang/bus';

import {
  addDocument,
  addFolder,
  createAssetStaging,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  keepsImportedBody,
  rewritePictureRefs,
  serializeManifest,
  type ProjectAssetPort,
  type ProjectState,
} from '../src/index.js';
import { png } from '../../pictures/test/fixtures.js';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const clock = { now: () => NOW.getTime() };

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: NOW, id: 'n_CHAPTER001' });
  addDocument(state, { parentId: 'n_CHAPTER001', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: 'n_LANDING001' });
  return state;
}

interface Harness {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly port: ProjectAssetPort;
  readonly written: Map<string, Uint8Array>;
}

function harness(state: ProjectState = project()): Harness {
  const written = new Map<string, Uint8Array>();
  const port: ProjectAssetPort = {
    staging: createAssetStaging(),
    writeBytes: async (path, bytes) => {
      written.set(path, bytes.slice());
    },
    has: async (path) => written.has(path),
  };
  const registry = createProjectCommandRegistry({ clock, assets: port });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, handle.bus, registry) });
  const handle: { bus: BusContext<ProjectState> } = {
    bus: { state, view: createViewState(), read: () => state, undo, log: createActivityLog(), idempotency: createIdempotencyCache(), notify: () => undefined },
  };
  return { state, undo, bus: handle.bus, registry, port, written };
}

let ordinal = 0;
function command(params: Record<string, unknown>, issuedBy: 'user' | 'agent' = 'user'): Command {
  ordinal += 1;
  return {
    id: `cmd_IMPORT${String(ordinal).padStart(4, '0')}`,
    name: 'binder.importTree',
    params,
    issuedBy,
    createdAt: 1_000,
    ...(issuedBy === 'agent' ? { turnId: 'turn-1' } : {}),
  };
}

/** Everything a project holds that an import can touch: the manifest's bytes and every body. */
function snapshotOf(state: ProjectState): { manifest: string; bodies: [string, string][] } {
  return {
    manifest: serializeManifest(state.manifest),
    bodies: [...state.documents.entries()].map(([id, doc]) => [id, doc.body] as [string, string]).sort(([a], [b]) => a.localeCompare(b)),
  };
}

function undoLast(h: Harness): void {
  const last = h.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = h.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

const SCENE = 'The ferry came at noon. Mara watched it.\n\n![The harbour](import:media/image1.png "Map")\n\nMara waved.';
const BOOK = [
  { type: 'folder', title: 'Part One' },
  { type: 'folder', title: 'Chapter 1: The Landing', parent: 0, synopsis: 'Arrival.' },
  { type: 'document', title: 'Chapter 1 · 1', parent: 1, body: 'The ferry came at noon.', notes: 'Comment (Ana): tighten.' },
  { type: 'document', title: 'Chapter 1 · 2', parent: 1, body: 'Night fell.', keywords: ['night'] },
  { type: 'document', title: 'Before chapter 1', place: 'research', body: 'For my mother.' },
];

describe('binder.importTree — the apply', () => {
  it('makes a Part → Chapter → Scene tree with its metadata and notes, and research front matter, as one undo group', async () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const result = await executeAsync(command({ nodes: BOOK }), h.bus, h.registry);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value.result as { nodeIds: string[]; documents: number; folders: number };
    expect(value).toMatchObject({ documents: 3, folders: 2 });
    const [part, chapter, first, , front] = value.nodeIds.map((id) => h.state.manifest.tree.find((node) => node.id === id));
    expect(part?.parentId).toBe('manuscript');
    expect(chapter?.parentId).toBe(part?.id);
    expect(chapter?.synopsis).toBe('Arrival.');
    expect(first?.parentId).toBe(chapter?.id);
    expect(first?.notes).toBe('Comment (Ana): tighten.');
    expect(front?.parentId).toBe('research');
    expect(h.state.documents.get(first?.id ?? '')?.body).toBe('The ferry came at noon.');
    expect(h.undo.groups()).toHaveLength(1);
    expect(h.bus.log.entries().at(-1)?.summary).toBe('imported 3 documents, 2 folders');

    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('stores the pictures, writes their ../assets/ path, adds the terms and the codex rows, and Undo restores the project exactly', async () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const from = SCENE.indexOf('Mara waved');
    const stagingId = h.port.staging.stage(png({ width: 4, height: 3 }));
    const result = await executeAsync(
      command({
        nodes: [
          { type: 'folder', title: 'Chapter 2' },
          { type: 'document', title: 'Chapter 2 · 1', parent: 0, body: SCENE, status: 'Beta read', label: 'Harbour' },
        ],
        vocabulary: { statuses: ['Beta read'], labels: ['Harbour'] },
        codex: { entries: [{ name: 'Mara', type: 'character', node: 1, cite: { from, to: from + 4, quote: 'Mara' } }] },
        pictures: [{ ref: 'import:media/image1.png', stagingId, alt: 'The harbour' }],
      }),
      h.bus,
      h.registry,
    );
    expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
    if (!result.ok) return;
    const value = result.value.result as { nodeIds: string[]; codexEntries: string[]; pictures: number };
    const sceneId = value.nodeIds[1] ?? '';
    const body = h.state.documents.get(sceneId)?.body ?? '';
    const record = h.state.manifest.assets?.[0];
    expect(record).toBeDefined();
    expect(body).toContain(`![The harbour](../assets/${record?.file} "Map")`);
    expect(body).not.toContain('import:');
    expect(h.written.has(`assets/${record?.file}`)).toBe(true);
    // The citation moved with the rewrite: the quote is still the text at its offsets.
    const entry = h.state.manifest.codex?.find((candidate) => candidate.name === 'Mara');
    expect(entry?.origin).toBe('import');
    expect(entry?.attachments).toEqual([sceneId]);
    const source = entry?.sources[0];
    expect(body.slice(source?.from, source?.to)).toBe('Mara');
    // The terms the import added, and the scene holding them.
    const scene = h.state.manifest.tree.find((node) => node.id === sceneId);
    expect(h.state.manifest.vocabulary.statuses.find((term) => term.id === scene?.status)?.name).toBe('Beta read');
    expect(h.state.manifest.vocabulary.labels.find((term) => term.id === scene?.label)?.name).toBe('Harbour');
    expect(h.undo.groups()).toHaveLength(1);

    undoLast(h);
    // One Undo takes back the nodes, the terms, the codex entry and the picture record: the manifest is byte-identical.
    expect(snapshotOf(h.state)).toEqual(before);
    expect(h.state.manifest.assets).toBeUndefined();
    expect(h.state.manifest.codex ?? []).toEqual([]);
  });

  it('writes nothing when the batch is refused: a codex row that collides refuses the whole import', async () => {
    const h = harness();
    const first = await executeAsync(command({ nodes: [{ type: 'folder', title: 'C' }, { type: 'document', title: 'S', parent: 0, body: 'Mara.' }], codex: { entries: [{ name: 'Mara', node: 1, cite: { from: 0, to: 4, quote: 'Mara' } }] } }), h.bus, h.registry);
    expect(first.ok).toBe(true);
    const before = snapshotOf(h.state);
    const again = await executeAsync(command({ nodes: [{ type: 'folder', title: 'C' }, { type: 'document', title: 'S', parent: 0, body: 'Mara.' }], codex: { entries: [{ name: 'mara', node: 1, cite: { from: 0, to: 4, quote: 'Mara' } }] } }), h.bus, h.registry);
    expect(again.ok).toBe(false);
    expect(snapshotOf(h.state)).toEqual(before);
    expect(h.undo.groups()).toHaveLength(1);
  });

  it('refuses a picture whose bytes are no longer staged, with nothing written', async () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const result = await executeAsync(command({ nodes: [{ type: 'folder', title: 'C' }], pictures: [{ ref: 'import:x.png', stagingId: 'stg_GONE' }] }), h.bus, h.registry);
    expect(result.ok).toBe(false);
    expect(snapshotOf(h.state)).toEqual(before);
    expect(h.written.size).toBe(0);
  });

  it('is refused for an agent, before anything runs', async () => {
    const h = harness();
    const before = snapshotOf(h.state);
    const result = await executeAsync(command({ nodes: BOOK }, 'agent'), h.bus, h.registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.risk).toBe('never');
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('is descriptor-only without the asset port, as the picture imports are', () => {
    const registry = createProjectCommandRegistry({ clock });
    expect(registry['binder.importTree'].apply).toBeUndefined();
  });
});

describe('the helpers the preview shares', () => {
  it('rewrites only import: image targets, and maps offsets after each rewrite', () => {
    const body = 'A ![a](import:one.png) and [link](https://x.test) and ![b](import:two.png "t").';
    const { body: out, map } = rewritePictureRefs(body, new Map([['import:one.png', '../assets/a_1.png'], ['import:two.png', '../assets/a_22.png']]));
    expect(out).toBe('A ![a](../assets/a_1.png) and [link](https://x.test) and ![b](../assets/a_22.png "t").');
    const at = body.indexOf('link');
    expect(out.slice(map(at), map(at) + 4)).toBe('link');
    expect(map(0)).toBe(0);
  });

  it('checks a body through the store’s own save and parse', () => {
    expect(keepsImportedBody('Line one.\n\n***\n\nLine two.\n')).toBe(true);
    expect(keepsImportedBody('---\ntitle: inside\n---\nbody')).toBe(true);
  });
});
