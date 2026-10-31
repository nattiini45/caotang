/**
 * `asset.import` and `asset.importBatch` through the shipped bus (pictures.md §2.4, §6.4). The pictures are real PNG containers built here,
 * so the sniff, the header, the metadata strip and the hash all run on what a host would stage.
 *
 * What these pin: the same bytes are one file whoever sends them; a private metadata block does not make two copies different; a write that
 * fails or is cancelled publishes no record and keeps the staged bytes for a retry; a batch is all or nothing; the manifest and the bundle
 * carry the records, and an entry this build cannot read goes through a save unchanged.
 */

import { crc32, deflateSync } from 'node:zlib';
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
  type CommandError,
  type ExecutionOutcome,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import {
  addDocument,
  createAssetStaging,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  exportProjectZip,
  importProjectZip,
  readProject,
  serializeManifest,
  type ProjectAssetPort,
  type ProjectState,
} from '../src/index.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const clock = { now: () => 1_000 };
const LANDING = 'n_7K2QX9M4A1';
const LETTER = 'n_3W8RN2TQ6C';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(enc(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface PngSpec {
  readonly width?: number;
  readonly height?: number;
  /** The text of an XMP packet, as an iTXt chunk, so a copy can differ in metadata alone. */
  readonly xmp?: string;
  /** A different pixel value makes a different picture. */
  readonly sample?: number;
}

/** A gray 8-bit PNG. A size far past what the pixels hold is allowed: only the header is read for the budget. */
function png(spec: PngSpec = {}): Uint8Array {
  const width = spec.width ?? 4;
  const height = spec.height ?? 4;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const rows = new Uint8Array(Math.min(height, 8) * (1 + Math.min(width, 8)));
  rows.fill(spec.sample ?? 0x40);
  return join([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(spec.xmp === undefined ? [] : [chunk('iTXt', join([enc('XML:com.adobe.xmp'), Uint8Array.from([0, 0, 0, 0, 0]), enc(spec.xmp)]))]),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function contains(bytes: Uint8Array, text: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(text));
}

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: LANDING });
  addDocument(state, { parentId: 'manuscript', title: 'The Letter', body: 'Dear Elena.', now: NOW, id: LETTER });
  return state;
}

interface Host {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly staging: ReturnType<typeof createAssetStaging>;
  /** The files the host holds, by project path. */
  readonly files: Map<string, Uint8Array>;
  /** Every write the host was asked for, in order, whether or not it was kept. */
  readonly writes: string[];
  /** Called before each write; throwing makes that write fail. */
  hook: ((path: string, count: number) => void | Promise<void>) | undefined;
}

function host(state: ProjectState = project()): Host {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const staging = createAssetStaging();
  const handle: Host = { state, files, writes, staging, hook: undefined } as unknown as Host;
  const assets: ProjectAssetPort = {
    staging,
    writeBytes: async (path, bytes) => {
      writes.push(path);
      await handle.hook?.(path, writes.length);
      files.set(path, bytes.slice());
    },
    list: async () => ({ authoritative: true, files: [...files.keys()].map((path) => path.slice('assets/'.length)) }),
    readBytes: async (path) => files.get(path),
  };
  const registry = createProjectCommandRegistry({ clock, assets });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => undefined,
  };
  return Object.assign(handle, { undo, bus, registry });
}

let ordinal = 0;
function command(name: CommandName, params: Record<string, unknown>): Command {
  ordinal += 1;
  return { id: `cmd_PICIMPORT${String(ordinal).padStart(3, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
}

function run(h: Host, name: CommandName, params: Record<string, unknown>): Promise<Result<ExecutionOutcome, CommandError>> {
  return executeAsync(command(name, params), h.bus, h.registry);
}

function value(result: Result<ExecutionOutcome, CommandError>): ExecutionOutcome {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function refusal(result: Result<ExecutionOutcome, CommandError>): CommandError {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

interface Imported {
  assetId: string;
  path: string;
  created: boolean;
  linkIds: string[];
}

function importOne(h: Host, bytes: Uint8Array, extra: Record<string, unknown> = {}) {
  return run(h, 'asset.import', { stagingId: h.staging.stage(bytes), ...extra });
}

function undoLast(h: Host): void {
  const last = h.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = h.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

describe('asset.import', () => {
  it('writes an activity row that names the nodes it placed the picture on and says what changed', async () => {
    const h = host();
    value(await importOne(h, png(), { links: [{ kind: 'node', nodeId: LANDING }] }));
    value(await run(h, 'asset.importBatch', { items: [{ stagingId: h.staging.stage(png({ sample: 0x20 })), links: [{ kind: 'node', nodeId: LETTER }] }] }));

    const rows = h.bus.log.entries();
    expect(rows.map((row) => row.command)).toEqual(['asset.import', 'asset.importBatch']);
    expect(rows[0]?.summary).toBe('imported 1 picture');
    expect(rows[0]?.affected.map((entry) => entry.title)).toEqual(['The Landing']);
    expect(rows[1]?.affected.map((entry) => entry.title)).toEqual(['The Letter']);
  });

  it('writes the picture once, records what it is, and places it where it was sent', async () => {
    const h = host();
    const bytes = png({ width: 6, height: 3 });
    const outcome = value(await importOne(h, bytes, { links: [{ kind: 'node', nodeId: LANDING }], caption: 'The jetty', alt: 'A wooden jetty' }));
    const imported = outcome.result as Imported;

    expect(imported.created).toBe(true);
    expect(imported.path).toBe(`assets/${imported.assetId}.png`);
    expect(h.files.get(imported.path)).toBeDefined();
    const [record] = h.state.manifest.assets ?? [];
    expect(record).toMatchObject({
      id: imported.assetId,
      file: `${imported.assetId}.png`,
      mime: 'image/png',
      width: 6,
      height: 3,
      caption: 'The jetty',
      alt: 'A wooden jetty',
      source: { kind: 'import' },
    });
    expect(record?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.bytes).toBe(h.files.get(imported.path)?.length);
    expect(h.state.manifest.assetLinks).toEqual([
      expect.objectContaining({ id: imported.linkIds[0], assetId: imported.assetId, target: { kind: 'node', nodeId: LANDING }, role: 'reference' }),
    ]);
  });

  it('writes one file for the same bytes imported twice, and the second import only places it', async () => {
    const h = host();
    const first = value(await importOne(h, png(), { links: [{ kind: 'node', nodeId: LANDING }] })).result as Imported;
    const second = value(await importOne(h, png(), { links: [{ kind: 'node', nodeId: LETTER }] })).result as Imported;

    expect(second.assetId).toBe(first.assetId);
    expect(second.created).toBe(false);
    expect(h.writes).toEqual([first.path]);
    expect(h.state.manifest.assets).toHaveLength(1);
    expect(h.state.manifest.assetLinks?.map((link) => link.target)).toEqual([
      { kind: 'node', nodeId: LANDING },
      { kind: 'node', nodeId: LETTER },
    ]);
  });

  it('strips a private metadata block before the hash, so two copies that differ only in it are one picture', async () => {
    const h = host();
    const tagged = png({ xmp: '<x:xmpmeta>photographer: SECRET-PERSON</x:xmpmeta>' });
    const first = value(await importOne(h, tagged)).result as Imported;
    const second = value(await importOne(h, png({ xmp: '<x:xmpmeta>photographer: SOMEONE-ELSE</x:xmpmeta>' }))).result as Imported;
    const clean = value(await importOne(h, png())).result as Imported;

    expect(second.assetId).toBe(first.assetId);
    expect(clean.assetId).toBe(first.assetId);
    expect(h.files.size).toBe(1);
    const stored = h.files.get(first.path);
    expect(stored).toBeDefined();
    expect(contains(stored ?? new Uint8Array(), 'SECRET-PERSON')).toBe(false);
    expect(contains(stored ?? new Uint8Array(), 'xmp')).toBe(false);
  });

  it('adopts a file that is in assets/ with no record, instead of writing it a second time', async () => {
    const h = host();
    const first = value(await importOne(h, png())).result as Imported;
    // The record goes (an older manifest, or a hand edit) and the file stays.
    h.state.manifest.assets = [];
    const again = value(await importOne(h, png())).result as Imported;

    expect(again.assetId).toBe(first.assetId);
    expect(h.writes).toEqual([first.path]);
    expect(h.state.manifest.assets?.map((record) => record.id)).toEqual([first.assetId]);
  });

  it('undoes to the project as it was, and leaves the file for the next import to find', async () => {
    const h = host();
    const first = value(await importOne(h, png(), { links: [{ kind: 'node', nodeId: LANDING }] })).result as Imported;
    expect(h.undo.groups()).toHaveLength(1);
    undoLast(h);

    expect(h.state.manifest.assets ?? []).toEqual([]);
    expect(h.state.manifest.assetLinks ?? []).toEqual([]);
    expect(h.files.has(first.path)).toBe(true);

    const again = value(await importOne(h, png())).result as Imported;
    expect(again.assetId).toBe(first.assetId);
    expect(h.writes).toEqual([first.path]);
  });

  it('refuses an unknown staging id, a node that is gone and a file that is not a picture, writing nothing', async () => {
    const h = host();
    expect(refusal(await run(h, 'asset.import', { stagingId: 'stg_NEVERSTAGED' })).code).toBe('not-found');
    expect(refusal(await importOne(h, png(), { links: [{ kind: 'node', nodeId: 'n_ZZZZZZZZZZ' }] })).code).toBe('not-found');
    expect(refusal(await importOne(h, enc('not a picture at all, just words'))).code).toBe('invalid-params');
    expect(h.writes).toEqual([]);
    expect(h.state.manifest.assets ?? []).toEqual([]);
  });

  it('asks once about a large photo and does not write until the writer has chosen', async () => {
    const h = host();
    const photo = png({ width: 6000, height: 5000 });
    const stagingId = h.staging.stage(photo);
    const asked = refusal(await run(h, 'asset.import', { stagingId }));

    expect(asked.details).toMatchObject({ largePhotoPrompt: true });
    expect(h.writes).toEqual([]);

    // The same staged bytes answer the second try: nothing was re-staged.
    const kept = value(await run(h, 'asset.import', { stagingId, largePhotos: 'keep-originals' })).result as Imported;
    expect(h.files.has(kept.path)).toBe(true);
    expect(h.state.manifest.assets?.[0]).toMatchObject({ width: 6000, height: 5000 });
  });

  it('refuses working copies on a host that cannot make them, before it writes', async () => {
    const h = host();
    const refused = refusal(await importOne(h, png({ width: 6000, height: 5000 }), { largePhotos: 'working-copies' }));
    expect(refused.target).toBe('largePhotos');
    expect(h.writes).toEqual([]);
  });
});

describe('asset.import: a write that fails or is cancelled', () => {
  it('keeps the staged bytes when the quota is full, so the retry needs no second choosing of the file', async () => {
    const h = host();
    const stagingId = h.staging.stage(png());
    let full = true;
    h.hook = () => {
      if (!full) return;
      const failure = new Error('The quota has been exceeded.');
      failure.name = 'QuotaExceededError';
      throw failure;
    };

    const refused = refusal(await run(h, 'asset.import', { stagingId, links: [{ kind: 'node', nodeId: LANDING }] }));
    expect(refused.code).toBe('limit-exceeded');
    expect(refused.details).toMatchObject({ quota: true, kept: true });
    expect(h.state.manifest.assets ?? []).toEqual([]);
    expect(h.state.manifest.assetLinks ?? []).toEqual([]);
    expect(h.undo.groups()).toHaveLength(0);

    full = false;
    const retried = value(await run(h, 'asset.import', { stagingId, links: [{ kind: 'node', nodeId: LANDING }] })).result as Imported;
    expect(h.files.has(retried.path)).toBe(true);
    expect(h.state.manifest.assets).toHaveLength(1);
  });

  it('is not published when the writer cancels while the file is being written, and the file is left unnamed', async () => {
    const h = host();
    const stagingId = h.staging.stage(png());
    h.hook = () => {
      h.staging.cancel([stagingId]);
    };

    const refused = refusal(await run(h, 'asset.import', { stagingId, links: [{ kind: 'node', nodeId: LANDING }] }));
    expect(refused.message).toContain('cancelled');
    expect(h.state.manifest.assets ?? []).toEqual([]);
    expect(h.state.manifest.assetLinks ?? []).toEqual([]);
    expect(h.undo.groups()).toHaveLength(0);
  });

  it('is not written at all when the writer cancels before the first file', async () => {
    const h = host();
    const stagingId = h.staging.stage(png());
    h.staging.cancel([stagingId]);
    const refused = refusal(await run(h, 'asset.import', { stagingId }));
    expect(refused.message).toMatch(/cancelled|no longer held/);
    expect(h.writes).toEqual([]);
  });

  it('refuses a staging id that is already being imported', async () => {
    const h = host();
    const stagingId = h.staging.stage(png());
    let second: Promise<Result<ExecutionOutcome, CommandError>> | undefined;
    h.hook = () => {
      second = run(h, 'asset.import', { stagingId });
    };
    const first = await run(h, 'asset.import', { stagingId });
    expect(first.ok).toBe(true);
    const refused = refusal(await (second ?? Promise.reject(new Error('the hook did not run'))));
    expect(refused.code).toBe('not-found');
    expect(h.state.manifest.assets).toHaveLength(1);
  });
});

describe('asset.importBatch', () => {
  it('imports several pictures as one undo group, with each placed where it was sent', async () => {
    const h = host();
    const outcome = value(
      await run(h, 'asset.importBatch', {
        items: [
          { stagingId: h.staging.stage(png({ sample: 0x10 })), links: [{ kind: 'node', nodeId: LANDING }] },
          { stagingId: h.staging.stage(png({ sample: 0x20 })), links: [{ kind: 'node', nodeId: LETTER }] },
          { stagingId: h.staging.stage(png({ sample: 0x10 })) },
        ],
      }),
    );
    const { items } = outcome.result as { items: Imported[] };

    expect(items).toHaveLength(3);
    expect(items[2]?.assetId).toBe(items[0]?.assetId);
    expect(h.files.size).toBe(2);
    expect(h.state.manifest.assets).toHaveLength(2);
    expect(h.state.manifest.assetLinks).toHaveLength(2);
    expect(h.undo.groups()).toHaveLength(1);

    undoLast(h);
    expect(h.state.manifest.assets ?? []).toEqual([]);
    expect(h.state.manifest.assetLinks ?? []).toEqual([]);
  });

  it('publishes no record when a later file fails to write, and the retry reuses the staged bytes and the files already written', async () => {
    const h = host();
    const first = h.staging.stage(png({ sample: 0x10 }));
    const second = h.staging.stage(png({ sample: 0x20 }));
    const items = [
      { stagingId: first, links: [{ kind: 'node', nodeId: LANDING }] },
      { stagingId: second, links: [{ kind: 'node', nodeId: LETTER }] },
    ];
    let broken = true;
    h.hook = (_path, count) => {
      if (broken && count === 2) throw new Error('the disk is full');
    };

    const refused = refusal(await run(h, 'asset.importBatch', { items }));
    expect(refused.message).toContain('the disk is full');
    expect(refused.details).toMatchObject({ kept: true, filesWritten: 1 });
    expect(h.state.manifest.assets ?? []).toEqual([]);
    expect(h.state.manifest.assetLinks ?? []).toEqual([]);
    expect(h.undo.groups()).toHaveLength(0);

    broken = false;
    value(await run(h, 'asset.importBatch', { items }));
    expect(h.state.manifest.assets).toHaveLength(2);
    // The first file was left by the failed try and adopted, not written again; only the second was written afresh.
    expect(h.writes).toHaveLength(3);
    expect(h.writes.filter((path) => path === h.writes[0])).toHaveLength(1);
    expect(h.files.size).toBe(2);
  });

  it('refuses the whole batch for one item that is not a picture, and writes no file for the others', async () => {
    const h = host();
    const refused = refusal(
      await run(h, 'asset.importBatch', {
        items: [{ stagingId: h.staging.stage(png()) }, { stagingId: h.staging.stage(enc('just words')) }],
      }),
    );
    expect(refused.code).toBe('invalid-params');
    expect(refused.message).toContain('picture 2');
    expect(h.writes).toEqual([]);
    expect(h.state.manifest.assets ?? []).toEqual([]);
  });

  it('refuses a batch that names a node that is gone before any file is written', async () => {
    const h = host();
    const refused = refusal(
      await run(h, 'asset.importBatch', {
        items: [{ stagingId: h.staging.stage(png()) }, { stagingId: h.staging.stage(png({ sample: 0x20 })), links: [{ kind: 'node', nodeId: 'n_ZZZZZZZZZZ' }] }],
      }),
    );
    expect(refused.code).toBe('not-found');
    expect(h.writes).toEqual([]);
  });
});

describe('the manifest carries the pictures', () => {
  it('writes assets[] and assetLinks[] and reads them back through a bundle, picture file included', async () => {
    const h = host();
    const imported = value(await importOne(h, png(), { links: [{ kind: 'node', nodeId: LANDING }], caption: 'The jetty' })).result as Imported;

    const exported = await exportProjectZip(h.state, { now: NOW, assets: Object.fromEntries(h.files) });
    expect(exported.entries).toContain(imported.path);
    const unpacked = await importProjectZip(exported.bytes);
    const loaded = await readProject(unpacked.fs);

    expect(loaded.state.manifest.assets).toEqual(h.state.manifest.assets);
    expect(loaded.state.manifest.assetLinks).toEqual(h.state.manifest.assetLinks);
    expect(Array.from(unpacked.assets[imported.path] ?? [])).toEqual(Array.from(h.files.get(imported.path) ?? []));
  });

  it('is byte-identical through a second save, so a project with pictures does not churn', async () => {
    const h = host();
    value(await importOne(h, png(), { links: [{ kind: 'node', nodeId: LANDING }] }));
    const first = serializeManifest(h.state.manifest);
    const unpacked = await importProjectZip((await exportProjectZip(h.state, { now: NOW })).bytes);
    const loaded = await readProject(unpacked.fs);
    expect(serializeManifest(loaded.state.manifest)).toBe(serializeManifest(h.state.manifest));
    expect(serializeManifest(h.state.manifest)).toBe(first);
  });

  it('carries a record and a placement this build cannot read through a save and a reload unchanged', async () => {
    const h = host();
    const imported = value(await importOne(h, png(), { links: [{ kind: 'node', nodeId: LANDING }] })).result as Imported;
    const record = h.state.manifest.assets?.[0];
    if (record === undefined) throw new Error('no record');
    // A newer build's field on a record, a link of a kind this build does not know, and two entries that are not records at all.
    h.state.manifest.assets = [{ ...record, futureField: { keep: ['me'] } }];
    h.state.manifest.assetLinks = [
      ...(h.state.manifest.assetLinks ?? []),
      { id: 'l_9F8G7H6J5K', assetId: imported.assetId, target: { kind: 'timeline', at: 3 }, role: 'poster', order: 20 },
    ];
    h.state.manifest.unreadableAssets = [{ id: 'a_BROKEN0001', file: 42 }];
    h.state.manifest.unreadableAssetLinks = ['not even an object'];

    const unpacked = await importProjectZip((await exportProjectZip(h.state, { now: NOW })).bytes);
    const loaded = await readProject(unpacked.fs);

    expect(loaded.state.manifest.assets?.[0]).toMatchObject({ futureField: { keep: ['me'] } });
    expect(loaded.state.manifest.assetLinks?.map((link) => link.id)).toContain('l_9F8G7H6J5K');
    expect(loaded.state.manifest.unreadableAssets).toEqual([{ id: 'a_BROKEN0001', file: 42 }]);
    expect(loaded.state.manifest.unreadableAssetLinks).toEqual(['not even an object']);
    expect(serializeManifest(loaded.state.manifest)).toBe(serializeManifest(h.state.manifest));
  });
});
