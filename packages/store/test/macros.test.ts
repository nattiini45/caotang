/**
 * The writer's macros in the store (extensibility.md §10, project-format.md §2): `macro.save` and `macro.delete` through the shipped
 * `execute()` and undo store, the tolerant load of `macros[]`, and the lossless round trip through the folder and the `.caotang` bundle.
 *
 * Every refusal is asserted with the state unchanged, because a refusal that wrote anything would be the bug the bus's validate-first rule
 * exists to stop. The load half is held against hostile files: a hand-edited manifest may name anything, and the load drops what the bus
 * would refuse and says so.
 */
import { describe, expect, it } from 'vitest';
import { newId } from '@caotang/ids';
import {
  MACROS_MAX,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type CommandName,
  type CommandRegistry,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';

import {
  MemoryArtifactFs,
  addDocument,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  exportProjectZip,
  importProjectZip,
  readProject,
  serializeManifest,
  validateManifest,
  writeProject,
  type Manifest,
  type ProjectMacro,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-02T15:00:00.000Z');
const LATER_MS = Date.parse('2026-10-08T09:00:00.000Z');
const SCENE = 'n_BEACH00001';
const ID = 'm_7K2QX9M4A1';
const SECOND = 'm_ABCDEFGHJK';

const SPEC = {
  kind: 'object' as const,
  description: 'The macro params.',
  properties: {
    chapter: { kind: 'string' as const, description: 'The chapter.', nonBlank: true },
    status: { kind: 'enum' as const, description: 'The status.', values: ['draft', 'revised'], default: 'revised' },
  },
  required: ['chapter'],
};

function macro(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'revise-chapter',
    name: 'Revise chapter',
    description: 'Marks a chapter revised and notes it.',
    params: structuredClone(SPEC),
    steps: [
      { tool: 'meta.set', params: { node: { $param: 'chapter' }, status: { $param: 'status' } }, expect: 'The chapter is marked revised.' },
      { tool: 'notes.append', params: { node: { $param: 'chapter' }, text: 'Revised "today"\nwith a quote.' }, expect: 'A note is added.' },
    ],
    ...overrides,
  };
}

/** A stored macro (it has an id), as the manifest holds one. */
const stored = (overrides: Record<string, unknown> = {}): ProjectMacro => ({ id: ID, ...macro(), ...overrides }) as unknown as ProjectMacro;

interface Harness {
  readonly state: ProjectState;
  readonly bus: BusContext<ProjectState>;
  readonly registry: CommandRegistry;
  readonly undo: UndoStore;
}

function harness(): Harness {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: OPENED, id: SCENE });
  const registry = createProjectCommandRegistry({ clock: { now: () => LATER_MS } });
  const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  return { state, bus, registry, undo };
}

function send(h: Harness, name: CommandName, params: Record<string, unknown>, issuedBy: 'user' | 'agent' = 'user') {
  return execute({ id: newId('cmd'), name, params, issuedBy, createdAt: LATER_MS, ...(issuedBy === 'agent' ? { turnId: 'turn_1' } : {}) }, h.bus, h.registry);
}

function succeed(h: Harness, name: CommandName, params: Record<string, unknown>): ExecutionOutcome {
  const result = send(h, name, params);
  if (!result.ok) throw new Error(`${name} was refused: ${result.error.message}`);
  return result.value;
}

function undoGroup(h: Harness, outcome: ExecutionOutcome): void {
  if (outcome.undoGroupId === undefined) throw new Error('the command registered no undo group');
  const undone = h.undo.undo(outcome.undoGroupId);
  if (!undone.ok) throw new Error(`undo refused: ${undone.error.message}`);
  expect(undone.value.failures).toEqual([]);
}

describe('macro.save', () => {
  it('creates a macro in the manifest, mints its id, and reports it', () => {
    const h = harness();
    const outcome = succeed(h, 'macro.save', { macro: macro() });
    const id = (outcome.result as { macroId: string }).macroId;
    expect(id).toMatch(/^m_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(h.state.manifest.macros).toEqual([{ id, ...macro() }]);
    expect(h.bus.log.entries().at(-1)?.summary).toBe('saved the macro "Revise chapter"');
  });

  it('keeps an id the caller gave, and replaces the macro with that id', () => {
    const h = harness();
    succeed(h, 'macro.save', { macro: macro({ id: ID }) });
    succeed(h, 'macro.save', { macro: macro({ id: ID, name: 'Revise a chapter' }) });
    expect(h.state.manifest.macros).toHaveLength(1);
    expect(h.state.manifest.macros?.[0]).toMatchObject({ id: ID, name: 'Revise a chapter' });
    expect(h.bus.log.entries().at(-1)?.summary).toBe('changed the macro "Revise a chapter"');
  });

  it('is undone by deleting the new macro, and the replaced one comes back as it was', () => {
    const h = harness();
    const created = succeed(h, 'macro.save', { macro: macro({ id: ID }) });
    const replaced = succeed(h, 'macro.save', { macro: macro({ id: ID, name: 'Other', description: 'x' }) });
    undoGroup(h, replaced);
    expect(h.state.manifest.macros).toEqual([stored()]);
    undoGroup(h, created);
    expect(h.state.manifest.macros).toBeUndefined();
  });

  it('refuses a slug another macro holds, and a 51st macro, and writes nothing', () => {
    const h = harness();
    succeed(h, 'macro.save', { macro: macro({ id: ID }) });
    const before = structuredClone(h.state.manifest.macros);
    const slug = send(h, 'macro.save', { macro: macro({ id: SECOND }) });
    expect(slug).toMatchObject({ ok: false, error: { code: 'invalid-params', target: 'macro.slug' } });
    expect(h.state.manifest.macros).toEqual(before);
    for (let i = 1; i < MACROS_MAX; i += 1) succeed(h, 'macro.save', { macro: macro({ slug: `m-${i}` }) });
    expect(h.state.manifest.macros).toHaveLength(MACROS_MAX);
    expect(send(h, 'macro.save', { macro: macro({ slug: 'one-more' }) })).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    expect(h.state.manifest.macros).toHaveLength(MACROS_MAX);
  });

  it('refuses a step that names a tool a macro may never name, and an undeclared placeholder', () => {
    const h = harness();
    for (const tool of ['agent.plan', 'tool.search', 'mcp__notion__search', 'macro.revise-chapter']) {
      const result = send(h, 'macro.save', { macro: macro({ steps: [{ tool, params: {}, expect: 'x' }] }) });
      expect(result, tool).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    }
    const ghost = send(h, 'macro.save', { macro: macro({ steps: [{ tool: 'meta.set', params: { node: { $param: 'ghost' } }, expect: 'x' }] }) });
    expect(ghost).toMatchObject({ ok: false });
    expect(h.state.manifest.macros).toBeUndefined();
  });

  it('is never an agent command: refused with the risk and a hint not to retry, and nothing runs', () => {
    const h = harness();
    const result = send(h, 'macro.save', { macro: macro() }, 'agent');
    expect(result).toMatchObject({ ok: false, error: { code: 'permission-denied', risk: 'never' } });
    expect(h.state.manifest.macros).toBeUndefined();
    expect(h.undo.groups()).toEqual([]);
  });
});

describe('macro.delete', () => {
  it('removes the macro, drops the key with the last one, and is undone by saving it back', () => {
    const h = harness();
    succeed(h, 'macro.save', { macro: macro({ id: ID }) });
    succeed(h, 'macro.save', { macro: macro({ id: SECOND, slug: 'second' }) });
    const first = succeed(h, 'macro.delete', { macroId: ID });
    expect(h.state.manifest.macros?.map((m) => m.id)).toEqual([SECOND]);
    const last = succeed(h, 'macro.delete', { macroId: SECOND });
    expect(h.state.manifest.macros).toBeUndefined();
    undoGroup(h, last);
    undoGroup(h, first);
    expect(h.state.manifest.macros?.map((m) => m.id).sort()).toEqual([ID, SECOND]);
    expect(h.state.manifest.macros?.find((m) => m.id === ID)).toEqual(stored());
  });

  it('refuses an id the project does not hold, and an agent', () => {
    const h = harness();
    expect(send(h, 'macro.delete', { macroId: ID })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    succeed(h, 'macro.save', { macro: macro({ id: ID }) });
    expect(send(h, 'macro.delete', { macroId: ID }, 'agent')).toMatchObject({ ok: false, error: { code: 'permission-denied', risk: 'never' } });
    expect(h.state.manifest.macros).toHaveLength(1);
  });
});

/** A manifest with `macros` set to whatever a hand edit might have put there. */
function manifestWith(macros: unknown): Manifest {
  const manifest = createEmptyManifest('Macros', OPENED);
  (manifest as unknown as Record<string, unknown>)['macros'] = macros;
  return manifest;
}

function load(macros: unknown) {
  return validateManifest(manifestWith(macros), { docFiles: [] });
}

describe('macros[] on load', () => {
  it('keeps a macro as it is, with no warning', () => {
    const report = load([stored()]);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.manifest?.macros).toEqual([stored()]);
  });

  it('drops a value that is not an array, with a warning, and the project still opens', () => {
    const report = load({});
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.path)).toContain('macros');
    expect(report.manifest).not.toHaveProperty('macros');
  });

  it('drops a malformed macro and keeps the others, each warning naming where', () => {
    const report = load([stored(), 'nope', { id: SECOND }, null, stored({ id: 'm_ZZZZZZZZZZ', slug: 'third' })]);
    expect(report.ok).toBe(true);
    expect(report.manifest?.macros?.map((m) => m.slug)).toEqual(['revise-chapter', 'third']);
    expect(report.warnings.map((w) => w.path)).toEqual(['macros[1]', 'macros[2]', 'macros[3]']);
    expect(report.warnings.every((w) => w.message.endsWith('macro dropped'))).toBe(true);
  });

  it('drops every hostile macro the bus would refuse: a forbidden tool, 31 steps, an unknown $param, a type of a param, a script', () => {
    const steps31 = Array.from({ length: 31 }, () => ({ tool: 'notes.append', params: { text: 'x' }, expect: 'x' }));
    const hostile = [
      stored({ id: 'm_AAAAAAAAA1', slug: 'a', steps: [{ tool: 'mcp__evil__run', params: {}, expect: 'x' }] }),
      stored({ id: 'm_AAAAAAAAA2', slug: 'b', steps: [{ tool: 'agent.plan', params: {}, expect: 'x' }] }),
      stored({ id: 'm_AAAAAAAAA3', slug: 'c', steps: [{ tool: 'tool.search', params: {}, expect: 'x' }] }),
      stored({ id: 'm_AAAAAAAAA4', slug: 'd', steps: [{ tool: 'macro.other', params: {}, expect: 'x' }] }),
      stored({ id: 'm_AAAAAAAAA5', slug: 'e', steps: steps31 }),
      stored({ id: 'm_AAAAAAAAA6', slug: 'f', steps: [{ tool: 'meta.set', params: { node: { $param: 'ghost' } }, expect: 'x' }] }),
      stored({ id: 'm_AAAAAAAAA7', slug: 'g', script: 'return plan' }),
      stored({ id: 'm_AAAAAAAAA8', slug: 'h', params: { ...SPEC, properties: { chapter: { kind: 'array', description: 'x', items: {} } } } }),
      stored({ id: 'm_AAAAAAAAA9', slug: 'Bad Slug' }),
      stored({ id: 'm_AAAAAAAAAA', slug: 'i', steps: [{ tool: 'notes.append', params: { text: 'x'.repeat(30_000) }, expect: 'x' }] }),
      stored({ id: 'm_AAAAAAAAAB', slug: 'j', description: 'd'.repeat(601) }),
    ];
    const report = load(hostile);
    expect(report.ok).toBe(true);
    expect(report.manifest?.macros).toBeUndefined();
    expect(report.warnings).toHaveLength(hostile.length);
  });

  it('drops a macro carrying __proto__, constructor or prototype keys, and pollutes nothing', () => {
    const text = JSON.stringify([stored()]);
    const proto = JSON.parse(text.replace('"expect":"The chapter is marked revised."', '"expect":"x","__proto__":{"polluted":true}')) as unknown;
    const nested = JSON.parse(JSON.stringify([stored()]).replace('"status":"revised"', '"status":"revised"').replace('"text":', '"constructor":{"x":1},"text":')) as unknown;
    const report = load([...(proto as unknown[]), ...(nested as unknown[])]);
    expect(report.ok).toBe(true);
    expect(report.manifest?.macros).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('drops a second macro with a kept id or slug, and any beyond the limit', () => {
    const duplicates = load([stored(), stored({ slug: 'other' }), stored({ id: SECOND })]);
    expect(duplicates.manifest?.macros?.map((m) => m.id)).toEqual([ID]);
    expect(duplicates.warnings).toHaveLength(2);
    const many = Array.from({ length: MACROS_MAX + 3 }, (_, i) => stored({ id: `m_${String(i).padStart(10, '0')}`, slug: `m-${i}` }));
    const report = load(many);
    expect(report.manifest?.macros).toHaveLength(MACROS_MAX);
    expect(report.warnings.some((w) => w.message.includes(`more than ${MACROS_MAX}`))).toBe(true);
  });
});

describe('macros[] round trip', () => {
  function withMacros(): ProjectState {
    const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: OPENED, id: SCENE });
    state.manifest.macros = [stored(), stored({ id: SECOND, slug: 'second', description: '', params: { kind: 'object', description: 'none', properties: {}, required: [] }, steps: [{ tool: 'notes.append', params: { node: 'n_BEACH00001', text: 'Ünïcode ✓' }, expect: 'Adds a note.' }] })];
    return state;
  }

  it('writes the macro as a block, a step to a line, in the manifest', () => {
    const text = serializeManifest(withMacros().manifest);
    expect(text).toContain('  "macros": [\n    {\n      "id": "m_7K2QX9M4A1",\n      "slug": "revise-chapter",');
    expect(text).toContain('      "steps": [\n        { "tool": "meta.set", "params": {"node":{"$param":"chapter"},"status":{"$param":"status"}}, "expect": "The chapter is marked revised." },');
    expect(JSON.parse(text).macros).toHaveLength(2);
  });

  it('writes no key for a project without macros', () => {
    expect(serializeManifest(createEmptyManifest('Plain', OPENED))).not.toContain('macros');
  });

  it('is lossless through the folder: write, read, write again is byte for byte the same', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, withMacros(), { now: OPENED });
    const loaded = await readProject(fs);
    expect(loaded.state.manifest.macros).toEqual(withMacros().manifest.macros);
    expect(loaded.notices.filter((n) => n.path.startsWith('macros'))).toEqual([]);
    const first = await fs.read('caotang.json');
    await writeProject(fs, loaded.state, { now: OPENED });
    expect(await fs.read('caotang.json')).toBe(first);
  });

  it('is lossless through the .caotang bundle', async () => {
    const bundle = await exportProjectZip(withMacros(), { now: OPENED });
    const imported = await importProjectZip(bundle.bytes);
    const loaded = await readProject(imported.fs);
    expect(loaded.state.manifest.macros).toEqual(withMacros().manifest.macros);
    expect(loaded.notices.filter((n) => n.path.startsWith('macros'))).toEqual([]);
  });

  it('keeps a hand-edited file loadable: a hostile macro is dropped, the good one stays, and the next save drops the bad one for good', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, withMacros(), { now: OPENED });
    const manifest = JSON.parse(await fs.read('caotang.json')) as { macros: Record<string, unknown>[] };
    manifest.macros.push({ ...manifest.macros[0], id: 'm_ZZZZZZZZZZ', slug: 'evil', steps: [{ tool: 'mcp__x__y', params: {}, expect: 'x' }] });
    await fs.writeAtomic('caotang.json', JSON.stringify(manifest, null, 2));
    const loaded = await readProject(fs);
    expect(loaded.state.manifest.macros?.map((m) => m.slug)).toEqual(['revise-chapter', 'second']);
    expect(loaded.notices.some((n) => n.path === 'macros[2]')).toBe(true);
  });
});
