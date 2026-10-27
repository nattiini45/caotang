/**
 * The project's macros at the MCP server (extensibility.md §10). The server lists and runs no macro in this build, and it must not lose
 * one: a host that writes into a project the app saved macros in saves `caotang.json` through the store, so `macros[]` has to come back
 * out as it went in. Nothing is mocked: the folder is written by the store and the client is the SDK's own.
 */

import { mkdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { addDocument, addFolder, createEmptyManifest, createProjectState, writeProject, type ProjectMacro } from '@caotang/store';

import { NodeArtifactFs } from '../src/index.js';
import { OPENED, connectClient, removeDir, resultJson, startOver, tempDir } from './support.js';

const CHAPTER = 'n_CHAPTR0001';
const SCENE = 'n_BEACH00001';

const MACRO: ProjectMacro = {
  id: 'm_7K2QX9M4A1',
  slug: 'revise-chapter',
  name: 'Revise chapter',
  description: 'Marks a chapter revised and notes it.',
  params: { kind: 'object', description: 'The macro params.', properties: { chapter: { kind: 'string', description: 'The chapter.' } }, required: ['chapter'] },
  steps: [{ tool: 'notes.append', params: { doc: { $param: 'chapter' }, text: 'Revised.' }, expect: 'A note is added.' }],
};

async function project(): Promise<string> {
  const root = tempDir('macros');
  mkdirSync(root, { recursive: true });
  const state = createProjectState(createEmptyManifest('Macros', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'The Landing', body: 'Fog.', now: OPENED, id: SCENE });
  state.manifest.macros = [MACRO];
  await writeProject(new NodeArtifactFs(root), state, { now: OPENED });
  return root;
}

const macrosOf = (root: string): unknown => (JSON.parse(readFileSync(`${root}/caotang.json`, 'utf8')) as { macros?: unknown }).macros;

describe('macros at the server', () => {
  it('keeps macros[] through a write a host makes, and lists no tool for them', async () => {
    const root = await project();
    const before = macrosOf(root);
    expect(before).toEqual([MACRO]);
    const server = await startOver(root, true);
    const client = await connectClient(server.url, server.token);
    try {
      const written = await client.callTool({ name: 'notes.append', arguments: { doc: SCENE, text: 'ok' } });
      expect(written.isError).not.toBe(true);
      expect(macrosOf(root)).toEqual(before);

      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools.filter((name) => name.startsWith('macro'))).toEqual([]);
      expect(JSON.stringify(resultJson(await client.callTool({ name: 'project.overview', arguments: {} })))).not.toContain('Revise chapter');
      await expect(client.callTool({ name: 'macro.revise-chapter', arguments: { chapter: SCENE } })).rejects.toThrow(/not found/);
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });
});
