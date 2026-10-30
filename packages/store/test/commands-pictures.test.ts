/**
 * The picture registry (pictures.md §2.1, §2.4, §6.2, §6.4), through the shipped bus: `asset.import`, `asset.importBatch` and
 * `asset.setMeta`, the cover import re-based on them, the manifest's `assets[]` round trip, and the open's backfill.
 *
 * The issue's "done when", each pinned here: the same bytes imported twice write one file; an imported JPEG has no GPS IFD and
 * keeps its Orientation; an old project gets a record for every used file; the cover's undo is unchanged.
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
  type CommandName,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';
import { jpegHasGps, jpegOrientation, sha256Hex } from '@caotang/pictures';

import {
  addDocument,
  backfillAssetRecords,
  createAssetStaging,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  serializeManifest,
  validateManifest,
  type ProjectAssetPort,
  type ProjectState,
} from '../src/index.js';
import { exifTiff, jpeg, png } from '../../pictures/test/fixtures.js';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const clock = { now: () => NOW.getTime() };

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: 'n_LANDING001' });
  return state;
}

interface Bus {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly port: ProjectAssetPort;
  readonly written: Map<string, Uint8Array>;
  writes: number;
}

function bus(state: ProjectState = project()): Bus {
  const written = new Map<string, Uint8Array>();
  const staging = createAssetStaging();
  const b = { written, writes: 0 } as { written: Map<string, Uint8Array>; writes: number };
  const port: ProjectAssetPort = {
    staging,
    writeBytes: async (path, bytes) => {
      b.writes += 1;
      written.set(path, bytes.slice());
    },
  };
  const registry = createProjectCommandRegistry({ clock, assets: port });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, handle.bus, registry) });
  const handle: { bus: BusContext<ProjectState> } = {
    bus: { state, view: createViewState(), read: () => state, undo, log: createActivityLog(), idempotency: createIdempotencyCache(), notify: () => undefined },
  };
  return Object.assign(b, { state, undo, bus: handle.bus, registry, port });
}

let ordinal = 0;
function command(name: CommandName, params: Record<string, unknown>): Command {
  ordinal += 1;
  return { id: `cmd_PICTURE${String(ordinal).padStart(3, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
}

function runAsync(b: Bus, name: CommandName, params: Record<string, unknown>) {
  return executeAsync(command(name, params), b.bus, b.registry);
}

function run(b: Bus, name: CommandName, params: Record<string, unknown>) {
  return execute(command(name, params), b.bus, b.registry);
}

function okValue(result: ReturnType<typeof execute>): ExecutionOutcome {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function undoLast(b: Bus): void {
  const last = b.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = b.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

const PHOTO = jpeg({ exif: exifTiff(6), width: 4032, height: 3024 });

async function importOne(b: Bus, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  return runAsync(b, 'asset.import', { stagingId: b.port.staging.stage(bytes), ...extra });
}

describe('asset.import — one picture into assets/ and the registry', () => {
  it('writes the stripped bytes, records hash, size and source, and keeps Orientation without the GPS IFD', async () => {
    const b = bus();
    const outcome = okValue(await importOne(b, PHOTO, { caption: 'The ferry', alt: 'A ferry at dawn', source: { kind: 'import', label: 'IMG_0001.jpg' } }));
    const result = outcome.result as { assetId: string; path: string; existing: boolean; stripped: string[] };
    expect(result.existing).toBe(false);
    expect(result.stripped).toContain('location');
    const stored = b.written.get(result.path);
    expect(stored).toBeDefined();
    if (stored === undefined) return;
    expect(jpegHasGps(stored)).toBe(false);
    expect(jpegOrientation(stored)).toBe(6);
    expect(b.state.manifest.assets).toEqual([
      {
        id: result.assetId,
        file: `${result.assetId}.jpg`,
        mime: 'image/jpeg',
        sha256: await sha256Hex(stored),
        bytes: stored.length,
        width: 4032,
        height: 3024,
        caption: 'The ferry',
        alt: 'A ferry at dawn',
        source: { kind: 'import', label: 'IMG_0001.jpg' },
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it('writes one file for the same bytes imported twice, and returns the first id', async () => {
    const b = bus();
    const first = okValue(await importOne(b, PHOTO)).result as { assetId: string };
    const second = okValue(await importOne(b, PHOTO)).result as { assetId: string; existing: boolean };
    expect(second).toMatchObject({ assetId: first.assetId, existing: true });
    expect(b.writes).toBe(1);
    expect(b.state.manifest.assets).toHaveLength(1);
  });

  it('undo takes the record out and leaves the file; the same bytes again re-create the record over that file', async () => {
    const b = bus();
    const first = okValue(await importOne(b, PHOTO)).result as { assetId: string; path: string };
    undoLast(b);
    expect(b.state.manifest.assets).toBeUndefined();
    expect(b.written.has(first.path)).toBe(true);
    const again = okValue(await importOne(b, PHOTO)).result as { assetId: string; existing: boolean };
    expect(again).toMatchObject({ assetId: first.assetId, existing: false });
    expect(b.writes).toBe(1);
    expect(b.state.manifest.assets?.map((record) => record.id)).toEqual([first.assetId]);
  });

  it('refuses SVG and a staged id that is not held, and writes nothing', async () => {
    const b = bus();
    const svg = await importOne(b, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
    expect(!svg.ok && svg.error.code).toBe('invalid-params');
    expect(!svg.ok && svg.error.message).toMatch(/SVG/);
    const gone = await runAsync(b, 'asset.import', { stagingId: 'stg_NOTHELD' });
    expect(!gone.ok && gone.error.code).toBe('not-found');
    expect(b.writes).toBe(0);
    expect(b.state.manifest.assets).toBeUndefined();
  });

  it('is refused as not wired without the asset port', async () => {
    const registry = createProjectCommandRegistry({ clock });
    expect(registry['asset.import'].apply).toBeUndefined();
    expect(registry['asset.importBatch'].apply).toBeUndefined();
    expect(registry['asset.setMeta'].apply).toBeDefined();
  });
});

describe('asset.importBatch — several pictures, one undo group, all or none', () => {
  it('imports each picture once, dedups inside the batch, and one undo takes them all back', async () => {
    const b = bus();
    const items = [PHOTO, png({ width: 300, height: 200 }), PHOTO].map((bytes) => ({ stagingId: b.port.staging.stage(bytes) }));
    const outcome = okValue(await runAsync(b, 'asset.importBatch', { items }));
    const result = outcome.result as { items: { assetId: string; existing: boolean }[] };
    expect(result.items.map((item) => item.existing)).toEqual([false, false, true]);
    expect(result.items[2]?.assetId).toBe(result.items[0]?.assetId);
    expect(b.writes).toBe(2);
    expect(b.state.manifest.assets).toHaveLength(2);
    expect(b.undo.groups()).toHaveLength(1);
    undoLast(b);
    expect(b.state.manifest.assets).toBeUndefined();
  });

  it('writes nothing when one picture is refused', async () => {
    const b = bus();
    const items = [PHOTO, Uint8Array.from([1, 2, 3])].map((bytes) => ({ stagingId: b.port.staging.stage(bytes) }));
    const refused = await runAsync(b, 'asset.importBatch', { items });
    expect(!refused.ok && refused.error.message).toMatch(/picture 2/);
    expect(b.writes).toBe(0);
    expect(b.state.manifest.assets).toBeUndefined();
  });
});

describe('asset.setMeta — caption, alt, decorative, tags, source label', () => {
  async function withPicture(): Promise<{ b: Bus; assetId: string }> {
    const b = bus();
    const { assetId } = okValue(await importOne(b, PHOTO, { source: { kind: 'paste' } })).result as { assetId: string };
    return { b, assetId };
  }

  it('sets the fields, stamps updatedAt, and undo restores the record exactly', async () => {
    const { b, assetId } = await withPicture();
    const before = JSON.stringify(b.state.manifest.assets);
    okValue(
      run(b, 'asset.setMeta', {
        assetId,
        patch: { caption: 'Dawn', alt: 'A ferry', decorative: true, tags: ['sea', 'ferry'], sourceLabel: 'clipboard' },
        expect: { caption: null, alt: null, decorative: null, tags: null, sourceLabel: null },
      }),
    );
    expect(b.state.manifest.assets?.[0]).toMatchObject({ caption: 'Dawn', alt: 'A ferry', decorative: true, tags: ['sea', 'ferry'], source: { kind: 'paste', label: 'clipboard' } });
    expect(b.state.manifest.assets?.[0]?.updatedAt).toBe(NOW.toISOString());
    undoLast(b);
    const after = { ...b.state.manifest.assets?.[0] };
    delete after.updatedAt;
    expect(JSON.stringify([after])).toBe(before);
  });

  it('refuses a stale expect and an unknown picture, changing nothing', async () => {
    const { b, assetId } = await withPicture();
    const stale = run(b, 'asset.setMeta', { assetId, patch: { caption: 'Dawn' }, expect: { caption: 'Dusk' } });
    expect(!stale.ok && stale.error.code).toBe('revision-conflict');
    const missing = run(b, 'asset.setMeta', { assetId: 'a_0000000000', patch: { caption: 'Dawn' }, expect: { caption: null } });
    expect(!missing.ok && missing.error.code).toBe('not-found');
    expect(b.state.manifest.assets?.[0]?.caption).toBeUndefined();
  });

  it('refuses a patch and an expect that name different fields', async () => {
    const { b, assetId } = await withPicture();
    const refused = run(b, 'asset.setMeta', { assetId, patch: { caption: 'Dawn' }, expect: { alt: null } });
    expect(!refused.ok && refused.error.code).toBe('invalid-params');
  });
});

describe('the cover import, re-based on the registry', () => {
  it('records the cover, writes one file for the same cover twice, and its undo still only puts the reference back', async () => {
    const b = bus();
    const first = okValue(await runAsync(b, 'project.importAsset', { stagingId: b.port.staging.stage(PHOTO), target: 'cover' })).result as { assetId: string };
    const second = okValue(await runAsync(b, 'project.importAsset', { stagingId: b.port.staging.stage(PHOTO), target: 'cover' })).result as { assetId: string };
    expect(second.assetId).toBe(first.assetId);
    expect(b.writes).toBe(1);
    expect(b.state.manifest.assets?.map((record) => record.id)).toEqual([first.assetId]);
    undoLast(b);
    expect(b.state.manifest.project.coverAssetId).toBe(first.assetId);
    undoLast(b);
    expect(b.state.manifest.project.coverAssetId).toBeNull();
    expect(b.state.manifest.assets).toHaveLength(1);
  });
});

describe('assets[] in caotang.json (pictures.md §2.1, D4)', () => {
  it('round-trips through the serializer and the load, keeping every field', async () => {
    const b = bus();
    okValue(await importOne(b, PHOTO, { caption: 'Dawn', source: { kind: 'import', label: 'a.jpg' } }));
    const text = serializeManifest(b.state.manifest);
    const report = validateManifest(JSON.parse(text));
    expect(report.errors.filter((error) => error.path.startsWith('assets'))).toEqual([]);
    expect(report.warnings.filter((warning) => warning.path.startsWith('assets'))).toEqual([]);
    const loaded = report.manifest;
    if (loaded === undefined) throw new Error('the manifest did not load');
    expect(loaded.assets).toEqual(b.state.manifest.assets);
    expect(serializeManifest(loaded)).toBe(text);
  });

  it('drops a record that cannot be read, with a warning, and keeps the rest', async () => {
    const b = bus();
    okValue(await importOne(b, PHOTO));
    const raw = JSON.parse(serializeManifest(b.state.manifest)) as Record<string, unknown>;
    (raw['assets'] as unknown[]).push({ id: 'not-an-id' });
    const report = validateManifest(raw);
    expect(report.manifest?.assets).toHaveLength(1);
    expect(report.warnings.some((warning) => warning.path === 'assets[1]')).toBe(true);
  });

  it('writes no assets key for a project without records', () => {
    expect(serializeManifest(project().manifest)).not.toContain('"assets"');
  });
});

describe('the open backfills a record for every used file (pictures.md §6.2)', () => {
  it('gives the cover, a shot, a visual reference and an inline image a record, and leaves unused and missing files alone', async () => {
    const state = project();
    const files = new Map<string, Uint8Array>([
      ['assets/a_C0VER00001.png', png({ width: 600, height: 900 })],
      ['assets/a_SH0T000001.jpg', jpeg({ width: 1920, height: 1080 })],
      ['assets/a_REF0000001.png', png({ width: 10, height: 10 })],
      ['assets/a_1N11NE0001.png', png({ width: 20, height: 20 })],
      ['assets/a_0RPHAN0001.png', png({ width: 30, height: 30 })],
    ]);
    state.manifest.project.coverAssetId = 'a_C0VER00001';
    state.manifest.tree.push({ ...state.manifest.tree[0]!, id: 'n_SHOT000001', parentId: 'manuscript', type: 'shot', title: 'Shot 1', shot: { image: 'a_SH0T000001' } });
    state.manifest.codex = [{ id: 'c_MARA000001', name: 'Mara', aliases: [], type: 'character', description: '', includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], visualRefs: ['a_REF0000001', 'a_M1SS1NG001'], origin: 'manual', sources: [] }];
    const doc = state.documents.get('n_LANDING001');
    if (doc !== undefined) doc.body = 'The ferry.\n\n![The ferry](../assets/a_1N11NE0001.png "Dawn")';
    const added = await backfillAssetRecords(state, { list: () => [...files.keys()], read: (path) => Promise.resolve(files.get(path)) }, { now: () => NOW.getTime() });
    expect(added.map((record) => record.id).sort()).toEqual(['a_1N11NE0001', 'a_C0VER00001', 'a_REF0000001', 'a_SH0T000001']);
    const cover = state.manifest.assets?.find((record) => record.id === 'a_C0VER00001');
    expect(cover).toMatchObject({ file: 'a_C0VER00001.png', mime: 'image/png', width: 600, height: 900, sha256: await sha256Hex(files.get('assets/a_C0VER00001.png')!) });
    // A second open adds nothing.
    expect(await backfillAssetRecords(state, { list: () => [...files.keys()], read: (path) => Promise.resolve(files.get(path)) })).toEqual([]);
  });
});
