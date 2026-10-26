/**
 * The agent-file commands through the shipped bus: the change lands, the undo restores exactly what was there (an undone new note leaves no
 * file for the next save), a refusal writes nothing, and an agent is held to the confirm card and refused `memory.forget`. The folder save is
 * checked for what the commands leave for it to write and remove.
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

import {
  INSTRUCTIONS_FILE,
  MEMORY_INDEX,
  MemoryArtifactFs,
  addDocument,
  agentFileTexts,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  parseMemoryFile,
  readProject,
  writeProject,
  type ProjectState,
} from '../src/index.js';

const NOW = new Date('2026-10-08T09:00:00.000Z');
const clock = { now: () => Date.parse('2026-10-09T12:00:00.000Z') };

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
}

function bus(state: ProjectState = project()): Bus {
  const registry = createProjectCommandRegistry({ clock });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, handle.bus, registry) });
  const handle: { bus: BusContext<ProjectState> } = {
    bus: { state, view: createViewState(), read: () => state, undo, log: createActivityLog(), idempotency: createIdempotencyCache(), notify: () => undefined },
  };
  return { state, undo, bus: handle.bus, registry };
}

let ordinal = 0;
function command(name: CommandName, params: Record<string, unknown>, issuedBy: 'user' | 'agent' = 'user', turnId = 'turn_1'): Command {
  ordinal += 1;
  return { id: `cmd_AGENT${String(ordinal).padStart(5, '0')}`, name, params, issuedBy, createdAt: 1_000, ...(issuedBy === 'agent' ? { turnId, callId: `call_${ordinal}` } : {}) };
}
const run = (b: Bus, name: CommandName, params: Record<string, unknown>, issuedBy: 'user' | 'agent' = 'user', context: { approvedPlan?: boolean; confirmed?: boolean } = {}) =>
  execute(command(name, params, issuedBy), { ...b.bus, permission: context }, b.registry);
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

const dialogue = { slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'Use "said" for tags.' };
const endings = { slug: 'process-endings', type: 'process', title: 'Scene endings', body: 'End on a line of dialogue where possible.' };

describe('project.setInstructions', () => {
  it('creates CAOTANG.md, replaces it, and undoes each step', () => {
    const b = bus();
    okValue(run(b, 'project.setInstructions', { text: 'British spelling.\n' }));
    expect(b.state.agentFiles.instructions).toEqual({ path: INSTRUCTIONS_FILE, text: 'British spelling.\n' });
    okValue(run(b, 'project.setInstructions', { text: 'British spelling.\nPast tense.\n' }));
    undoLast(b);
    expect(b.state.agentFiles.instructions?.text).toBe('British spelling.\n');
    undoLast(b);
    expect(b.state.agentFiles.instructions).toBeUndefined();
    // The file the first step made is left for the next save to remove, and a save that finds none removes nothing.
    expect(b.state.removedAgentFiles.has(INSTRUCTIONS_FILE)).toBe(true);
  });

  it('an empty text leaves an empty CAOTANG.md, which keeps an AGENTS.md beside it unread', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    fs.putFile('AGENTS.md', 'From AGENTS.md.\n');
    const b = bus((await readProject(fs)).state);
    expect(b.state.agentFiles.instructions?.path).toBe('AGENTS.md');
    okValue(run(b, 'project.setInstructions', { text: '' }));
    await writeProject(fs, b.state, { now: NOW });
    expect(await fs.read(INSTRUCTIONS_FILE)).toBe('');
    expect(await fs.read('AGENTS.md')).toBe('From AGENTS.md.\n');
    expect((await readProject(fs)).state.agentFiles.instructions).toEqual({ path: INSTRUCTIONS_FILE, text: '' });
  });

  it('refuses a stale digest and writes nothing', () => {
    const b = bus();
    okValue(run(b, 'project.setInstructions', { text: 'One.' }));
    const before = b.state.agentFiles;
    const result = run(b, 'project.setInstructions', { text: 'Two.', expectedDigest: '00000000000000' });
    expect(result).toMatchObject({ ok: false, error: { code: 'revision-conflict' } });
    expect(b.state.agentFiles).toBe(before);
  });

  it('is held to a confirm card for an agent, and lands in the turn’s undo group with the agent as its author', () => {
    const b = bus();
    expect(run(b, 'project.setInstructions', { text: 'x' }, 'agent')).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(b.state.agentFiles.instructions).toBeUndefined();
    const outcome = okValue(run(b, 'project.setInstructions', { text: 'x' }, 'agent', { confirmed: true }));
    expect(outcome.undoGroupId).toBeDefined();
    expect(b.state.agentFiles.instructions?.text).toBe('x');
  });
});

describe('memory.write', () => {
  it('creates a note and its index line, stamps it from the clock and the command, and updates it', () => {
    const b = bus();
    const created = okValue(run(b, 'memory.write', dialogue));
    expect(created.result).toMatchObject({ slug: 'style-dialogue', created: true });
    const [note] = b.state.agentFiles.memory;
    expect(note).toEqual({ ...dialogue, modified: '2026-10-09T12:00:00.000Z', origin: 'writer' });
    expect(b.state.agentFiles.index).toBe('- [Dialogue tags](style-dialogue.md) (style): Use "said" for tags.\n');

    okValue(run(b, 'memory.write', { ...dialogue, body: 'Use "said", never "asked".' }));
    expect(b.state.agentFiles.memory).toHaveLength(1);
    expect(b.state.agentFiles.memory[0]?.body).toBe('Use "said", never "asked".');
    expect(b.state.agentFiles.index).toContain('never "asked"');
  });

  it('keeps the notes and the index in slug order', () => {
    const b = bus();
    okValue(run(b, 'memory.write', dialogue));
    okValue(run(b, 'memory.write', endings));
    expect(b.state.agentFiles.memory.map((note) => note.slug)).toEqual(['process-endings', 'style-dialogue']);
    expect(b.state.agentFiles.index?.split('\n').filter(Boolean).map((line) => line.slice(0, 20))).toEqual(['- [Scene endings](pr', '- [Dialogue tags](st']);
  });

  it('marks an agent note with its origin and the turn, and needs a confirm card first', () => {
    const b = bus();
    expect(run(b, 'memory.write', dialogue, 'agent')).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
    expect(b.state.agentFiles.memory).toEqual([]);
    okValue(run(b, 'memory.write', dialogue, 'agent', { approvedPlan: true }));
    expect(b.state.agentFiles.memory[0]).toMatchObject({ origin: 'agent', sourceTurn: 'turn_1' });
  });

  it('undo of a new note removes it and leaves its file for the save to remove; undo of an update puts the old body back', async () => {
    const fs = new MemoryArtifactFs();
    const b = bus();
    okValue(run(b, 'memory.write', dialogue));
    await writeProject(fs, b.state, { now: NOW });
    expect(await fs.exists('memory/style-dialogue.md')).toBe(true);

    okValue(run(b, 'memory.write', { ...dialogue, body: 'Changed.' }));
    undoLast(b);
    expect(b.state.agentFiles.memory[0]?.body).toBe(dialogue.body);

    undoLast(b);
    expect(b.state.agentFiles.memory).toEqual([]);
    expect(b.state.agentFiles.index).toBeUndefined();
    const report = await writeProject(fs, b.state, { now: NOW });
    expect(report.pruned.sort()).toEqual([MEMORY_INDEX, 'memory/style-dialogue.md']);
    expect(await fs.exists('memory')).toBe(true);
    expect(await fs.exists('memory/style-dialogue.md')).toBe(false);
  });

  it('refuses a title that is a codex name, naming codex.write, and writes nothing', () => {
    const b = bus();
    b.state.manifest.codex = [
      { id: 'c_ELENA00001', name: 'Elena Voss', type: 'character', aliases: ['The Cartographer'], includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], description: '', origin: 'manual', sources: [] } as never,
    ];
    for (const title of ['Elena Voss', 'the cartographer']) {
      const result = run(b, 'memory.write', { ...dialogue, title });
      expect(result, title).toMatchObject({ ok: false, error: { code: 'invalid-params', correctiveHint: expect.stringContaining('codex.write') } });
    }
    expect(b.state.agentFiles.memory).toEqual([]);
  });

  it('writes files a later load reads back as the same notes', async () => {
    const fs = new MemoryArtifactFs();
    const b = bus();
    okValue(run(b, 'memory.write', dialogue));
    okValue(run(b, 'memory.write', endings));
    okValue(run(b, 'project.setInstructions', { text: 'British spelling.\n' }));
    await writeProject(fs, b.state, { now: NOW });
    expect(parseMemoryFile(await fs.read('memory/style-dialogue.md'))).toMatchObject({ ok: true, file: { title: 'Dialogue tags', modified: '2026-10-09T12:00:00.000Z' } });
    const loaded = await readProject(fs);
    expect(agentFileTexts(loaded.state.agentFiles)).toEqual(agentFileTexts(b.state.agentFiles));
  });
});

describe('memory.forget', () => {
  it('removes a note and its index line, lists its file for the save to remove, and one undo brings it back', async () => {
    const fs = new MemoryArtifactFs();
    const b = bus();
    okValue(run(b, 'memory.write', dialogue));
    okValue(run(b, 'memory.write', endings));
    await writeProject(fs, b.state, { now: NOW });

    okValue(run(b, 'memory.forget', { slug: 'style-dialogue' }));
    expect(b.state.agentFiles.memory.map((note) => note.slug)).toEqual(['process-endings']);
    expect(b.state.agentFiles.index).not.toContain('style-dialogue');
    expect(b.state.removedAgentFiles.has('memory/style-dialogue.md')).toBe(true);

    undoLast(b);
    expect(b.state.agentFiles.memory.map((note) => note.slug)).toEqual(['process-endings', 'style-dialogue']);
    expect(b.state.removedAgentFiles.has('memory/style-dialogue.md')).toBe(false);
    const kept = await writeProject(fs, b.state, { now: NOW });
    expect(kept.pruned).toEqual([]);

    okValue(run(b, 'memory.forget', { slug: 'style-dialogue' }));
    const removed = await writeProject(fs, b.state, { now: NOW });
    expect(removed.pruned).toEqual(['memory/style-dialogue.md']);
    expect(await fs.exists('memory/process-endings.md')).toBe(true);
  });

  it('forgetting the last note removes the index too', () => {
    const b = bus();
    okValue(run(b, 'memory.write', dialogue));
    okValue(run(b, 'memory.forget', { slug: 'style-dialogue' }));
    expect(b.state.agentFiles.index).toBeUndefined();
    expect(b.state.removedAgentFiles.has(MEMORY_INDEX)).toBe(true);
  });

  it('forgets a note the load could not read, and removes only that file', async () => {
    const fs = new MemoryArtifactFs();
    await writeProject(fs, project(), { now: NOW });
    fs.putFile('memory/hand-note.md', 'plain note\n');
    const b = bus((await readProject(fs)).state);
    okValue(run(b, 'memory.forget', { slug: 'hand-note' }));
    const report = await writeProject(fs, b.state, { now: NOW });
    expect(report.pruned).toEqual(['memory/hand-note.md']);
  });

  it('is refused for an agent whatever approval rides on the turn, and changes nothing', () => {
    const b = bus();
    okValue(run(b, 'memory.write', dialogue));
    for (const context of [{}, { approvedPlan: true }, { approvedPlan: true, confirmed: true }]) {
      const result = run(b, 'memory.forget', { slug: 'style-dialogue' }, 'agent', context);
      expect(result, JSON.stringify(context)).toMatchObject({ ok: false, error: { code: 'hard-denied' } });
    }
    expect(b.state.agentFiles.memory).toHaveLength(1);
  });

  it('refuses a note the project does not hold', () => {
    const b = bus();
    expect(run(b, 'memory.forget', { slug: 'nope' })).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });
});
