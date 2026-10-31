/**
 * A dialogue container as the focus of `dialogue.draft` (dialogue-narrative.md §7, context-assembly §2): L4 is the container's prior
 * beats, one line each, L2 is the codex of the characters who speak in it, and L5 is its Ink as the focus. A container is a focus only
 * for `dialogue.draft`, and a document is the focus of every other tool.
 */

import { describe, expect, it } from 'vitest';

import { addDocument, createEmptyManifest, createProjectState, type CodexEntry, type ProjectState } from '@caotang/store';

import { ContextError, assemble, type AgentTask, type AppSnapshot, type LayerReport } from '../src/index.js';
import { textOf } from '@caotang/gateway';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const TAVERN = 'n_TAVERN0001';
const BEAT = 'n_BEAT000001';
const PROSE = 'n_PROSE00001';
const INK = ['=== opening ===', 'Elena: The ferry is late again.', '-> arrival', '', '=== arrival ===', 'A bird sings from the rafters.', '-> END'].join('\n');

function codexEntry(name: string, overrides: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id: `c_${name.toUpperCase().padEnd(10, 'X').slice(0, 10)}`,
    name,
    aliases: [],
    type: 'character',
    description: `${name} keeps the light.`,
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** A manuscript with a prose scene and a dialogue container holding `ink`, and the codex `entries`. */
function appWith(ink: string, entries: readonly CodexEntry[]): AppSnapshot {
  const state: ProjectState = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
  addDocument(state, { id: PROSE, parentId: 'manuscript', title: 'The Landing', body: 'Elena came in on the tide.', now: NOW });
  addDocument(state, { id: TAVERN, parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body: ink, now: NOW });
  state.manifest.codex = [...entries];
  return { state };
}

function layer(prompt: ReturnType<typeof assemble>, id: LayerReport['id']): LayerReport {
  const found = prompt.layers.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no ${id} layer`);
  return found;
}

const DIALOGUE: AgentTask = { tool: 'dialogue.draft', instruction: 'Brief: A thank-you.', focus: TAVERN };

describe('dialogue.draft over a container as its focus (dialogue-narrative §7)', () => {
  it('keeps the codex entry of each character who speaks in the container in L2, and no other entry the Ink does not name', () => {
    const app = appWith(INK, [codexEntry('Elena'), codexEntry('Marek')]);
    const prompt = assemble(DIALOGUE, app);
    expect(layer(prompt, 'L2').kept.map((item) => item.label)).toEqual(['Elena']);
    expect(layer(prompt, 'L2').kept[0]?.reason).toContain('speakers');
  });

  it('applies the codex policy to a speaker: a `never` speaker stays out of L2', () => {
    const app = appWith(INK, [codexEntry('Elena', { includePolicy: 'never' })]);
    expect(layer(assemble(DIALOGUE, app), 'L2').kept).toEqual([]);
  });

  it('keeps the container’s beats in L4 in body order, each named by its knot', () => {
    const prompt = assemble(DIALOGUE, appWith(INK, []));
    expect(layer(prompt, 'L4').kept.map((item) => item.label)).toEqual(['opening', 'arrival']);
    const body = prompt.messages.map((message) => textOf(message.content)).join('\n');
    expect(body).toContain('## opening (beat)\nElena: The ferry is late again.');
    expect(body).toContain('## arrival (beat)\nA bird sings from the rafters.');
  });

  it('reads the container’s Ink as its focus, and a container with no lines has no beats and no speakers', () => {
    const prompt = assemble(DIALOGUE, appWith(INK, [codexEntry('Elena')]));
    expect(prompt.focus).toMatchObject({ doc: TAVERN, mode: 'continue' });
    expect(prompt.focus?.head).toContain('Elena: The ferry is late again.');

    const empty = assemble(DIALOGUE, appWith('', [codexEntry('Elena')]));
    expect(layer(empty, 'L4').kept).toEqual([]);
    expect(layer(empty, 'L2').kept).toEqual([]);
  });

  it('refuses a document as the focus of dialogue.draft, and names the kind it is', () => {
    const app = appWith(INK, []);
    expect(() => assemble({ ...DIALOGUE, focus: PROSE }, app)).toThrow(ContextError);
    expect(() => assemble({ ...DIALOGUE, focus: PROSE }, app)).toThrow(/is a document, not a dialogue container/);
  });

  it('refuses a container as the focus of a scene draft, since a scene’s focus is a document', () => {
    const app = appWith(INK, []);
    expect(() => assemble({ tool: 'scene.draft', instruction: 'Continue.', focus: TAVERN }, app)).toThrow(/is a dialogue, not a document/);
  });

  it('refuses dialogue.draft with no focus', () => {
    expect(() => assemble({ tool: 'dialogue.draft', instruction: 'Brief: x' }, appWith(INK, []))).toThrow(/needs a focus container/);
  });

  it('accepts a beat as the focus of dialogue.draft, the node types the container resolver takes, so the loop and the assembly agree', () => {
    // The loop resolves a beat as a container (resolveContainer); the assembly must take the same node types, or a beat would pass the
    // loop and then fail here with a model-facing error.
    const state: ProjectState = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW));
    addDocument(state, { id: BEAT, parentId: 'manuscript', title: 'Beat', type: 'beat', body: INK, now: NOW });
    const prompt = assemble({ tool: 'dialogue.draft', instruction: 'Brief: A thank-you.', focus: BEAT }, { state });
    expect(prompt.focus).toMatchObject({ doc: BEAT });
    expect(layer(prompt, 'L4').kept.map((item) => item.label)).toEqual(['opening', 'arrival']);
  });
});
