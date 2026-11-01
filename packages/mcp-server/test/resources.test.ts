/**
 * The project as MCP resources (extensibility.md §9): what is listed and in what order, that a read is the read tool's text whole,
 * that it refuses in the tool's words, and that it never writes the folder. Subscriptions are in subscriptions.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { refusalSentence } from '@caotang/harness';

import { RESOURCE_MAX_BYTES, changeOf, docUri, notesUri } from '../src/resources.js';
import { hasBody } from '../src/uris.js';
import {
  CHAPTER_ONE,
  CHAPTER_TWO,
  ELENA,
  FERRYMAN,
  FERRYMAN_BODY,
  HARBOUR,
  HARBOUR_BODY,
  KESTREL,
  LANDING,
  LANDING_NOTES,
  STORM,
  STORM_BODY,
  connectClient,
  folderBytes,
  removeDir,
  resultJson,
  seedWriting,
  startFixture,
  tempDir,
  type Fixture,
} from './support.js';

const BINDER_ORDER = [LANDING, STORM, HARBOUR, FERRYMAN];

async function listed(client: Client): Promise<{ uri: string; name: string; mimeType?: string }[]> {
  return (await client.listResources()).resources;
}

async function textOf(client: Client, uri: string): Promise<{ text: string; mimeType?: string }> {
  const { contents } = await client.readResource({ uri });
  const [first] = contents;
  if (first === undefined || !('text' in first)) throw new Error(`no text for ${uri}`);
  return first.mimeType === undefined ? { text: first.text } : { text: first.text, mimeType: first.mimeType };
}

describe('the resource list', () => {
  let fixture: Fixture;
  let client: Client;

  beforeAll(async () => {
    fixture = await startFixture({ label: 'res-list', allowWrites: false, seed: true, writing: true });
    client = await connectClient(fixture.url, fixture.token);
  });

  afterAll(async () => {
    await client?.close();
    await fixture?.close();
  });

  it('lists the project, the binder and the codex, then every document in binder order and every codex entry in codex order', async () => {
    const uris = (await listed(client)).map((resource) => resource.uri);
    expect(uris).toEqual([
      'caotang://project',
      'caotang://binder',
      'caotang://codex',
      'caotang://timeline',
      'caotang://timeline.csv',
      'caotang://assets',
      ...BINDER_ORDER.map((id) => `caotang://doc/${id}`),
      // `always` first, then type in enum order, then name: the character before the bird.
      `caotang://codex/${ELENA}`,
      `caotang://codex/${KESTREL}`,
    ]);
  });

  it('lists the same bytes twice', async () => {
    const first = JSON.stringify(await client.listResources());
    const second = JSON.stringify(await client.listResources());
    expect(second).toBe(first);
  });

  it('names a node by its id and its title, and never by a file name', async () => {
    const all = await listed(client);
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/docs\/|codex\/n_|\.md|\.fountain|\.ink|caotang\.json/u);
    expect(all.find((resource) => resource.uri === docUri(LANDING))?.name).toBe('The Landing');
  });

  it('gives each body its own type: Markdown, Fountain for a screenplay, Ink as plain text', async () => {
    const byUri = new Map((await listed(client)).map((resource) => [resource.uri, resource.mimeType]));
    expect(byUri.get(docUri(LANDING))).toBe('text/markdown');
    expect(byUri.get(docUri(HARBOUR))).toBe('text/x-fountain');
    expect(byUri.get(docUri(FERRYMAN))).toBe('text/plain');
    expect(byUri.get('caotang://binder')).toBe('application/json');
  });

  it('lists the templates a host completes against', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      'caotang://asset/{id}',
      'caotang://codex/{id}',
      'caotang://doc/{id}',
      'caotang://notes/{id}',
    ]);
  });
});

describe('reading a resource', () => {
  let fixture: Fixture;
  let client: Client;

  beforeAll(async () => {
    fixture = await startFixture({ label: 'res-read', allowWrites: false, seed: true, writing: true });
    client = await connectClient(fixture.url, fixture.token);
  });

  afterAll(async () => {
    await client?.close();
    await fixture?.close();
  });

  it('returns a document as doc.read returns it', async () => {
    for (const [id, mime] of [
      [LANDING, 'text/markdown'],
      [STORM, 'text/markdown'],
      [HARBOUR, 'text/x-fountain'],
    ] as const) {
      const tool = resultJson(await client.callTool({ name: 'doc.read', arguments: { doc: id } }));
      const data = tool['data'] as { text: string };
      const read = await textOf(client, docUri(id));
      expect(read.text).toBe(data.text);
      expect(read.mimeType).toBe(mime);
    }
    expect((await textOf(client, docUri(STORM))).text).toBe(STORM_BODY);
    expect((await textOf(client, docUri(HARBOUR))).text).toBe(HARBOUR_BODY);
  });

  it('returns a dialogue container’s Ink as plain text', async () => {
    const read = await textOf(client, docUri(FERRYMAN));
    expect(read).toEqual({ text: FERRYMAN_BODY, mimeType: 'text/plain' });
  });

  it('returns the notes as notes.read returns them', async () => {
    const tool = resultJson(await client.callTool({ name: 'notes.read', arguments: { doc: LANDING } }));
    const data = tool['data'] as { synopsis: string; notes: string; keywords: string[] };
    const read = await textOf(client, notesUri(LANDING));
    expect(read.mimeType).toBe('text/markdown');
    expect(read.text).toContain(data.notes);
    expect(read.text).toContain(data.synopsis);
    expect(read.text).toContain(data.keywords.join(', '));
    expect(read.text.startsWith('# The Landing\n')).toBe(true);
    expect(LANDING_NOTES).toBe(data.notes);
  });

  it('returns a codex entry as codex.read returns it', async () => {
    const tool = resultJson(await client.callTool({ name: 'codex.read', arguments: { id: ELENA } }));
    const entry = (tool['data'] as { entries: { name: string; type: string; aliases: string[]; description: string }[] }).entries[0];
    const read = await textOf(client, `caotang://codex/${ELENA}`);
    expect(entry).toBeDefined();
    expect(read.text).toContain(`# ${entry?.name}`);
    expect(read.text).toContain(`Type: ${entry?.type}`);
    expect(read.text).toContain(`Aliases: ${entry?.aliases.join(', ')}`);
    expect(read.text).toContain(entry?.description ?? '');
  });

  it('returns the codex index and the binder as JSON, and the overview as Markdown with the ids to read by', async () => {
    const codex = JSON.parse((await textOf(client, 'caotang://codex')).text) as { entries: { id: string; name: string; aliases: string[] }[] };
    expect(codex.entries.map((entry) => entry.id)).toEqual([ELENA, KESTREL]);
    expect(codex.entries[0]?.aliases).toEqual(['Lena']);

    const binder = await textOf(client, 'caotang://binder');
    expect(binder.mimeType).toBe('application/json');
    const nodes = (JSON.parse(binder.text) as { nodes: { id: string }[] }).nodes.map((node) => node.id);
    expect(nodes).toEqual(expect.arrayContaining([CHAPTER_ONE, CHAPTER_TWO, ...BINDER_ORDER]));

    const project = await textOf(client, 'caotang://project');
    expect(project.mimeType).toBe('text/markdown');
    expect(project.text).toContain('The Lighthouse Keeper');
    expect(project.text).toContain(CHAPTER_ONE);
  });

  it('refuses an unknown id, and a folder where a document is wanted, with -32602 and the tool’s words', async () => {
    for (const ref of ['n_MSSNG00001', CHAPTER_ONE]) {
      const tool = resultJson(await client.callTool({ name: 'doc.read', arguments: { doc: ref } }));
      const error = tool['error'] as { message: string; correctiveHint?: string };
      const toolError = refusalSentence(error.message, error.correctiveHint);
      const refused = await client.readResource({ uri: docUri(ref) }).catch((error: unknown) => error as { code?: number; message: string });
      expect(refused).toMatchObject({ code: -32602 });
      expect((refused as { message: string }).message).toContain(toolError);
    }
    await expect(client.readResource({ uri: `caotang://codex/c_NOPE000001` })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('codex entry with id "c_NOPE000001"') as string,
    });
    await expect(client.readResource({ uri: 'caotang://elsewhere' })).rejects.toMatchObject({ code: -32602 });
  });

  it('completes on titles and names, and returns ids', async () => {
    const complete = async (uri: string, value: string): Promise<string[]> =>
      (await client.complete({ ref: { type: 'ref/resource', uri }, argument: { name: 'id', value } })).completion.values;
    expect(await complete('caotang://doc/{id}', 'land')).toEqual([LANDING]);
    expect(await complete('caotang://doc/{id}', 'THE')).toEqual([LANDING, STORM]);
    expect(await complete('caotang://doc/{id}', 'zzz')).toEqual([]);
    expect(await complete('caotang://doc/{id}', '')).toEqual(BINDER_ORDER);
    expect(await complete('caotang://codex/{id}', 'len')).toEqual([ELENA]);
    expect(await complete('caotang://codex/{id}', 'lena')).toEqual([ELENA]);
    expect(await complete('caotang://notes/{id}', 'chapter')).toEqual([CHAPTER_ONE, CHAPTER_TWO]);
  });

  it('caches nothing and nothing in a shared cache: ttlMs 0, cacheScope private', async () => {
    const result = (await client.readResource({ uri: docUri(LANDING) })) as unknown as Record<string, unknown>;
    expect(result['cacheScope']).toBe('private');
    expect(result['ttlMs']).toBe(0);
    const listing = (await client.listResources()) as unknown as Record<string, unknown>;
    expect(listing['cacheScope']).toBe('private');
  });
});

describe('a body over the ceiling', () => {
  it('is refused with its size, and is never cut', async () => {
    const root = tempDir('res-big');
    await seedWriting(root);
    const { openProject } = await import('../src/session.js');
    const { createToolRuntime, startHttpServer } = await import('../src/server.js');
    const { testToken } = await import('./support.js');
    const session = await openProject({ root, allowWrites: false });
    const big = 'The ferry was late. '.repeat(Math.ceil(RESOURCE_MAX_BYTES / 20) + 1);
    session.state.documents.set(LANDING, { id: LANDING, body: big, revision: 1 });
    const token = testToken();
    const server = await startHttpServer(createToolRuntime(session), { port: 0, token });
    const client = await connectClient(server.url, token);
    try {
      const bytes = Buffer.byteLength(big, 'utf8');
      const refused = await client.readResource({ uri: docUri(LANDING) }).catch((error: unknown) => error as { message: string });
      expect(refused).toMatchObject({ message: expect.stringContaining(`${bytes} bytes`) as string });
      expect((refused as { message: string }).message).toContain(`${RESOURCE_MAX_BYTES} bytes`);
      expect((refused as { message: string }).message).toContain('never cut');
      // The listing still names it, and a document under the ceiling still reads.
      expect((await listed(client)).map((resource) => resource.uri)).toContain(docUri(LANDING));
      expect((await textOf(client, docUri(STORM))).text).toBe(STORM_BODY);
    } finally {
      await client.close();
      await server.close();
      await session.close();
      removeDir(root);
    }
  }, 30_000);
});

describe('reading never writes the folder', () => {
  it.each([false, true])('leaves every file as it was, with allowWrites %s', async (allowWrites) => {
    const fixture = await startFixture({ label: `res-digest-${allowWrites}`, allowWrites, seed: true, writing: true });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const before = folderBytes(fixture.root);
      for (const resource of await listed(client)) await client.readResource({ uri: resource.uri });
      await client.readResource({ uri: notesUri(LANDING) });
      await client.readResource({ uri: notesUri(CHAPTER_ONE) });
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});

describe('what a log row changes', () => {
  it('maps commands to the resources they touch', async () => {
    const fixture = await startFixture({ label: 'res-change', allowWrites: false, seed: true, writing: true });
    try {
      const { state } = fixture.session;
      const row = (command: string, ...ids: string[]) => ({
        at: 0,
        command,
        issuedBy: 'agent' as const,
        source: 'mcp' as const,
        affected: ids.map((nodeId) => ({ nodeId, title: nodeId })),
        summary: command,
      });
      expect(changeOf(state, [row('notes.append', LANDING)])).toEqual({
        updated: ['caotang://assets', 'caotang://binder', notesUri(LANDING), 'caotang://project', 'caotang://timeline', 'caotang://timeline.csv'].sort(),
        listChanged: false,
      });
      expect(changeOf(state, [row('doc.write', STORM)]).updated).toContain(docUri(STORM));
      expect(changeOf(state, [row('binder.move', STORM)]).listChanged).toBe(true);
      expect(changeOf(state, [row('binder.rename', STORM)])).toMatchObject({ listChanged: true, updated: expect.arrayContaining([notesUri(STORM)]) as string[] });
      const codex = changeOf(state, [row('codex.upsert')]);
      expect(codex.listChanged).toBe(true);
      expect(codex.updated).toEqual(expect.arrayContaining(['caotang://codex', `caotang://codex/${ELENA}`, `caotang://codex/${KESTREL}`]));
      // A declaration that touches only coherence.json still refreshes the timeline, and nothing else.
      expect(changeOf(state, [row('coherence.setSceneMeta', STORM)])).toEqual({ updated: ['caotang://timeline', 'caotang://timeline.csv'], listChanged: false });
      expect(changeOf(state, [row('view.setScroll', STORM), row('export.compile')])).toEqual({ updated: [], listChanged: false });
      // A folder has no body of its own.
      expect(changeOf(state, [row('doc.write', CHAPTER_ONE)]).updated).not.toContain(docUri(CHAPTER_ONE));
      expect(state.manifest.tree.filter(hasBody).map((node) => node.id)).toEqual(expect.arrayContaining(BINDER_ORDER));
    } finally {
      await fixture.close();
    }
  });
});
