/**
 * `proof` is the Proof half of exporter.md §4's Draft/Proof duality, for the formats whose file is text: the file a compile would write,
 * made by the compile's own plan and renderer, before anything is made. Each test holds it to the compile: the text is the file the same
 * request writes through the bus. A binary format has no Proof, and says so. A proof reserves nothing, writes nothing, logs nothing and
 * runs no command.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';
import { createProjectCommandRegistry, MemoryArtifactFs, type ExportRecipe, type ProjectState } from '@caotang/store';

import { BINARY_FORMATS, createExporter, hasTextProof, EXPORT_FORMATS, type ExporterService, type ExportProof, type ExportPreviewRequest } from '../src/index.js';
import { COMPILED_AT, IDS, makeProject } from './fixture.js';
import { ASSETS, makeMediaProject } from './media-fixture.js';

interface Rig {
  readonly state: ProjectState;
  readonly fs: MemoryArtifactFs;
  readonly exporter: ExporterService;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => ExecutionOutcome;
}

let serial = 0;

function rig(state: ProjectState = makeProject()): Rig {
  const fs = new MemoryArtifactFs();
  const clock = { now: () => COMPILED_AT };
  const bytes = { writeBytes: async () => undefined, removeBytes: async () => undefined };
  const exporter = createExporter({ readState: () => state, artifacts: fs, bytes, clock, assets: () => ASSETS });
  const registry = createProjectCommandRegistry({ clock, exporter: exporter.commandPort() });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  const run = (name: Command['name'], params: Record<string, unknown>): ExecutionOutcome => {
    serial += 1;
    const command = { id: `cmd_PROF${String(serial).padStart(6, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command;
    const outcome = execute(command, bus, registry);
    if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
    return outcome.value;
  };
  return { state, fs, exporter, undo, bus, run };
}

function holdRecipe(r: { readonly state: ProjectState }, recipe: ExportRecipe): void {
  const kept = (r.state.manifest.recipes ?? []).filter((held) => held.name !== recipe.name);
  r.state.manifest.recipes = [...kept, recipe];
}

function textOf(proof: ExportProof) {
  if (proof.kind !== 'text') throw new Error(`expected a text proof, got ${proof.kind}`);
  return proof;
}

/** Compiles the request through the bus and gives back the text of the file it wrote first. */
async function compiled(r: Rig, params: Record<string, unknown>): Promise<string> {
  const outcome = r.run('export.compile', params);
  await r.exporter.idle();
  const output = (outcome.result as { output: string }).output;
  const text = r.fs.snapshot()[output];
  if (text === undefined) throw new Error(`the compile wrote no ${output}`);
  return text;
}

const WHOLE: ExportPreviewRequest['selection'] = { kind: 'manuscript' };

describe('exporter.proof — the file a text compile writes', () => {
  it('is the Markdown and the plain text the compile of the same request writes, byte for byte', async () => {
    for (const format of ['md', 'txt'] as const) {
      const r = rig();
      await r.exporter.ready();
      const proof = textOf(await r.exporter.proof({ selection: WHOLE, format }));
      expect(proof.fileName).toBe(`The Lighthouse Keeper.${format}`);
      expect(proof.otherFiles).toEqual([]);
      expect(proof.text).toBe(await compiled(r, { format }));
      expect(proof.text).toContain('The Lighthouse Keeper');
    }
  });

  it('follows a recipe with the title page off, as the compile does', async () => {
    const r = rig();
    await r.exporter.ready();
    holdRecipe(r, { name: 'Plain', includeRootIds: ['manuscript'], format: 'docx', templateId: 'default', options: { titlePage: false, toc: false } });
    const withPage = textOf(await r.exporter.proof({ selection: WHOLE, format: 'md' })).text;
    const plain = textOf(await r.exporter.proof({ selection: WHOLE, format: 'md', recipeName: 'Plain' })).text;
    expect(plain).not.toBe(withPage);
    expect(plain).toBe(await compiled(r, { format: 'md', recipeName: 'Plain' }));
  });

  it('is the part a part compile writes', async () => {
    const r = rig();
    await r.exporter.ready();
    const proof = textOf(await r.exporter.proof({ selection: { kind: 'nodes', includeRootIds: [IDS.chapterOne] }, format: 'txt' }));
    const outcome = r.run('export.compileSelection', { includeRootIds: [IDS.chapterOne], format: 'txt' });
    await r.exporter.idle();
    expect(proof.text).toBe(r.fs.snapshot()[(outcome.result as { output: string }).output]);
  });

  it('is the Fountain a screenplay compile writes, and names every further file of a compile that writes more than one', async () => {
    const r = rig(makeMediaProject());
    await r.exporter.ready();
    const fountain = textOf(await r.exporter.proof({ selection: WHOLE, format: 'fountain' }));
    expect(fountain.text).toBe(await compiled(r, { format: 'fountain' }));

    const pack = textOf(await r.exporter.proof({ selection: WHOLE, format: 'promptpack', templateId: 'runway-gen4' }));
    expect(pack.fileName).toBe('runway-gen4-prompt-pack.json');
    expect(pack.otherFiles).toEqual(['runway-gen4-prompt-pack.md', 'runway-gen4-shot-list.csv']);
    expect(pack.text).toBe(await compiled(r, { format: 'promptpack', templateId: 'runway-gen4' }));
  });
});

describe('exporter.proof — the formats it has none for, and refusals', () => {
  it('has no Proof for a binary container, and says so without rendering it', async () => {
    const r = rig();
    for (const format of BINARY_FORMATS) {
      expect(hasTextProof(format)).toBe(false);
      expect(await r.exporter.proof({ selection: WHOLE, format })).toEqual({ kind: 'none', format });
    }
    expect(EXPORT_FORMATS.filter(hasTextProof)).toEqual(EXPORT_FORMATS.filter((format) => !BINARY_FORMATS.includes(format)));
  });

  it('reports the refusal a compile would get, and does not throw', async () => {
    const r = rig();
    const gate = await r.exporter.proof({ selection: WHOLE, format: 'fountain' });
    expect(gate.kind === 'refused' && gate.error.message).toContain('the selection holds no screenplay scene');
    const recipe = await r.exporter.proof({ selection: WHOLE, format: 'md', recipeName: 'Missing' });
    expect(recipe.kind === 'refused' && recipe.error.code).toBe('not-found');
    const format = await r.exporter.proof({ selection: WHOLE, format: 'rtf' });
    expect(format.kind === 'refused' && format.error.code).toBe('invalid-params');
  });

  it('writes no file, reserves no name, leaves the compile log and the undo store alone, and runs no command', async () => {
    const r = rig();
    await r.exporter.ready();
    const before = JSON.stringify(r.fs.snapshot());
    const activityBefore = r.bus.log.length;
    const undoBefore = r.undo.groups().length;

    await r.exporter.proof({ selection: WHOLE, format: 'md' });
    await r.exporter.proof({ selection: WHOLE, format: 'txt' });
    await r.exporter.proof({ selection: WHOLE, format: 'docx' });
    await r.exporter.idle();

    expect(JSON.stringify(r.fs.snapshot())).toBe(before);
    expect(r.fs.snapshot()['exports/compile-log.json']).toBeUndefined();
    expect(r.bus.log.length).toBe(activityBefore);
    expect(r.undo.groups().length).toBe(undoBefore);
    expect(r.run('export.compile', { format: 'md' }).result).toMatchObject({ output: 'exports/The Lighthouse Keeper.md' });
  });

  it('reads the project as it is now, so an edit between two proofs shows', async () => {
    const r = rig();
    expect(textOf(await r.exporter.proof({ selection: WHOLE, format: 'txt' })).text).not.toContain('She picked up.');
    const call = r.state.documents.get(IDS.call);
    if (call === undefined) throw new Error('the fixture has no The Call document');
    call.body = 'She picked up.';
    expect(textOf(await r.exporter.proof({ selection: WHOLE, format: 'txt' })).text).toContain('She picked up.');
  });
});
