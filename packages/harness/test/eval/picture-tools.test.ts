/**
 * The agent's picture tools (pictures.md §8.1), driven directly beneath their registry rows: each test runs the tool the way
 * the runtime does (params checked against the spec, `prepare`, then every prepared command through the shipped bus under the
 * grant the tool gives it), against the store's real command registry and a real in-memory project. Nothing is mocked but the
 * host: the file store, the model route and the resizer.
 *
 * Pinned here: the reads' shapes and bounds; that an image part exists only for a vision model and only on a user message; the view
 * rule on a host that can resize and on one that cannot; a batch that is checked whole and undone whole; a quote that fits two
 * paragraphs is refused rather than guessed; an unknown or used staging id is refused; and a placement that goes stale between the card
 * and the write changes nothing.
 */

import { crc32, deflateSync } from 'node:zlib';

import {
  COMMAND_REGISTRY,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  executeAsync,
  toJsonSchema,
  type BusContext,
  type Command,
  type CommandError,
  type CommandName,
  type ExecutionOutcome,
  type PermissionContext,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  imagePartsOf,
  validatePart,
  type ChatMessage,
  type Gateway,
  type ImagePart,
} from '@caotang/gateway';
import { createMockProvider, type MockProvider } from '@caotang/gateway/mock';
import {
  addDocument,
  createAssetStaging,
  createProjectCommandRegistry,
  getBody,
  getRevision,
  type ProjectAssetPort,
  type ProjectState,
} from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { complete } from '../../src/agent/drafting.js';
import { estimateTokens } from '../../src/tokens.js';
import {
  PICTURE_ACCEPT_EDITS_TOOLS,
  PICTURE_DEFINITIONS,
  PICTURE_TOOL_METADATA,
  PICTURE_TOOL_NAMES,
  createPictureOutbox,
  importPort,
  pictureViewMessage,
  picturePorts,
  viewPort,
  type PictureToolName,
  type PictureViewHost,
  type ViewedPicture,
} from '../../src/tools/pictures.js';
import type { CallParams, PortContext, ToolValue } from '../../src/types.js';
import { checkParams } from '../../src/validate.js';
import { LANDING, STORM, clock, makeState } from '../fixtures.js';

const HARBOUR = 'n_HARBOUR001';
const HARBOUR_BODY = 'The lamp swung in the wind.\n\nA gull cried over the quay.\n\nThe lamp swung again.';
const enc = (value: string): Uint8Array => new TextEncoder().encode(value);

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

/** A gray PNG. Only the header names the size, so a large picture costs a few bytes; `sample` makes a different picture. */
function png(width = 4, height = 4, sample = 0x40): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const rows = new Uint8Array(Math.min(height, 8) * (1 + Math.min(width, 8))).fill(sample);
  return join([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

let sequence = 0;
const next = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${sequence}`;
};

interface World {
  readonly state: ProjectState;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly undo: UndoStore;
  readonly staging: ReturnType<typeof createAssetStaging>;
  readonly files: Map<string, Uint8Array>;
  readonly reads: string[];
  readonly bus: (permission?: PermissionContext) => BusContext<ProjectState>;
}

function world(): World {
  const state = makeState();
  addDocument(state, { parentId: 'manuscript', title: 'The Harbour', body: HARBOUR_BODY, now: new Date('2026-10-08T09:00:00.000Z'), id: HARBOUR });
  const files = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const staging = createAssetStaging();
  const assets: ProjectAssetPort = {
    staging,
    writeBytes: async (path, bytes) => {
      files.set(path, bytes.slice());
    },
    list: async () => ({ authoritative: true, files: [...files.keys()].map((path) => path.slice('assets/'.length)) }),
    readBytes: async (path) => {
      reads.push(path);
      return files.get(path);
    },
  };
  const registry = createProjectCommandRegistry({ clock, assets });
  const log = createActivityLog();
  const idempotency = createIdempotencyCache();
  const view = createViewState();
  // eslint-disable-next-line prefer-const
  let undo: UndoStore;
  const bus = (permission?: PermissionContext): BusContext<ProjectState> => ({
    state,
    view,
    read: () => state,
    ...(permission === undefined ? {} : { permission }),
    undo,
    log,
    idempotency,
    notify: () => undefined,
  });
  undo = createUndoStore({ dispatch: (command) => execute(command, bus(), registry) });
  return { state, registry, undo, staging, files, reads, bus };
}

function command(name: CommandName, params: CallParams, turnId: string, callId: string): Command {
  return { id: next('cmd'), name, params, issuedBy: 'agent', turnId, callId, createdAt: 1_000 };
}

const CONFIRMED: PermissionContext = { confirmed: true };

/**
 * One native tool call as the runtime makes it: the closed-set check, the tool's own refusal rule, `prepare`, then each prepared
 * command through the bus under the grant it carries (`inherit`), then `finish`.
 */
function runNative(w: World, name: PictureToolName, input: unknown, permission?: PermissionContext, turnId: string = next('turn')): Result<ToolValue, CommandError> {
  const definition = PICTURE_DEFINITIONS[name];
  if (definition.kind !== 'native') throw new Error(`${name} is a port`);
  const checked = checkParams(name, definition.params, input);
  if (!checked.ok) return checked;
  const refused = definition.refine?.(checked.value);
  if (refused !== undefined) return { ok: false, error: refused };
  const prepared = definition.prepare(checked.value, { state: w.state, registry: w.registry, clock: clock.now });
  if (!prepared.ok) return prepared;
  const callId = next('call');
  const done: { name: CommandName; outcome: ExecutionOutcome }[] = [];
  for (const [index, step] of prepared.value.commands.entries()) {
    const params = typeof step.params === 'function' ? step.params(done) : step.params;
    const granted: PermissionContext = { ...(permission ?? {}), ...(step.inherit === undefined ? {} : { inheritedGrant: step.inherit }) };
    const result = execute(command(step.name, params, turnId, `${callId}:${index}`), w.bus(granted), w.registry);
    if (!result.ok) return result;
    done.push({ name: step.name, outcome: result.value });
  }
  return prepared.value.finish(done);
}

function portContext(w: World, permission?: PermissionContext, turnId: string = next('turn')): PortContext {
  const callId = next('call');
  let attempts = 0;
  const id = (): string => `${callId}:${(attempts += 1)}`;
  const granted = (inherit?: 'write-confirm'): PermissionContext => ({ ...(permission ?? {}), ...(inherit === undefined ? {} : { inheritedGrant: inherit }) });
  return {
    state: w.state,
    turnId,
    dispatch: (name, params) => execute(command(name, params, turnId, id()), w.bus(granted()), w.registry),
    dispatchInherited: (name, params) => execute(command(name, params, turnId, id()), w.bus(granted('write-confirm')), w.registry),
    dispatchAsync: (name, params) => executeAsync(command(name, params, turnId, id()), w.bus(granted()), w.registry),
    recordEffect: () => undefined,
    logRow: () => undefined,
  };
}

function good<T>(result: Result<T, CommandError>): T {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function refused<T>(result: Result<T, CommandError>): CommandError {
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

interface Imported {
  readonly assetId: string;
  readonly placements: readonly string[];
}

async function importPicture(w: World, bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<Imported> {
  const result = await importPort({ stagingId: w.staging.stage(bytes), ...extra }, portContext(w, CONFIRMED));
  const value = good(result);
  return { assetId: String(value.data['assetId']), placements: value.data['placements'] as readonly string[] };
}

const bodyOf = (w: World, id: string): string => getBody(w.state, id);

describe('the picture tools and the registry', () => {
  it('names seven tools, each with a metadata row, a definition and a schema', () => {
    expect([...PICTURE_TOOL_NAMES]).toEqual(['pictures.list', 'pictures.view', 'pictures.annotate', 'pictures.attach', 'pictures.import', 'pictures.place', 'pictures.transcribe']);
    expect(PICTURE_TOOL_METADATA.map((row) => row.name)).toEqual([...PICTURE_TOOL_NAMES]);
    expect(Object.keys(PICTURE_DEFINITIONS)).toEqual([...PICTURE_TOOL_NAMES]);
    for (const name of PICTURE_TOOL_NAMES) {
      const schema = toJsonSchema(PICTURE_DEFINITIONS[name].params);
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
    }
  });

  it('takes each tool’s risk and undo from the command it maps onto', () => {
    const row = (name: PictureToolName) => PICTURE_TOOL_METADATA.find((candidate) => candidate.name === name)!;
    const risk = (command: CommandName) => COMMAND_REGISTRY[command].descriptor.agentRisk;
    expect(row('pictures.list').risk).toBe('read');
    expect(row('pictures.view').risk).toBe('read');
    expect(row('pictures.annotate').risk).toBe(risk('asset.setMeta'));
    expect(risk('asset.setLinkMeta')).toBe('write-auto');
    expect(row('pictures.attach').risk).toBe(risk('asset.link'));
    expect(risk('asset.unlink')).toBe('write-auto');
    expect(row('pictures.import').risk).toBe(risk('asset.import'));
    // The place tool is a confirm card over a primitive no model can name.
    expect(row('pictures.place').risk).toBe('write-confirm');
    expect(row('pictures.transcribe').risk).toBe(risk('asset.transcribe'));
    expect(risk('editor.insert')).toBe('never');
    for (const name of PICTURE_TOOL_NAMES) {
      const meta = row(name);
      expect(meta.undoable).toBe(meta.risk !== 'read');
      expect(meta.load).toBe('deferred');
      if (meta.risk === 'write-confirm') expect(meta.description.endsWith('Requires user confirmation.')).toBe(true);
    }
  });

  it('joins ACCEPT_EDITS_TOOLS with the two write-auto rows and no others', () => {
    const auto = PICTURE_TOOL_METADATA.filter((meta) => meta.risk === 'write-auto').map((meta) => meta.name);
    expect(auto).toEqual(['pictures.annotate', 'pictures.attach']);
    expect([...PICTURE_ACCEPT_EDITS_TOOLS]).toEqual(auto);
  });

  it('wires import as an async port and view only where a host says how to read and show a picture', () => {
    expect(Object.keys(picturePorts()).sort()).toEqual(['pictures.import']);
    const host: PictureViewHost = { vision: () => false, readBytes: async () => undefined, deliver: () => undefined };
    expect(Object.keys(picturePorts(host)).sort()).toEqual(['pictures.import', 'pictures.view']);
    expect(PICTURE_DEFINITIONS['pictures.view']).toMatchObject({ kind: 'port', port: 'pictures.view' });
    expect(PICTURE_DEFINITIONS['pictures.import']).toMatchObject({ kind: 'port', port: 'pictures.import' });
  });
});

describe('pictures.list', () => {
  it('lists records, placements and uses as text, narrowed by target or tag', async () => {
    const w = world();
    const a = await importPicture(w, png(4, 4, 1), { caption: 'The jetty', alt: 'A wooden jetty', links: [{ kind: 'node', doc: 'The Landing' }, { kind: 'project' }] });
    const b = await importPicture(w, png(4, 4, 2), { caption: 'The lamp', links: [{ kind: 'paragraph', doc: 'The Harbour', anchor: 'gull cried' }] });
    good(runNative(w, 'pictures.annotate', { items: [{ id: b.assetId, tags: ['lamp', 'night'] }] }));
    // An inline picture in a body is a use, not a placement.
    good(runNative(w, 'pictures.place', { assetId: a.assetId, doc: 'The Landing', anchor: 'The ferry was late' }, CONFIRMED));

    const all = good(runNative(w, 'pictures.list', {}));
    expect(all.affected).toEqual([]);
    expect(all.data['total']).toBe(2);
    const pictures = all.data['pictures'] as Record<string, unknown>[];
    expect(pictures.map((entry) => entry['id'])).toEqual([a.assetId, b.assetId]);
    expect(pictures[0]).toMatchObject({
      caption: 'The jetty',
      alt: 'A wooden jetty',
      mime: 'image/png',
      // Links of different targets share an order, so their sequence is by id and not a fact to assert.
      links: expect.arrayContaining([
        expect.objectContaining({ role: 'reference', target: { kind: 'node', doc: { id: LANDING, title: 'The Landing' } } }),
        expect.objectContaining({ role: 'reference', target: { kind: 'project' } }),
      ]),
      uses: ['an inline picture in "The Landing"'],
    });
    expect(pictures[1]).toMatchObject({ tags: ['lamp', 'night'], links: [{ target: { kind: 'paragraph', doc: { title: 'The Harbour' }, quote: expect.stringContaining('A gull cried') } }] });
    // Text only: nothing that names a file, a hash or bytes.
    expect(JSON.stringify(all.data)).not.toMatch(/sha256|"file"|assets\/a_/);

    const byNode = good(runNative(w, 'pictures.list', { target: 'The Harbour' }));
    expect((byNode.data['pictures'] as { id: string }[]).map((entry) => entry.id)).toEqual([b.assetId]);
    const landing = good(runNative(w, 'pictures.list', { target: LANDING }));
    expect((landing.data['pictures'] as { id: string }[]).map((entry) => entry.id)).toEqual([a.assetId]);
    const project = good(runNative(w, 'pictures.list', { target: 'project' }));
    expect((project.data['pictures'] as { id: string }[]).map((entry) => entry.id)).toEqual([a.assetId]);
    const byTag = good(runNative(w, 'pictures.list', { tag: 'NIGHT' }));
    expect((byTag.data['pictures'] as { id: string }[]).map((entry) => entry.id)).toEqual([b.assetId]);
    expect(refused(runNative(w, 'pictures.list', { target: 'No Such Place' })).code).toBe('not-found');
  });

  it('is bounded: it counts what it leaves out and stays inside its cap', () => {
    const w = world();
    w.state.manifest.assets = Array.from({ length: 120 }, (_, index) => ({
      id: `a_${String(index).padStart(10, '0')}`,
      file: `a_${String(index).padStart(10, '0')}.png`,
      mime: 'image/png' as const,
      sha256: 'a'.repeat(64),
      bytes: 100,
      caption: 'x'.repeat(1500),
      createdAt: '2026-10-08T09:00:00.000Z',
    }));
    const cap = PICTURE_TOOL_METADATA.find((meta) => meta.name === 'pictures.list')!.response_token_cap;
    const listed = good(runNative(w, 'pictures.list', { limit: 100 }));
    expect(listed.data['total']).toBe(120);
    expect(listed.data['omitted']).toBeGreaterThan(0);
    expect((listed.data['pictures'] as unknown[]).length + Number(listed.data['omitted'])).toBe(120);
    expect(estimateTokens(JSON.stringify(listed))).toBeLessThanOrEqual(cap);
    expect(listed.notes?.[0]).toContain('narrow the list');
    expect(refused(runNative(w, 'pictures.list', { limit: 101 })).code).toBe('invalid-params');
  });
});

describe('pictures.annotate', () => {
  it('sets and clears fields on pictures and placements, and one Undo reverses the batch', async () => {
    const w = world();
    const a = await importPicture(w, png(4, 4, 1), { caption: 'Old caption', links: [{ kind: 'node', doc: 'The Landing' }] });
    const b = await importPicture(w, png(4, 4, 2), { alt: 'Old alt' });
    const before = JSON.stringify([w.state.manifest.assets, w.state.manifest.assetLinks]);

    const turn = 'turn-annotate';
    const outcome = good(
      runNative(
        w,
        'pictures.annotate',
        {
          items: [
            { id: a.assetId, caption: 'The jetty at dusk', alt: 'A wooden jetty at dusk', tags: ['jetty', 'dusk'] },
            { id: b.assetId, alt: '', decorative: true },
            { id: a.placements[0], note: 'Opens the chapter' },
          ],
        },
        undefined,
        turn,
      ),
    );
    expect(outcome.data['changed']).toEqual([
      { id: a.assetId, kind: 'picture', fields: ['caption', 'alt', 'tags'] },
      { id: b.assetId, kind: 'picture', fields: ['alt', 'decorative'] },
      { id: a.placements[0], kind: 'placement', fields: ['note'] },
    ]);
    const [first, second] = w.state.manifest.assets ?? [];
    expect(first).toMatchObject({ caption: 'The jetty at dusk', alt: 'A wooden jetty at dusk', tags: ['jetty', 'dusk'] });
    expect(second).toMatchObject({ decorative: true });
    expect(second?.alt).toBeUndefined();
    expect(w.state.manifest.assetLinks?.[0]?.note).toBe('Opens the chapter');

    // One group, one Undo: the records and the placement are as they were.
    const groups = w.undo.groups().filter((group) => group.turnId === turn);
    expect(groups).toHaveLength(1);
    expect(outcome.undoGroupId).toBe(groups[0]?.id);
    const undone = w.undo.undo(groups[0]!.id);
    expect(undone.ok).toBe(true);
    expect(JSON.stringify([w.state.manifest.assets, w.state.manifest.assetLinks])).toBe(before);
  });

  it('takes at most 50 items', async () => {
    const w = world();
    const a = await importPicture(w, png());
    const items = Array.from({ length: 51 }, () => ({ id: a.assetId, caption: 'x' }));
    const error = refused(runNative(w, 'pictures.annotate', { items }));
    expect(error.code).toBe('limit-exceeded');
    expect(error.message).toMatch(/50/);
    const fifty = Array.from({ length: 50 }, (_, index) => ({ id: a.assetId, caption: `c${index}` }));
    // Fifty entries pass the limit; the same id fifty times is refused for what it is.
    expect(refused(runNative(w, 'pictures.annotate', { items: fifty })).code).toBe('invalid-params');
  });

  it('checks the whole batch first: one bad item writes nothing and the refusal names it', async () => {
    const w = world();
    const a = await importPicture(w, png(4, 4, 1), { caption: 'Keep', links: [{ kind: 'node', doc: 'The Landing' }] });
    const before = JSON.stringify([w.state.manifest.assets, w.state.manifest.assetLinks]);
    const groups = w.undo.groups().length;

    const error = refused(
      runNative(w, 'pictures.annotate', {
        items: [
          { id: a.assetId, caption: 'Changed' },
          { id: 'a_ZZZZZZZZZZ', caption: 'No such picture' },
          { id: a.assetId, alt: 'Repeats the first id' },
          { id: a.assetId, note: 'A note belongs to a placement' },
          { id: 'x_nonsense', caption: 'Neither kind of id' },
        ],
      }),
    );
    expect(error.code).toBe('invalid-params');
    const failures = (error.details as { failures: { target: string }[] }).failures;
    expect(failures.map((failure) => failure.target)).toEqual(['items[1]', 'items[2]', 'items[3]', 'items[4]']);
    expect(JSON.stringify([w.state.manifest.assets, w.state.manifest.assetLinks])).toBe(before);
    expect(w.undo.groups()).toHaveLength(groups);
  });
});

describe('pictures.attach', () => {
  it('places a picture on a node and on a paragraph named by a quote, and removes a placement', async () => {
    const w = world();
    const a = await importPicture(w, png(4, 4, 1));

    const turn = 'turn-attach';
    const placed = good(
      runNative(
        w,
        'pictures.attach',
        {
          attach: [
            { assetId: a.assetId, to: { kind: 'node', doc: 'The Landing' }, note: 'Cover the landing' },
            { assetId: a.assetId, to: { kind: 'paragraph', doc: 'The Harbour', anchor: 'A gull cried' }, role: 'reference' },
          ],
        },
        undefined,
        turn,
      ),
    );
    expect(placed.data['removed']).toBe(0);
    const links = w.state.manifest.assetLinks ?? [];
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ assetId: a.assetId, target: { kind: 'node', nodeId: LANDING }, note: 'Cover the landing' });
    const paragraph = links[1]?.target as { kind: string; nodeId: string; anchor: { exact: string; ordinal: number; capturedRevision: number; blockHash: string } };
    expect(paragraph).toMatchObject({ kind: 'paragraph', nodeId: HARBOUR });
    // Resolved at plan time to the anchor the store keeps: the paragraph's own text, its place, and the revision it was read at.
    expect(paragraph.anchor.exact).toBe('A gull cried over the quay.');
    expect(paragraph.anchor.ordinal).toBe(1);
    expect(paragraph.anchor.capturedRevision).toBe(getRevision(w.state, HARBOUR));
    expect(paragraph.anchor.blockHash).toMatch(/^[0-9a-f]{16}$/);
    expect((placed.data['placed'] as { linkId: string }[]).map((entry) => entry.linkId)).toEqual(links.map((link) => link.id));

    const removed = good(runNative(w, 'pictures.attach', { detach: [links[0]!.id] }));
    expect(removed.data).toMatchObject({ placed: [], removed: 1 });
    expect(w.state.manifest.assetLinks).toHaveLength(1);

    // The attach group alone is undone: the two placements it made go, and the removal stays.
    const group = w.undo.groups().find((candidate) => candidate.turnId === turn)!;
    expect(w.undo.undo(group.id).ok).toBe(true);
  });

  it('refuses a quote that fits two paragraphs, and writes nothing', async () => {
    const w = world();
    const a = await importPicture(w, png());
    const before = JSON.stringify(w.state.manifest.assetLinks ?? []);
    const error = refused(runNative(w, 'pictures.attach', { attach: [{ assetId: a.assetId, to: { kind: 'paragraph', doc: 'The Harbour', anchor: 'The lamp swung' } }] }));
    expect(error.code).toBe('invalid-params');
    const failure = (error.details as unknown as { failures: { message: string; details: { candidates: { paragraph: number }[] } }[] }).failures[0]!;
    expect(failure.message).toContain('fits 2 paragraphs');
    expect(failure.message).toContain('It was not guessed');
    expect(failure.details.candidates.map((candidate) => candidate.paragraph)).toEqual([1, 3]);
    expect(JSON.stringify(w.state.manifest.assetLinks ?? [])).toBe(before);

    // The whole of one paragraph is a quote that fits only it, though another paragraph begins the same way.
    good(runNative(w, 'pictures.attach', { attach: [{ assetId: a.assetId, to: { kind: 'paragraph', doc: 'The Harbour', anchor: 'The lamp swung in the wind.' } }] }));
    const target = w.state.manifest.assetLinks?.[0]?.target as { anchor: { ordinal: number } };
    expect(target.anchor.ordinal).toBe(0);
    expect(refused(runNative(w, 'pictures.attach', { attach: [{ assetId: a.assetId, to: { kind: 'paragraph', doc: 'The Harbour', anchor: 'a quote the document never says' } }] })).details).toBeDefined();
  });

  it('checks a batch against the placements the batch itself makes', async () => {
    const w = world();
    const a = await importPicture(w, png());
    const twice = { assetId: a.assetId, to: { kind: 'node', doc: 'The Storm' } };
    const error = refused(runNative(w, 'pictures.attach', { attach: [twice, twice] }));
    expect(error.code).toBe('invalid-params');
    expect((error.details as { failures: { target: string }[] }).failures.map((failure) => failure.target)).toEqual(['attach[1]']);
    expect(w.state.manifest.assetLinks ?? []).toEqual([]);
    expect(refused(runNative(w, 'pictures.attach', {})).message).toContain('nothing to do');
  });
});

describe('pictures.import', () => {
  it('saves a staged picture with its caption and placements, as one confirmed import', async () => {
    const w = world();
    const imported = await importPicture(w, png(6, 3), { caption: 'The jetty', alt: 'A wooden jetty', links: [{ kind: 'node', doc: 'The Storm' }], source: { kind: 'mcp', label: 'Sketch', server: 'draw', tool: 'sketch' } });
    expect(w.files.get(`assets/${imported.assetId}.png`)).toBeDefined();
    expect(w.state.manifest.assets?.[0]).toMatchObject({ id: imported.assetId, caption: 'The jetty', alt: 'A wooden jetty', width: 6, height: 3, source: { kind: 'mcp', server: 'draw', tool: 'sketch' } });
    expect(w.state.manifest.assetLinks?.[0]).toMatchObject({ id: imported.placements[0], target: { kind: 'node', nodeId: STORM } });
  });

  it('cannot stage bytes: the params have no place for them', () => {
    const definition = PICTURE_DEFINITIONS['pictures.import'];
    for (const key of ['bytes', 'data', 'base64', 'url', 'path']) {
      const error = refused(checkParams('pictures.import', definition.params, { stagingId: 's_1', [key]: 'AAAA' }));
      expect(error.code).toBe('invalid-params');
      expect(error.message).toContain(key);
    }
  });

  it('refuses an unknown staging id and one that was already used, and writes nothing', async () => {
    const w = world();
    const unknown = refused(await importPort({ stagingId: 's_neverstaged' }, portContext(w, CONFIRMED)));
    expect(unknown.code).toBe('not-found');
    expect(w.files.size).toBe(0);

    const stagingId = w.staging.stage(png());
    good(await importPort({ stagingId }, portContext(w, CONFIRMED)));
    const filesAfter = w.files.size;
    const used = refused(await importPort({ stagingId }, portContext(w, CONFIRMED)));
    expect(used.code).toBe('not-found');
    expect(w.files.size).toBe(filesAfter);
    expect(w.state.manifest.assets).toHaveLength(1);
  });

  it('is refused without the writer’s confirmation, and a placement it cannot resolve writes nothing', async () => {
    const w = world();
    const stagingId = w.staging.stage(png());
    expect(refused(await importPort({ stagingId }, portContext(w))).code).toBe('permission-denied');
    expect(w.files.size).toBe(0);
    const ambiguous = refused(await importPort({ stagingId, links: [{ kind: 'paragraph', doc: 'The Harbour', anchor: 'The lamp swung' }] }, portContext(w, CONFIRMED)));
    expect(ambiguous.code).toBe('invalid-params');
    expect(w.files.size).toBe(0);
    // The staged bytes were not spent by a refusal made before the import began.
    expect(good(await importPort({ stagingId }, portContext(w, CONFIRMED))).data['created']).toBe(true);
  });
});

describe('pictures.place', () => {
  it('shows a ghost, inserts the inline image beside the quoted paragraph, and one Undo restores the body', async () => {
    const w = world();
    const a = await importPicture(w, png(), { caption: 'A gull', alt: 'A gull over the quay' });
    const before = bodyOf(w, HARBOUR);
    const input = { assetId: a.assetId, doc: 'The Harbour', anchor: 'gull cried', position: 'after' };

    const definition = PICTURE_DEFINITIONS['pictures.place'];
    if (definition.kind !== 'native') throw new Error('place is native');
    const prepared = good(definition.prepare(good(checkParams('pictures.place', definition.params, input)), { state: w.state, registry: w.registry, clock: clock.now }));
    expect(prepared.preview).toMatchObject({
      doc: { id: HARBOUR, title: 'The Harbour' },
      picture: { id: a.assetId, caption: 'A gull', alt: 'A gull over the quay' },
      ghost: { kind: 'inline-image', position: 'after', paragraph: 'A gull cried over the quay.', neighbour: 'The lamp swung again.' },
    });
    // A card is a preview only: preparing wrote nothing, and the command it will dispatch carries the tool's own grant.
    expect(bodyOf(w, HARBOUR)).toBe(before);
    expect(prepared.commands).toHaveLength(1);
    expect(prepared.commands[0]).toMatchObject({ name: 'editor.insert', inherit: 'write-confirm' });

    const turn = 'turn-place';
    const placed = good(runNative(w, 'pictures.place', input, CONFIRMED, turn));
    const markdown = `![A gull over the quay](../assets/${a.assetId}.png "A gull")`;
    expect(bodyOf(w, HARBOUR)).toBe(HARBOUR_BODY.replace('A gull cried over the quay.', `A gull cried over the quay.\n\n${markdown}`));
    expect(placed.data['inserted']).toBe(markdown);
    expect(placed.affected.map((node) => node.title)).toEqual(['The Harbour']);

    // The body snapshot is in the same group as the insert, so the one Undo is exact.
    const group = w.undo.groups().filter((candidate) => candidate.turnId === turn);
    expect(group).toHaveLength(1);
    expect(placed.undoGroupId).toBe(group[0]?.id);
    expect(w.undo.undo(group[0]!.id).ok).toBe(true);
    expect(bodyOf(w, HARBOUR)).toBe(before);
  });

  it('puts the image before a paragraph on request', async () => {
    const w = world();
    const a = await importPicture(w, png());
    good(runNative(w, 'pictures.place', { assetId: a.assetId, doc: 'The Harbour', anchor: 'The lamp swung in the wind.', position: 'before', size: 'half' }, CONFIRMED));
    expect(bodyOf(w, HARBOUR).startsWith(`![](../assets/${a.assetId}.png "[caotang-image v1;size=half]")\n\nThe lamp swung in the wind.`)).toBe(true);
  });

  it('is not a way to reach editor.insert: without the tool’s grant the bus refuses the primitive', async () => {
    const w = world();
    const direct = execute(command('editor.insert', { docId: HARBOUR, offset: 0, text: 'x' }, 'turn-direct', 'call-direct'), w.bus(CONFIRMED), w.registry);
    expect(refused(direct).code).toBe('permission-denied');
    expect(bodyOf(w, HARBOUR)).toBe(HARBOUR_BODY);
    expect(PICTURE_TOOL_NAMES.some((name) => name.includes('insert'))).toBe(false);
  });

  it('refuses a quote that fits two paragraphs, a document that moved on, and a document with no inline pictures', async () => {
    const w = world();
    const a = await importPicture(w, png());
    const base = { assetId: a.assetId, doc: 'The Harbour' };

    const ambiguous = refused(runNative(w, 'pictures.place', { ...base, anchor: 'The lamp swung' }, CONFIRMED));
    expect(ambiguous.message).toContain('fits 2 paragraphs');
    expect(ambiguous.correctiveHint).toContain('quote more');

    const revision = getRevision(w.state, HARBOUR);
    const stale = refused(runNative(w, 'pictures.place', { ...base, anchor: 'gull', revision: revision + 1 }, CONFIRMED));
    expect(stale.code).toBe('revision-conflict');
    expect(bodyOf(w, HARBOUR)).toBe(HARBOUR_BODY);

    const storm = w.state.manifest.tree.find((node) => node.id === STORM)!;
    storm.kind = 'screenplay';
    expect(refused(runNative(w, 'pictures.place', { assetId: a.assetId, doc: 'The Storm', anchor: 'Rain' }, CONFIRMED)).message).toContain('no inline pictures');
    expect(refused(runNative(w, 'pictures.place', { assetId: 'a_ZZZZZZZZZZ', doc: 'The Harbour', anchor: 'gull' }, CONFIRMED)).code).toBe('not-found');
    expect(refused(runNative(w, 'pictures.place', { assetId: a.assetId, doc: 'The Friend', anchor: 'anything' }, CONFIRMED)).code).toBe('not-found');
  });

  it('refuses at the write, with nothing changed, when the document moves between the card and the apply', async () => {
    const w = world();
    const a = await importPicture(w, png());
    const definition = PICTURE_DEFINITIONS['pictures.place'];
    if (definition.kind !== 'native') throw new Error('place is native');
    const prepared = good(definition.prepare(good(checkParams('pictures.place', definition.params, { assetId: a.assetId, doc: 'The Harbour', anchor: 'gull cried' })), { state: w.state, registry: w.registry, clock: clock.now }));

    // The writer edits the paragraph while the card is open.
    good(execute(command('doc.write', { docId: HARBOUR, body: HARBOUR_BODY.replace('gull cried', 'gull wheeled') }, 'turn-writer', 'call-writer'), w.bus(CONFIRMED), w.registry));
    const edited = bodyOf(w, HARBOUR);

    const step = prepared.commands[0]!;
    const result = execute(command(step.name, step.params as CallParams, 'turn-stale', 'call-stale'), w.bus({ ...CONFIRMED, inheritedGrant: step.inherit! }), w.registry);
    expect(refused(result).code).toBe('revision-conflict');
    expect(bodyOf(w, HARBOUR)).toBe(edited);
    expect(w.undo.groups().filter((group) => group.turnId === 'turn-stale')).toEqual([]);
  });
});

describe('pictures.view', () => {
  interface Setup {
    readonly w: World;
    readonly outbox: ReturnType<typeof createPictureOutbox>;
    readonly resized: { from: ViewedPicture; to: number }[];
  }

  function host(w: World, options: { vision: boolean; resize?: boolean; limits?: { maxImageBytes: number; maxTotalBytes: number; maxImages: number } }): { host: PictureViewHost; setup: Setup } {
    const outbox = createPictureOutbox();
    const resized: { from: ViewedPicture; to: number }[] = [];
    const picked: PictureViewHost = {
      vision: () => options.vision,
      readBytes: async (path) => {
        w.reads.push(path);
        return w.files.get(path);
      },
      deliver: outbox.deliver,
      ...(options.limits === undefined ? {} : { limits: () => options.limits! }),
      ...(options.resize === true
        ? {
            resize: async (picture: ViewedPicture, longEdge: number): Promise<ViewedPicture> => {
              resized.push({ from: picture, to: longEdge });
              const ratio = longEdge / Math.max(picture.width, picture.height);
              const width = Math.round(picture.width * ratio);
              const height = Math.round(picture.height * ratio);
              return { bytes: png(width, height, 9), mime: 'image/png', width, height };
            },
          }
        : {}),
    };
    return { host: picked, setup: { w, outbox, resized } };
  }

  async function view(w: World, picked: PictureViewHost, params: CallParams) {
    return viewPort(picked)(params, portContext(w, undefined, 'turn-view'));
  }

  it('sends image parts to a vision model, as stored when the picture is within the limit', async () => {
    const w = world();
    const small = png(900, 600, 3);
    const a = await importPicture(w, small, { caption: 'The harbour chart', alt: 'A chart' });
    const { host: picked, setup } = host(w, { vision: true });

    const result = good(await view(w, picked, { assetIds: [a.assetId] }));
    expect(result.data['images']).toEqual([{ id: a.assetId, width: 900, height: 600, bytes: small.length, sent: 'as stored' }]);
    expect(result.summary).toContain('as stored');
    expect(JSON.stringify(result)).not.toMatch(/downscaled|shrunk/);
    const parts = setup.outbox.take('turn-view');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'image', mime: 'image/png', size: small.length, caption: 'The harbour chart' });
    expect(Buffer.from(parts[0]!.bytes).equals(Buffer.from(small))).toBe(true);
    expect(setup.outbox.take('turn-view')).toEqual([]);
  });

  it('downscales to 1568 px on a host that can resize, and says so', async () => {
    const w = world();
    const big = await importPicture(w, png(3200, 2400, 4));
    const { host: picked, setup } = host(w, { vision: true, resize: true });
    const result = good(await view(w, picked, { assetIds: [big.assetId] }));
    expect(setup.resized.map((call) => call.to)).toEqual([1568]);
    expect(result.data['images']).toEqual([expect.objectContaining({ id: big.assetId, width: 1568, height: 1176, sent: 'downscaled from 3200 × 2400 to 1568 × 1176 px' })]);
    expect(setup.outbox.take('turn-view')).toHaveLength(1);

    const smaller = good(await view(w, picked, { assetIds: [big.assetId], maxPx: 512 }));
    expect(smaller.data['images']).toEqual([expect.objectContaining({ width: 512, height: 384 })]);
  });

  it('on a host that cannot resize, sends stored bytes only when they are already within the limit, and otherwise refuses without claiming a shrink', async () => {
    const w = world();
    const big = await importPicture(w, png(3200, 2400, 4));
    const small = await importPicture(w, png(1000, 800, 5));
    const { host: picked, setup } = host(w, { vision: true });

    const tooWide = refused(await view(w, picked, { assetIds: [big.assetId] }));
    expect(tooWide.code).toBe('limit-exceeded');
    expect(tooWide.message).toContain('3200 × 2400 px');
    expect(tooWide.message).toContain('3200 px');
    expect(tooWide.message).toContain('cannot shrink');
    expect(tooWide.correctiveHint).toMatch(/working copy|import a copy/);
    expect(tooWide.message).not.toMatch(/downscaled|resized/);

    // The refusal is for the whole call: a good picture beside the bad one is not sent either.
    expect(refused(await view(w, picked, { assetIds: [small.assetId, big.assetId] })).code).toBe('limit-exceeded');
    expect(setup.outbox.take('turn-view')).toEqual([]);

    // maxPx lowers the bar, and the host still does not shrink.
    expect(refused(await view(w, picked, { assetIds: [small.assetId], maxPx: 800 })).message).toContain('1000 × 800 px');
    good(await view(w, picked, { assetIds: [small.assetId] }));
    expect(setup.outbox.take('turn-view')).toHaveLength(1);
  });

  it('refuses a picture whose stored bytes are over the transport limit, naming its size', async () => {
    const w = world();
    const a = await importPicture(w, png(500, 500, 6));
    const bytes = w.files.get(`assets/${a.assetId}.png`)!.length;
    const { host: picked, setup } = host(w, { vision: true, limits: { maxImageBytes: bytes - 1, maxTotalBytes: 10_000_000, maxImages: 20 } });
    const error = refused(await view(w, picked, { assetIds: [a.assetId] }));
    expect(error.code).toBe('limit-exceeded');
    expect(error.message).toContain(`${bytes} bytes`);
    expect(error.message).toContain('as stored');
    expect(setup.outbox.take('turn-view')).toEqual([]);

    const together = host(w, { vision: true, limits: { maxImageBytes: bytes, maxTotalBytes: bytes + 1, maxImages: 20 } });
    const b = await importPicture(w, png(500, 500, 7));
    expect(refused(await view(w, together.host, { assetIds: [a.assetId, b.assetId] })).message).toContain('together');
  });

  it('gives a model with no vision the caption, alt text and transcription as text, with a note, and reads no bytes', async () => {
    const w = world();
    const a = await importPicture(w, png(), { caption: 'The harbour chart', alt: 'A chart of the harbour' });
    const bare = await importPicture(w, png(4, 4, 8));
    w.state.manifest.assets![0]!.transcription = { text: 'Low tide at six.', at: '2026-10-08T09:00:00.000Z' };
    const { host: picked, setup } = host(w, { vision: false });
    w.reads.length = 0;

    const result = good(await view(w, picked, { assetIds: [a.assetId, bare.assetId] }));
    expect(result.data['images']).toBe('none: text only');
    expect(result.data['pictures']).toEqual([
      { id: a.assetId, caption: 'The harbour chart', alt: 'A chart of the harbour', transcription: 'Low tide at six.' },
      { id: bare.assetId },
    ]);
    expect(result.notes?.[0]).toContain('does not accept images');
    expect(result.notes?.[1]).toContain(`${bare.assetId} has no caption, alt text or transcription`);
    expect(w.reads).toEqual([]);
    expect(setup.outbox.take('turn-view')).toEqual([]);
  });

  it('takes one to four pictures that exist', async () => {
    const w = world();
    const a = await importPicture(w, png());
    const definition = PICTURE_DEFINITIONS['pictures.view'];
    expect(refused(checkParams('pictures.view', definition.params, { assetIds: [] })).code).toBe('invalid-params');
    const five = ['a_0000000001', 'a_0000000002', 'a_0000000003', 'a_0000000004', 'a_0000000005'];
    expect(refused(checkParams('pictures.view', definition.params, { assetIds: five })).code).toBe('limit-exceeded');
    expect(refused(checkParams('pictures.view', definition.params, { assetIds: [a.assetId], maxPx: 2000 })).message).toContain('1568');
    const { host: picked } = host(w, { vision: true });
    expect(refused(await view(w, picked, { assetIds: ['a_ZZZZZZZZZZ'] })).code).toBe('not-found');
  });

  it('refuses a damaged record or file instead of sending it', async () => {
    const w = world();
    const a = await importPicture(w, png());
    const { host: picked } = host(w, { vision: true });
    w.files.set(`assets/${a.assetId}.png`, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    expect(refused(await view(w, picked, { assetIds: [a.assetId] })).message).toContain('not the image/png');
    w.files.delete(`assets/${a.assetId}.png`);
    expect(refused(await view(w, picked, { assetIds: [a.assetId] })).code).toBe('not-found');
    w.state.manifest.assets![0]!.file = '../caotang.json';
    expect(refused(await view(w, picked, { assetIds: [a.assetId] })).message).toContain('names the file "../caotang.json"');
  });
});

describe('images reach the model only on a user message, and only a vision model takes them', () => {
  const REPLY = 'A chart of the harbour.';

  async function gateway(mock: MockProvider): Promise<Gateway> {
    const keys = createKeyStore(createMemoryVaultPort());
    const profiles = createProfileStore({ keys });
    await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
    return createGateway({ profiles, keys, clock: createManualClock(0), mock });
  }

  const seesImage = {
    match: (request: { messages: readonly ChatMessage[] }) => request.messages.some((message) => imagePartsOf(message.content).length > 0),
    respond: () => ({ content: REPLY }),
  };

  it('puts a view’s images in a user message after the tool result; an image on a tool message is refused by the gateway', async () => {
    const w = world();
    const a = await importPicture(w, png(900, 600, 3), { caption: 'The harbour chart' });
    const outbox = createPictureOutbox();
    const picked: PictureViewHost = { vision: () => true, readBytes: async (path) => w.files.get(path), deliver: outbox.deliver };
    const result = good(await viewPort(picked)({ assetIds: [a.assetId] }, portContext(w, undefined, 'turn-vision')));
    const images = outbox.take('turn-vision');
    const message = pictureViewMessage(images);

    expect(message.role).toBe('user');
    for (const part of message.content as readonly ImagePart[]) expect(validatePart(part, 'user')).toBeUndefined();
    expect(validatePart(images[0]!, 'tool')).toEqual(expect.stringContaining('user'));

    const mock = createMockProvider({ capsVision: true, scripts: [seesImage] });
    const sent: ChatMessage[] = [
      { role: 'system', content: 'You are reading a project.' },
      { role: 'user', content: 'What does the chart show?' },
      { role: 'tool', toolCallId: 'call_1', content: JSON.stringify({ ok: true, data: result.data }) },
      message,
    ];
    const reply = await complete({ gateway: await gateway(mock), turnId: 'turn-vision' }, sent, 'text');
    expect(reply.text).toBe(REPLY);
    const seen = mock.calls[0]?.messages ?? [];
    expect(seen.filter((entry) => imagePartsOf(entry.content).length > 0).map((entry) => entry.role)).toEqual(['user']);
    expect(JSON.stringify(seen.find((entry) => entry.role === 'tool'))).not.toContain('"bytes"');
  });

  it('a model with no vision is told in text and is sent no image, so its call is never refused', async () => {
    const w = world();
    const a = await importPicture(w, png(900, 600, 3), { caption: 'The harbour chart', alt: 'A chart' });
    const outbox = createPictureOutbox();
    const mock = createMockProvider({ scripts: [{ match: () => true, respond: () => ({ content: REPLY }) }] });
    const picked: PictureViewHost = { vision: () => false, readBytes: async (path) => w.files.get(path), deliver: outbox.deliver };
    const result = good(await viewPort(picked)({ assetIds: [a.assetId] }, portContext(w, undefined, 'turn-text')));
    expect(outbox.take('turn-text')).toEqual([]);

    const reply = await complete(
      { gateway: await gateway(mock), turnId: 'turn-text' },
      [
        { role: 'user', content: 'What does the chart show?' },
        { role: 'tool', toolCallId: 'call_1', content: JSON.stringify({ ok: true, data: result.data, notes: result.notes }) },
      ],
      'text',
    );
    expect(reply.text).toBe(REPLY);
    expect((mock.calls[0]?.messages ?? []).flatMap((entry) => imagePartsOf(entry.content))).toEqual([]);
    expect(JSON.stringify(mock.calls[0]?.messages)).toContain('does not accept images');
  });
});
