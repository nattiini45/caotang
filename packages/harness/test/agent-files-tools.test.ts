/**
 * The three rows that reach the writer's instructions and the agent's memory (context-assembly.md §2, layer LI): `memory.read`, a read;
 * `memory.write` and `instructions.propose`, which are write-confirm and previewed as a word diff. Each call goes through the ordinary
 * gate; `memory.forget` has no tool at all, and the agent's attempt at the command is hard-denied.
 */

import { describe, expect, it } from 'vitest';

import { textDigest } from '@caotang/bus';
import type { MemoryFile } from '@caotang/store';

import { TOOL_NAMES } from '../src/index.js';
import { CHAPTER_ONE, LANDING, makeHarness, makeState, refusalOf, run, valueOf } from './fixtures.js';

const confirmed = { permission: { confirmed: true } } as const;

const endings: MemoryFile = {
  slug: 'process-endings',
  type: 'process',
  title: 'Scene endings',
  body: 'End on a line of dialogue where possible.',
  modified: '2026-10-01T10:00:00.000Z',
  origin: 'writer',
};

function project() {
  const state = makeState();
  state.agentFiles = {
    instructions: { path: 'CAOTANG.md', text: 'British spelling.\n' },
    index: '- [Scene endings](process-endings.md) (process): End on a line of dialogue where possible.\n',
    memory: [endings],
    declined: new Map([['memory/hand-note.md', 'plain']]),
    unreadable: [],
  };
  return state;
}

describe('memory.read', () => {
  it('lists the notes with their digests, and the digest of CAOTANG.md, and names a note it could not read', () => {
    const harness = makeHarness({}, project());
    const { data } = valueOf(run(harness, 'memory.read', {}));
    expect(data).toMatchObject({
      instructions: { file: 'CAOTANG.md', characters: 18, digest: textDigest('British spelling.\n') },
      notes: [{ slug: 'process-endings', type: 'process', title: 'Scene endings', origin: 'writer', digest: textDigest(endings.body) }],
      unreadable: ['memory/hand-note.md'],
    });
  });

  it('reads one note whole, and refuses a slug the project does not hold, saying where to look', () => {
    const harness = makeHarness({}, project());
    expect(valueOf(run(harness, 'memory.read', { slug: 'process-endings' })).data).toMatchObject({ body: endings.body, digest: textDigest(endings.body) });
    const missing = refusalOf(run(harness, 'memory.read', { slug: 'nope' }));
    expect(missing).toMatchObject({ code: 'not-found', correctiveHint: expect.stringContaining('no slug') });
    expect(refusalOf(run(harness, 'memory.read', { slug: 'hand-note' })).message).toContain('could not be read');
  });

  it('answers a project with none, and takes no write permission', () => {
    const harness = makeHarness();
    expect(valueOf(run(harness, 'memory.read', {})).data).toMatchObject({ instructions: { file: null }, notes: [] });
  });
});

describe('memory.write', () => {
  it('previews the old and the new body, saves behind a confirmation, and undoes to the exact files', () => {
    const state = project();
    const harness = makeHarness({}, state);
    const before = JSON.stringify([...state.agentFiles.memory]);

    const preview = harness.previewPlan({ steps: [{ tool: 'memory.write', params: { title: 'Dialogue tags', type: 'style', body: 'Use said.' }, expect: 'the note is saved' }] });
    if (!preview.ok) throw new Error(`expected a preflight: ${preview.error.message}`);
    expect(preview.value.steps[0]?.preview).toEqual({ doc: 'Memory note: Dialogue tags', before: '', after: 'Use said.' });
    expect(state.agentFiles.memory).toHaveLength(1);

    const done = valueOf(run(harness, 'memory.write', { title: 'Dialogue tags', type: 'style', body: 'Use said.' }, confirmed));
    expect(done.data).toMatchObject({ slug: 'dialogue-tags', created: true });
    expect(state.agentFiles.memory.map((note) => note.slug)).toEqual(['dialogue-tags', 'process-endings']);
    expect(state.agentFiles.memory[0]).toMatchObject({ origin: 'agent', sourceTurn: expect.stringContaining('turn') });
    expect(state.agentFiles.index).toContain('(dialogue-tags.md)');
    expect(harness.undo.undo(done.undoGroupId ?? '').ok).toBe(true);
    expect(JSON.stringify([...state.agentFiles.memory])).toBe(before);
    expect(state.agentFiles.index).toContain('process-endings');
    expect(state.agentFiles.index).not.toContain('dialogue-tags');
  });

  it('is refused without a card, and writes nothing', () => {
    const state = project();
    const harness = makeHarness({}, state);
    expect(refusalOf(run(harness, 'memory.write', { title: 'Dialogue tags', type: 'style', body: 'Use said.' })).code).toBe('permission-denied');
    expect(state.agentFiles.memory).toHaveLength(1);
  });

  it('updates the note that has the title, keeps its slug, and checks the digest it was read at', () => {
    const state = project();
    const harness = makeHarness({}, state);
    const stale = refusalOf(run(harness, 'memory.write', { title: 'scene endings', type: 'process', body: 'New.', expectedDigest: textDigest('Old.') }, confirmed));
    expect(stale.code).toBe('revision-conflict');
    expect(state.agentFiles.memory[0]?.body).toBe(endings.body);

    const done = valueOf(run(harness, 'memory.write', { title: 'scene endings', type: 'process', body: 'New.', expectedDigest: textDigest(endings.body) }, confirmed));
    expect(done.data).toMatchObject({ slug: 'process-endings', created: false });
    expect(state.agentFiles.memory).toHaveLength(1);
    expect(state.agentFiles.memory[0]?.body).toBe('New.');
  });

  it('refuses a title that is a codex entry’s name or alias, naming codex.write', () => {
    const state = project();
    const harness = makeHarness({}, state);
    const error = refusalOf(run(harness, 'memory.write', { title: 'Elena', type: 'reference', body: 'Elena is left-handed.' }, confirmed));
    expect(error.code).toBe('invalid-params');
    expect(`${error.message} ${error.correctiveHint ?? ''}`).toContain('codex.write');
    expect(state.agentFiles.memory).toHaveLength(1);
  });

  it('does not name a codex entry that a read rule withholds when a guessed alias matches it, in a call or in a plan preflight', () => {
    const state = project();
    const entry = state.manifest.codex?.find((candidate) => candidate.name === 'Elena');
    if (entry === undefined) throw new Error('the fixture holds Elena');
    entry.aliases = ['Secret Alias'];
    entry.attachments = [LANDING];
    const harness = makeHarness({ rules: () => ({ rules: [{ effect: 'deny', tool: '*', source: 'project', scope: { subtree: CHAPTER_ONE }, access: 'read' }] }) }, state);
    const params = { title: 'Secret Alias', type: 'reference', body: 'Elena is left-handed.' };

    const error = refusalOf(run(harness, 'memory.write', params, confirmed));
    expect(error.code).toBe('invalid-params');
    expect(JSON.stringify(error)).not.toContain('Elena');
    const preview = harness.previewPlan({ steps: [{ tool: 'memory.write', params, expect: 'the note is saved' }] });
    expect(JSON.stringify(preview)).not.toContain('Elena');
    expect(state.agentFiles.memory).toHaveLength(1);
  });

  it('makes a slug from the title, adds a number when another note has it, and refuses a title with nothing to make one from', () => {
    const state = project();
    state.agentFiles = { ...state.agentFiles, memory: [...state.agentFiles.memory, { ...endings, slug: 'tone', title: 'Tone and mood' }] };
    const harness = makeHarness({}, state);
    // A title whose slug is taken by a note of another title: the number keeps both.
    valueOf(run(harness, 'memory.write', { title: 'Tone!', type: 'style', body: 'Dry.' }, confirmed));
    expect(state.agentFiles.memory.map((note) => note.slug)).toContain('tone-2');
    expect(refusalOf(run(harness, 'memory.write', { title: '!!!', type: 'style', body: 'x' }, confirmed)).message).toContain('slug');
  });

  it('refuses a body over 4,000 characters and an unknown type, naming the key', () => {
    const harness = makeHarness({}, project());
    expect(refusalOf(run(harness, 'memory.write', { title: 'Long', type: 'style', body: 'x'.repeat(4_001) }, confirmed)).code).toBe('limit-exceeded');
    expect(refusalOf(run(harness, 'memory.write', { title: 'Odd', type: 'lore', body: 'x' }, confirmed)).code).toBe('invalid-params');
  });
});

describe('instructions.propose', () => {
  it('previews the old and the new text, writes CAOTANG.md behind a confirmation, and undoes to the old file', () => {
    const state = project();
    const harness = makeHarness({}, state);
    const preview = harness.previewPlan({ steps: [{ tool: 'instructions.propose', params: { text: 'British spelling.\nPast tense.\n' }, expect: 'CAOTANG.md says it' }] });
    if (!preview.ok) throw new Error(`expected a preflight: ${preview.error.message}`);
    expect(preview.value.steps[0]?.preview).toEqual({ doc: 'CAOTANG.md', before: 'British spelling.\n', after: 'British spelling.\nPast tense.\n' });

    expect(refusalOf(run(harness, 'instructions.propose', { text: 'x' })).code).toBe('permission-denied');
    const done = valueOf(run(harness, 'instructions.propose', { text: 'British spelling.\nPast tense.\n', expectedDigest: textDigest('British spelling.\n') }, confirmed));
    expect(state.agentFiles.instructions?.text).toBe('British spelling.\nPast tense.\n');
    expect(done.summary).toContain('changed CAOTANG.md');
    expect(harness.undo.undo(done.undoGroupId ?? '').ok).toBe(true);
    expect(state.agentFiles.instructions?.text).toBe('British spelling.\n');
  });

  it('is a conflict when CAOTANG.md changed since the digest was read', () => {
    const state = project();
    const harness = makeHarness({}, state);
    expect(refusalOf(run(harness, 'instructions.propose', { text: 'x', expectedDigest: textDigest('older') }, confirmed)).code).toBe('revision-conflict');
    expect(state.agentFiles.instructions?.text).toBe('British spelling.\n');
  });
});

describe('what the agent cannot do', () => {
  it('has no tool that forgets a note or sets the instructions without a card', () => {
    expect(TOOL_NAMES.filter((name) => name.startsWith('memory.') || name.startsWith('instructions.'))).toEqual(['memory.read', 'memory.write', 'instructions.propose']);
    const harness = makeHarness({}, project());
    expect(refusalOf(run(harness, 'memory.forget', { slug: 'process-endings' }, confirmed)).code).toBeDefined();
  });
});
