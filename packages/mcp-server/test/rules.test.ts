/**
 * The project's agent rules at the MCP server (agent-harness §4, Rules; extensibility §9). The server reads `agent.rules` from the
 * folder it opened and gives them to the harness it calls tools through, so a host that connects is held to the writer's rules as the
 * agent in the app is: a deny refuses the call and names the rule, an ask becomes the host's question, and a read-deny keeps the
 * folder from tools, resources and prompts. A rule the load had to drop leaves the rules unreadable, and the server then refuses every
 * write. Nothing is mocked: the folder is written by the store and the client is the SDK's own.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { addDocument, addFolder, createEmptyManifest, createProjectState, writeProject, type PermissionRule } from '@caotang/store';

import { NodeArtifactFs } from '../src/index.js';
import { OPENED, acceptConfirm, connectClient, folderBytes, removeDir, resultJson, startOver, tempDir } from './support.js';

const ACT_ONE = 'n_ACT1ANE001';
const ACT_TWO = 'n_ACT2TW0001';
const SECRET = 'n_SECRET0001';
const OPEN = 'n_0PEN000001';
const SECRET_BODY = 'The keeper buried the ledger under the third stone.';

/** A folder with a locked chapter (Act 1) and a hidden one (Act 2), and a manifest carrying `rules` as given. */
async function project(rules: unknown): Promise<string> {
  const root = tempDir('rules');
  mkdirSync(root, { recursive: true });
  const fs = new NodeArtifactFs(root);
  const state = createProjectState(createEmptyManifest('Rules', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Act 1', now: OPENED, id: ACT_ONE });
  addFolder(state, { parentId: 'manuscript', title: 'Act 2', now: OPENED, id: ACT_TWO });
  addDocument(state, { parentId: ACT_ONE, title: 'The Open Scene', body: 'Fog.', now: OPENED, id: OPEN });
  addDocument(state, { parentId: ACT_TWO, title: 'The Secret Scene', body: SECRET_BODY, now: OPENED, id: SECRET, synopsis: 'A ledger.' });
  await writeProject(fs, state, { now: OPENED });
  const manifestPath = `${root}/caotang.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest['agent'] = { rules };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return root;
}

const LOCK: PermissionRule = { effect: 'deny', tool: '*', scope: { subtree: ACT_ONE }, access: 'write', note: 'Locked for my editor' };
const HIDE: PermissionRule = { effect: 'deny', tool: '*', scope: { subtree: ACT_TWO }, access: 'read', note: 'Private' };

describe('the project’s rules at the server', () => {
  it('refuses a write into a locked chapter, names the rule, and leaves the folder as it was', async () => {
    const root = await project([LOCK]);
    const server = await startOver(root, true);
    const client = await connectClient(server.url, server.token);
    try {
      const before = folderBytes(root);
      const refused = await client.callTool({ name: 'notes.append', arguments: { doc: OPEN, text: 'x' } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(resultJson(refused))).toContain('Locked for my editor');
      expect(JSON.stringify(resultJson(refused))).toContain('permission-denied');
      expect(folderBytes(root)).toEqual(before);
      // The other chapter is the host's to write.
      const allowed = await client.callTool({ name: 'notes.append', arguments: { doc: SECRET, text: 'ok' } });
      expect(allowed.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });

  it('turns an ask on a write into the host’s question: declined writes nothing, accepted writes', async () => {
    const root = await project([{ effect: 'ask', tool: 'notes.append', note: 'Tell me first' }]);
    const server = await startOver(root, true);
    const asked: string[] = [];
    const no = await connectClient(server.url, server.token, (params) => {
      asked.push(JSON.stringify(params));
      return { action: 'decline' };
    });
    try {
      const before = folderBytes(root);
      const declined = await no.callTool({ name: 'notes.append', arguments: { doc: OPEN, text: 'x' } });
      expect(JSON.stringify(declined)).toContain('declined');
      expect(asked).toHaveLength(1);
      expect(folderBytes(root)).toEqual(before);
    } finally {
      await no.close();
    }
    const yes = await connectClient(server.url, server.token, acceptConfirm);
    try {
      const written = await yes.callTool({ name: 'notes.append', arguments: { doc: OPEN, text: 'x' } });
      expect(written.isError).not.toBe(true);
      expect(Object.values(folderBytes(root)).join('\n')).toContain('x');
    } finally {
      await yes.close();
      await server.close();
      removeDir(root);
    }
  });

  it('keeps a read-denied chapter out of the tree, the overview, the resources and the prompts, and refuses a read of it', async () => {
    const root = await project([HIDE]);
    const server = await startOver(root, false);
    const client = await connectClient(server.url, server.token);
    try {
      const tree = await client.callTool({ name: 'binder.read_tree', arguments: { root: 'manuscript', depth: 3 } });
      expect(JSON.stringify(resultJson(tree))).not.toContain('Act 2');
      expect(JSON.stringify(resultJson(tree))).not.toContain('Secret');
      expect((resultJson(tree)['data'] as { withheld: number }).withheld).toBe(2);

      const refused = await client.callTool({ name: 'doc.read', arguments: { doc: SECRET } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).not.toContain(SECRET_BODY);

      const listed = JSON.stringify((await client.listResources()).resources);
      expect(listed).not.toContain('Secret');
      expect(listed).toContain('The Open Scene');
      await expect(client.readResource({ uri: `caotang://doc/${SECRET}` })).rejects.toBeDefined();
      await expect(client.readResource({ uri: `caotang://notes/${SECRET}` })).rejects.toBeDefined();
      const binder = (await client.readResource({ uri: 'caotang://binder' })).contents.map((entry) => ('text' in entry ? entry.text : '')).join('');
      expect(binder).not.toContain('Secret');

      await expect(client.getPrompt({ name: 'fill-synopsis', arguments: { doc: SECRET } })).rejects.toBeDefined();
      const open = await client.getPrompt({ name: 'fill-synopsis', arguments: { doc: OPEN } });
      expect(JSON.stringify(open)).not.toContain(SECRET_BODY);
      expect(JSON.stringify(open)).not.toContain('Secret');
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });

  it('holds a read-deny aimed at one read tool to the resource that mirrors it', async () => {
    const root = await project([{ effect: 'deny', tool: 'doc.*', scope: { subtree: ACT_TWO }, access: 'read' }, { effect: 'deny', tool: 'notes.read', scope: { subtree: ACT_TWO }, access: 'read' }]);
    const server = await startOver(root, false);
    const client = await connectClient(server.url, server.token);
    try {
      expect(JSON.stringify((await client.listResources()).resources)).not.toContain('Secret');
      await expect(client.readResource({ uri: `caotang://doc/${SECRET}` })).rejects.toBeDefined();
      await expect(client.readResource({ uri: `caotang://notes/${SECRET}` })).rejects.toBeDefined();
      const open = await client.readResource({ uri: `caotang://doc/${OPEN}` });
      expect(JSON.stringify(open)).toContain('Fog.');
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });

  it('fails closed when a rule in the file could not be read: every write is refused, a read is not', async () => {
    const root = await project([LOCK, { effect: 'deny' }]);
    const notes: string[] = [];
    const server = await startOver(root, true, (line) => notes.push(line));
    const client = await connectClient(server.url, server.token);
    try {
      const before = folderBytes(root);
      const refused = await client.callTool({ name: 'notes.append', arguments: { doc: SECRET, text: 'x' } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(resultJson(refused))).toContain('the rules could not be read');
      expect(folderBytes(root)).toEqual(before);
      const read = await client.callTool({ name: 'doc.read', arguments: { doc: SECRET } });
      expect(read.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });

  it('does not treat an allow rule as a lost restriction: it has no effect and writes stay open', async () => {
    const root = await project([{ effect: 'allow', tool: 'notes.append' }, LOCK]);
    const server = await startOver(root, true);
    const client = await connectClient(server.url, server.token);
    try {
      const allowed = await client.callTool({ name: 'notes.append', arguments: { doc: SECRET, text: 'ok' } });
      expect(allowed.isError).not.toBe(true);
      const refused = await client.callTool({ name: 'notes.append', arguments: { doc: OPEN, text: 'no' } });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });

  it('holds a project with no rules to nothing', async () => {
    const root = await project([]);
    const server = await startOver(root, true);
    const client = await connectClient(server.url, server.token);
    try {
      expect((await client.callTool({ name: 'notes.append', arguments: { doc: OPEN, text: 'x' } })).isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      removeDir(root);
    }
  });
});
