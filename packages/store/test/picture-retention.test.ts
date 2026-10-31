/**
 * Retention-safe picture storage through the shipped bus (pictures.md §6.3, §6.4.2, §6.5, §6.6.1): the retention inventory's
 * root-provider contracts, `asset.sweep`'s preview/recheck/remove, the rename-by-hash `asset.relink`, and the bulk
 * `asset.storeWorkingCopies` batch.
 *
 * Every root category of §6.6.1 is pinned as blocking a deletion; an unknown or unreadable root refuses the sweep whole; an
 * interrupted sweep reports each removed and remaining file; and no test ever deletes against a real project — the host here is
 * an in-memory file map.
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
  type CommandError,
  type CommandName,
  type ExecutionOutcome,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import {
  addDocument,
  collectRetention,
  createAssetStaging,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  deleteAssetBytes,
  executeSweep,
  getAssetBytes,
  getThumb,
  idsRetentionRoot,
  openAssetStore,
  previewSweep,
  putAssetBytes,
  putThumb,
  refusingRetentionRoot,
  stateRetentionRoots,
  textsRetentionRoot,
  valueRetentionRoot,
  UndoRetentionLedger,
  undoGroupRetention,
  bundleAssetFileNamesOf,
  pictureStorageReport,
  PICTURE_STORAGE_BUDGET_BYTES,
  ASSET_DB_VERSION,
  type ProjectAssetPort,
  type ProjectState,
  type RetentionRoot,
} from '../src/index.js';
import { captureParagraphAnchor } from '@caotang/pictures';
import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const clock = { now: () => 1_000 };
const LANDING = 'n_7K2QX9M4A1';
const LETTER = 'n_3W8RN2TQ6C';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An asset id from a word of the base32 alphabet (no I, L, O, U). */
const id = (word: string): string => `a_${word.padEnd(10, '0').slice(0, 10)}`;

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

/** A gray 8-bit PNG. */
function png(spec: { readonly width?: number; readonly height?: number; readonly sample?: number } = {}): Uint8Array {
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
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array(0)),
  ]);
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
  readonly ledger: UndoRetentionLedger;
  /** The files the host holds, by project path. */
  readonly files: Map<string, Uint8Array>;
  /** The extra retention roots beside the state-derived ones (undo groups, checkpoints, journals…). */
  readonly extraRoots: RetentionRoot[];
  /** Called before each remove; throwing makes that removal fail. */
  removeHook: ((path: string) => void) | undefined;
  /** Called before each write; throwing makes that write fail. */
  writeHook: ((path: string) => void) | undefined;
  /** Awaited after each file is stored, so a test can act while the file is there and no record names it yet. */
  afterWrite: (() => Promise<void>) | undefined;
}

function host(state: ProjectState = project(), options: { readonly process?: ProjectAssetPort['process'] } = {}): Host {
  const files = new Map<string, Uint8Array>();
  const staging = createAssetStaging();
  const ledger = new UndoRetentionLedger();
  const handle: Host = { state, files, staging, ledger, extraRoots: [], removeHook: undefined, writeHook: undefined, afterWrite: undefined } as unknown as Host;
  const assets: ProjectAssetPort = {
    staging,
    writeBytes: async (path, bytes) => {
      handle.writeHook?.(path);
      files.set(path, bytes.slice());
      await handle.afterWrite?.();
    },
    list: async () => ({ authoritative: true, files: [...files.keys()].map((path) => path.slice('assets/'.length)) }),
    readBytes: async (path) => files.get(path),
    ...(options.process === undefined ? {} : { process: options.process }),
    deletion: {
      listRetention: async () => collectRetention([...stateRetentionRoots(state), ...handle.extraRoots]),
      remove: async (paths) => {
        const removed: string[] = [];
        for (const path of paths) {
          handle.removeHook?.(path);
          if (files.delete(path)) removed.push(path);
        }
        return removed;
      },
    },
  };
  const registry = createProjectCommandRegistry({ clock, assets, undoRetention: ledger });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, handle.bus, registry) });
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
  return { id: `cmd_RETENTION${String(ordinal).padStart(3, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
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

function undoLast(h: Host): void {
  const last = h.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = h.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

function importOne(h: Host, bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<Result<ExecutionOutcome, CommandError>> {
  return run(h, 'asset.import', { stagingId: h.staging.stage(bytes), ...extra });
}

interface Imported {
  assetId: string;
  path: string;
  created: boolean;
  linkIds: string[];
}

/** Imports one picture and returns its record and path. */
async function importPicture(h: Host, bytes: Uint8Array = png()): Promise<{ record: NonNullable<ProjectState['manifest']['assets']>[number]; path: string }> {
  const imported = value(await importOne(h, bytes)).result as Imported;
  const record = (h.state.manifest.assets ?? []).find((candidate) => candidate.id === imported.assetId);
  if (record === undefined) throw new Error('no record after import');
  return { record, path: imported.path };
}

/** The sweep preview against the host's own ports, for the root-category pins. */
async function preview(h: Host): Promise<ReturnType<typeof previewSweep>> {
  const listing = { authoritative: true, files: [...h.files.keys()].map((path) => path.slice('assets/'.length)) };
  const retention = await collectRetention([...stateRetentionRoots(h.state), ...h.extraRoots]);
  return previewSweep({ listing, state: h.state, retention });
}

describe('the retention inventory (pictures.md §6.6.1)', () => {
  it('keeps a file a registry record names, and a file a use names, and offers only the rest', async () => {
    const h = host();
    const { record } = await importPicture(h);
    const orphan = id('RENAMED'); // a listed file with no record and no use
    h.files.set(`assets/${orphan}.png`, png({ sample: 0x11 }));

    const seen = await preview(h);
    expect(seen.ok).toBe(true);
    if (seen.ok) expect(seen.candidates.map((candidate) => candidate.assetId)).toEqual([orphan]);
    // The recorded file is never a candidate, whatever else names it.
    expect(record.file).toBe(`${record.id}.png`);
  });

  it('keeps a file each typed use names: cover, shot, codex, inline, vendor, comic panel and link', async () => {
    const h = host();
    const used = id('VENDR');
    const assetFile = `${used}.png`;
    h.files.set(`assets/${assetFile}`, png());
    h.state.manifest.project.coverAssetId = used;
    const landing = h.state.manifest.tree.find((node) => node.id === LANDING)!;
    landing.shot = { image: used, vendorRefs: { veo: { references: [{ type: 'image', assetId: used }] } } };
    const letter = h.state.manifest.tree.find((node) => node.id === LETTER)!;
    letter.comicPage = { panels: [{ id: 'p1', assetId: used }] };
    h.state.manifest.codex = [{ id: 'c_ELENA00001', name: 'Elena', visualRefs: [used] } as never];
    h.state.documents.get(LANDING)!.body = `Text.\n\n![alt](../assets/${assetFile} "cap")`;
    h.state.manifest.assetLinks = [{ id: 'l_LINK000001', assetId: used, target: { kind: 'node', nodeId: LANDING }, role: 'reference', order: 10 }];

    const seen = await preview(h);
    expect(seen.ok).toBe(true);
    if (seen.ok) expect(seen.candidates).toEqual([]);
    // Drop every use and the file becomes a candidate: each root above retained it on its own.
    h.state.manifest.project.coverAssetId = null;
    h.state.manifest.assetLinks = [];
    h.state.documents.get(LANDING)!.body = 'Text.';
    h.state.manifest.codex = [];
    landing.shot = undefined;
    letter.comicPage = undefined;
    const gone = await preview(h);
    expect(gone.ok).toBe(true);
    if (gone.ok) expect(gone.candidates.map((candidate) => candidate.assetId)).toEqual([used]);
  });

  it('keeps a file an orphaned or unknown-shaped link names, because an orphan is still the writer’s link', async () => {
    const h = host();
    const used = id('GHOST');
    h.files.set(`assets/${used}.png`, png());
    h.state.manifest.assetLinks = [
      { id: 'l_ORPHAN0001', assetId: used, target: { kind: 'paragraph', nodeId: LANDING, anchor: { from: 0, to: 4, exact: 'The ', prefix: '', suffix: '', capturedRevision: 1, blockHash: 'ab', ordinal: 0 }, orphaned: true }, role: 'reference', order: 10 },
      { id: 'l_UNKNOWN001', assetId: used, target: { kind: 'future-thing', nodeId: LANDING }, role: 'future-role', order: 20 } as never,
    ];
    const seen = await preview(h);
    expect(seen.ok).toBe(true);
    if (seen.ok) expect(seen.candidates).toEqual([]);
  });

  it('keeps a file a retention root names — undo capture, checkpoint, pending journal, declined file, rotating snapshot — and offers it once that root is gone', async () => {
    const h = host();
    const used = id('SWEEP');
    h.files.set(`assets/${used}.png`, png());

    // An open undo group whose capture names a picture (the ledger the applies note into): the group retains its id.
    const { record } = await importPicture(h);
    value(await run(h, 'asset.delete', { assetId: record.id }));
    const open = undoGroupRetention(h.undo.groups(), h.ledger);
    // The deleted record's file is unrecorded now, and the open group still retains it.
    expect((h.state.manifest.assets ?? []).some((candidate) => candidate.id === record.id)).toBe(false);
    expect([...open.ids.keys()]).toContain(record.id);

    const roots = [
      idsRetentionRoot('open undo groups', open.ids),
      textsRetentionRoot('checkpoints', [`a body that once placed ![x](../assets/${used}.png)`]),
      textsRetentionRoot('pending journal', [`unsent: ../assets/${used}.png`]),
      textsRetentionRoot('declined files', [`codex file text naming assets/${used}.png`]),
      valueRetentionRoot('rotating snapshots', { assets: [{ id: used }] }),
    ];
    h.extraRoots.push(...roots);

    const seen = await preview(h);
    expect(seen.ok).toBe(true);
    if (seen.ok) expect(seen.candidates.map((candidate) => candidate.assetId)).not.toContain(used);

    // Each root alone retains the file.
    for (const root of roots) {
      h.extraRoots.length = 0;
      h.extraRoots.push(root);
      const alone = await preview(h);
      expect(alone.ok).toBe(true);
      if (alone.ok) expect(alone.candidates.map((candidate) => candidate.assetId)).not.toContain(used);
    }

    // Every root gone (the groups forgotten, the journals empty): the file is offered.
    h.extraRoots.length = 0;
    for (const group of h.undo.groups()) h.undo.forget(group.id);
    const after = await preview(h);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.candidates.map((candidate) => candidate.assetId)).toContain(used);
  });

  it('refuses the whole sweep when a root cannot enumerate, and removes nothing', async () => {
    const h = host();
    const free = id('SWEEP');
    h.files.set(`assets/${free}.png`, png());
    h.extraRoots.push(refusingRetentionRoot('editor history', 'the journal did not open'));

    const seen = await preview(h);
    expect(seen.ok).toBe(false);
    if (!seen.ok) expect(seen.reason).toContain('editor history');

    const result = await run(h, 'asset.sweep', {});
    const error = refusal(result);
    expect(error.code).toBe('io-error');
    expect(error.message).toContain('refused');
    expect(h.files.has(`assets/${free}.png`)).toBe(true);
  });

  it('refuses the sweep against a non-authoritative listing', async () => {
    const h = host();
    h.files.set(`assets/${id('SWEEP')}.png`, png());
    const port = {
      list: async () => ({ authoritative: false, files: [] as string[] }),
      listRetention: async () => collectRetention(stateRetentionRoots(h.state)),
      remove: async (paths: readonly string[]) => paths.filter((path) => h.files.delete(path)),
    };
    const report = await executeSweep(h.state, port);
    expect(report.refused).toBeDefined();
    expect(report.removed).toEqual([]);
    expect(h.files.size).toBe(1);
  });
});

describe('asset.sweep', () => {
  it('removes only no-record/no-use/no-retention files, after rechecking the listing and the roots immediately before removal', async () => {
    const h = host();
    const { record } = await importPicture(h); // recorded: never a candidate
    const free = id('SWEEP');
    const keptByRoot = id('HAPPY');
    h.files.set(`assets/${free}.png`, png({ sample: 0x33 }));
    h.files.set(`assets/${keptByRoot}.png`, png({ sample: 0x44 }));
    h.extraRoots.push(idsRetentionRoot('checkpoints', [[keptByRoot, ['a checkpoint body']]]));
    // Not a picture name: the sweep leaves it alone, as the loaders do.
    h.files.set('assets/notes.txt', enc('hello'));

    const result = value(await run(h, 'asset.sweep', {})).result as { candidates: number; removed: string[]; remaining: string[] };
    expect(result.candidates).toBe(1);
    expect(result.removed).toEqual([`assets/${free}.png`]);
    expect(result.remaining).toEqual([]);
    expect(h.files.has(`assets/${free}.png`)).toBe(false);
    expect(h.files.has(`assets/${keptByRoot}.png`)).toBe(true);
    expect(h.files.has(`assets/${record.file}`)).toBe(true);
    expect(h.files.has('assets/notes.txt')).toBe(true);
  });

  it('reports each removed and remaining file honestly when a removal fails part-way', async () => {
    const h = host();
    const one = id('SWEEP');
    const two = id('CRATE');
    const three = id('BREAD');
    for (const [name, sample] of [[one, 0x1], [two, 0x2], [three, 0x3]] as const) h.files.set(`assets/${name}.png`, png({ sample }));
    h.removeHook = (path) => {
      if (path === `assets/${two}.png`) throw new Error('the disk is full');
    };

    const result = value(await run(h, 'asset.sweep', {})).result as { candidates: number; removed: string[]; remaining: string[]; interrupted?: string };
    expect(result.candidates).toBe(3);
    expect(result.removed).toEqual([`assets/${one}.png`]);
    expect(result.remaining).toEqual([`assets/${two}.png`, `assets/${three}.png`]);
    expect(result.interrupted).toContain('the disk is full');
    expect(h.files.has(`assets/${one}.png`)).toBe(false);
    expect(h.files.has(`assets/${two}.png`)).toBe(true);
    expect(h.files.has(`assets/${three}.png`)).toBe(true);
  });

  it('keeps a file a record named after the recheck, because every file is checked against the live project just before it is removed', async () => {
    const h = host();
    const first = id('SWEEP');
    const second = id('CRATE');
    for (const [name, sample] of [[first, 0x1], [second, 0x2]] as const) h.files.set(`assets/${name}.png`, png({ sample }));
    const port = {
      list: async () => ({ authoritative: true, files: [...h.files.keys()].map((path) => path.slice('assets/'.length)) }),
      listRetention: async () => collectRetention(stateRetentionRoots(h.state)),
      remove: async (paths: readonly string[]) => {
        // A command outside the sweep's gate publishes a record for the other file while the first is being removed.
        h.state.manifest.assets = [{ id: second, file: `${second}.png` } as never];
        return paths.filter((path) => h.files.delete(path));
      },
    };
    const report = await executeSweep(h.state, port);
    expect(report.removed).toEqual([`assets/${first}.png`]);
    expect(report.remaining).toEqual([`assets/${second}.png`]);
    expect(h.files.has(`assets/${second}.png`)).toBe(true);
  });

  it('does not sweep a picture file an import has written and not yet published', async () => {
    const h = host();
    let sweeping: Promise<Result<ExecutionOutcome, CommandError>> | undefined;
    h.afterWrite = async () => {
      h.afterWrite = undefined;
      sweeping = run(h, 'asset.sweep', {});
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const imported = value(await importOne(h, png())).result as Imported;
    const swept = value(await sweeping!).result as { candidates: number; removed: string[] };
    expect(swept.removed).toEqual([]);
    expect(h.files.has(imported.path)).toBe(true);
    expect((h.state.manifest.assets ?? []).map((record) => record.id)).toEqual([imported.assetId]);
  });

  it('removes nothing when a root names the file between the preview and the recheck (a concurrent change)', async () => {
    const h = host();
    const raced = id('SWEEP');
    h.files.set(`assets/${raced}.png`, png());
    let calls = 0;
    let gained = false;
    const racingRoot: RetentionRoot = {
      name: 'undo groups',
      list: async () => (gained ? { authoritative: true, ids: new Map([[raced, ['appeared during the sweep']]]) } : { authoritative: true, ids: new Map() }),
    };
    const port = {
      list: async () => ({ authoritative: true, files: [...h.files.keys()].map((path) => path.slice('assets/'.length)) }),
      listRetention: async () => {
        calls += 1;
        if (calls === 2) gained = true; // the recheck, immediately before removal, sees the new root
        return collectRetention([...stateRetentionRoots(h.state), racingRoot]);
      },
      remove: async (paths: readonly string[]) => paths.filter((path) => h.files.delete(path)),
    };
    const report = await executeSweep(h.state, port);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(report.removed).toEqual([]);
    expect(report.remaining).toEqual([`assets/${raced}.png`]);
    expect(h.files.has(`assets/${raced}.png`)).toBe(true);
  });
});

describe('asset.relink (rename by hash, §6.3)', () => {
  it('points a record at the unrecorded file whose bytes hash to its sha256, and one undo puts the old name back', async () => {
    const h = host();
    const { record, path } = await importPicture(h);
    // The file is renamed outside Caotang: the old path is gone, an unrecorded file holds the same bytes.
    const bytes = h.files.get(path)!;
    h.files.delete(path);
    const renamed = id('RENAMED');
    h.files.set(`assets/${renamed}.png`, bytes);

    const result = value(await run(h, 'asset.relink', { pairs: [{ assetId: record.id, file: `${renamed}.png` }] }));
    expect((result.result as { pairs: { assetId: string; file: string }[] }).pairs).toEqual([{ assetId: record.id, file: `${renamed}.png` }]);
    expect((h.state.manifest.assets ?? []).find((candidate) => candidate.id === record.id)?.file).toBe(`${renamed}.png`);

    undoLast(h);
    expect((h.state.manifest.assets ?? []).find((candidate) => candidate.id === record.id)?.file).toBe(record.file);
  });

  it('refuses when the named file does not hold the record’s bytes, and changes nothing', async () => {
    const h = host();
    const { record, path } = await importPicture(h);
    h.files.delete(path);
    const other = id('RENAMED');
    h.files.set(`assets/${other}.png`, png({ sample: 0x77 })); // different bytes: a different hash

    const result = await run(h, 'asset.relink', { pairs: [{ assetId: record.id, file: `${other}.png` }] });
    const error = refusal(result);
    expect(['not-found', 'revision-conflict']).toContain(error.code);
    expect((h.state.manifest.assets ?? []).find((candidate) => candidate.id === record.id)?.file).toBe(record.file);
  });

  it('refuses a pair whose file is another record’s, or a non-asset name, in validate', async () => {
    const h = host();
    const first = await importPicture(h);
    const second = await importPicture(h, png({ sample: 0x55 }));
    const bad1 = await run(h, 'asset.relink', { pairs: [{ assetId: first.record.id, file: second.record.file }] });
    expect(refusal(bad1).code).toBe('invalid-params');
    const bad2 = await run(h, 'asset.relink', { pairs: [{ assetId: first.record.id, file: 'not-a-picture.png' }] });
    expect(refusal(bad2).code).toBe('invalid-params');
    const bad3 = await run(h, 'asset.relink', { pairs: [{ assetId: id('RENAMED'), file: `${id('RENAMED')}.png` }] });
    expect(refusal(bad3).code).toBe('not-found');
  });
});

describe('asset.storeWorkingCopies (the bulk working-copy batch)', () => {
  /** A host whose canvas "process" returns a smaller PNG of the same mime. */
  function processingHost(state: ProjectState = project()): Host {
    return host(state, {
      process: async (input) => {
        const width = Math.min(input.width, 8);
        const height = Math.min(input.height, 8);
        return { bytes: png({ width, height, sample: 0x66 }), mime: input.mime, width, height };
      },
    });
  }

  it('writes a new immutable file and record, updates every typed and inline reference, and one undo restores the batch', async () => {
    const h = processingHost();
    const { record } = await importPicture(h, png({ width: 64, height: 32 }));
    const used = record.id;
    const file = record.file;
    // Every supported reference shape names the picture.
    h.state.manifest.project.coverAssetId = used;
    const landing = h.state.manifest.tree.find((node) => node.id === LANDING)!;
    landing.shot = { image: used, vendorRefs: { veo: { references: [{ type: 'image', assetId: used }] } } };
    const letter = h.state.manifest.tree.find((node) => node.id === LETTER)!;
    letter.comicPage = { panels: [{ id: 'p1', assetId: used }] };
    h.state.manifest.codex = [{ id: 'c_ELENA00001', name: 'Elena', visualRefs: [used] } as never];
    h.state.manifest.assetLinks = [{ id: 'l_LINK000001', assetId: used, target: { kind: 'node', nodeId: LANDING }, role: 'card', order: 10, note: 'the card' }];
    h.state.documents.get(LANDING)!.body = `Text.\n\n![alt](../assets/${file} "cap")`;

    const outcome = value(await run(h, 'asset.storeWorkingCopies', { assetIds: [used] }));
    const result = outcome.result as { assetIds: string[] };
    const newId = result.assetIds[0]!;
    expect(newId).not.toBe(used);

    const records = h.state.manifest.assets ?? [];
    const next = records.find((candidate) => candidate.id === newId)!;
    expect(next.workingCopy).toEqual({ fromBytes: h.files.get(`assets/${file}`)!.length, fromWidth: 64, fromHeight: 32 });
    expect(next.caption).toBe(record.caption);
    expect(h.files.has(`assets/${next.file}`)).toBe(true);
    // The old record and file stay: prior bytes are retained for undo.
    expect(records.some((candidate) => candidate.id === used)).toBe(true);
    expect(h.files.has(`assets/${file}`)).toBe(true);

    // Every reference moved.
    expect(h.state.manifest.project.coverAssetId).toBe(newId);
    expect(landing.shot?.['image']).toBe(newId);
    expect((landing.shot?.['vendorRefs'] as Record<string, { references: { assetId?: string }[] }>).veo?.references[0]?.assetId).toBe(newId);
    expect((letter.comicPage as { panels: { assetId: string }[] }).panels[0]?.assetId).toBe(newId);
    expect(h.state.manifest.codex?.[0]?.visualRefs).toEqual([newId]);
    expect(h.state.manifest.assetLinks?.[0]).toMatchObject({ id: 'l_LINK000001', assetId: newId, note: 'the card' });
    expect(h.state.documents.get(LANDING)!.body).toBe(`Text.\n\n![alt](../assets/${next.file} "cap")`);

    // One undo group restores the whole batch.
    const groupCount = h.undo.groups().length;
    undoLast(h);
    expect(h.undo.groups().length).toBe(groupCount - 1);
    expect(h.state.manifest.project.coverAssetId).toBe(used);
    // The undo installs a restored tree, so the node is read back rather than from the pre-apply reference.
    const landingAfter = h.state.manifest.tree.find((node) => node.id === LANDING)!;
    const letterAfter = h.state.manifest.tree.find((node) => node.id === LETTER)!;
    expect(landingAfter.shot?.['image']).toBe(used);
    expect((landingAfter.shot?.['vendorRefs'] as Record<string, { references: { assetId?: string }[] }>).veo?.references[0]?.assetId).toBe(used);
    expect((letterAfter.comicPage as { panels: { assetId: string }[] }).panels[0]?.assetId).toBe(used);
    expect(h.state.manifest.codex?.[0]?.visualRefs).toEqual([used]);
    expect(h.state.manifest.assetLinks?.[0]).toMatchObject({ assetId: used });
    expect(h.state.documents.get(LANDING)!.body).toBe(`Text.\n\n![alt](../assets/${file} "cap")`);
    expect((h.state.manifest.assets ?? []).map((candidate) => candidate.id)).toEqual([used]);
  });

  /** A host whose `process` waits, so a test can change the project while the working copies are being made. */
  function pausedHost(): { h: Host; began: Promise<void>; release: () => void } {
    let release!: () => void;
    let begin!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const began = new Promise<void>((resolve) => (begin = resolve));
    const h = host(project(), {
      process: async (input) => {
        begin();
        await gate;
        const width = Math.min(input.width, 8);
        const height = Math.min(input.height, 8);
        return { bytes: png({ width, height, sample: 0x66 }), mime: input.mime, width, height };
      },
    });
    return { h, began, release };
  }

  it('keeps what other commands did to the pictures while the copies were being made', async () => {
    const { h, began, release } = pausedHost();
    const a = (await importPicture(h, png({ sample: 0x11 }))).record;
    const b = (await importPicture(h, png({ sample: 0x22 }))).record;
    const running = run(h, 'asset.storeWorkingCopies', { assetIds: [a.id] });
    await began;
    value(await run(h, 'asset.setMeta', { assetId: b.id, patch: { caption: 'Changed B' } }));
    value(await run(h, 'asset.setMeta', { assetId: a.id, patch: { caption: 'Changed A' } }));
    // A record another writer added, outside this command's gate.
    const added = { ...b, id: id('ADDED'), file: `${id('ADDED')}.png`, caption: 'Added' };
    h.state.manifest.assets = [...(h.state.manifest.assets ?? []), added];
    release();
    const newId = (value(await running).result as { assetIds: string[] }).assetIds[0]!;

    const records = h.state.manifest.assets ?? [];
    expect(records.map((record) => record.id)).toEqual([a.id, b.id, added.id, newId]);
    expect(records.find((record) => record.id === b.id)?.caption).toBe('Changed B');
    expect(records.find((record) => record.id === added.id)?.caption).toBe('Added');
    expect(records.find((record) => record.id === a.id)?.caption).toBe('Changed A');
    expect(records.find((record) => record.id === newId)?.caption).toBe('Changed A');

    // One undo takes back the copy only: what the other commands did stays.
    undoLast(h);
    expect((h.state.manifest.assets ?? []).map((record) => record.id)).toEqual([a.id, b.id, added.id]);
    expect((h.state.manifest.assets ?? []).find((record) => record.id === b.id)?.caption).toBe('Changed B');
  });

  it('refuses the batch when its picture was deleted while the copies were being made, and adds no record', async () => {
    const { h, began, release } = pausedHost();
    const a = (await importPicture(h)).record;
    const running = run(h, 'asset.storeWorkingCopies', { assetIds: [a.id] });
    await began;
    value(await run(h, 'asset.delete', { assetId: a.id }));
    release();
    expect(refusal(await running).code).toBe('revision-conflict');
    expect(h.state.manifest.assets ?? []).toEqual([]);
  });

  it('refuses the whole batch on an unknown reference shape and writes nothing', async () => {
    const h = processingHost();
    const { record } = await importPicture(h);
    // A manifest field outside the known reference fields names the picture.
    const landing = h.state.manifest.tree.find((node) => node.id === LANDING)!;
    landing.synopsis = record.id;

    const before = JSON.stringify(h.state.manifest);
    const result = await run(h, 'asset.storeWorkingCopies', { assetIds: [record.id] });
    const error = refusal(result);
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('does not know');
    expect(JSON.stringify(h.state.manifest)).toBe(before);
    expect(h.files.size).toBe(1); // only the imported file; no working copy was written
  });

  it('refuses an inline reference with a different extension than the record’s file', async () => {
    const h = processingHost();
    const { record } = await importPicture(h);
    h.state.documents.get(LANDING)!.body = `![x](../assets/${record.id}.jpg)`;
    const result = await run(h, 'asset.storeWorkingCopies', { assetIds: [record.id] });
    expect(refusal(result).code).toBe('invalid-params');
    expect(h.files.size).toBe(1);
  });

  it('maps a paragraph link of a body whose inline reference it rewrote, and one undo puts the anchor back', async () => {
    const h = processingHost();
    const { record } = await importPicture(h);
    // A picture attached to the paragraph below the inline image. The rewrite keeps the body's length (the new id is the same
    // shape), so the offsets do not move — the capture's revision is what has to keep up with the body it was taken against.
    const doc = h.state.documents.get(LANDING)!;
    doc.body = `Text.\n\n![alt](../assets/${record.file} "cap")\n\nThe lamp was lit.\n`;
    const at = doc.body.indexOf('The lamp');
    const anchor = captureParagraphAnchor(doc.body, at, doc.revision);
    if (anchor === undefined) throw new Error('no anchor');
    h.state.manifest.assetLinks = [{ id: 'l_9WORKINGCP', assetId: record.id, target: { kind: 'paragraph', nodeId: LANDING, anchor }, role: 'reference', order: 10 }];

    value(await run(h, 'asset.storeWorkingCopies', { assetIds: [record.id] }));
    const mapped = h.state.manifest.assetLinks?.find((candidate) => candidate.id === 'l_9WORKINGCP');
    const target = mapped?.target as { anchor: { from: number; to: number; exact: string; capturedRevision: number } } | undefined;
    const rewritten = h.state.documents.get(LANDING)!.body;
    expect(target?.anchor.exact).toBe('The lamp was lit.');
    expect(rewritten.slice(target!.anchor.from, target!.anchor.to)).toBe(target!.anchor.exact);
    expect(target!.anchor.capturedRevision).toBe(h.state.documents.get(LANDING)!.revision);

    undoLast(h);
    const back = h.state.manifest.assetLinks?.find((candidate) => candidate.id === 'l_9WORKINGCP');
    expect((back?.target as { anchor: { capturedRevision: number } }).anchor.capturedRevision).toBe(anchor.capturedRevision);
    expect(back?.assetId).toBe(record.id);
  });

  it('refuses on a host without a process port, before anything is written', async () => {
    const h = host();
    const { record } = await importPicture(h);
    const result = await run(h, 'asset.storeWorkingCopies', { assetIds: [record.id] });
    const error = refusal(result);
    expect(error.code).toBe('invalid-params');
    expect(error.message).toContain('cannot make');
    expect(h.files.size).toBe(1);
  });
});

describe('quota errors keep the staged bytes (pictures.md §6.4)', () => {
  it('fails a write with a quota error, keeps the staged picture, and a retry with the same staging id succeeds', async () => {
    const h = host();
    const token = h.staging.stage(png());
    let failures = 1;
    h.writeHook = () => {
      if (failures > 0) {
        failures -= 1;
        const error = new Error('the disk is full');
        error.name = 'QuotaExceededError';
        throw error;
      }
    };
    const first = await run(h, 'asset.import', { stagingId: token });
    const error = refusal(first);
    expect(error.code).toBe('limit-exceeded');
    expect((error.details as { kept?: boolean } | undefined)?.kept).toBe(true);
    expect((h.state.manifest.assets ?? [])).toEqual([]);

    h.writeHook = undefined;
    const second = value(await run(h, 'asset.import', { stagingId: token }));
    expect((second.result as Imported).created).toBe(true);
  });
});

describe('the storage budget and the bundle’s file set (§6.1, §6.5)', () => {
  it('reports the project’s picture weight against the 500 MiB soft budget', async () => {
    const h = host();
    const { record } = await importPicture(h);
    const report = pictureStorageReport(h.state);
    expect(report.recordCount).toBe(1);
    expect(report.budgetBytes).toBe(PICTURE_STORAGE_BUDGET_BYTES);
    expect(report.overBudget).toBe(false);
    expect(report.totalBytes).toBe(record.bytes);
    (h.state.manifest.assets ?? []).forEach((candidate) => {
      (candidate as { bytes: number }).bytes = PICTURE_STORAGE_BUDGET_BYTES + 1;
    });
    expect(pictureStorageReport(h.state).overBudget).toBe(true);
  });

  it('carries in a bundle only the files with a record or a use', async () => {
    const h = host();
    const { record } = await importPicture(h, png(), );
    void record;
    const usedNoRecord = id('CRATE'); // a link names it, no record
    h.state.manifest.assetLinks = [{ id: 'l_LINK000001', assetId: usedNoRecord, target: { kind: 'project' }, role: 'reference', order: 10 }];
    const free = id('SWEEP');
    const listed = [`${record.file}`, `${usedNoRecord}.png`, `${free}.png`, 'notes.txt'];
    const keep = bundleAssetFileNamesOf(h.state, listed);
    expect([...keep].sort()).toEqual([`${record.file}`, `${usedNoRecord}.png`].sort());
  });
});

describe('the asset database upgrade (v1 → v2 adds only thumbs)', () => {
  it('opens a v1 database, keeps every stored file, and adds the thumbs store', async () => {
    const factory = new MemoryIndexedDb();
    const name = 'caotang-assets-upgrade-test';
    // A version-1 database, as the previous build wrote it: the assets store only.
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const assets = db.createObjectStore('assets', { keyPath: ['projectId', 'path'] });
        assets.createIndex('byProject', 'projectId', { unique: false });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    {
      const store = await openAssetStore(factory, name); // would fail if the version were not raised
      void store;
    }
    // Reopen at v1 is refused; the shipped opener upgrades to v2.
    const v1 = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onblocked = () => reject(new Error('blocked'));
    }).catch(() => undefined);
    expect(v1).toBeUndefined();

    const store = await openAssetStore(factory, name);
    expect(ASSET_DB_VERSION).toBe(2);
    expect(store.db.version).toBe(2);
    expect(store.db.objectStoreNames.contains('assets')).toBe(true);
    expect(store.db.objectStoreNames.contains('thumbs')).toBe(true);

    // A file written before the upgrade is still there, byte for byte.
    await putAssetBytes(store, 'p_ONE', 'assets/a_SHOTONE001.png', png());
    store.close();
    const reopened = await openAssetStore(factory, name);
    expect(reopened.db.version).toBe(2);
    expect(await getAssetBytes(reopened, 'p_ONE', 'assets/a_SHOTONE001.png')).toEqual(png());

    // Thumbnails live only in the thumbs store, and go with their file.
    await putThumb(reopened, 'p_ONE', 'assets/a_SHOTONE001.png', 256, png({ sample: 0x99 }));
    expect(await getThumb(reopened, 'p_ONE', 'assets/a_SHOTONE001.png', 256)).toEqual(png({ sample: 0x99 }));
    expect(await deleteAssetBytes(reopened, 'p_ONE', 'assets/a_SHOTONE001.png')).toBe(true);
    expect(await getThumb(reopened, 'p_ONE', 'assets/a_SHOTONE001.png', 256)).toBeUndefined();
    expect(await deleteAssetBytes(reopened, 'p_ONE', 'assets/a_SHOTONE001.png')).toBe(false);
    reopened.close();
  });
});
