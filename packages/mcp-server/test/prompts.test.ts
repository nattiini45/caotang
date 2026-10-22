/**
 * The writer's prompts (extensibility.md §9): each is the in-app agent's own context assembly for the same task, plus a closing
 * instruction. The golden files pin the bytes, so a change to the assembly or to a task is a deliberate change here too. Set
 * UPDATE_GOLDEN=1 to rewrite them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { assemble, type AgentTask } from '@caotang/context';
import { continuityTask, refusalSentence, sceneTask, synopsisInstruction } from '@caotang/harness';
import { readProject } from '@caotang/store';

import { NodeArtifactFs } from '../src/index.js';
import { PROMPTS, toPromptMessages } from '../src/prompts.js';
import {
  CHAPTER_ONE,
  CHAPTER_TWO,
  HARBOUR,
  LANDING,
  OPENED,
  STORM,
  STORM_BODY,
  connectClient,
  resultJson,
  startFixture,
  type Fixture,
} from './support.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden');

/** Compares text with a golden file, rewriting the file first when UPDATE_GOLDEN is set. */
function matchesGolden(name: string, text: string): void {
  const path = join(GOLDEN, name);
  if (process.env['UPDATE_GOLDEN'] === '1') {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, text);
  }
  expect(existsSync(path), `${name} is missing: run with UPDATE_GOLDEN=1`).toBe(true);
  expect(text).toBe(readFileSync(path, 'utf8'));
}

async function promptText(client: Client, name: string, args: Record<string, string>): Promise<string> {
  const { messages } = await client.getPrompt({ name, arguments: args });
  expect(messages).toHaveLength(1);
  const [message] = messages;
  if (message?.content.type !== 'text') throw new Error('expected a text message');
  expect(message.role).toBe('user');
  return message.content.text;
}

/** The project as a fresh open reads it: the state the in-app assembly would be given. */
async function stateOf(fixture: Fixture) {
  return (await readProject(new NodeArtifactFs(fixture.root), { now: OPENED })).state;
}

describe('the prompts', () => {
  let readOnly: Fixture;
  let writable: Fixture;
  let roClient: Client;
  let rwClient: Client;

  beforeAll(async () => {
    readOnly = await startFixture({ label: 'prompt-ro', allowWrites: false, seed: true, writing: true });
    writable = await startFixture({ label: 'prompt-rw', allowWrites: true, seed: true, writing: true });
    roClient = await connectClient(readOnly.url, readOnly.token);
    rwClient = await connectClient(writable.url, writable.token);
  });

  afterAll(async () => {
    await roClient?.close();
    await rwClient?.close();
    await readOnly?.close();
    await writable?.close();
  });

  it('lists the five prompts in every mode, each with its arguments', async () => {
    for (const client of [roClient, rwClient]) {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toEqual(['draft-scene', 'fill-synopsis', 'continuity-check', 'codex-from-doc', 'revise-with-codex']);
      const draft = prompts.find((prompt) => prompt.name === 'draft-scene');
      expect(draft?.arguments?.map((arg) => [arg.name, arg.required])).toEqual([
        ['doc', true],
        ['instruction', true],
        ['mode', false],
      ]);
      expect(prompts.find((prompt) => prompt.name === 'continuity-check')?.arguments?.map((arg) => [arg.name, arg.required])).toEqual([['scope', false]]);
    }
  });

  it('completes the document and the scope from the binder', async () => {
    const complete = async (name: string, argument: string, value: string): Promise<string[]> =>
      (await roClient.complete({ ref: { type: 'ref/prompt', name }, argument: { name: argument, value } })).completion.values;
    expect(await complete('draft-scene', 'doc', 'storm')).toEqual([STORM]);
    expect(await complete('revise-with-codex', 'doc', 'harb')).toEqual([HARBOUR]);
    expect(await complete('continuity-check', 'scope', 'chapter')).toEqual([CHAPTER_ONE, CHAPTER_TWO]);
    expect(await complete('draft-scene', 'instruction', 'x')).toEqual([]);
  });

  it('draft-scene is the in-app scene.draft assembly for the same task, then a closing instruction', async () => {
    const state = await stateOf(readOnly);
    const task = sceneTask('The Storm', STORM, 'continue', 'Carry on into the morning.', undefined, undefined, false);
    const assembled = assemble(task, { state }, {});
    const [system, user] = assembled.messages;
    const text = await promptText(roClient, 'draft-scene', { doc: STORM, instruction: 'Carry on into the morning.', mode: 'continue' });
    const handBack = PROMPTS.find((prompt) => prompt.name === 'draft-scene')?.handBack(false) ?? '';
    expect(text).toBe(`# Caotang context\n\n${system?.content}\n\n${user?.content}\n\n${handBack}`);
    expect(text).toContain(STORM_BODY.split('\n')[0] ?? '');
    expect(toPromptMessages(assembled, handBack)[0]?.content.text).toBe(text);
  });

  it('closes differently on a read-only server and with --allow-writes, naming only tools that server lists', async () => {
    const args = { doc: STORM, instruction: 'Carry on.', mode: 'continue' };
    const ro = await promptText(roClient, 'draft-scene', args);
    const rw = await promptText(rwClient, 'draft-scene', args);
    expect(ro).not.toBe(rw);
    expect(ro).toContain('This server is read-only');
    expect(rw).not.toContain('This server is read-only');
    expect(rw).toContain('doc.import');
    expect(ro).not.toContain('doc.import');

    const listed = new Set((await rwClient.listTools()).tools.map((tool) => tool.name));
    for (const prompt of PROMPTS) {
      const named = prompt.handBack(true).match(/\b[a-z]+\.[a-z_]+\b/gu) ?? [];
      for (const tool of named) expect(listed.has(tool), `${prompt.name} names ${tool}`).toBe(true);
    }
  });

  it('fill-synopsis, continuity-check, codex-from-doc and revise-with-codex are the in-app assemblies for their tasks', async () => {
    const state = await stateOf(readOnly);
    const text = (task: AgentTask): string =>
      assemble(task, { state }, {})
        .messages.map((message) => message.content)
        .join('\n\n');
    const storm = state.manifest.tree.find((node) => node.id === STORM);
    if (storm === undefined) throw new Error('fixture');

    const synopsis = await promptText(roClient, 'fill-synopsis', { doc: 'The Storm' });
    expect(synopsis).toContain(text({ tool: 'synopsis.fill', instruction: synopsisInstruction(storm, 'both'), focus: STORM }));

    const scoped = continuityTask([LANDING, STORM], []);
    expect(await promptText(roClient, 'continuity-check', { scope: CHAPTER_ONE })).toContain(text(scoped));
    // Left out, the scope is the whole manuscript: the two prose scenes, the screenplay scene (the dialogue container is not a document).
    const whole = await promptText(roClient, 'continuity-check', {});
    expect(whole).toContain('Check these documents for continuity problems.');
    expect(whole).toContain(text(continuityTask([LANDING, STORM, HARBOUR], [])));

    const codex = await promptText(roClient, 'codex-from-doc', { doc: STORM });
    expect(codex).toContain('The codex already holds: Elena (character), Kestrel (other).');
    expect(codex).toContain(STORM_BODY.split('\n')[0] ?? '');

    const revise = await promptText(roClient, 'revise-with-codex', { doc: STORM, instruction: 'Make it colder.' });
    const rewrite = sceneTask('The Storm', STORM, 'rewrite_selection', 'Make it colder.', { from: 0, to: STORM_BODY.length, exact: STORM_BODY }, undefined, false);
    expect(revise).toContain(text(rewrite));
  });

  it('matches the golden files, byte for byte', async () => {
    const draft = { doc: STORM, instruction: 'Carry on into the morning.', mode: 'continue' };
    matchesGolden('draft-scene.continue.read-only.txt', await promptText(roClient, 'draft-scene', draft));
    matchesGolden('draft-scene.continue.writes.txt', await promptText(rwClient, 'draft-scene', draft));
    matchesGolden('fill-synopsis.read-only.txt', await promptText(roClient, 'fill-synopsis', { doc: STORM }));
    matchesGolden('continuity-check.read-only.txt', await promptText(roClient, 'continuity-check', { scope: CHAPTER_ONE }));
    matchesGolden('codex-from-doc.read-only.txt', await promptText(roClient, 'codex-from-doc', { doc: STORM }));
    matchesGolden('revise-with-codex.read-only.txt', await promptText(roClient, 'revise-with-codex', { doc: STORM, instruction: 'Make it colder.' }));
  });

  it('refuses a folder where a document is wanted with the words doc.read uses', async () => {
    const tool = resultJson(await roClient.callTool({ name: 'doc.read', arguments: { doc: CHAPTER_ONE } }));
    const error = tool['error'] as { message: string; correctiveHint?: string };
    const expected = refusalSentence(error.message, error.correctiveHint);
    for (const name of ['draft-scene', 'fill-synopsis', 'codex-from-doc', 'revise-with-codex']) {
      await expect(roClient.getPrompt({ name, arguments: { doc: CHAPTER_ONE, instruction: 'x' } })).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining(expected) as string,
      });
    }
  });

  it('refuses a draft of a document that has text, as scene.draft does, an unknown mode, and a blank brief', async () => {
    await expect(roClient.getPrompt({ name: 'draft-scene', arguments: { doc: STORM, instruction: 'x' } })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('ode draft needs an empty document') as string,
    });
    await expect(roClient.getPrompt({ name: 'draft-scene', arguments: { doc: STORM, instruction: 'x', mode: 'sideways' } })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(roClient.getPrompt({ name: 'draft-scene', arguments: { doc: STORM } })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('nstruction must not be blank') as string,
    });
  });

  it('refuses a scope that is not a part or folder', async () => {
    await expect(roClient.getPrompt({ name: 'continuity-check', arguments: { scope: 'n_MSSNG00001' } })).rejects.toMatchObject({ code: -32602 });
  });

  it('calls no model and needs no key: the project is the only input', async () => {
    const text = await promptText(roClient, 'draft-scene', { doc: STORM, instruction: 'Carry on.', mode: 'continue' });
    expect(text).toContain('Caotang writing agent');
    expect(text).not.toMatch(/api[_ -]?key|bearer/iu);
  });
});
