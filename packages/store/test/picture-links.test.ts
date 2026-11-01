/**
 * The picture commands that change only the manifest: `asset.setMeta`, `asset.setLinkMeta`, `asset.link`, `asset.unlink`,
 * `asset.reorderLinks` and `asset.delete` (pictures.md §2.4), and the backfill that gives an older project its records.
 *
 * What these pin: every command is one undo group that puts the lists back exactly; a card replaced keeps the old card as a reference and
 * every other placement and note; a delete takes the record and its placements together, is refused while a typed use remains, and one undo
 * restores both in order; a backfill adds records for the images a project uses and nothing else, and a second run adds none.
 */

import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
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
  backfillAssetRecords,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  type ProjectState,
} from '../src/index.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-09T10:00:00.000Z') };
const LANDING = 'n_7K2QX9M4A1';
const LETTER = 'n_3W8RN2TQ6C';
const ONE = 'a_7K2QX9M4A1';
const TWO = 'a_3W8RN2TQ6C';
const THREE = 'a_5T4RW9KZB2';
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function record(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    file: `${id}.png`,
    mime: 'image/png' as const,
    sha256: id.slice(2).toLowerCase().padEnd(64, '0'),
    bytes: 100,
    createdAt: NOW.toISOString(),
    ...extra,
  };
}

function link(id: string, assetId: string, nodeId: string, order: number, extra: Record<string, unknown> = {}) {
  return { id, assetId, target: { kind: 'node' as const, nodeId }, role: 'reference' as const, order, ...extra };
}

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: LANDING });
  addDocument(state, { parentId: 'manuscript', title: 'The Letter', body: 'Dear Elena.', now: NOW, id: LETTER });
  state.manifest.assets = [record(ONE), record(TWO), record(THREE)];
  state.manifest.assetLinks = [
    link('l_1AAAAAAAAA', ONE, LANDING, 10, { note: 'Arrival' }),
    link('l_2AAAAAAAAA', TWO, LANDING, 20),
    link('l_3AAAAAAAAA', ONE, LETTER, 10),
  ];
  return state;
}

interface Host {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
}

function host(state: ProjectState = project()): Host {
  const registry = createProjectCommandRegistry({ clock });
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
  return { state, undo, bus, registry };
}

let ordinal = 0;
function run(h: Host, name: CommandName, params: Record<string, unknown>): Result<ExecutionOutcome, CommandError> {
  ordinal += 1;
  const command: Command = { id: `cmd_PICLINKS${String(ordinal).padStart(3, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
  return execute(command, h.bus, h.registry);
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

const snapshotOf = (state: ProjectState) => JSON.parse(JSON.stringify({ assets: state.manifest.assets, assetLinks: state.manifest.assetLinks })) as unknown;

describe('asset.setMeta and asset.setLinkMeta', () => {
  it('changes the caption, alt, tags and source label, stamps the record, and one undo puts it back', () => {
    const h = host();
    const before = snapshotOf(h.state);
    value(run(h, 'asset.setMeta', { assetId: ONE, patch: { caption: 'The jetty', alt: 'A wooden jetty', decorative: true, tags: ['sea'], sourceLabel: 'Grandfather' } }));

    expect(h.state.manifest.assets?.[0]).toMatchObject({ caption: 'The jetty', alt: 'A wooden jetty', decorative: true, tags: ['sea'], source: { kind: 'import', label: 'Grandfather' }, updatedAt: '2026-10-09T10:00:00.000Z' });
    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('clears a field with null, and refuses a change that is based on a value the record no longer holds', () => {
    const h = host();
    value(run(h, 'asset.setMeta', { assetId: ONE, patch: { caption: 'First' } }));
    value(run(h, 'asset.setMeta', { assetId: ONE, patch: { caption: null }, expect: { caption: 'First' } }));
    expect(h.state.manifest.assets?.[0]).not.toHaveProperty('caption');

    const stale = refusal(run(h, 'asset.setMeta', { assetId: ONE, patch: { caption: 'Second' }, expect: { caption: 'First' } }));
    expect(stale.code).toBe('revision-conflict');
    expect(refusal(run(h, 'asset.setMeta', { assetId: 'a_ZZZZZZZZZZ', patch: { caption: 'x' } })).code).toBe('not-found');
  });

  it('keeps a link note apart from the record: a note is the placement’s, and clears with null', () => {
    const h = host();
    expect(refusal(run(h, 'asset.setMeta', { assetId: ONE, patch: { note: 'x' } })).code).toBe('invalid-params');
    value(run(h, 'asset.setLinkMeta', { linkId: 'l_2AAAAAAAAA', patch: { note: 'Chapter opener' } }));
    expect(h.state.manifest.assetLinks?.find((entry) => entry.id === 'l_2AAAAAAAAA')?.note).toBe('Chapter opener');
    value(run(h, 'asset.setLinkMeta', { linkId: 'l_1AAAAAAAAA', patch: { note: null }, expect: { note: 'Arrival' } }));
    expect(h.state.manifest.assetLinks?.find((entry) => entry.id === 'l_1AAAAAAAAA')).not.toHaveProperty('note');
    expect(h.state.manifest.assets?.[0]).not.toHaveProperty('note');
  });
});

describe('asset.link, asset.unlink and asset.reorderLinks', () => {
  it('places a picture at the end of a node’s pictures, and refuses to place it twice', () => {
    const h = host();
    const placed = value(run(h, 'asset.link', { assetId: THREE, target: { kind: 'node', nodeId: LANDING }, note: 'Mood' })).result as { linkId: string };
    const links = h.state.manifest.assetLinks?.filter((entry) => (entry.target as { nodeId?: string }).nodeId === LANDING) ?? [];
    expect(links.map((entry) => entry.id)).toEqual(['l_1AAAAAAAAA', 'l_2AAAAAAAAA', placed.linkId]);
    expect(links.at(-1)).toMatchObject({ assetId: THREE, role: 'reference', note: 'Mood' });
    expect(links.at(-1)?.order).toBeGreaterThan(links.at(-2)?.order ?? 0);

    expect(refusal(run(h, 'asset.link', { assetId: THREE, target: { kind: 'node', nodeId: LANDING } })).code).toBe('invalid-params');
  });

  it('turns the old card into a reference when a new card is placed, and keeps every other placement and note', () => {
    const h = host();
    const onLetter = (): { id: string; assetId: string; role: string }[] =>
      (h.state.manifest.assetLinks ?? []).filter((entry) => (entry.target as { nodeId?: string }).nodeId === LETTER);
    const firstCard = value(run(h, 'asset.link', { assetId: TWO, target: { kind: 'node', nodeId: LETTER }, role: 'card' })).result as { linkId: string };
    const secondCard = value(run(h, 'asset.link', { assetId: THREE, target: { kind: 'node', nodeId: LETTER }, role: 'card' })).result as { linkId: string };

    expect(onLetter().filter((entry) => entry.role === 'card').map((entry) => entry.id)).toEqual([secondCard.linkId]);
    expect(onLetter().find((entry) => entry.id === firstCard.linkId)?.role).toBe('reference');
    expect(onLetter().map((entry) => entry.assetId).sort()).toEqual([ONE, TWO, THREE].sort());
    // The landing's own placements and notes were not touched.
    expect(h.state.manifest.assetLinks?.find((entry) => entry.id === 'l_1AAAAAAAAA')).toMatchObject({ note: 'Arrival', role: 'reference' });

    undoLast(h);
    expect(onLetter().filter((entry) => entry.role === 'card').map((entry) => entry.id)).toEqual([firstCard.linkId]);
    expect(onLetter().map((entry) => entry.assetId).sort()).toEqual([ONE, TWO].sort());
  });
  it('removes a placement and keeps the picture and its other placements, and one undo puts it back in place', () => {
    const h = host();
    const before = snapshotOf(h.state);
    value(run(h, 'asset.unlink', { linkId: 'l_1AAAAAAAAA' }));
    expect(h.state.manifest.assetLinks?.map((entry) => entry.id)).toEqual(['l_2AAAAAAAAA', 'l_3AAAAAAAAA']);
    expect(h.state.manifest.assets).toHaveLength(3);
    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
    expect(refusal(run(h, 'asset.unlink', { linkId: 'l_ZZZZZZZZZZ' })).code).toBe('not-found');
  });

  it('re-targets an orphaned placement with its note, timeline pin and unknown fields, and one undo restores the whole move', () => {
    const h = host();
    h.state.manifest.assetLinks = [link('l_ORPHAN0001', ONE, LANDING, 10, {
      target: { kind: 'paragraph', nodeId: LANDING, anchor: { from: 0, to: 4, exact: 'The ', prefix: '', suffix: 'ferry', capturedRevision: 0, blockHash: 'ab12cd34ef567890', ordinal: 0 }, orphaned: true },
      note: 'Keep this',
      when: { dayOffset: 3 },
      futureField: { kept: true },
    })];
    const before = snapshotOf(h.state);
    value(run(h, 'asset.makeDocumentLevel', { linkId: 'l_ORPHAN0001' }));
    expect(h.undo.groups()).toHaveLength(1);
    expect(h.state.manifest.assetLinks).toHaveLength(1);
    expect(h.state.manifest.assetLinks?.[0]).toMatchObject({
      id: 'l_ORPHAN0001',
      assetId: ONE,
      target: { kind: 'node', nodeId: LANDING },
      note: 'Keep this',
      when: { dayOffset: 3 },
      futureField: { kept: true },
    });
    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('refuses to make a placement document-level while its paragraph is intact', () => {
    const h = host();
    expect(refusal(run(h, 'asset.makeDocumentLevel', { linkId: 'l_1AAAAAAAAA' })).code).toBe('invalid-params');
    expect(h.undo.groups()).toHaveLength(0);
  });

  it('merges an orphaned placement into an existing document-level one as one undoable command', () => {
    const h = host();
    h.state.manifest.assetLinks?.push(link('l_ORPHAN0001', ONE, LANDING, 30, {
      target: { kind: 'paragraph', nodeId: LANDING, anchor: { from: 0, to: 4, exact: 'The ', prefix: '', suffix: 'ferry', capturedRevision: 0, blockHash: 'ab12cd34ef567890', ordinal: 0 }, orphaned: true },
      when: { dayOffset: 3 },
    }));
    const before = snapshotOf(h.state);
    value(run(h, 'asset.makeDocumentLevel', { linkId: 'l_ORPHAN0001' }));
    expect(h.undo.groups()).toHaveLength(1);
    expect(h.state.manifest.assetLinks?.some((entry) => entry.id === 'l_ORPHAN0001')).toBe(false);
    expect(h.state.manifest.assetLinks?.find((entry) => entry.id === 'l_1AAAAAAAAA')).toMatchObject({ note: 'Arrival', when: { dayOffset: 3 } });
    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('puts a target’s pictures in the order given, refuses a list that is not all of them, and one undo restores the order', () => {
    const h = host();
    const before = snapshotOf(h.state);
    value(run(h, 'asset.reorderLinks', { target: { kind: 'node', nodeId: LANDING }, orderedIds: ['l_2AAAAAAAAA', 'l_1AAAAAAAAA'] }));
    const onLanding = (h.state.manifest.assetLinks ?? []).filter((entry) => (entry.target as { nodeId?: string }).nodeId === LANDING).sort((a, b) => a.order - b.order);
    expect(onLanding.map((entry) => entry.id)).toEqual(['l_2AAAAAAAAA', 'l_1AAAAAAAAA']);

    expect(refusal(run(h, 'asset.reorderLinks', { target: { kind: 'node', nodeId: LANDING }, orderedIds: ['l_2AAAAAAAAA'] })).code).toBe('invalid-params');
    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('undoes only what it changed when something else has changed the list since', () => {
    const h = host();
    value(run(h, 'asset.unlink', { linkId: 'l_1AAAAAAAAA' }));
    const first = h.undo.groups().at(-1);
    value(run(h, 'asset.setLinkMeta', { linkId: 'l_2AAAAAAAAA', patch: { note: 'Later note' } }));
    if (first === undefined) throw new Error('no group');
    const undone = h.undo.undo(first.id);
    expect(undone.ok).toBe(true);
    const byId = new Map((h.state.manifest.assetLinks ?? []).map((entry) => [entry.id, entry]));
    expect(byId.has('l_1AAAAAAAAA')).toBe(true);
    expect(byId.get('l_2AAAAAAAAA')?.note).toBe('Later note');
  });
});

describe('asset.delete', () => {
  it('removes the record and every placement of it, and one undo brings them back in their places', () => {
    const h = host();
    const before = snapshotOf(h.state);
    const outcome = value(run(h, 'asset.delete', { assetId: ONE }));

    expect((outcome.result as { removedLinks: number }).removedLinks).toBe(2);
    expect(h.state.manifest.assets?.map((entry) => entry.id)).toEqual([TWO, THREE]);
    expect(h.state.manifest.assetLinks?.map((entry) => entry.id)).toEqual(['l_2AAAAAAAAA']);
    expect(h.undo.groups()).toHaveLength(1);

    undoLast(h);
    expect(snapshotOf(h.state)).toEqual(before);
  });

  it('is refused while a typed use remains, and lists the uses', () => {
    const h = host();
    h.state.manifest.project.coverAssetId = ONE;
    const refused = refusal(run(h, 'asset.delete', { assetId: ONE }));
    expect(refused.code).toBe('invalid-params');
    expect(refused.message).toContain(ONE);
    expect(refused.details).toHaveProperty('uses');
    expect(h.state.manifest.assets).toHaveLength(3);

    h.state.manifest.project.coverAssetId = null;
    value(run(h, 'asset.delete', { assetId: ONE }));
  });

  it('is refused while a document shows the picture inline', () => {
    const h = host();
    const document = h.state.documents.get(LANDING);
    if (document === undefined) throw new Error('no document');
    document.body = `The ferry was late.\n\n![the jetty](../assets/${TWO}.png)\n`;
    const refused = refusal(run(h, 'asset.delete', { assetId: TWO }));
    expect(refused.message).toContain('The Landing');
    expect(h.state.manifest.assets).toHaveLength(3);
  });
});

describe('the backfill of an older project', () => {
  /** A project from before the registry: the cover, a shot image and an inline picture are used, and none has a record. */
  function older() {
    const state = project();
    state.manifest.assets = [];
    state.manifest.assetLinks = [];
    state.manifest.project.coverAssetId = ONE;
    const document = state.documents.get(LANDING);
    if (document === undefined) throw new Error('no document');
    document.body = `The ferry was late.\n\n![the jetty](../assets/${TWO}.png)\n`;
    const files = new Map<string, Uint8Array>([
      [`assets/${ONE}.png`, png(0x10)],
      [`assets/${TWO}.png`, png(0x20)],
      [`assets/${THREE}.png`, png(0x30)],
    ]);
    const port = {
      list: async () => ({ authoritative: true, files: [...files.keys()].map((path) => path.slice('assets/'.length)) }),
      readBytes: async (path: string) => files.get(path),
    };
    return { state, port, files };
  }

  it('records the files the project uses, hashing what is stored, and leaves a file nothing uses alone', async () => {
    const { state, port } = older();
    const result = await backfillAssetRecords(state, port, NOW);

    expect([...result.created].sort()).toEqual([ONE, TWO].sort());
    expect(state.manifest.assets?.map((entry) => entry.id).sort()).toEqual([ONE, TWO].sort());
    for (const entry of state.manifest.assets ?? []) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.mime).toBe('image/png');
      expect(entry).not.toHaveProperty('source');
    }
  });

  it('does nothing the second time, and does not touch a record that is already there', async () => {
    const { state, port } = older();
    await backfillAssetRecords(state, port, NOW);
    const first = state.manifest.assets;
    const again = await backfillAssetRecords(state, port, NOW);

    expect(again.created).toEqual([]);
    expect(state.manifest.assets).toBe(first);
  });

  it('makes no record for a use whose file is absent from a complete listing, and says so', async () => {
    const { state, port, files } = older();
    files.delete(`assets/${TWO}.png`);
    const result = await backfillAssetRecords(state, port, NOW);

    expect(result.created).toEqual([ONE]);
    expect(result.missingFiles).toEqual([TWO]);
  });

  it('makes no record from a listing that is not complete, and reads nothing it was not asked about', async () => {
    const { state, files } = older();
    const read: string[] = [];
    const result = await backfillAssetRecords(
      state,
      { list: async () => ({ authoritative: false, files: [...files.keys()].map((path) => path.slice('assets/'.length)) }), readBytes: async (path) => (read.push(path), files.get(path)) },
      NOW,
    );
    expect(result.missingFiles).toEqual([]);
    expect(read).not.toContain(`assets/${THREE}.png`);
  });
});

function png(sample: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(enc(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 4);
  view.setUint32(4, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(new Uint8Array(20).fill(sample))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
