/**
 * The MCP surface, end to end: an in-process server on port 0, and the SDK's own client
 * over Streamable HTTP. Each test states one property of extensibility.md §7 and §9.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client as LegacyClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Client } from '@modelcontextprotocol/client';
import { mcpExposure, metadataFor, TOOL_METADATA } from '@caotang/harness';
import { ArtifactNotFoundError, parseDocumentFile } from '@caotang/store';

import { createToolRuntime, LEGACY_ROUND_TIMEOUT_MS, LegacySessions, startHttpServer, type RunningHttpServer } from '../src/index.js';
import { openProject, ProjectContentError, type ProjectSession } from '../src/index.js';
import { NodeArtifactFs } from '../src/node-fs.js';
import { manifestOnDisk } from '../src/session.js';
import {
  acceptConfirm,
  cancelConfirm,
  connectClient,
  declineConfirm,
  type Answer,
  type Exchange,
  HAND_WRITTEN_DOC,
  HAND_WRITTEN_DOC_NAME,
  LANDING_BODY,
  removeDir,
  resend,
  resultJson,
  seedProject,
  startFixture,
  tempDir,
  testToken,
  type Fixture,
  LANDING,
  CHAPTER_ONE,
  SHOTS_FOLDER,
} from './support.js';

/** Every file under a folder, relative and sorted, with its bytes: the whole observable state of the folder. */
function folderBytes(root: string, dir = ''): Record<string, string> {
  const out: Record<string, string> = {};
  const here = join(root, dir);
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, folderBytes(root, rel));
    else out[rel] = readFileSync(join(root, rel), 'utf8');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The names a client sees in `tools/list`, sorted. */
async function listedNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).sort();
}

const WRITE_TOOLS = TOOL_METADATA.filter((meta) => meta.risk === 'write-auto' || meta.risk === 'write-confirm').map((meta) => meta.name);
/**
 * The tools this server does not list, because no port answers them here and an unwired tool is never advertised
 * (tools.ts, the `wired` check). The first three draft with Caotang's own provider, which this server does not hold.
 * `coherence.review` (coherence.md §5.3) is here too, because its review pipeline calls the provider, and so are
 * `shots.derive` (its proposal is staged by a model) and `prompt.draft` (a model). `shots.annotate` is not here: the
 * harness completes the store registry this server passes it with the shot commands (runtime.ts, completeRegistry), so
 * the write-auto tool is wired, and it is listed on a server started with --allow-writes, as any write is.
 * `dialogue.draft` (dialogue-narrative.md §7) writes the Ink the loop stages, so it is unwired
 * until a provider supplies it. Its read, `dialogue.table`, is wired and listed. The video-prompt-pack module's
 * `prompt.variant` (video-prompt-pack.md §6) is a read that makes a model call, so it has no port here either, and it
 * is not listed. The name is kept as the list it has always been; the reasons are the comment's.
 */
const MODEL_BACKED = [
  'scene.draft',
  'synopsis.fill',
  'continuity.scan',
  'coherence.review',
  'shots.derive',
  'prompt.draft',
  'prompt.variant',
  'dialogue.draft',
];

describe('the tool surface', () => {
  let readOnly: Fixture;
  let writable: Fixture;

  beforeAll(async () => {
    readOnly = await startFixture({ label: 'ro', allowWrites: false, seed: true });
    writable = await startFixture({ label: 'rw', allowWrites: true, seed: true });
  });

  afterAll(async () => {
    await readOnly?.close();
    await writable?.close();
  });

  it('lists only the reads on a read-only server, and the writes too with --allow-writes', async () => {
    const roClient = await connectClient(readOnly.url, readOnly.token);
    const rwClient = await connectClient(writable.url, writable.token);
    try {
      const roNames = await listedNames(roClient);
      const rwNames = await listedNames(rwClient);

      for (const name of WRITE_TOOLS) expect(roNames).not.toContain(name);
      expect(roNames).toContain('project.overview');
      expect(roNames).toContain('binder.read_tree');

      for (const name of WRITE_TOOLS.filter((n) => !MODEL_BACKED.includes(n))) expect(rwNames).toContain(name);
      expect(rwNames).toContain('doc.import');
      // The negative half: no model-backed tool is listed, with writes on either. coherence.review is wired as an async port, so
      // without the async check it was the one listed here, and a host asked the user to approve a call that then refused.
      for (const name of MODEL_BACKED) expect(rwNames).not.toContain(name);
      expect(rwNames.length).toBeGreaterThan(roNames.length);
    } finally {
      await roClient.close();
      await rwClient.close();
    }
  });

  it('never lists agent.plan, the protocol row, nor any hard-denied command', async () => {
    const client = await connectClient(writable.url, writable.token);
    try {
      const names = await listedNames(client);
      expect(names).not.toContain('agent.plan');
      expect(names).not.toContain('project.deleteNode');
    } finally {
      await client.close();
    }
  });

  it('does not list tool.search, which could only report that no tool servers are connected to this one', async () => {
    const roClient = await connectClient(readOnly.url, readOnly.token);
    const rwClient = await connectClient(writable.url, writable.token);
    try {
      expect(await listedNames(roClient)).not.toContain('tool.search');
      expect(await listedNames(rwClient)).not.toContain('tool.search');
    } finally {
      await roClient.close();
      await rwClient.close();
    }
  });

  it('says which writes ask first in its instructions, and the tools that ask are exactly the ones whose description says so', async () => {
    const client = await connectClient(writable.url, writable.token);
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('A write tool whose description starts with "Requires user confirmation."');
      expect(instructions).not.toContain('a write that changes the project asks the user');
      const { tools } = await client.listTools();
      const asking = tools.filter((tool) => (tool.description ?? '').startsWith('Requires user confirmation.')).map((tool) => tool.name);
      // The write-confirm tools this server lists (the harness's registry, minus the model-backed ones it does not list).
      const confirming = TOOL_METADATA.filter((meta) => meta.risk === 'write-confirm' && mcpExposure(meta).exposed && !MODEL_BACKED.includes(meta.name))
        .map((meta) => meta.name);
      expect(asking.sort()).toEqual(confirming.filter((name) => tools.some((tool) => tool.name === name)).sort());
      expect(asking).toContain('doc.import');
    } finally {
      await client.close();
    }
  });

  it('advertises no list-change notices, because its tool list is fixed when the project opens', async () => {
    const client = await connectClient(writable.url, writable.token);
    try {
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('advertises each tool with the harness description, the harness schema and the harness annotations, unchanged', async () => {
    const client = await connectClient(writable.url, writable.token);
    try {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const listings = writable.session.harness.tools();
      for (const listing of listings) {
        const exposure = mcpExposure(listing);
        // tool.search is the one exposed tool this server leaves out: it has no tool server to search (tools.ts).
        if (!exposure.exposed || !listing.wired || listing.name === 'tool.search') {
          expect(byName.has(listing.name), `${listing.name} must not be listed`).toBe(false);
          continue;
        }
        const tool = byName.get(listing.name);
        expect(tool, `${listing.name} must be listed`).toBeDefined();
        expect(tool?.description).toBe(exposure.description);
        expect(tool?.inputSchema).toEqual(listing.schema);
        expect(tool?.annotations).toEqual(exposure.annotations);
      }
    } finally {
      await client.close();
    }
  });

  it('does not list a tool with no port on this server, and codex.read answers from the manifest', async () => {
    // Found by a large worldbuilding import: codex.read was listed and refused every
    // call, because the server built its harness without the codex port. An outside agent
    // plans around what is listed, so a tool that cannot run here is not listed.
    const client = await connectClient(writable.url, writable.token, acceptConfirm);
    try {
      const names = await listedNames(client);
      for (const name of MODEL_BACKED) expect(names).not.toContain(name);
      expect(names).toContain('codex.read');
      const result = await client.callTool({ name: 'codex.read', arguments: { limit: 5 } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(resultJson(result))).not.toContain('has no implementation');
      // Not registered, so the protocol answers "not found" rather than a tool error.
      await expect(client.callTool({ name: 'scene.draft', arguments: { doc: LANDING, instruction: 'Draft it.' } })).rejects.toThrow(/not found/);
    } finally {
      await client.close();
    }
  });

  it('marks write-confirm tools as needing confirmation, and reads as read-only', async () => {
    const client = await connectClient(writable.url, writable.token);
    try {
      const { tools } = await client.listTools();
      const docImport = tools.find((tool) => tool.name === 'doc.import');
      expect(docImport?.description?.startsWith('Requires user confirmation.')).toBe(true);
      expect(docImport?.annotations?.readOnlyHint).toBe(false);
      const overview = tools.find((tool) => tool.name === 'project.overview');
      expect(overview?.annotations?.readOnlyHint).toBe(true);
      const metaSet = tools.find((tool) => tool.name === 'meta.set');
      expect(metaSet?.annotations?.idempotentHint).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('the reads', () => {
  let fixture: Fixture;
  let client: Client;

  beforeAll(async () => {
    fixture = await startFixture({ label: 'reads', allowWrites: false, seed: true });
    client = await connectClient(fixture.url, fixture.token);
  });

  afterAll(async () => {
    await client?.close();
    await fixture?.close();
  });

  it('project.overview returns the real project, not a placeholder', async () => {
    const result = await client.callTool({ name: 'project.overview', arguments: {} });
    expect(result.isError).not.toBe(true);
    const body = resultJson(result);
    expect(body['summary']).toBe('"The Lighthouse Keeper": 1 documents, 6 words');
    expect(JSON.stringify(body)).toContain('Chapter 1');
  });

  it('the empty-project note names no write tool on a read-only server, and keeps the harness note on a writable one', async () => {
    const empty = await startFixture({ label: 'empty-ro', allowWrites: false });
    const emptyWritable = await startFixture({ label: 'empty-rw', allowWrites: true });
    const roClient = await connectClient(empty.url, empty.token);
    const rwClient = await connectClient(emptyWritable.url, emptyWritable.token);
    try {
      const read = resultJson(await roClient.callTool({ name: 'project.overview', arguments: {} }));
      expect(JSON.stringify(read)).toContain('Chapters are made in Caotang, because this server is read-only.');
      expect(JSON.stringify(read)).not.toContain('binder.restructure');
      // The description is the one a host reads at listing, and it names no write tool on a read-only server either.
      const { tools } = await roClient.listTools();
      expect(tools.find((tool) => tool.name === 'project.overview')?.description ?? '').not.toContain('binder.restructure');
      const written = resultJson(await rwClient.callTool({ name: 'project.overview', arguments: {} }));
      expect(JSON.stringify(written)).toContain('Use binder.restructure to create chapters.');
    } finally {
      await roClient.close();
      await rwClient.close();
      await empty.close();
      await emptyWritable.close();
    }
  });

  it('binder.read_tree returns the chapter and the document from the folder', async () => {
    const result = await client.callTool({ name: 'binder.read_tree', arguments: { root: 'manuscript', depth: 2 } });
    expect(result.isError).not.toBe(true);
    const body = JSON.stringify(resultJson(result));
    expect(body).toContain('Chapter 1');
    expect(body).toContain(CHAPTER_ONE);
    expect(body).toContain(LANDING);
  });

  it('doc.read returns a document body byte for byte', async () => {
    const result = await client.callTool({ name: 'doc.read', arguments: { doc: LANDING, response_format: 'detailed' } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(resultJson(result))).toContain('The ferry was late, as always.');
  });

  it('a call with a bad key is refused with a model-facing message that names the key', async () => {
    const result = await client.callTool({ name: 'project.overview', arguments: { nonsense: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(resultJson(result))).toContain('nonsense');
  });
});

describe('a write-confirm tool across the boundary', () => {
  const IMPORT_BODY = 'Rain on the slate.\n\n***\n\nThe lamp failed at dusk, and "nobody" said so — “quietly”.\nLine three keeps\ttabs.';

  it('doc.import with the confirmation accepted writes a document whose body is byte-identical to the input', async () => {
    const fixture = await startFixture({ label: 'import-ok', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const before = folderBytes(fixture.root);
      const result = await client.callTool({
        name: 'doc.import',
        arguments: { parent: CHAPTER_ONE, title: 'The Storm', body: IMPORT_BODY, synopsis: 'Rain.' },
      });
      expect(result.isError).not.toBe(true);
      const body = resultJson(result);
      const doc = (body['data'] as { doc: { id: string; title: string } }).doc;
      expect(doc.title).toBe('The Storm');

      const written = join(fixture.root, 'docs', `${doc.id}.md`);
      expect(existsSync(written)).toBe(true);
      const parsed = parseDocumentFile(readFileSync(written, 'utf8'));
      expect(parsed.body).toBe(IMPORT_BODY);

      const after = folderBytes(fixture.root);
      expect(Object.keys(after).filter((name) => !(name in before))).toContain(`docs/${doc.id}.md`);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('the imported document is still there after the server stops and the folder is opened again', async () => {
    const fixture = await startFixture({ label: 'import-reopen', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    let id = '';
    try {
      const result = await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Kept', body: 'Kept text.' } });
      id = ((resultJson(result)['data'] as { doc: { id: string } }).doc).id;
    } finally {
      await client.close();
      await fixture.stop();
    }

    const reopened = await openProject({ root: fixture.root, allowWrites: false });
    try {
      const doc = reopened.state.manifest.tree.find((node) => node.id === id);
      expect(doc?.title).toBe('Kept');
      expect(reopened.state.documents.get(id)?.body).toBe('Kept text.');
    } finally {
      await reopened.close();
      removeDir(fixture.root);
    }
  });

  it('doc.import with the confirmation declined writes nothing, to the folder or to the project', async () => {
    const fixture = await startFixture({ label: 'import-declined', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, declineConfirm);
    try {
      const before = folderBytes(fixture.root);
      const stateBefore = fixture.session.state.manifest.tree.length;
      const result = await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Never', body: 'Never written.' } });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain('"written":false');
      expect(folderBytes(fixture.root)).toEqual(before);
      expect(fixture.session.state.manifest.tree.length).toBe(stateBefore);
      expect(fixture.session.harness.log.length).toBe(0);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('doc.import with the confirmation cancelled writes nothing either', async () => {
    const fixture = await startFixture({ label: 'import-cancelled', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, cancelConfirm);
    try {
      const before = folderBytes(fixture.root);
      await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Never', body: 'Never written.' } });
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('refuses a write whose arguments cannot run before the host is asked, so no dialog asks for a change that would fail', async () => {
    const fixture = await startFixture({ label: 'refuse-first', allowWrites: true, seed: true });
    const asked: unknown[] = [];
    const answer: Answer = (params) => {
      asked.push(params);
      return { action: 'accept', content: { confirmed: true } };
    };
    const client = await connectClient(fixture.url, fixture.token, answer);
    try {
      const before = folderBytes(fixture.root);
      const result = await client.callTool({ name: 'doc.import', arguments: { parent: 'The Void', title: 'Lost', body: 'x' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(resultJson(result))).toContain('The Void');
      expect(asked).toEqual([]);
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('a client that did not declare elicitation is refused before anything is written', async () => {
    const fixture = await startFixture({ label: 'import-no-elicit', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const before = folderBytes(fixture.root);
      const result = await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Never', body: 'Never written.' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(resultJson(result))).toContain('did not declare elicitation support');
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('a write-confirm tool on a read-only server is refused by name, and nothing is written', async () => {
    const fixture = await startFixture({ label: 'import-ro', allowWrites: false, seed: true });
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const before = folderBytes(fixture.root);
      const result = await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Never', body: 'x' } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(resultJson(result))).toContain('read-only');
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});

describe('the boundary', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture({ label: 'boundary', allowWrites: true, seed: true });
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it('answers a request with a missing bearer token with 401', async () => {
    const response = await fetch(fixture.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('answers a request with a wrong bearer token with 401, and the same request with the right one is not refused', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const wrong = await fetch(fixture.url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${testToken()}` }, body });
    expect(wrong.status).toBe(401);
    const right = await fetch(fixture.url, { method: 'POST', headers: { ...headers, authorization: `Bearer ${fixture.token}` }, body });
    expect(right.status).not.toBe(401);
  });

  it('refuses a client that connects with a wrong token', async () => {
    await expect(connectClient(fixture.url, testToken())).rejects.toThrow();
  });

  it('refuses hard-denied project.deleteNode whatever the caller asks, and deletes nothing', async () => {
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const before = folderBytes(fixture.root);
      const result = await client.callTool({ name: 'project.deleteNode', arguments: { nodeId: LANDING } });
      expect(result.isError).toBe(true);
      const error = (resultJson(result)['error'] as { code: string; message: string });
      expect(error.code).toBe('hard-denied');
      expect(error.message).toContain('hard-denied');
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
    }
  });

  it('rejects a request that is not on the MCP path', async () => {
    const base = fixture.url.replace(/\/mcp$/, '/elsewhere');
    const response = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${fixture.token}` }, body: '{}' });
    expect(response.status).toBe(404);
  });

  it('refuses a request whose Origin is not localhost', async () => {
    const response = await fetch(fixture.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', authorization: `Bearer ${fixture.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(403);
  });
});

describe('the activity log', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture({ label: 'activity', allowWrites: true, seed: true });
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it('every row an MCP write leaves carries source mcp, including a confirmed write', async () => {
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Logged', body: 'Logged text.' } });
      await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'draft' } });
      const rows = fixture.session.harness.log.entries();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.source === 'mcp')).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('the write-auto path', () => {
  it('meta.set over MCP changes the project and the change is on disk when the call returns', async () => {
    const fixture = await startFixture({ label: 'meta', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const result = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      expect(result.isError).not.toBe(true);
      const onDisk = readFileSync(join(fixture.root, 'caotang.json'), 'utf8');
      expect(onDisk).toContain('"status": "final"');
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('meta.set on a read-only server is refused and the folder keeps its bytes', async () => {
    const fixture = await startFixture({ label: 'meta-ro', allowWrites: false, seed: true });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const before = folderBytes(fixture.root);
      const result = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      expect(result.isError).toBe(true);
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });
});

describe('reading the manifest back', () => {
  it('retries a sharing error that clears, so a file another program has open for a moment is still read', async () => {
    let calls = 0;
    const busyThenFree = {
      read: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return 'the manifest';
      },
    };
    expect(await manifestOnDisk(busyThenFree)).toBe('the manifest');
    expect(calls).toBe(3);
  });

  it('reports a file that stays busy as unreadable, and a file that is absent as absent, without retrying the absent one', async () => {
    const stuck = { read: async () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) };
    expect(await manifestOnDisk(stuck)).toBeUndefined();

    let calls = 0;
    const absent = {
      read: async () => {
        calls += 1;
        throw new ArtifactNotFoundError('caotang.json');
      },
    };
    expect(await manifestOnDisk(absent)).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe('a folder another program changed', () => {
  /** The folder's manifest as another program would save it: the same project, with its name edited. */
  function savedElsewhere(root: string): string {
    return readFileSync(join(root, 'caotang.json'), 'utf8').replace('"The Lighthouse Keeper"', '"Saved Elsewhere"');
  }

  it('stops writes once caotang.json is no longer the one this server saved, and never overwrites it', async () => {
    const fixture = await startFixture({ label: 'stale', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token);
    const statusOf = (): string | null | undefined => fixture.session.state.manifest.tree.find((node) => node.id === LANDING)?.status;
    try {
      const first = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'revised' } });
      expect(first.isError).not.toBe(true);
      expect(statusOf()).toBe('revised');

      const other = savedElsewhere(fixture.root);
      writeFileSync(join(fixture.root, 'caotang.json'), other);

      const second = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      expect(second.isError).toBe(true);
      expect(JSON.stringify(resultJson(second))).toContain('changed on disk');
      expect(readFileSync(join(fixture.root, 'caotang.json'), 'utf8')).toBe(other);

      const third = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'draft' } });
      expect(third.isError).toBe(true);
      expect(JSON.stringify(resultJson(third))).toContain('restart caotang-mcp');
      expect(statusOf()).toBe('final');
      expect(readFileSync(join(fixture.root, 'caotang.json'), 'utf8')).toBe(other);

      const read = await client.callTool({ name: 'project.overview', arguments: {} });
      expect(read.isError).not.toBe(true);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('refuses a confirmed write once the folder has changed, and imports nothing', async () => {
    const fixture = await startFixture({ label: 'stale-confirm', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const first = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'revised' } });
      expect(first.isError).not.toBe(true);
      writeFileSync(join(fixture.root, 'caotang.json'), savedElsewhere(fixture.root));
      await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });

      const treeBefore = fixture.session.state.manifest.tree.length;
      const imported = await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Refused', body: 'Never saved.' } });
      expect(imported.isError).toBe(true);
      expect(JSON.stringify(resultJson(imported))).toContain('restart caotang-mcp');
      expect(fixture.session.state.manifest.tree.length).toBe(treeBefore);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('asks the writer nothing for a write once the folder has stopped, and says the write was not made', async () => {
    const fixture = await startFixture({ label: 'stale-no-ask', allowWrites: true, seed: true });
    const asked: Parameters<Answer>[0][] = [];
    const client = await connectClient(fixture.url, fixture.token, (params) => {
      asked.push(params);
      return { action: 'accept', content: { confirmed: true } };
    });
    try {
      const first = await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Kept', body: 'Saved.' } });
      expect(first.isError).not.toBe(true);
      expect(asked).toHaveLength(1);

      // A held document changed under the server. The next write checks the folder before anyone is asked, finds the change, and is refused
      // without a question: the question would promise a change the save would refuse.
      writeFileSync(join(fixture.root, 'docs', `${LANDING}.md`), '---\nid: n_BEACH00001\ntitle: The Landing\n---\n\nChanged by another program.\n');
      const second = await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Second', body: 'Found.' } });
      expect(second.isError).toBe(true);
      expect(JSON.stringify(resultJson(second))).toContain('was not made');
      expect(JSON.stringify(resultJson(second))).toContain('changed the document “The Landing”');
      expect(asked).toHaveLength(1);

      // Once the folder has stopped, a write is refused before anyone is asked: the question would promise a change that cannot be made.
      const third = await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Third', body: 'Refused.' } });
      expect(third.isError).toBe(true);
      expect(JSON.stringify(resultJson(third))).toContain('was not made');
      expect(asked).toHaveLength(1);
    } finally {
      await client.close();
      await fixture.close();
    }
    // Two writes through the boundary, neither of them a save: a few hundred milliseconds, well inside the 5 s default on a loaded machine.
  }, 30_000);

  it('says once, in the message, that a write made in memory is not saved when the folder changed during the save', async () => {
    const fixture = await startFixture({ label: 'stale-after-write', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    const fs = fixture.session.fs;
    const ensureDir = fs.ensureDir.bind(fs);
    let raced = false;
    // Another program edits a document after the save's check and before its write reaches the file: the write stops there, after the change
    // is in memory.
    fs.ensureDir = async (dir: string) => {
      if (!raced && dir === 'docs') {
        raced = true;
        appendFileSync(join(fixture.root, 'docs', `${LANDING}.md`), 'Another program wrote this.\n');
      }
      return ensureDir(dir);
    };
    try {
      const result = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      expect(result.isError).toBe(true);
      const { message } = (resultJson(result) as { error: { message: string } }).error;
      expect(message).toContain('because another program changed the document “The Landing”.');
      // Counted without regard to case, so a second sentence that says "applied in memory" or "restart caotang-mcp" again is caught.
      expect(message.match(/in memory/gi)).toHaveLength(1);
      expect(message.match(/restart caotang-mcp/gi)).toHaveLength(1);
      expect(message).not.toContain('may not be on disk');
    } finally {
      fs.ensureDir = ensureDir;
      await client.close();
      await fixture.close();
    }
  }, 30_000);

  it('does not say a save failed when the write was saved and another program changed caotang.json after it', async () => {
    const fixture = await startFixture({ label: 'changed-after-save', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    const fs = fixture.session.fs;
    const writeAtomic = fs.writeAtomic.bind(fs);
    let overwritten = false;
    // Another program rewrites caotang.json right after this server's save wrote it.
    fs.writeAtomic = async (path: string, contents: string) => {
      await writeAtomic(path, contents);
      if (path === 'caotang.json' && !overwritten) {
        overwritten = true;
        await writeAtomic('caotang.json', '{"formatVersion": 1, "other": "program"}');
      }
    };
    try {
      const result = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      expect(result.isError).toBe(true);
      const { message } = (resultJson(result) as { error: { message: string } }).error;
      expect(message.startsWith('"meta.set" was saved, but')).toBe(true);
      expect(message).toContain('The change was saved, and then another program changed caotang.json');
      expect(message).not.toContain('could not finish saving');
      expect(message.match(/restart caotang-mcp/gi)).toHaveLength(1);
    } finally {
      fs.writeAtomic = writeAtomic;
      await client.close();
      await fixture.close();
    }
  }, 30_000);
});

describe('the registry seam', () => {
  it('exposes exactly the tools the harness declares, and the protocol row is not among them', () => {
    const names = TOOL_METADATA.map((meta) => meta.name);
    const exposed = TOOL_METADATA.filter((meta) => mcpExposure(meta).exposed).map((meta) => meta.name);
    expect(exposed.length).toBe(names.length - 1);
    expect(exposed).not.toContain('agent.plan');
    expect(metadataFor('doc.import')?.surface).toBe('extension');
  });

  it('lists exactly the read tools on a read-only server, and the write tools only with --allow-writes', async () => {
    // The tool list is the server's whole outward contract, and a statement of what a read-only
    // server exposes. It is pinned here so a new row cannot change `tools/list` without the
    // README's tables (and extensibility §9) being updated with it. The list is the one a client
    // reads off the wire, from a server started with and without --allow-writes: a copy of the
    // gate in this file would go green when the gate in tools.ts changes.
    const readOnly = await startFixture({ label: 'listed-ro', allowWrites: false, seed: true });
    let writable: Fixture | undefined;
    try {
      writable = await startFixture({ label: 'listed-rw', allowWrites: true, seed: true });
      let roClient: Client | undefined;
      try {
        roClient = await connectClient(readOnly.url, readOnly.token);
        const rwClient = await connectClient(writable.url, writable.token);
        try {
          expect(await listedNames(roClient)).toEqual(['binder.read_tree', 'codex.read', 'coherence.scan', 'dialogue.table', 'doc.read', 'notes.read', 'project.overview']);
          expect(await listedNames(rwClient)).toEqual([
            'binder.read_tree',
            'binder.restructure',
            'codex.import',
            'codex.read',
            'codex.write',
            'coherence.scan',
            'coherence.setFindingStatus',
            'dialogue.table',
            'doc.import',
            'doc.read',
            'export.compile',
            'meta.set',
            'notes.append',
            'notes.read',
            'project.overview',
            'shots.annotate',
          ]);
        } finally {
          await rwClient.close();
        }
      } finally {
        await roClient?.close();
      }
    } finally {
      // Each fixture is closed on its own: a close that fails must not skip the other one, or the
      // server and the temp dir of the first fixture are left behind.
      try {
        await writable?.close();
      } finally {
        await readOnly.close();
      }
    }
  }, 30_000);
});

describe('the confirmation round trip on the wire', () => {
  /** The retry the client sent with the user's answer: the one request whose body carries `inputResponses`. */
  function acceptedRetry(exchanges: readonly Exchange[]): Exchange {
    const retry = exchanges.find((exchange) => exchange.body.includes('"inputResponses"'));
    if (retry === undefined) throw new Error('the client sent no accepted retry');
    return retry;
  }

  /** The request body with one part replaced, as a string. */
  function altered(exchange: Exchange, change: (params: Record<string, unknown>) => void): string {
    const body = JSON.parse(exchange.body) as { params: Record<string, unknown> };
    change(body.params);
    return JSON.stringify(body);
  }

  it('an accepted retry sent again is answered as before, and does not write the document a second time', async () => {
    const fixture = await startFixture({ label: 'replay', allowWrites: true, seed: true });
    const exchanges: Exchange[] = [];
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm, exchanges);
    try {
      await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Once', body: 'Once only.' } });
      const retry = acceptedRetry(exchanges);
      const first = await resend(retry);
      const again = await resend(retry);
      expect(again['result']).toEqual(first['result']);
      expect(fixture.session.state.manifest.tree.filter((node) => node.title === 'Once')).toHaveLength(1);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('an accepted codex.write create resent is answered with the first answer, not refused for a name the first accept took', async () => {
    // The first accept makes the entry, so the same create checked again would collide with it. The replay is checked first and answered
    // from the ledger, so the host gets the first answer and the canon holds one entry, not two.
    const fixture = await startFixture({ label: 'replay-codex', allowWrites: true, seed: true });
    const exchanges: Exchange[] = [];
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm, exchanges);
    try {
      await client.callTool({
        name: 'codex.write',
        arguments: { entries: [{ action: 'create', name: 'Harbor Master', type: 'character', description: 'Keeps the light.' }] },
      });
      const retry = acceptedRetry(exchanges);
      const first = await resend(retry);
      const again = await resend(retry);
      expect((first['result'] as { isError?: boolean }).isError).not.toBe(true);
      expect(again['result']).toEqual(first['result']);
      const named = (fixture.session.state.manifest.codex ?? []).filter((entry) => entry.name === 'Harbor Master');
      expect(named).toHaveLength(1);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('two identical accepted retries in flight at once are one write: the second waits for the first and runs nothing', async () => {
    const fixture = await startFixture({ label: 'replay-race', allowWrites: true, seed: true });
    const exchanges: Exchange[] = [];
    // A declined round leaves its question open. Asking it again gives a fresh state, which the two accepts below share.
    const client = await connectClient(fixture.url, fixture.token, declineConfirm, exchanges);
    try {
      await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Racing', body: 'Once only.' } });
      const initial = exchanges.find((exchange) => exchange.body.includes('"tools/call"') && !exchange.body.includes('"inputResponses"'));
      if (initial === undefined) throw new Error('the client sent no initial call');
      const asked = (await resend(initial))['result'] as { requestState?: string };
      if (typeof asked.requestState !== 'string') throw new Error('the server asked nothing for the initial call');
      const accept = altered(initial, (params) => {
        params['inputResponses'] = { confirm: { action: 'accept', content: { confirmed: true } } };
        params['requestState'] = asked.requestState;
      });

      const [first, second] = await Promise.all([resend(initial, accept), resend(initial, accept)]);
      expect(second['result']).toEqual(first['result']);
      expect(fixture.session.state.manifest.tree.filter((node) => node.title === 'Racing')).toHaveLength(1);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('an accepted answer is not applied to different arguments: the call is asked again and nothing is written', async () => {
    const fixture = await startFixture({ label: 'changed-args', allowWrites: true, seed: true });
    const exchanges: Exchange[] = [];
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm, exchanges);
    try {
      await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Asked', body: 'Asked about.' } });
      const retry = acceptedRetry(exchanges);
      const before = folderBytes(fixture.root);
      const answer = await resend(
        retry,
        altered(retry, (params) => {
          (params['arguments'] as Record<string, unknown>)['title'] = 'Swapped';
        }),
      );
      expect((answer['result'] as { resultType: string }).resultType).toBe('input_required');
      expect(folderBytes(fixture.root)).toEqual(before);
      expect(fixture.session.state.manifest.tree.some((node) => node.title === 'Swapped')).toBe(false);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('a round state that was altered is refused as an invalid request state, and nothing is written', async () => {
    const fixture = await startFixture({ label: 'tamper', allowWrites: true, seed: true });
    const exchanges: Exchange[] = [];
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm, exchanges);
    try {
      await client.callTool({ name: 'doc.import', arguments: { parent: CHAPTER_ONE, title: 'Forged', body: 'Forged.' } });
      const retry = acceptedRetry(exchanges);
      const before = folderBytes(fixture.root);
      const answer = await resend(
        retry,
        altered(retry, (params) => {
          const state = String(params['requestState']);
          params['requestState'] = `${state.slice(0, -3)}${state.endsWith('AAA') ? 'BBB' : 'AAA'}`;
        }),
      );
      expect(answer['error']).toBeDefined();
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('export.compile through the confirmation writes the compiled file into exports/', async () => {
    const fixture = await startFixture({ label: 'export', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const result = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: 'manuscript', includeSubtrees: true }, format: 'md' },
      });
      expect(result.isError).not.toBe(true);
      const compiled = readdirSync(join(fixture.root, 'exports')).filter((name) => name.endsWith('.md'));
      expect(compiled).toHaveLength(1);
      expect(readFileSync(join(fixture.root, 'exports', compiled[0] ?? ''), 'utf8')).toContain('The ferry was late');
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  // The gates a screenplay, game or shot-list compile applies to its selection run at apply, after the writer is asked. The confirmation runs
  // them first (session.check), so a compile the exporter would refuse is refused with its reason, and the writer is never asked for it.
  it.each([
    ['fountain', 'the selection holds no screenplay scene'],
    ['fdx', 'the selection holds no screenplay scene'],
    ['shot-list-csv', 'the selection holds no shot'],
    ['ink-json', 'the selection holds no dialogue container'],
    ['dialogue-csv', 'the selection holds no dialogue container'],
  ])('a %s compile of a prose-only selection is refused before the writer is asked, and nothing is written', async (format, reason) => {
    const fixture = await startFixture({ label: `export-refused-${format}`, allowWrites: true, seed: true });
    const asked: Parameters<Answer>[0][] = [];
    const client = await connectClient(fixture.url, fixture.token, (params) => {
      asked.push(params);
      return { action: 'accept', content: { confirmed: true } };
    });
    try {
      const before = folderBytes(fixture.root);
      const result = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: 'manuscript', includeSubtrees: true }, format },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(resultJson(result))).toContain(reason);
      expect(asked).toEqual([]);
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('export.compile to EPUB writes the book, because the server gives the exporter the project identifier and metadata', async () => {
    const fixture = await startFixture({ label: 'export-epub', allowWrites: true, seed: true });
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const result = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: 'manuscript', includeSubtrees: true }, format: 'epub' },
      });
      // Without the metadata callback the compile is refused for want of an identifier, so a written .epub is the proof it runs.
      expect(result.isError).not.toBe(true);
      const compiled = readdirSync(join(fixture.root, 'exports')).filter((name) => name.endsWith('.epub'));
      expect(compiled).toHaveLength(1);
      // The EPUB container's first entry is its uncompressed `mimetype`, so the bytes hold the media type as text.
      expect(readFileSync(join(fixture.root, 'exports', compiled[0] ?? '')).toString('latin1')).toContain('application/epub+zip');
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('a shot-list compile is refused with the reason when the images cannot be listed, before the writer is asked, and a docx compile still writes its book', async () => {
    // The assets folder cannot be listed (a permission error, not an absent folder). The confirmed call lists the images before it is
    // checked, so the failure is found before the writer is asked: the compile is refused with the reason, and no dialog is shown for it.
    const real = NodeArtifactFs.prototype.listFiles;
    const listing = vi.spyOn(NodeArtifactFs.prototype, 'listFiles').mockImplementation(function (this: NodeArtifactFs, dir: string) {
      if (dir.startsWith('assets')) return Promise.reject(new Error('EACCES: permission denied, scandir assets'));
      return real.call(this, dir);
    });
    const fixture = await startFixture({ label: 'export-unlistable', allowWrites: true, seed: true });
    const asked: Parameters<Answer>[0][] = [];
    const client = await connectClient(fixture.url, fixture.token, (params) => {
      asked.push(params);
      return { action: 'accept', content: { confirmed: true } };
    });
    try {
      const refused = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: 'manuscript', includeSubtrees: true }, format: 'shot-list-csv' },
      });
      expect(refused.isError).toBe(true);
      const said = JSON.stringify(refused.content);
      expect(said).toContain('io-error');
      expect(said).toContain('could not be listed (EACCES');
      expect(asked).toEqual([]);
      const exportsDir = join(fixture.root, 'exports');
      expect(existsSync(exportsDir) ? readdirSync(exportsDir).filter((name) => name.endsWith('.csv')) : []).toEqual([]);

      // A book names no image, so it compiles from the same folder, and it is the one compile the writer is asked for here.
      const book = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: 'manuscript', includeSubtrees: true }, format: 'docx' },
      });
      expect(book.isError).not.toBe(true);
      expect(asked).toHaveLength(1);
      expect(readdirSync(exportsDir).filter((name) => name.endsWith('.docx'))).toHaveLength(1);
    } finally {
      listing.mockRestore();
      await client.close();
      await fixture.close();
    }
    // Two confirmed compiles, one of them a DOCX: about 0.5 s alone, and past the 5 s default once in a package run on a loaded machine.
  }, 30_000);
  it('a shot-list compile is asked for and written once the images can be listed again, after the listing failed when the project opened', async () => {
    // The listing fails once, at the open (a folder busy for a moment), and then reads. Each confirmed call lists the images again before
    // it is checked, so the failure held from the open does not refuse every later compile.
    const real = NodeArtifactFs.prototype.listFiles;
    let unreadable = true;
    const listing = vi.spyOn(NodeArtifactFs.prototype, 'listFiles').mockImplementation(function (this: NodeArtifactFs, dir: string) {
      if (unreadable && dir.startsWith('assets')) return Promise.reject(new Error('EBUSY: resource busy or locked, scandir assets'));
      return real.call(this, dir);
    });
    const fixture = await startFixture({ label: 'export-relisted', allowWrites: true, seed: true, shot: true });
    const asked: Parameters<Answer>[0][] = [];
    const client = await connectClient(fixture.url, fixture.token, (params) => {
      asked.push(params);
      return { action: 'accept', content: { confirmed: true } };
    });
    try {
      unreadable = false;
      const result = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: SHOTS_FOLDER, includeSubtrees: true }, format: 'shot-list-csv' },
      });
      expect(JSON.stringify(result.content)).not.toContain('could not be listed');
      expect(result.isError).not.toBe(true);
      expect(asked).toHaveLength(1);
      const csv = readdirSync(join(fixture.root, 'exports')).filter((name) => name.endsWith('.csv'));
      expect(csv).toHaveLength(1);
      expect(readFileSync(join(fixture.root, 'exports', csv[0] ?? ''), 'utf8')).toContain('The harbour, empty.');
    } finally {
      listing.mockRestore();
      await client.close();
      await fixture.close();
    }
  }, 30_000);

  it('export.compile draws a contact sheet with Chinese text in the Noto Sans Mono CJK fallback font, read from its package', async () => {
    const fixture = await startFixture({ label: 'export-cjk', allowWrites: true, seed: true, shot: true, shotAction: '港口空无一人。' });
    const client = await connectClient(fixture.url, fixture.token, () => ({ action: 'accept', content: { confirmed: true } }));
    try {
      const result = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: SHOTS_FOLDER, includeSubtrees: true }, format: 'contact-sheet-pdf' },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).not.toContain('drawn as');
      const pdf = readdirSync(join(fixture.root, 'exports')).filter((name) => name.endsWith('.pdf'));
      expect(pdf).toHaveLength(1);
      const bytes = readFileSync(join(fixture.root, 'exports', pdf[0] ?? ''));
      // The subset font is embedded as a TrueType program; Helvetica alone would embed none.
      expect(bytes.toString('latin1')).toContain('/FontFile2');
      expect(bytes.byteLength).toBeLessThan(40_000);
    } finally {
      await client.close();
      await fixture.close();
    }
  }, 30_000);

  it('export.compile draws a contact sheet with emoji in the Noto Emoji fallback font, read from its package', async () => {
    const fixture = await startFixture({ label: 'export-emoji', allowWrites: true, seed: true, shot: true, shotAction: 'Harbour 🌊 at dawn 👨‍👩‍👧 🇩🇪 1️⃣' });
    const client = await connectClient(fixture.url, fixture.token, () => ({ action: 'accept', content: { confirmed: true } }));
    try {
      const result = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: SHOTS_FOLDER, includeSubtrees: true }, format: 'contact-sheet-pdf' },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).not.toContain('drawn as');
      const pdf = readdirSync(join(fixture.root, 'exports')).filter((name) => name.endsWith('.pdf'));
      expect(pdf).toHaveLength(1);
      const bytes = readFileSync(join(fixture.root, 'exports', pdf[0] ?? '')).toString('latin1');
      // The emoji subset is embedded as a TrueType program under its own name; the CJK font is not read for emoji.
      expect(bytes).toContain('/BaseFont /CAOTEM+NotoEmoji-Regular');
      expect(bytes.match(/\/FontFile2/g)).toHaveLength(1);
    } finally {
      await client.close();
      await fixture.close();
    }
  }, 30_000);

  it('a shot-list compile is refused before the writer is asked when the images stop being listable after the project opened', async () => {
    // The reverse: the listing read at the open, and the folder became unreadable since. The check lists again, so the dialog never
    // asks for a compile the accept would refuse.
    const real = NodeArtifactFs.prototype.listFiles;
    let unreadable = false;
    const listing = vi.spyOn(NodeArtifactFs.prototype, 'listFiles').mockImplementation(function (this: NodeArtifactFs, dir: string) {
      if (unreadable && dir.startsWith('assets')) return Promise.reject(new Error('EACCES: permission denied, scandir assets'));
      return real.call(this, dir);
    });
    const fixture = await startFixture({ label: 'export-unlisted-later', allowWrites: true, seed: true, shot: true });
    const asked: Parameters<Answer>[0][] = [];
    const client = await connectClient(fixture.url, fixture.token, (params) => {
      asked.push(params);
      return { action: 'accept', content: { confirmed: true } };
    });
    try {
      unreadable = true;
      const before = folderBytes(fixture.root);
      const result = await client.callTool({
        name: 'export.compile',
        arguments: { selection: { root: SHOTS_FOLDER, includeSubtrees: true }, format: 'shot-list-csv' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('could not be listed (EACCES');
      expect(asked).toEqual([]);
      expect(folderBytes(fixture.root)).toEqual(before);
    } finally {
      listing.mockRestore();
      await client.close();
      await fixture.close();
    }
  }, 30_000);

  // A 2025-era host that declares elicitation is asked over HTTP and can confirm a write there: legacy-http.test.ts.

  it('a client on the 2025 handshake still connects, and lists the reads and no writes', async () => {
    const fixture = await startFixture({ label: 'legacy', allowWrites: false, seed: true });
    const client = new LegacyClient({ name: 'legacy-test', version: '0.0.0' }, { capabilities: {} });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(fixture.url), {
          requestInit: { headers: { authorization: `Bearer ${fixture.token}` } },
        }),
      );
      const names = await listedNames(client);
      expect(names).toContain('project.overview');
      expect(names).not.toContain('doc.import');
    } finally {
      await client.close();
      await fixture.close();
    }
  });

  it('a 2025 connection is told its confirmations wait 60 seconds, and a 2026-07-28 request, which holds nothing open, is told no deadline', async () => {
    const fixture = await startFixture({ label: 'deadline', allowWrites: true, seed: true });
    const legacy = new LegacyClient({ name: 'legacy-test', version: '0.0.0' }, { capabilities: {} });
    const modern = await connectClient(fixture.url, fixture.token);
    try {
      await legacy.connect(
        new StreamableHTTPClientTransport(new URL(fixture.url), {
          requestInit: { headers: { authorization: `Bearer ${fixture.token}` } },
        }),
      );
      expect(LEGACY_ROUND_TIMEOUT_MS).toBe(60_000);
      expect(legacy.getInstructions()).toContain('A confirmation waits 60 seconds');
      expect(modern.getInstructions()).not.toContain('waits');
    } finally {
      await legacy.close();
      await modern.close();
      await fixture.close();
    }
  });

  it('a fresh table of 2025-era connections has none busy, and reports its limit', () => {
    const none = new LegacySessions();
    expect(none.busyCount).toBe(0);
    expect(none.limit).toBe(16);
  });
});

describe('the session folder', () => {
  it('a folder with no caotang.json and no --create is refused, and nothing is made in it', async () => {
    const root = tempDir('no-project');
    try {
      await expect(openProject({ root, allowWrites: false })).rejects.toThrow(/no Caotang project/);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      removeDir(root);
    }
  });

  it('a second writer on the same folder is refused while the first is open', async () => {
    const root = tempDir('locked');
    await seedProject(root, 'Locked');
    const first: ProjectSession = await openProject({ root, allowWrites: false });
    try {
      await expect(openProject({ root, allowWrites: false })).rejects.toThrow(/in use by another writer/);
    } finally {
      await first.close();
      removeDir(root);
    }
  });

  it('a folder opened through the runtime keeps its state after a restart', async () => {
    const root = tempDir('restart');
    const token = 'restart-token-0123456789';
    await seedProject(root, 'Restart');
    const session = await openProject({ root, allowWrites: true });
    const server: RunningHttpServer = await startHttpServer(createToolRuntime(session), { port: 0, token });
    const client = await connectClient(server.url, token);
    try {
      const changed = await client.callTool({ name: 'meta.set', arguments: { targets: [LANDING], status: 'final' } });
      expect(changed.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }

    const reopened = await openProject({ root, allowWrites: false });
    try {
      expect(reopened.state.manifest.project.name).toBe('Restart');
      expect(reopened.state.manifest.tree.map((node) => node.id)).toEqual(expect.arrayContaining([CHAPTER_ONE, LANDING]));
      expect(reopened.state.documents.get(LANDING)?.body).toBe(LANDING_BODY);
      expect(reopened.state.manifest.tree.find((node) => node.id === LANDING)?.status).toBe('final');
    } finally {
      await reopened.close();
      removeDir(root);
    }
  });

  it.each([
    ['a document file', join('docs', HAND_WRITTEN_DOC_NAME)],
    ['a codex file', join('codex', 'c_5H8QK2M9RT.md')],
    ['a manifest copy', 'caotang.json.bak.1'],
  ])('--create refuses a folder that holds %s with no caotang.json, and leaves every file as it was', async (_label, file) => {
    const root = tempDir('orphan-create');
    try {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), HAND_WRITTEN_DOC);
      const before = folderBytes(root);
      await expect(openProject({ root, create: 'Recovered Book', allowWrites: false })).rejects.toThrow(ProjectContentError);
      expect(folderBytes(root)).toEqual(before);
      expect(existsSync(join(root, 'caotang.json'))).toBe(false);
    } finally {
      removeDir(root);
    }
  });

  it('--create makes a project in a folder whose other files belong to no project, and leaves them alone', async () => {
    const root = tempDir('loose-files');
    try {
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'notes.md'), 'Loose notes.\n');
      writeFileSync(join(root, 'docs', 'chapter-one.md'), 'Not an id.\n');
      const session = await openProject({ root, create: 'Loose', allowWrites: false });
      try {
        expect(session.created).toBe(true);
        expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('Loose notes.\n');
        expect(readFileSync(join(root, 'docs', 'chapter-one.md'), 'utf8')).toBe('Not an id.\n');
      } finally {
        await session.close();
      }
    } finally {
      removeDir(root);
    }
  });
});
