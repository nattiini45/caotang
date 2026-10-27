/**
 * The writer's hooks in the store (hooks.md §5, §6, project-format.md §2): `hook.save` and `hook.delete` through the shipped `execute()`
 * and undo store, the tolerant load of `agent.hooks`, and the lossless round trip through the folder and the `.caotang` bundle.
 *
 * The load half is held against hostile files: a hand-edited manifest may name anything, and the load drops what the bus would refuse and
 * says so by the hook's name. A project file holds only the `check` handler, so a hook of any other kind is dropped, not run.
 */
import { describe, expect, it } from 'vitest';
import { newId } from '@caotang/ids';
import {
  HOOKS_MAX,
  HOOK_PATTERNS_MAX,
  HOOK_TEXT_MAX,
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
  type PermissionRule,
  type ProjectHook,
  type ProjectState,
} from '../src/index.js';

const OPENED = new Date('2026-10-22T09:00:00.000Z');
const LATER_MS = Date.parse('2026-10-23T09:00:00.000Z');
const SCENE = 'n_BEACH00001';
const ID = 'h_7K2QX9M4A1';
const SECOND = 'h_ABCDEFGHJK';

function hook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'No “suddenly”',
    event: 'tool.before',
    matcher: { tools: ['scene.draft', 'notes.append'] },
    handler: { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'suddenly', message: 'Show the change instead.' }, { match: 'very', message: 'Cut it.' }] } },
    onBlock: 'block',
    enabled: true,
    ...overrides,
  };
}

/** A stored hook (it has an id), as the manifest holds one. */
const stored = (overrides: Record<string, unknown> = {}): ProjectHook => ({ id: ID, ...hook(), ...overrides }) as unknown as ProjectHook;

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

describe('hook.save', () => {
  it('creates a hook under agent.hooks, mints its id, and reports it', () => {
    const h = harness();
    const outcome = succeed(h, 'hook.save', { hook: hook() });
    const id = (outcome.result as { hookId: string }).hookId;
    expect(id).toMatch(/^h_[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(h.state.manifest.agent?.hooks).toEqual([{ id, ...hook() }]);
    expect(h.bus.log.entries().at(-1)?.summary).toBe('saved the hook "No “suddenly”"');
  });

  it('keeps an id the caller gave, and replaces the hook with that id', () => {
    const h = harness();
    succeed(h, 'hook.save', { hook: hook({ id: ID }) });
    succeed(h, 'hook.save', { hook: hook({ id: ID, name: 'No “suddenly” or “very”' }) });
    expect(h.state.manifest.agent?.hooks).toHaveLength(1);
    expect(h.state.manifest.agent?.hooks?.[0]).toMatchObject({ id: ID, name: 'No “suddenly” or “very”' });
    expect(h.bus.log.entries().at(-1)?.summary).toBe('changed the hook "No “suddenly” or “very”"');
  });

  it('is undone by deleting the new hook, and the replaced one comes back as it was', () => {
    const h = harness();
    const created = succeed(h, 'hook.save', { hook: hook({ id: ID }) });
    const replaced = succeed(h, 'hook.save', { hook: hook({ id: ID, name: 'Other', enabled: false }) });
    undoGroup(h, replaced);
    expect(h.state.manifest.agent?.hooks).toEqual([stored()]);
    undoGroup(h, created);
    expect(h.state.manifest.agent).toBeUndefined();
  });

  it('leaves the writer\'s rules where they are: the hooks are one key of agent', () => {
    const h = harness();
    const rule: PermissionRule = { effect: 'ask', tool: 'meta.set' };
    h.state.manifest.agent = { rules: [rule] };
    const created = succeed(h, 'hook.save', { hook: hook({ id: ID }) });
    expect(h.state.manifest.agent).toEqual({ rules: [rule], hooks: [stored()] });
    undoGroup(h, created);
    expect(h.state.manifest.agent).toEqual({ rules: [rule] });
  });

  it('refuses a 21st hook, and writes nothing', () => {
    const h = harness();
    for (let i = 0; i < HOOKS_MAX; i += 1) succeed(h, 'hook.save', { hook: hook({ name: `Hook ${i}` }) });
    const full = structuredClone(h.state.manifest.agent);
    expect(send(h, 'hook.save', { hook: hook({ name: 'One more' }) })).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    expect(h.state.manifest.agent).toEqual(full);
    // A hook that is already there can still be changed when the list is full.
    const id = h.state.manifest.agent?.hooks?.[0]?.id;
    expect(send(h, 'hook.save', { hook: hook({ id, name: 'Renamed' }) })).toMatchObject({ ok: true });
  });

  it('refuses a handler that is not a check, a regex, a stray key and an over-long pattern, naming each', () => {
    const h = harness();
    const check = (inner: Record<string, unknown>) => ({ handler: { kind: 'check', check: inner } });
    const refused: [string, Record<string, unknown>][] = [
      ['mcp handler', { handler: { kind: 'mcp', serverKey: 's', toolName: 't' } }],
      ['model handler', { handler: { kind: 'model', prompt: 'is it good?' } }],
      ['command handler', { handler: { kind: 'command', argv: ['rm', '-rf', '/'] } }],
      ['regex pattern', check({ kind: 'pattern', patterns: [{ match: 'sudden(ly)?', regex: true, message: 'x' }] })],
      ['unknown check', check({ kind: 'script', source: 'return 1' })],
      ['long pattern', check({ kind: 'pattern', patterns: [{ match: 'x'.repeat(HOOK_TEXT_MAX + 1), message: 'x' }] })],
      ['long message', check({ kind: 'pattern', patterns: [{ match: 'x', message: 'm'.repeat(HOOK_TEXT_MAX + 1) }] })],
      ['too many patterns', check({ kind: 'pattern', patterns: Array.from({ length: HOOK_PATTERNS_MAX + 1 }, (_, i) => ({ match: `w${i}`, message: 'x' })) })],
      ['blank pattern', check({ kind: 'pattern', patterns: [{ match: '  ', message: 'x' }] })],
      ['unknown event', { event: 'tool.during' }],
      ['stray key', { transform: { params: {} } }],
      ['prototype key', JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>],
      ['bad check id', check({ kind: 'coherence', checks: ['POV Coverage!'] })],
      ['words with no bound', check({ kind: 'words' })],
      ['words min over max', check({ kind: 'words', min: 9, max: 3 })],
      ['matcher with a stray key', { matcher: { tools: ['scene.draft'], regex: '.*' } }],
    ];
    for (const [label, over] of refused) {
      const result = send(h, 'hook.save', { hook: hook(over) });
      expect(result, label).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
    }
    expect(h.state.manifest.agent).toBeUndefined();
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it('is never an agent command: refused with the risk and a hint not to retry, and nothing runs', () => {
    const h = harness();
    const result = send(h, 'hook.save', { hook: hook() }, 'agent');
    expect(result).toMatchObject({ ok: false, error: { code: 'permission-denied', risk: 'never' } });
    expect(h.state.manifest.agent).toBeUndefined();
    expect(h.undo.groups()).toEqual([]);
  });
});

describe('hook.delete', () => {
  it('removes the hook, drops the key with the last one, and is undone by saving it back', () => {
    const h = harness();
    succeed(h, 'hook.save', { hook: hook({ id: ID }) });
    succeed(h, 'hook.save', { hook: hook({ id: SECOND, name: 'Second' }) });
    const first = succeed(h, 'hook.delete', { hookId: ID });
    expect(h.state.manifest.agent?.hooks?.map((x) => x.id)).toEqual([SECOND]);
    const last = succeed(h, 'hook.delete', { hookId: SECOND });
    expect(h.state.manifest.agent).toBeUndefined();
    undoGroup(h, last);
    undoGroup(h, first);
    expect(h.state.manifest.agent?.hooks?.map((x) => x.id).sort()).toEqual([ID, SECOND]);
    expect(h.state.manifest.agent?.hooks?.find((x) => x.id === ID)).toEqual(stored());
  });

  it('refuses an id the project does not hold, and an agent', () => {
    const h = harness();
    expect(send(h, 'hook.delete', { hookId: ID })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    succeed(h, 'hook.save', { hook: hook({ id: ID }) });
    expect(send(h, 'hook.delete', { hookId: ID }, 'agent')).toMatchObject({ ok: false, error: { code: 'permission-denied', risk: 'never' } });
    expect(h.state.manifest.agent?.hooks).toHaveLength(1);
  });
});

/** A manifest with `agent` set to whatever a hand edit might have put there. */
function manifestWith(agent: unknown): Manifest {
  const manifest = createEmptyManifest('Hooks', OPENED);
  (manifest as unknown as Record<string, unknown>)['agent'] = agent;
  return manifest;
}

function load(hooks: unknown, more: Record<string, unknown> = {}) {
  return validateManifest(manifestWith({ hooks, ...more }), { docFiles: [] });
}

describe('agent.hooks on load', () => {
  it('keeps a hook as it is, with no warning', () => {
    const report = load([stored()]);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.manifest?.agent?.hooks).toEqual([stored()]);
  });

  it('drops a value that is not an array, with a warning, and the project still opens', () => {
    const report = load({});
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.path)).toEqual(['agent.hooks']);
    expect(report.manifest?.agent).not.toHaveProperty('hooks');
  });

  it('drops a malformed hook and keeps the others, each warning naming the hook', () => {
    const report = load([stored(), 'nope', { id: SECOND, name: 'Broken' }, null, stored({ id: 'h_ZZZZZZZZZZ', name: 'Third' })]);
    expect(report.ok).toBe(true);
    expect(report.manifest?.agent?.hooks?.map((x) => x.name)).toEqual(['No “suddenly”', 'Third']);
    expect(report.warnings.map((w) => w.path)).toEqual(['agent.hooks[1]', 'agent.hooks[2]', 'agent.hooks[3]']);
    expect(report.warnings[1]?.message).toContain('hook "Broken" dropped');
  });

  it('drops every hook whose handler is not a check, naming the hook, so a shared folder carries nothing that runs', () => {
    const handlers = [
      { kind: 'mcp', serverKey: 's', toolName: 't' },
      { kind: 'model', prompt: 'is this good?' },
      { kind: 'command', argv: ['rm', '-rf', '/'] },
      { kind: 'script', source: 'return 1' },
      { kind: 'check', check: { kind: 'pattern', patterns: [{ match: 'a', regex: true, message: 'x' }] } },
    ];
    const hostile = handlers.map((handler, i) => stored({ id: `h_AAAAAAAAA${i}`, name: `Hostile ${i}`, handler }));
    const report = load([...hostile, stored({ id: SECOND, name: 'Kept' })]);
    expect(report.ok).toBe(true);
    expect(report.manifest?.agent?.hooks?.map((x) => x.name)).toEqual(['Kept']);
    expect(report.warnings).toHaveLength(hostile.length);
    for (const [i, warning] of report.warnings.entries()) expect(warning.message, warning.path).toContain(`hook "Hostile ${i}" dropped`);
  });

  it('keeps a hook for an event this build does not run, and says it has no effect yet', () => {
    const report = load([stored({ event: 'export.before' })]);
    expect(report.manifest?.agent?.hooks).toHaveLength(1);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.message).toContain('export.before');
  });

  it('drops a hook carrying __proto__ or constructor keys, and pollutes nothing', () => {
    const text = JSON.stringify([stored()]);
    const proto = JSON.parse(text.replace('"enabled":true', '"enabled":true,"__proto__":{"polluted":true}')) as unknown[];
    const nested = JSON.parse(text.replace('"matcher":{', '"matcher":{"constructor":{"x":1},')) as unknown[];
    const report = load([...proto, ...nested]);
    expect(report.ok).toBe(true);
    expect(report.manifest?.agent?.hooks).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('drops a second hook with a kept hook\'s id, and any beyond the limit', () => {
    const duplicates = load([stored(), stored({ name: 'Same id' })]);
    expect(duplicates.manifest?.agent?.hooks?.map((x) => x.name)).toEqual(['No “suddenly”']);
    expect(duplicates.warnings).toHaveLength(1);
    const many = Array.from({ length: HOOKS_MAX + 3 }, (_, i) => stored({ id: `h_${String(i).padStart(10, '0')}`, name: `Hook ${i}` }));
    const report = load(many);
    expect(report.manifest?.agent?.hooks).toHaveLength(HOOKS_MAX);
    expect(report.warnings.some((w) => w.message.includes(`more than ${HOOKS_MAX}`))).toBe(true);
  });

  it('reads the rules beside the hooks, and keeps a key a newer build wrote under agent', () => {
    const rule: PermissionRule = { effect: 'ask', tool: 'meta.set' };
    const report = load([stored()], { rules: [rule], futureKey: { x: [1, 2] } });
    expect(report.manifest?.agent).toEqual({ hooks: [stored()], rules: [rule], futureKey: { x: [1, 2] } });
  });
});

describe('agent.hooks round trip', () => {
  function withHooks(): ProjectState {
    const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
    addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: OPENED, id: SCENE });
    state.manifest.agent = {
      rules: [{ effect: 'ask', tool: 'meta.set' }],
      hooks: [
        stored(),
        stored({
          id: SECOND,
          name: 'Scene checks, “日本語” ✓',
          event: 'tool.after',
          matcher: undefined,
          handler: { kind: 'check', check: { kind: 'coherence', checks: ['pov.coverage', 'presence.expected'], severityAtLeast: 'warning' } },
          onBlock: undefined,
          failClosed: true,
          enabled: false,
        }),
      ].map((x) => JSON.parse(JSON.stringify(x)) as ProjectHook),
      future: { keep: 'me' },
    };
    return state;
  }

  it('writes a hook as a block, a pattern to a line, under agent', () => {
    const text = serializeManifest(withHooks().manifest);
    expect(text).toContain('  "agent": {\n    "rules": [');
    expect(text).toContain('    "hooks": [\n      {\n        "id": "h_7K2QX9M4A1",\n        "name": "No “suddenly”",');
    expect(text).toContain('"check": { "kind": "pattern", "patterns": [\n          { "match": "suddenly", "message": "Show the change instead." },\n          { "match": "very", "message": "Cut it." }\n        ] } },');
    expect(text).toContain('    "future": {"keep":"me"}');
    expect(JSON.parse(text).agent.hooks).toHaveLength(2);
  });

  it("leaves out a key the app's settings own, such as a permission mode, which a project never carries", () => {
    const manifest = createEmptyManifest('Plain', OPENED);
    manifest.agent = { mode: 'auto', defaultMode: 'auto', lockAuto: false, budget: { maxModelCalls: 99 }, future: 1 };
    const text = serializeManifest(manifest);
    expect(JSON.parse(text).agent).toEqual({ future: 1 });
  });

  it('writes no key for a project without hooks, rules or other agent keys', () => {
    const manifest = createEmptyManifest('Plain', OPENED);
    manifest.agent = {};
    expect(serializeManifest(manifest)).not.toContain('agent');
  });

  it('is lossless through the folder: write, read, write again is byte for byte the same', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, withHooks(), { now: OPENED });
    const loaded = await readProject(fs);
    expect(loaded.state.manifest.agent).toEqual(withHooks().manifest.agent);
    expect(loaded.notices.filter((n) => n.path.startsWith('agent'))).toEqual([]);
    const first = await fs.read('caotang.json');
    await writeProject(fs, loaded.state, { now: OPENED });
    expect(await fs.read('caotang.json')).toBe(first);
  });

  it('is lossless through the .caotang bundle', async () => {
    const bundle = await exportProjectZip(withHooks(), { now: OPENED });
    const imported = await importProjectZip(bundle.bytes);
    const loaded = await readProject(imported.fs);
    expect(loaded.state.manifest.agent).toEqual(withHooks().manifest.agent);
    expect(loaded.notices.filter((n) => n.path.startsWith('agent'))).toEqual([]);
  });

  it('keeps a hand-edited file loadable: a hostile hook is dropped, the good one stays, and the next save drops the bad one for good', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, withHooks(), { now: OPENED });
    const manifest = JSON.parse(await fs.read('caotang.json')) as { agent: { hooks: Record<string, unknown>[] } };
    manifest.agent.hooks.push({ ...manifest.agent.hooks[0], id: 'h_ZZZZZZZZZZ', name: 'Evil', handler: { kind: 'command', argv: ['curl', 'evil.example'] } });
    await fs.writeAtomic('caotang.json', JSON.stringify(manifest, null, 2));
    const loaded = await readProject(fs);
    expect(loaded.state.manifest.agent?.hooks?.map((x) => x.id)).toEqual([ID, SECOND]);
    expect(loaded.notices.some((n) => n.path === 'agent.hooks[2]' && n.message.includes('"Evil"'))).toBe(true);
    await writeProject(fs, loaded.state, { now: OPENED });
    expect(await fs.read('caotang.json')).not.toContain('Evil');
  });
});
