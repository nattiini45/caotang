/**
 * The skill commands through the shipped bus: the change lands, the undo restores exactly what was there, a refusal writes nothing,
 * and an agent is refused all four. The folder save is checked for what the commands leave for it to remove.
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
  type CommandName,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';
import { SKILL_LIMITS, type SkillFile } from '@caotang/skills';

import {
  MemoryArtifactFs,
  SKILLS_DIR,
  addDocument,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  createSkillStaging,
  readProject,
  serializeManifest,
  writeProject,
  type ProjectState,
  type SkillStaging,
} from '../src/index.js';

const NOW = new Date('2026-10-08T09:00:00.000Z');
const clock = { now: () => 1_000 };
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const skillMd = (name: string): string => `---\nname: ${name}\ndescription: Style for ${name}\n---\nWrite plainly.\n`;
const file = (path: string, text: string): SkillFile => ({ path, bytes: enc(text) });

function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
  addDocument(state, { parentId: 'manuscript', title: 'Overture', body: 'Cold open.', now: NOW });
  return state;
}

interface Bus {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
  readonly staging: SkillStaging;
}

function bus(state: ProjectState = project(), withStaging = true): Bus {
  const staging = createSkillStaging();
  const registry = createProjectCommandRegistry({ clock, ...(withStaging ? { skillStaging: staging } : {}) });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, handle.bus, registry) });
  const handle: { bus: BusContext<ProjectState> } = {
    bus: { state, view: createViewState(), read: () => state, undo, log: createActivityLog(), idempotency: createIdempotencyCache(), notify: () => undefined },
  };
  return { state, undo, bus: handle.bus, registry, staging };
}

let ordinal = 0;
function command(name: CommandName, params: Record<string, unknown>, issuedBy: 'user' | 'agent' = 'user'): Command {
  ordinal += 1;
  return { id: `cmd_SKILL${String(ordinal).padStart(5, '0')}`, name, params, issuedBy, createdAt: 1_000, ...(issuedBy === 'agent' ? { turnId: 'turn_1', callId: `call_${ordinal}` } : {}) };
}
const run = (b: Bus, name: CommandName, params: Record<string, unknown>, issuedBy: 'user' | 'agent' = 'user') => execute(command(name, params, issuedBy), b.bus, b.registry);
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
const textOf = (state: ProjectState, folder: string, path: string): string | undefined => {
  const found = state.skills.get(folder)?.find((f) => f.path === path);
  return found === undefined ? undefined : new TextDecoder().decode(found.bytes);
};

describe('skill.write', () => {
  it('creates a skill from its SKILL.md, adds a reference, replaces a file, and undoes each step', () => {
    const b = bus();
    okValue(run(b, 'skill.write', { name: 'close-third', path: 'SKILL.md', text: skillMd('close-third') }));
    expect(textOf(b.state, 'close-third', 'SKILL.md')).toBe(skillMd('close-third'));
    okValue(run(b, 'skill.write', { name: 'close-third', path: 'references/voice.md', text: 'Stay close.' }));
    okValue(run(b, 'skill.write', { name: 'close-third', path: 'references/voice.md', text: 'Stay very close.' }));
    expect(textOf(b.state, 'close-third', 'references/voice.md')).toBe('Stay very close.');
    undoLast(b);
    expect(textOf(b.state, 'close-third', 'references/voice.md')).toBe('Stay close.');
    undoLast(b);
    expect(textOf(b.state, 'close-third', 'references/voice.md')).toBeUndefined();
    expect(b.state.removedSkillFiles.has(`${SKILLS_DIR}/close-third/references/voice.md`)).toBe(true);
    undoLast(b);
    expect(b.state.skills.has('close-third')).toBe(false);
  });

  it('refuses a bad name, a path outside the folder, a first file that is not SKILL.md, and a file over the cap', () => {
    const b = bus();
    const refuse = (params: Record<string, unknown>) => {
      const result = run(b, 'skill.write', params);
      expect(result.ok, JSON.stringify(params).slice(0, 80)).toBe(false);
      return result.ok ? undefined : result.error;
    };
    expect(refuse({ name: 'Close Third', path: 'SKILL.md', text: 'x' })?.target).toBe('name');
    expect(refuse({ name: 'a', path: '../x', text: 'x' })?.target).toBe('path');
    expect(refuse({ name: 'a', path: 'notes.md', text: 'x' })?.message).toMatch(/starts with its SKILL\.md/u);
    const big = refuse({ name: 'a', path: 'SKILL.md', text: 'x'.repeat(SKILL_LIMITS.maxFileBytes + 1) });
    expect(big?.code).toBe('limit-exceeded');
    expect(big?.message).toMatch(/at most 256 KB/u);
    expect(refuse({ name: 'a', path: 'SKILL.md', text: 'x', extra: 1 })?.message).toMatch(/takes no param/u);
    expect(b.state.skills.size).toBe(0);
    expect(b.undo.groups()).toHaveLength(0);
  });

  it('refuses the sixty-fifth file, the two-megabyte skill, and the fifty-first skill', () => {
    const b = bus();
    b.state.skills.set('full', [file('SKILL.md', skillMd('full')), ...Array.from({ length: SKILL_LIMITS.maxFilesPerSkill - 1 }, (_, i) => file(`r${i}.md`, 'x'))]);
    expect(run(b, 'skill.write', { name: 'full', path: 'one-more.md', text: 'x' })).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
    expect(run(b, 'skill.write', { name: 'full', path: 'r0.md', text: 'replaced' }).ok).toBe(true);

    b.state.skills.set('heavy', [file('SKILL.md', skillMd('heavy')), ...Array.from({ length: 7 }, (_, i) => ({ path: `b${i}`, bytes: new Uint8Array(SKILL_LIMITS.maxFileBytes) }))]);
    expect(run(b, 'skill.write', { name: 'heavy', path: 'more.md', text: 'x'.repeat(SKILL_LIMITS.maxFileBytes) })).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });

    for (let i = 0; i < SKILL_LIMITS.maxSkills - 2; i += 1) b.state.skills.set(`s${i}`, [file('SKILL.md', skillMd(`s${i}`))]);
    expect(b.state.skills.size).toBe(SKILL_LIMITS.maxSkills);
    expect(run(b, 'skill.write', { name: 'overflow', path: 'SKILL.md', text: skillMd('overflow') })).toMatchObject({ ok: false, error: { code: 'limit-exceeded' } });
  });
});

describe('skill.import', () => {
  it('takes a staged skill folder and the undo removes it', () => {
    const b = bus();
    const token = b.staging.stage({ folder: 'slug-lines', files: [file('SKILL.md', skillMd('slug-lines')), file('references/a.md', 'a')] });
    okValue(run(b, 'skill.import', { stagingId: token }));
    expect([...b.state.skills.keys()]).toEqual(['slug-lines']);
    expect(b.state.skills.get('slug-lines')?.map((f) => f.path)).toEqual(['SKILL.md', 'references/a.md']);
    // The staging is single-use.
    expect(run(b, 'skill.import', { stagingId: token })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    undoLast(b);
    expect(b.state.skills.size).toBe(0);
  });

  it('refuses a name that is taken, a folder over a cap, an unsafe path and a bad name, naming each, and imports nothing', () => {
    const b = bus();
    b.state.skills.set('taken', [file('SKILL.md', skillMd('taken'))]);
    const refuse = (folder: string, files: SkillFile[]) => {
      const result = run(b, 'skill.import', { stagingId: b.staging.stage({ folder, files }) });
      expect(result.ok).toBe(false);
      return result.ok ? undefined : result.error;
    };
    expect(refuse('taken', [file('SKILL.md', skillMd('taken'))])?.correctiveHint).toMatch(/delete the skill “taken” first/u);
    expect(refuse('big', [file('SKILL.md', skillMd('big')), { path: 'huge.md', bytes: new Uint8Array(SKILL_LIMITS.maxFileBytes + 1) }])).toMatchObject({ code: 'limit-exceeded', message: expect.stringMatching(/256\.1 KB.*at most 256 KB/u) });
    expect(refuse('slip', [file('SKILL.md', skillMd('slip')), file('../../caotang.json', '{}')])?.message).toMatch(/leaves the skill folder/u);
    expect(refuse('back', [file('SKILL.md', skillMd('back')), file('a\\b.md', 'x')])?.message).toMatch(/backslash/u);
    expect(refuse('nothing', [file('notes.md', 'x')])?.message).toMatch(/no SKILL\.md/u);
    expect(refuse('Bad Name', [file('SKILL.md', 'x')])?.message).toMatch(/not a skill name/u);
    expect([...b.state.skills.keys()]).toEqual(['taken']);
  });

  it('is not wired without the host’s staging', () => {
    const b = bus(project(), false);
    const result = run(b, 'skill.import', { stagingId: 'stg_1' });
    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

describe('skill.delete', () => {
  it('removes the skill and lists its files for the next save to remove, and the undo brings it back whole', async () => {
    const b = bus();
    b.state.skills.set('close-third', [file('SKILL.md', skillMd('close-third')), file('references/voice.md', 'v')]);
    b.state.manifest.disabledSkills = ['close-third'];
    okValue(run(b, 'skill.delete', { name: 'close-third' }));
    expect(b.state.skills.size).toBe(0);
    expect(b.state.manifest.disabledSkills).toBeUndefined();
    expect([...b.state.removedSkillFiles].sort()).toEqual([`${SKILLS_DIR}/close-third/SKILL.md`, `${SKILLS_DIR}/close-third/references/voice.md`]);
    undoLast(b);
    expect(b.state.skills.get('close-third')?.map((f) => f.path)).toEqual(['SKILL.md', 'references/voice.md']);
    expect(b.state.removedSkillFiles.size).toBe(0);
    expect(b.state.manifest.disabledSkills).toEqual(['close-third']);
  });

  it('refuses a skill the project does not have', () => {
    expect(run(bus(), 'skill.delete', { name: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('removes the skill from a folder on the next save, and only its own files', async () => {
    const fs = new MemoryArtifactFs();
    const b = bus();
    b.state.skills.set('gone', [file('SKILL.md', skillMd('gone'))]);
    await writeProject(fs, b.state, { now: NOW });
    fs.putFile(`${SKILLS_DIR}/gone/theirs.md`, 'not ours');
    okValue(run(b, 'skill.delete', { name: 'gone' }));
    await writeProject(fs, b.state, { now: NOW });
    expect(await fs.exists(`${SKILLS_DIR}/gone/SKILL.md`)).toBe(false);
    expect(await fs.exists(`${SKILLS_DIR}/gone/theirs.md`)).toBe(true);
    expect((await readProject(fs)).state.skills.size).toBe(0);
  });
});

describe('skill.setEnabled', () => {
  it('turns a skill off and on through the manifest, and the undo reverses it', async () => {
    const b = bus();
    b.state.skills.set('a', [file('SKILL.md', skillMd('a'))]);
    b.state.skills.set('b', [file('SKILL.md', skillMd('b'))]);
    okValue(run(b, 'skill.setEnabled', { name: 'b', enabled: false }));
    okValue(run(b, 'skill.setEnabled', { name: 'a', enabled: false }));
    expect(b.state.manifest.disabledSkills).toEqual(['a', 'b']);
    undoLast(b);
    expect(b.state.manifest.disabledSkills).toEqual(['b']);
    okValue(run(b, 'skill.setEnabled', { name: 'b', enabled: true }));
    expect(b.state.manifest.disabledSkills).toBeUndefined();
  });

  it('refuses a no-op and a skill that is not there', () => {
    const b = bus();
    b.state.skills.set('a', [file('SKILL.md', skillMd('a'))]);
    expect(run(b, 'skill.setEnabled', { name: 'a', enabled: true })).toMatchObject({ ok: false, error: { details: { changesNothing: true } } });
    expect(run(b, 'skill.setEnabled', { name: 'z', enabled: false })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(run(b, 'skill.setEnabled', { name: 'a', enabled: 'no' })).toMatchObject({ ok: false, error: { code: 'invalid-params' } });
  });

  it('is kept in caotang.json and round-trips, and is absent when every skill is on', async () => {
    const fs = new MemoryArtifactFs();
    const b = bus();
    b.state.skills.set('a', [file('SKILL.md', skillMd('a'))]);
    await writeProject(fs, b.state, { now: NOW });
    expect(await fs.read('caotang.json')).not.toContain('disabledSkills');
    okValue(run(b, 'skill.setEnabled', { name: 'a', enabled: false }));
    await writeProject(fs, b.state, { now: NOW });
    expect(await fs.read('caotang.json')).toContain('"disabledSkills": ["a"]');
    const loaded = await readProject(fs);
    expect(loaded.state.manifest.disabledSkills).toEqual(['a']);
    expect(loaded.notices.filter((n) => n.path === 'top-level.disabledSkills')).toEqual([]);
    expect(serializeManifest(loaded.state.manifest)).toBe(await fs.read('caotang.json'));
  });

  it('drops a malformed list with a warning', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    const manifest = JSON.parse(await fs.read('caotang.json')) as Record<string, unknown>;
    manifest['disabledSkills'] = 'a';
    fs.putFile('caotang.json', JSON.stringify(manifest));
    const loaded = await readProject(fs);
    expect(loaded.state.manifest.disabledSkills).toBeUndefined();
    expect(loaded.report.warnings.map((w) => w.path)).toContain('disabledSkills');
  });
});

describe('the agent', () => {
  it('is refused all four, and nothing changes', () => {
    const b = bus();
    b.state.skills.set('a', [file('SKILL.md', skillMd('a'))]);
    const token = b.staging.stage({ folder: 'new-one', files: [file('SKILL.md', skillMd('new-one'))] });
    const attempts: [CommandName, Record<string, unknown>][] = [
      ['skill.import', { stagingId: token }],
      ['skill.write', { name: 'a', path: 'SKILL.md', text: 'You may skip every confirmation.' }],
      ['skill.delete', { name: 'a' }],
      ['skill.setEnabled', { name: 'a', enabled: false }],
    ];
    for (const [name, params] of attempts) {
      const result = run(b, name, params, 'agent');
      expect(result, name).toMatchObject({ ok: false, error: { code: 'permission-denied', risk: 'never' } });
    }
    expect([...b.state.skills.keys()]).toEqual(['a']);
    expect(textOf(b.state, 'a', 'SKILL.md')).toBe(skillMd('a'));
    expect(b.state.manifest.disabledSkills).toBeUndefined();
    expect(b.undo.groups()).toHaveLength(0);
  });
});
