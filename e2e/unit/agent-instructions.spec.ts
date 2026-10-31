import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, readProjectState, writeProjectState } from '../../packages/store/src/index.js';

import { agentInstructionsView, tokensLabel } from '../../apps/desktop/src/app/agent-instructions-model.js';
import { Persistence } from '../../apps/desktop/src/app/persistence.js';
import { copyState, planPersistence, shadowOf } from '../../apps/desktop/src/app/persistence-plan.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { stepPreviewOf } from '../../apps/desktop/src/app/plan-preview.js';
import { normalizeSettings } from '../../apps/desktop/src/app/settings.js';

import { project } from './fixtures.js';

/**
 * The app's side of the agent's files (context-assembly.md §2, layer LI): what the panel says about CAOTANG.md and the notes against the
 * layer's cap, what the store must be told when they change, the session's commands, and the card's view of a proposed change.
 */

const long = (lines: number): string => Array.from({ length: lines }, (_, i) => `Rule ${String(i + 1).padStart(3, '0')}: keep the voice dry, always.`).join('\n');

// A session registers its flush signals on the page's document and window; a Node worker has neither.
const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown } | null = null;
test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});
test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
});

async function sessionFor(state = project()) {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  return { store, session: new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null }) };
}

test.describe('the panel’s view', () => {
  test('says nothing for a project with no instructions, and sizes the file and each note when it has them', async () => {
    const { session } = await sessionFor();
    const empty = agentInstructionsView(session.state);
    expect(empty).toMatchObject({ file: null, text: '', instructionsTokens: 0, indexTokens: 0, sentTokens: 0, capLines: [], notes: [], unreadable: [] });

    expect(session.setInstructions('British spelling.\n').ok).toBe(true);
    expect(session.writeMemoryNote({ slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'Use "said" for tags.' }).ok).toBe(true);
    const view = agentInstructionsView(session.state);
    expect(view.file).toBe('CAOTANG.md');
    expect(view.notes.map((note) => [note.slug, note.origin, note.tokens])).toEqual([['style-dialogue', 'writer', 5]]);
    expect(view.budget).toBe(1_500);
    expect(view.sentTokens).toBeGreaterThan(view.instructionsTokens);
    expect(view.capLines).toEqual([]);
  });

  test('names the file the cap cut, with the sentence the layer records, under the writer’s own cap', async () => {
    const { session } = await sessionFor();
    session.setInstructions(long(120));
    const view = agentInstructionsView(session.state, 300);
    expect(view.budget).toBe(300);
    expect(view.capLines).toHaveLength(1);
    expect(view.capLines[0]).toMatch(/^CAOTANG\.md is [\d,]+ tokens; the first [\d,]+ were sent$/u);
    expect(view.sentTokens).toBeLessThanOrEqual(300);
    expect(agentInstructionsView(session.state).capLines).toEqual([]);
  });

  test('lists a note the load could not read, and a file held back for its bytes', async () => {
    const state = project();
    state.agentFiles = { memory: [], declined: new Map([['memory/hand-note.md', 'plain']]), unreadable: ['CAOTANG.md'] };
    const view = agentInstructionsView(state);
    expect(view.unreadable).toEqual([{ path: 'memory/hand-note.md', slug: 'hand-note' }]);
    expect(view.heldBack).toEqual(['CAOTANG.md']);
  });

  test('counts a token as the assembly does', () => {
    expect(tokensLabel(1)).toBe('1 token');
    expect(tokensLabel(1_500)).toBe('1,500 tokens');
  });
});

test.describe('what the store must be told about the agent’s files', () => {
  test('a change is an incremental write of the files alone, and no change is nothing', async () => {
    const { session } = await sessionFor();
    const shadow = shadowOf(session.state);
    expect(planPersistence(shadow, session.state)).toEqual({ kind: 'none' });
    session.setInstructions('One.\n');
    const plan = planPersistence(shadow, session.state);
    expect(plan.kind).toBe('incremental');
    if (plan.kind !== 'incremental') return;
    expect(plan.bodies).toEqual([]);
    expect(plan.manifest).toBeNull();
    expect(plan.skills).toBeNull();
    expect(plan.agentFiles?.instructions?.text).toBe('One.\n');
  });

  test('a copy of the state keeps the files and the removals owed, and shares nothing with it', async () => {
    const { session } = await sessionFor();
    session.writeMemoryNote({ slug: 'a-note', type: 'process', title: 'A note', body: 'Body.' });
    session.forgetMemoryNote('a-note');
    const copy = copyState(session.state);
    expect(copy.agentFiles.memory).toEqual([]);
    expect([...copy.removedAgentFiles].sort()).toEqual(['memory/MEMORY.md', 'memory/a-note.md']);
    copy.removedAgentFiles.clear();
    expect(session.state.removedAgentFiles.size).toBe(2);
  });

  test('reach the store through the persistence pass, and come back with the project', async () => {
    const state = project();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);
    const persistence = new Persistence(store, state.manifest.project.id, () => state, shadowOf(state));
    const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
    session.setInstructions('British spelling.\n');
    session.writeMemoryNote({ slug: 'style-dialogue', type: 'style', title: 'Dialogue tags', body: 'Use said.' });
    await persistence.settle();
    expect(persistence.getStatus()).toBe('idle');
    const back = await readProjectState(store, state.manifest.project.id);
    expect(back.agentFiles.instructions).toEqual({ path: 'CAOTANG.md', text: 'British spelling.\n' });
    expect(back.agentFiles.memory.map((note) => note.slug)).toEqual(['style-dialogue']);
    expect(back.agentFiles.index).toContain('style-dialogue.md');

    session.forgetMemoryNote('style-dialogue');
    await persistence.settle();
    expect((await readProjectState(store, state.manifest.project.id)).agentFiles.memory).toEqual([]);
  });
});

test.describe('the session’s commands', () => {
  test('save the file and the notes as the writer, undo each, and refuse a stale digest with the bus’s words', async () => {
    const { session } = await sessionFor();
    expect(session.setInstructions('One.\n').ok).toBe(true);
    const stale = session.setInstructions('Two.\n', '00000000000000');
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.error.code).toBe('revision-conflict');
    expect(session.state.agentFiles.instructions?.text).toBe('One.\n');

    expect(session.writeMemoryNote({ slug: 'a-note', type: 'preference', title: 'A note', body: 'Body.' }).ok).toBe(true);
    expect(session.state.agentFiles.memory[0]?.origin).toBe('writer');
    expect(await session.undoLast()).toBe(true);
    expect(session.state.agentFiles.memory).toEqual([]);
    expect(await session.undoLast()).toBe(true);
    expect(session.state.agentFiles.instructions).toBeUndefined();
  });

  test('forget a note, and one undo brings it back', async () => {
    const { session } = await sessionFor();
    session.writeMemoryNote({ slug: 'a-note', type: 'preference', title: 'A note', body: 'Body.' });
    expect(session.forgetMemoryNote('a-note').ok).toBe(true);
    expect(session.state.agentFiles.memory).toEqual([]);
    expect(await session.undoLast()).toBe(true);
    expect(session.state.agentFiles.memory.map((note) => note.slug)).toEqual(['a-note']);
    expect(session.forgetMemoryNote('nope').ok).toBe(false);
  });
});

test.describe('the card’s view of a proposed change', () => {
  const state = project();

  test('shows a memory note and CAOTANG.md as a difference, with the words of what the text is', () => {
    const memory = stepPreviewOf('memory.write', { doc: 'Memory note: Dialogue tags', before: '', after: 'Use said.' }, state);
    expect(memory).toMatchObject({ kind: 'notes', subject: 'memory', doc: 'Memory note: Dialogue tags', wordsBefore: 0, wordsAfter: 2 });
    const instructions = stepPreviewOf('instructions.propose', { doc: 'CAOTANG.md', before: 'One rule.', after: 'One rule. Two rules.' }, state);
    expect(instructions).toMatchObject({ kind: 'notes', subject: 'instructions', doc: 'CAOTANG.md' });
    expect(instructions?.kind === 'notes' && instructions.segments.map((segment) => segment.kind)).toEqual(['same', 'added']);
  });
});

test.describe('the Context settings', () => {
  test('keep the instructions layer’s cap in range, with the other layers’', () => {
    const settings = normalizeSettings({ context: { layerBudgets: { LI: 10, L2: 5_000 } } });
    expect(settings.context.layerBudgets).toEqual({ LI: 200, L2: 5_000 });
    expect(normalizeSettings({ context: { layerBudgets: { LI: 900 } } }).context.layerBudgets).toEqual({ LI: 900 });
  });
});
