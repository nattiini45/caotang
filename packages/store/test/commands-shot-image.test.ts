/**
 * Storyboard: `shot.importImage` through the shipped bus. The image is written into `assets/`, the shot's `image` is set
 * through the storyboard module's own write, and both are one undo group. A refusal writes no file, so a shot that cannot
 * take the picture leaves nothing behind.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  err,
  execute,
  executeAsync,
  ok,
  type BusContext,
  type Command,
  type CommandName,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';
import {
  addDocument,
  addNode,
  createAssetStaging,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  nodeById,
  type ProjectAssetPort,
  type ProjectState,
  type ShotCommandPort,
} from '../src/index.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const clock = { now: () => 1_000 };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0xff]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const SHOT = 'n_SHOTONE001';
const SHOT_WITH_FIELDS = 'n_SHOTTWO001';

/**
 * A project with a storyboard holding two shots, and a document. The first shot has no metadata; the second has a shot size
 * and an action, so the test can see that the image is added beside them and undone without them changing.
 */
function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  addNode(state, { parentId: 'manuscript', title: 'Storyboard', type: 'folder', kind: 'storyboard', now: NOW, id: 'n_BOARD00001' });
  addNode(state, { parentId: 'n_BOARD00001', title: 'Shot 1', type: 'shot', now: NOW, id: SHOT });
  addNode(state, { parentId: 'n_BOARD00001', title: 'Shot 2', type: 'shot', now: NOW, id: SHOT_WITH_FIELDS });
  const shot = nodeById(state, SHOT_WITH_FIELDS);
  if (shot !== undefined) shot.shot = { shotSize: 'CU', action: 'She looks up.' };
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: 'n_LANDING001' });
  return state;
}

/**
 * The storyboard module's `shot.setMeta`, as a fake: the same guard (the stored value must be the one the caller expected)
 * and the same write (the node's stored value is replaced whole, or removed when the stored value is null).
 */
type ShotResult = ReturnType<ShotCommandPort['apply']>;

const shotPort: ShotCommandPort = {
  apply(state, name, params): ShotResult {
    if (name !== 'shot.setMeta') return err({ code: 'not-found', message: `the fake port has no ${name}` }) as ShotResult;
    const { nodeId, stored, expect } = params as { nodeId: string; stored: Record<string, unknown> | null; expect: unknown };
    const node = nodeById(state, nodeId);
    if (node === undefined || node.type !== 'shot') return err({ code: 'not-found', message: `no shot "${nodeId}"` }) as ShotResult;
    if (JSON.stringify(node.shot ?? null) !== JSON.stringify(expect ?? null)) {
      return err({ code: 'conflict', message: 'the shot changed since it was read' }) as ShotResult;
    }
    if (stored === null) delete node.shot;
    else node.shot = stored;
    return ok({ affected: [{ nodeId, title: node.title }], summary: 'set a shot' }) as ShotResult;
  },
};

interface Bus {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly staging: ReturnType<typeof createAssetStaging>;
  readonly written: Map<string, Uint8Array>;
}

function bus(state: ProjectState = project(), withPorts = true): Bus {
  const written = new Map<string, Uint8Array>();
  const staging = createAssetStaging();
  const assets: ProjectAssetPort = {
    staging,
    writeBytes: async (path, bytes) => {
      written.set(path, bytes.slice());
    },
  };
  const registry = createProjectCommandRegistry({ clock, ...(withPorts ? { assets, shots: shotPort } : {}) });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, handle.bus, registry) });
  const handle: { bus: BusContext<ProjectState> } = {
    bus: {
      state,
      view: createViewState(),
      read: () => state,
      undo,
      log: createActivityLog(),
      idempotency: createIdempotencyCache(),
      notify: () => undefined,
    },
  };
  return { state, undo, bus: handle.bus, registry, staging, written };
}

let ordinal = 0;
function command(name: CommandName, params: Record<string, unknown>): Command {
  ordinal += 1;
  return { id: `cmd_SHOTIMAGE${String(ordinal).padStart(3, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
}

async function importImage(b: Bus, nodeId: string, bytes: Uint8Array) {
  const stagingId = b.staging.stage(bytes);
  return executeAsync(command('shot.importImage', { nodeId, stagingId }), b.bus, b.registry);
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

describe('shot.importImage: the image is written, and the shot names it, in one undo group', () => {
  it('writes the picture into assets/ under a new id and sets it as the shot’s image', async () => {
    const b = bus();
    const outcome = okValue(await importImage(b, SHOT, PNG));
    const { assetId, path } = outcome.result as { assetId: string; path: string };

    expect(assetId).toMatch(/^a_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(path).toBe(`assets/${assetId}.png`);
    expect(b.written.get(path)).toEqual(PNG);
    expect(nodeById(b.state, SHOT)?.shot).toEqual({ image: assetId });
    expect(b.undo.groups()).toHaveLength(1);
  });

  it('keeps the shot’s other fields beside the new image, and the undo restores the stored value exactly', async () => {
    const b = bus();
    const before = JSON.stringify(nodeById(b.state, SHOT_WITH_FIELDS)?.shot);
    okValue(await importImage(b, SHOT_WITH_FIELDS, JPEG));
    expect(nodeById(b.state, SHOT_WITH_FIELDS)?.shot).toMatchObject({ shotSize: 'CU', action: 'She looks up.' });
    expect(nodeById(b.state, SHOT_WITH_FIELDS)?.shot).toHaveProperty('image');

    undoLast(b);
    expect(JSON.stringify(nodeById(b.state, SHOT_WITH_FIELDS)?.shot)).toBe(before);
  });

  it('leaves the file in place on undo, since nothing names it and removing it would tie undo to a second write', async () => {
    const b = bus();
    const { assetId } = okValue(await importImage(b, SHOT, PNG)).result as { assetId: string };
    undoLast(b);
    expect(nodeById(b.state, SHOT)?.shot).toBeUndefined();
    expect(b.written.has(`assets/${assetId}.png`)).toBe(true);
  });
});

describe('shot.importImage: a refusal writes no file', () => {
  it('refuses a node that is not a shot, before anything is written', async () => {
    const b = bus();
    const refused = await importImage(b, 'n_LANDING001', PNG);
    expect(refused.ok).toBe(false);
    expect(b.written.size).toBe(0);
    expect(b.undo.groups()).toHaveLength(0);
  });

  it('refuses a node that does not exist, before anything is written', async () => {
    const b = bus();
    const refused = await importImage(b, 'n_NOSUCH0001', PNG);
    expect(refused.ok).toBe(false);
    expect(b.written.size).toBe(0);
  });

  it('refuses a file that is not PNG, JPEG or WebP, and writes nothing', async () => {
    const b = bus();
    const refused = await importImage(b, SHOT, Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]));
    expect(refused.ok).toBe(false);
    expect(b.written.size).toBe(0);
    expect(nodeById(b.state, SHOT)?.shot).toBeUndefined();
  });

  it('refuses a staging id that is not held, as the cover import does', async () => {
    const b = bus();
    const refused = await executeAsync(command('shot.importImage', { nodeId: SHOT, stagingId: 'stg_NOTHELD01' }), b.bus, b.registry);
    expect(refused.ok).toBe(false);
    expect(b.written.size).toBe(0);
  });
});

describe('shot.importImage: registration', () => {
  it('is registered only when both the asset port and the storyboard port are injected', () => {
    expect(bus(project(), false).registry['shot.importImage'].apply).toBeUndefined();
    expect(bus().registry['shot.importImage'].apply).toBeDefined();
  });
});

/** Stages each picture and runs `shot.importImages` over the named shots. */
async function importImages(b: Bus, pictures: readonly { readonly nodeId: string; readonly bytes: Uint8Array }[]) {
  const items = pictures.map(({ nodeId, bytes }) => ({ nodeId, stagingId: b.staging.stage(bytes) }));
  return executeAsync(command('shot.importImages', { items }), b.bus, b.registry);
}

describe('shot.importImages: several pictures, each on its shot, in one undo group (storyboard.md §6)', () => {
  it('writes each picture under its own id and sets each shot’s image, keeping the fields beside it', async () => {
    const b = bus();
    const outcome = okValue(
      await importImages(b, [
        { nodeId: SHOT, bytes: PNG },
        { nodeId: SHOT_WITH_FIELDS, bytes: JPEG },
      ]),
    );
    const { items } = outcome.result as { items: { nodeId: string; assetId: string; path: string }[] };
    expect(items.map((item) => item.nodeId)).toEqual([SHOT, SHOT_WITH_FIELDS]);
    expect(items[0]?.path).toBe(`assets/${items[0]?.assetId}.png`);
    expect(items[1]?.path).toBe(`assets/${items[1]?.assetId}.jpg`);
    expect(b.written.get(items[0]?.path ?? '')).toEqual(PNG);
    expect(b.written.get(items[1]?.path ?? '')).toEqual(JPEG);
    expect(nodeById(b.state, SHOT)?.shot).toEqual({ image: items[0]?.assetId });
    expect(nodeById(b.state, SHOT_WITH_FIELDS)?.shot).toEqual({ shotSize: 'CU', action: 'She looks up.', image: items[1]?.assetId });
  });

  it('is one undo group, and one undo takes back every picture the batch set, restoring the stored values and stamps exactly', async () => {
    const b = bus();
    const before = JSON.stringify(b.state.manifest.tree);
    okValue(
      await importImages(b, [
        { nodeId: SHOT, bytes: PNG },
        { nodeId: SHOT_WITH_FIELDS, bytes: JPEG },
      ]),
    );
    expect(b.undo.groups()).toHaveLength(1);
    expect(b.undo.groups()[0]?.entries).toHaveLength(1);
    expect(JSON.stringify(b.state.manifest.tree)).not.toBe(before);

    undoLast(b);
    expect(JSON.stringify(b.state.manifest.tree)).toBe(before);
    expect(b.undo.groups()).toHaveLength(0);
  });

  it('leaves the files in place on undo, as the single import does', async () => {
    const b = bus();
    okValue(await importImages(b, [{ nodeId: SHOT, bytes: PNG }]));
    undoLast(b);
    expect(b.written.size).toBe(1);
  });

  it('writes nothing, sets nothing and takes back nothing when any shot is not a shot, or does not exist', async () => {
    for (const bad of ['n_LANDING001', 'n_NOSUCH0001']) {
      const b = bus();
      const refused = await importImages(b, [
        { nodeId: SHOT, bytes: PNG },
        { nodeId: bad, bytes: PNG },
      ]);
      expect(refused.ok, bad).toBe(false);
      expect(b.written.size, bad).toBe(0);
      expect(nodeById(b.state, SHOT)?.shot).toBeUndefined();
      expect(b.undo.groups()).toHaveLength(0);
    }
  });

  it('writes nothing when any file is not a picture, naming the shot it was for', async () => {
    const b = bus();
    const refused = await importImages(b, [
      { nodeId: SHOT, bytes: PNG },
      { nodeId: SHOT_WITH_FIELDS, bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]) },
    ]);
    expect(!refused.ok && refused.error.message).toContain('the image for "Shot 2" is not a PNG, JPEG or WebP image');
    expect(b.written.size).toBe(0);
    expect(nodeById(b.state, SHOT)?.shot).toBeUndefined();
  });

  it('writes nothing when a staging id is not held', async () => {
    const b = bus();
    const held = b.staging.stage(PNG);
    const refused = await executeAsync(
      command('shot.importImages', {
        items: [
          { nodeId: SHOT, stagingId: held },
          { nodeId: SHOT_WITH_FIELDS, stagingId: 'stg_NOTHELD01' },
        ],
      }),
      b.bus,
      b.registry,
    );
    expect(refused.ok).toBe(false);
    expect(b.written.size).toBe(0);
  });

  it('refuses a write that fails after earlier files were written: no shot is changed, and the message says how many files were left', async () => {
    const b = bus();
    let writes = 0;
    const failing: ProjectAssetPort = {
      staging: b.staging,
      writeBytes: async (path, bytes) => {
        writes += 1;
        if (writes === 2) throw new Error('disk full');
        b.written.set(path, bytes.slice());
      },
    };
    const registry = createProjectCommandRegistry({ clock, assets: failing, shots: shotPort });
    const items = [SHOT, SHOT_WITH_FIELDS].map((nodeId) => ({ nodeId, stagingId: b.staging.stage(PNG) }));
    const refused = await executeAsync(command('shot.importImages', { items }), b.bus, registry);

    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toContain('the image for "Shot 2" could not be saved (disk full), so no shot was given a picture.');
    expect(!refused.ok && refused.error.message).toContain('1 file was already written to the project');
    expect(b.written.size).toBe(1);
    expect(nodeById(b.state, SHOT)?.shot).toBeUndefined();
    expect(nodeById(b.state, SHOT_WITH_FIELDS)?.shot).toEqual({ shotSize: 'CU', action: 'She looks up.' });
    expect(b.undo.groups()).toHaveLength(0);
  });

  it('puts back the shots it had set when a later shot refuses, and says no shot was given a picture', async () => {
    const b = bus();
    let calls = 0;
    const flaky: ShotCommandPort = {
      apply(state, name, params, now) {
        calls += 1;
        if (calls === 2) return err({ code: 'conflict', message: 'the shot changed since it was read' }) as ShotResult;
        return shotPort.apply(state, name, params, now);
      },
    };
    const registry = createProjectCommandRegistry({
      clock,
      assets: { staging: b.staging, writeBytes: async (path, bytes) => void b.written.set(path, bytes.slice()) },
      shots: flaky,
    });
    const before = JSON.stringify(b.state.manifest.tree);
    const items = [SHOT, SHOT_WITH_FIELDS].map((nodeId) => ({ nodeId, stagingId: b.staging.stage(PNG) }));
    const refused = await executeAsync(command('shot.importImages', { items }), b.bus, registry);

    expect(!refused.ok && refused.error.message).toContain('No shot was given a picture; 2 files were written');
    expect(JSON.stringify(b.state.manifest.tree)).toBe(before);
    expect(b.undo.groups()).toHaveLength(0);
  });

  it('does not overwrite a shot changed after the batch: the undo refuses, names it, and keeps the entry', async () => {
    const b = bus();
    okValue(await importImages(b, [{ nodeId: SHOT, bytes: PNG }]));
    const shot = nodeById(b.state, SHOT);
    if (shot !== undefined) shot.shot = { ...(shot.shot as Record<string, unknown>), action: 'Edited later.' };
    const group = b.undo.groups()[0];
    const result = b.undo.undo(group?.id ?? '');
    expect(result.ok && result.value.failures).toHaveLength(1);
    expect(result.ok && result.value.failures[0]?.message).toContain('"Shot 1" changed after the pictures were added');
    expect(nodeById(b.state, SHOT)?.shot).toMatchObject({ action: 'Edited later.' });
    expect(b.undo.groups()).toHaveLength(1);
  });

  it('is registered only when both ports are injected', () => {
    expect(bus(project(), false).registry['shot.importImages'].apply).toBeUndefined();
    expect(bus().registry['shot.importImages'].apply).toBeDefined();
  });
});
