/**
 * CAOTANG.md and the memory notes through the server (context-assembly.md §2, layer LI): a host reads both, through `memory.read` and in
 * every prompt, and changes neither. The folder is the whole observable state, so each read is held to leave it as it was.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { textDigest } from '@caotang/bus';
import { serializeMemoryFile, type MemoryFile } from '@caotang/store';

import { STORM, connectClient, folderBytes, removeDir, resultJson, seedWriting, startOver, tempDir, type Fixture } from './support.js';

const RULE = 'No semicolons in dialogue.';
const note: MemoryFile = {
  slug: 'process-endings',
  type: 'process',
  title: 'Scene endings',
  body: 'End on a line of dialogue where possible.',
  modified: '2026-10-01T10:00:00.000Z',
  origin: 'agent',
  sourceTurn: 'turn_1',
};

/** Writes the writer's file and one note into a project folder before it is opened, as another program (or the app) would have. */
function seedAgentFiles(root: string): void {
  writeFileSync(join(root, 'CAOTANG.md'), `British spelling.\n${RULE}\n`);
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'process-endings.md'), serializeMemoryFile(note));
  writeFileSync(join(root, 'memory', 'MEMORY.md'), '- [Scene endings](process-endings.md) (process): End on a line of dialogue where possible.\n');
}

describe('the agent files through the server', () => {
  let readOnly: Fixture;
  let writable: Fixture;
  let roClient: Client;
  let rwClient: Client;

  /** A project folder with the agent files in it, opened by a server: the files are read at its open. */
  async function open(label: string, allowWrites: boolean): Promise<Fixture> {
    const root = tempDir(label);
    await seedWriting(root);
    seedAgentFiles(root);
    return startOver(root, allowWrites);
  }

  beforeAll(async () => {
    readOnly = await open('agent-ro', false);
    writable = await open('agent-rw', true);
    roClient = await connectClient(readOnly.url, readOnly.token);
    rwClient = await connectClient(writable.url, writable.token);
  });

  afterAll(async () => {
    await roClient?.close();
    await rwClient?.close();
    for (const fixture of [readOnly, writable]) {
      await fixture?.stop();
      if (fixture !== undefined) removeDir(fixture.root);
    }
  });

  it('lists memory.read on a read-only server, and never lists a write of the agent files, with writes on', async () => {
    const ro = (await roClient.listTools()).tools.map((tool) => tool.name);
    expect(ro).toContain('memory.read');
    expect(ro).not.toContain('memory.write');
    expect(ro).not.toContain('instructions.propose');
    const tool = (await roClient.listTools()).tools.find((candidate) => candidate.name === 'memory.read');
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    const rw = (await rwClient.listTools()).tools.map((candidate) => candidate.name);
    for (const name of ['memory.write', 'instructions.propose', 'memory.forget']) expect(rw, name).not.toContain(name);
  });

  it('reads CAOTANG.md’s digest and the notes from the folder, and one note whole, leaving the folder as it was', async () => {
    const before = folderBytes(readOnly.root);
    const list = resultJson(await roClient.callTool({ name: 'memory.read', arguments: {} }));
    const data = (list['data'] ?? list) as Record<string, unknown>;
    expect(data['instructions']).toMatchObject({ file: 'CAOTANG.md', digest: textDigest(`British spelling.\n${RULE}\n`) });
    expect(data['notes']).toMatchObject([{ slug: 'process-endings', title: 'Scene endings', type: 'process', origin: 'agent' }]);

    const one = resultJson(await roClient.callTool({ name: 'memory.read', arguments: { slug: 'process-endings' } }));
    expect(JSON.stringify(one)).toContain(note.body);
    const missing = await roClient.callTool({ name: 'memory.read', arguments: { slug: 'nope' } });
    expect(missing.isError).toBe(true);
    expect(folderBytes(readOnly.root)).toEqual(before);
  });

  it('carries CAOTANG.md and the memory index in the prompts, as the in-app assembly does', async () => {
    const { messages } = await roClient.getPrompt({ name: 'draft-scene', arguments: { doc: STORM, instruction: 'Carry on.', mode: 'continue' } });
    const [message] = messages;
    const text = message?.content.type === 'text' ? message.content.text : '';
    expect(text).toContain('# Instructions');
    expect(text).toContain(RULE);
    expect(text).toContain('British spelling.');
    expect(text.indexOf('# Instructions')).toBeLessThan(text.indexOf('# Project'));
    expect(text).toContain('Scene endings');
    expect(text).not.toContain('2026-10-01');
    expect(text).not.toContain('turn_1');
  });

  it('refuses a call to a write of the agent files, and writes nothing', async () => {
    const before = folderBytes(writable.root);
    /** A refusal is an error result, or a rejected request for a name the server does not list. */
    const refused = (call: Promise<{ isError?: boolean | undefined }>): Promise<boolean> => call.then((result) => result.isError === true, () => true);
    expect(await refused(rwClient.callTool({ name: 'memory.write', arguments: { title: 'x', type: 'style', body: 'x' } }))).toBe(true);
    expect(await refused(rwClient.callTool({ name: 'instructions.propose', arguments: { text: 'x' } }))).toBe(true);
    const forget = await rwClient.callTool({ name: 'memory.forget', arguments: { slug: 'process-endings' } });
    expect(forget.isError).toBe(true);
    expect(JSON.stringify(forget)).toContain('hard-denied');
    expect(folderBytes(writable.root)).toEqual(before);
  });
});
