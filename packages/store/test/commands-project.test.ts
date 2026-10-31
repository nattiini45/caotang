/**
 * Project export: the project-block, recipe, vocabulary and cover-import applies, through the shipped bus.
 *
 * Each apply is checked for the three things a writer relies on: the change lands, the undo restores exactly what
 * was there, and a refusal writes nothing. The cover import is the one asynchronous apply, so it runs through
 * `executeAsync`, the way the desktop dispatches it.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  executeAsync,
  resolveCommand,
  type BusContext,
  type Command,
  type CommandName,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';
import {
  COVER_MAX_BYTES,
  createAssetStaging,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  addDocument,
  addFolder,
  nodeById,
  sniffCoverImage,
  type ProjectAssetPort,
  type ProjectState,
} from '../src/index.js';

const NOW = new Date('2026-10-08T09:00:00.000Z');
const clock = { now: () => 1_000 };
const UUID = '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0xff]);

/** A new project with a chapter, a scene in it, and the identity pinned, so every value is known in the test. */
function project(): ProjectState {
  const state = createProjectState(
    createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => UUID, locale: 'en-US' }),
  );
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: NOW, id: 'n_CHAPTER0001' });
  addDocument(state, { parentId: 'n_CHAPTER0001', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: 'n_LANDING001' });
  return state;
}

interface Bus {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly ported: ProjectAssetPort;
  readonly written: Map<string, Uint8Array>;
}

/** The bus over one project, with the store's registry and an asset port that records what it writes. */
function bus(state: ProjectState = project(), withAssets = true): Bus {
  const written = new Map<string, Uint8Array>();
  const staging = createAssetStaging();
  const ported: ProjectAssetPort = {
    staging,
    writeBytes: async (path, bytes) => {
      written.set(path, bytes.slice());
    },
  };
  const registry = createProjectCommandRegistry({ clock, ...(withAssets ? { assets: ported } : {}) });
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
  return { state, undo, bus: handle.bus, registry, ported, written };
}

let ordinal = 0;
function command(name: CommandName, params: Record<string, unknown>): Command {
  ordinal += 1;
  return { id: `cmd_M9TEST${String(ordinal).padStart(4, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
}

function run(b: Bus, name: CommandName, params: Record<string, unknown>) {
  return execute(command(name, params), b.bus, b.registry);
}

async function runAsync(b: Bus, name: CommandName, params: Record<string, unknown>): Promise<ReturnType<typeof execute>> {
  return executeAsync(command(name, params), b.bus, b.registry);
}

/** Undoes the most recent group, which is what one click on Undo does. */
function undoLast(b: Bus): void {
  const last = b.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = b.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

function okValue(result: ReturnType<typeof execute>): ExecutionOutcome {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The names of the stored recipes, read at the call, so a test that removed the list still reads what the apply stored. */
function recipeNamesOf(b: Bus): string[] | undefined {
  return b.state.manifest.recipes?.map((recipe) => recipe.name);
}

describe('project.rename — the title, with the root node kept equal to it', () => {
  it('renames the project and its root, and the undo restores the old title to both', () => {
    const b = bus();
    okValue(run(b, 'project.rename', { title: 'The Lantern Keeper' }));
    expect(b.state.manifest.project.name).toBe('The Lantern Keeper');
    expect(nodeById(b.state, 'root')?.title).toBe('The Lantern Keeper');
    undoLast(b);
    expect(b.state.manifest.project.name).toBe('The Lighthouse Keeper');
    expect(nodeById(b.state, 'root')?.title).toBe('The Lighthouse Keeper');
  });

  it('refuses a blank title and writes nothing', () => {
    const b = bus();
    const refused = run(b, 'project.rename', { title: '   ' });
    expect(refused.ok).toBe(false);
    expect(b.state.manifest.project.name).toBe('The Lighthouse Keeper');
    expect(b.undo.groups()).toHaveLength(0);
  });
});

describe('project.setMetadata — the author, the language, the ISBN and the cover reference', () => {
  it('sets the author, the language and an ISBN given with hyphens, and undoes each to what it was', () => {
    const b = bus();
    okValue(run(b, 'project.setMetadata', { patch: { author: 'Ada Writer', language: 'de', isbn: '978-0-306-40615-7' } }));
    expect(b.state.manifest.project.author).toBe('Ada Writer');
    expect(b.state.manifest.project.language).toBe('de');
    expect(b.state.manifest.project.identifier?.isbn).toBe('urn:isbn:9780306406157');
    undoLast(b);
    expect(b.state.manifest.project.author).toBeUndefined();
    expect(b.state.manifest.project.language).toBe('en');
    expect(b.state.manifest.project.identifier?.isbn).toBeNull();
  });

  it('clears the author with null, and the undo puts the author back', () => {
    const b = bus();
    okValue(run(b, 'project.setMetadata', { patch: { author: 'Ada Writer' } }));
    okValue(run(b, 'project.setMetadata', { patch: { author: null } }));
    expect(b.state.manifest.project.author).toBeUndefined();
    undoLast(b);
    expect(b.state.manifest.project.author).toBe('Ada Writer');
  });

  it('keeps the identifier it was given: a metadata change never mints a new one', () => {
    const b = bus();
    okValue(run(b, 'project.setMetadata', { patch: { language: 'fr' } }));
    expect(b.state.manifest.project.identifier?.uuid).toBe(`urn:uuid:${UUID}`);
  });

  it('refuses an ISBN with a bad check digit, and writes nothing', () => {
    const b = bus();
    const refused = run(b, 'project.setMetadata', { patch: { isbn: '978-0-306-40615-8' } });
    expect(refused.ok).toBe(false);
    expect(b.state.manifest.project.identifier?.isbn).toBeUndefined();
  });

  it('refuses a cover set by an id that is not an asset id', () => {
    const b = bus();
    expect(run(b, 'project.setMetadata', { patch: { coverAssetId: '../escape' } }).ok).toBe(false);
    expect(b.state.manifest.project.coverAssetId).toBeUndefined();
  });
});

describe('vocabulary.upsert and vocabulary.remove — statuses and labels', () => {
  it('creates a label with an id minted from its name, and the undo removes it again', () => {
    const b = bus();
    const outcome = okValue(run(b, 'vocabulary.upsert', { kind: 'label', name: 'Act 1', color: '#D9A44A' }));
    expect(outcome.result).toEqual({ id: 'act-1' });
    expect(b.state.manifest.vocabulary.labels).toEqual([{ id: 'act-1', name: 'Act 1', color: '#d9a44a' }]);
    undoLast(b);
    expect(b.state.manifest.vocabulary.labels).toEqual([]);
  });

  it('gives a second term of the same slug a suffix, so ids never collide', () => {
    const b = bus();
    okValue(run(b, 'vocabulary.upsert', { kind: 'label', name: 'Act 1', color: '#d9a44a' }));
    okValue(run(b, 'vocabulary.upsert', { kind: 'label', name: 'Act-1', color: '#4a90d9' }));
    expect(b.state.manifest.vocabulary.labels.map((term) => term.id)).toEqual(['act-1', 'act-1-2']);
  });

  it('renames and recolours a term by id, and the undo restores its name and colour', () => {
    const b = bus();
    okValue(run(b, 'vocabulary.upsert', { kind: 'status', id: 'revised', name: 'Second pass', color: '#123456' }));
    expect(b.state.manifest.vocabulary.statuses.find((term) => term.id === 'revised')).toEqual({
      id: 'revised',
      name: 'Second pass',
      color: '#123456',
    });
    undoLast(b);
    expect(b.state.manifest.vocabulary.statuses.find((term) => term.id === 'revised')).toEqual({
      id: 'revised',
      name: 'Revised',
      color: '#4a90d9',
    });
  });

  it('refuses a second term with the same name, whatever its case', () => {
    const b = bus();
    const refused = run(b, 'vocabulary.upsert', { kind: 'status', name: 'DRAFT', color: '#000000' });
    expect(refused.ok).toBe(false);
    expect(b.state.manifest.vocabulary.statuses).toHaveLength(3);
  });

  it('removes a status, detaches the nodes that held it, and the undo restores the term in its place and each node', () => {
    const b = bus();
    const scene = nodeById(b.state, 'n_LANDING001');
    if (scene === undefined) throw new Error('fixture scene missing');
    scene.status = 'final';
    okValue(run(b, 'vocabulary.remove', { kind: 'status', id: 'final' }));
    expect(b.state.manifest.vocabulary.statuses.map((term) => term.id)).toEqual(['draft', 'revised']);
    expect(scene.status).toBeNull();
    undoLast(b);
    expect(b.state.manifest.vocabulary.statuses.map((term) => term.id)).toEqual(['draft', 'revised', 'final']);
    expect(scene.status).toBe('final');
  });

  it('refuses to remove a term that is not in the vocabulary', () => {
    const b = bus();
    expect(run(b, 'vocabulary.remove', { kind: 'label', id: 'nope' }).ok).toBe(false);
  });
});

describe('recipe.save and recipe.delete — the saved export configurations', () => {
  it('saves a recipe, replaces it by name, and the undo restores the one it replaced', () => {
    const b = bus();
    okValue(run(b, 'recipe.save', { name: 'Beta', includeRootIds: ['manuscript'], format: 'md' }));
    okValue(
      run(b, 'recipe.save', {
        name: 'Beta',
        includeRootIds: ['manuscript'],
        format: 'epub',
        options: { toc: false, author: 'A. N. Other' },
      }),
    );
    const beta = () => b.state.manifest.recipes?.find((recipe) => recipe.name === 'Beta');
    expect(beta()?.format).toBe('epub');
    expect(beta()?.options).toEqual({ toc: false, author: 'A. N. Other' });
    undoLast(b);
    expect(beta()?.format).toBe('md');
    expect(beta()?.options).toBeUndefined();
  });

  it('deletes a recipe, and the undo saves it back with its options', () => {
    const b = bus();
    okValue(run(b, 'recipe.save', { name: 'Beta', includeRootIds: ['manuscript'], format: 'docx', options: { titlePage: false } }));
    okValue(run(b, 'recipe.delete', { name: 'Beta' }));
    expect(b.state.manifest.recipes?.some((recipe) => recipe.name === 'Beta')).toBe(false);
    undoLast(b);
    expect(b.state.manifest.recipes?.find((recipe) => recipe.name === 'Beta')).toEqual({
      name: 'Beta',
      includeRootIds: ['manuscript'],
      format: 'docx',
      options: { titlePage: false },
    });
  });

  it('restores every picture option when a replaced recipe is undone', () => {
    const b = bus();
    const options = { pictures: 'placeholder' as const, epubImageMaxPx: 960, epubKeepWebp: true, keepPictureMetadata: true, timelinePictures: false };
    okValue(run(b, 'recipe.save', { name: 'Beta', includeRootIds: ['manuscript'], format: 'epub', options }));
    okValue(run(b, 'recipe.save', { name: 'Beta', includeRootIds: ['manuscript'], format: 'md' }));
    undoLast(b);
    expect(b.state.manifest.recipes?.find((recipe) => recipe.name === 'Beta')).toEqual({ name: 'Beta', includeRootIds: ['manuscript'], format: 'epub', options });
  });

  it('starts a project with the default Manuscript recipe, and deletes it like any other', () => {
    const b = bus();
    expect(b.state.manifest.recipes?.map((recipe) => recipe.name)).toEqual(['Manuscript']);
    okValue(run(b, 'recipe.delete', { name: 'Manuscript' }));
    expect(b.state.manifest.recipes).toEqual([]);
  });

  it('refuses a recipe that selects a node which is not in the project, and writes nothing', () => {
    const b = bus();
    const refused = run(b, 'recipe.save', { name: 'Ghost', includeRootIds: ['n_NOPE000000'], format: 'md' });
    expect(refused.ok).toBe(false);
    expect(b.state.manifest.recipes?.some((recipe) => recipe.name === 'Ghost')).toBe(false);
  });

  it('keeps the implicit default recipe when a recipe is saved in a project that stores no recipes (exporter.md §4)', () => {
    const b = bus();
    // A project that predates recipes has no `recipes` key, and holds the default without storing it.
    delete b.state.manifest.recipes;
    okValue(run(b, 'recipe.save', { name: 'Beta', includeRootIds: ['manuscript'], format: 'md' }));
    expect(recipeNamesOf(b)).toEqual(['Manuscript', 'Beta']);
    undoLast(b);
    expect(recipeNamesOf(b)).toEqual(['Manuscript']);
  });

  it('deletes the implicit default recipe of a project that stores no recipes, and writes an empty list, not none', () => {
    const b = bus();
    delete b.state.manifest.recipes;
    okValue(run(b, 'recipe.delete', { name: 'Manuscript' }));
    expect(b.state.manifest.recipes).toEqual([]);
    undoLast(b);
    expect(recipeNamesOf(b)).toEqual(['Manuscript']);
  });

  it('refuses to delete a name the project does not hold, and stores no list for a project that stores none', () => {
    const b = bus();
    delete b.state.manifest.recipes;
    expect(run(b, 'recipe.delete', { name: 'Ghost' }).ok).toBe(false);
    expect(b.state.manifest.recipes).toBeUndefined();
    expect(b.undo.groups()).toHaveLength(0);
  });
});

describe('project.importAsset — the cover, written into assets/ and referenced', () => {
  it('writes the staged image into assets/ under a new id, sets it as the cover, and the undo restores the reference', async () => {
    const b = bus();
    const token = b.ported.staging.stage(PNG);
    const outcome = okValue(await runAsync(b, 'project.importAsset', { stagingId: token, target: 'cover' }));
    const assetId = (outcome.result as { assetId: string }).assetId;
    expect(assetId).toMatch(/^a_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(b.written.get(`assets/${assetId}.png`)).toEqual(PNG);
    expect(b.state.manifest.project.coverAssetId).toBe(assetId);
    undoLast(b);
    expect(b.state.manifest.project.coverAssetId).toBeNull();
    // The file stays: nothing names it, every reader ignores it, and removing it would tie undo to a second write.
    expect(b.written.has(`assets/${assetId}.png`)).toBe(true);
  });

  it('refuses a file that is not a PNG, JPEG or WebP image, and writes nothing', async () => {
    const b = bus();
    const token = b.ported.staging.stage(Uint8Array.from([0x25, 0x50, 0x44, 0x46]));
    const refused = await runAsync(b, 'project.importAsset', { stagingId: token, target: 'cover' });
    expect(refused.ok).toBe(false);
    expect(b.written.size).toBe(0);
    expect(b.state.manifest.project.coverAssetId).toBeUndefined();
  });

  it('refuses an import whose staged bytes are gone, with a not-found refusal', async () => {
    const b = bus();
    const refused = await runAsync(b, 'project.importAsset', { stagingId: 'stg_NOTHELD', target: 'cover' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('not-found');
  });

  it('is not wired without the asset port: the name is refused as having no implementation', async () => {
    const b = bus(project(), false);
    expect(b.registry['project.importAsset'].apply).toBeUndefined();
    const refused = await runAsync(b, 'project.importAsset', { stagingId: 'stg_X', target: 'cover' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('has no implementation in this build');
  });

  it('is never executed through the synchronous door, because its apply is asynchronous (command-bus A2)', () => {
    const b = bus();
    const refused = run(b, 'project.importAsset', { stagingId: 'stg_X', target: 'cover' });
    expect(refused.ok).toBe(false);
  });

  it('a staged image is imported once: a second take finds nothing', () => {
    const staging = createAssetStaging();
    const token = staging.stage(PNG);
    expect(staging.take(token)).toEqual(PNG);
    expect(staging.take(token)).toBeUndefined();
  });
});

describe('sniffCoverImage and the cover limit', () => {
  it('reads PNG, JPEG and WebP from their leading bytes, never from a name', () => {
    expect(sniffCoverImage(PNG)).toEqual({ extension: 'png', mime: 'image/png' });
    expect(sniffCoverImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ extension: 'jpg', mime: 'image/jpeg' });
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffCoverImage(webp)).toEqual({ extension: 'webp', mime: 'image/webp' });
  });

  it('refuses a RIFF file that is not WebP, and an empty file', () => {
    expect(sniffCoverImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeUndefined();
    expect(sniffCoverImage(new Uint8Array())).toBeUndefined();
  });

  it('caps a cover at sixteen megabytes', () => {
    expect(COVER_MAX_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe('the new names are registered and typed as the bus describes them', () => {
  it('resolves every project-export name in the store registry, except the import without its port', () => {
    const registry = createProjectCommandRegistry({ clock, assets: bus().ported });
    for (const name of [
      'project.rename',
      'project.setMetadata',
      'project.importAsset',
      'vocabulary.upsert',
      'vocabulary.remove',
      'recipe.save',
      'recipe.delete',
    ] as const) {
      expect(registry[name].apply, name).toBeTypeOf('function');
    }
    expect(resolveCommand('project.rename').ok).toBe(false);
  });
});
