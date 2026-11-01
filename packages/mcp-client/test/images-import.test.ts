/**
 * An external server's picture, end to end over the Streamable HTTP wire (pictures.md §8.3, #145): the server answers with an image block,
 * the client hands the model a bounded stub, the writer's import saves the staged bytes with the server and tool as their source, the record
 * is in the manifest, and a view or an export reads it back. A declined import writes nothing and leaves no staged bytes.
 */

import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  executeAsync,
  type BusContext,
  type Command,
  type CommandError,
  type ExecutionOutcome,
  type Result,
} from '@caotang/bus';
import {
  addDocument,
  createAssetStaging,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  exportProjectZip,
  importProjectZip,
  readProject,
  type ProjectAssetPort,
  type ProjectState,
  type RetryableAssetStaging,
} from '@caotang/store';
import { afterEach, describe, expect, it } from 'vitest';

import {
  STAGED_IMAGE_LIFETIME_MS,
  applyMcpInvoke,
  createImageStager,
  createLoadedTools,
  createMcpClient,
  createMcpTransport,
  prepareInvoke,
  type ImageStager,
  type McpClient,
} from '../src/index.js';
import { base64, png } from './pictures-support.js';
import { FIXED_NOW, serverFor, startInProcessServer, type FixtureState, type InProcessServer } from './support.js';

const NOW = new Date('2026-10-09T09:00:00.000Z');
const KEY = 's_AAAAAAAAAA';
const LANDING = 'n_7K2QX9M4A1';
const clock = { now: () => 1_000 };

const servers: InProcessServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function project(uuid: string): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => uuid, locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: NOW, id: LANDING });
  return state;
}

interface Host {
  readonly state: ProjectState;
  readonly staging: RetryableAssetStaging;
  readonly files: Map<string, Uint8Array>;
  readonly writes: string[];
  readonly run: (params: Record<string, unknown>) => Promise<Result<ExecutionOutcome, CommandError>>;
}

/** A project whose pictures are written to memory, with `asset.import` registered the way the app registers it. */
function host(uuid: string, staging?: RetryableAssetStaging): Host {
  const state = project(uuid);
  const own = staging ?? createAssetStaging(state.manifest.project.id);
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const assets: ProjectAssetPort = {
    staging: own,
    writeBytes: async (path, bytes) => {
      writes.push(path);
      files.set(path, bytes.slice());
    },
    list: async () => ({ authoritative: true, files: [...files.keys()].map((path) => path.slice('assets/'.length)) }),
    readBytes: async (path) => files.get(path),
  };
  const registry = createProjectCommandRegistry({ clock, assets });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo: createUndoStore({ dispatch: (command) => execute(command, bus, registry) }),
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => undefined,
  };
  let ordinal = 0;
  return {
    state,
    staging: own,
    files,
    writes,
    run: (params) => {
      ordinal += 1;
      const command: Command = { id: `cmd_MCPIMAGE${String(ordinal).padStart(3, '0')}`, name: 'asset.import', params, issuedBy: 'user', createdAt: 1_000 };
      return executeAsync(command, bus, registry);
    },
  };
}

const UUID_A = '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d';
const UUID_B = '9d1b6c2a-4e8f-4b7a-8c3d-5a2e1f0b9c8e';

interface Connected {
  readonly client: McpClient;
  readonly server: InProcessServer;
}

/** A client over a real Streamable HTTP wire to an in-process server whose `get_map` tool answers with an image block. */
async function connect(respond: FixtureState['respond']): Promise<Connected> {
  const server = startInProcessServer({
    tools: [{ name: 'get_map', description: 'Draw the harbour.', inputSchema: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] } }],
    respond,
  });
  servers.push(server);
  const client = createMcpClient({
    settings: { enabled: true, servers: [serverFor(KEY, 'Map Maker', { url: 'https://maps.fixture.test/mcp' })] },
    fetch: server.fetch,
    probe: async () => false,
    now: () => FIXED_NOW,
    listTimeoutMs: 2_000,
    callTimeoutMs: 2_000,
  });
  await client.connect(KEY);
  client.approveReview(KEY, client.review(KEY)?.fingerprint ?? '');
  return { client, server };
}

async function callGetMap(client: McpClient, images: ImageStager) {
  const loaded = createLoadedTools();
  loaded.beginTurn('turn-1');
  loaded.load([`mcp__${KEY}__get_map`]);
  const prepared = prepareInvoke({ client, loaded }, { serverKey: KEY, toolName: 'get_map', args: { place: 'the jetty' } });
  if (!prepared.ok) throw new Error(prepared.error.message);
  return applyMcpInvoke({ client, loaded, transport: createMcpTransport(client), images }, prepared.value, { report: () => undefined });
}

function manualTime() {
  let now = 5_000_000;
  const jobs: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    timers: { set: (run: () => void, ms: number) => jobs.push({ at: now + ms, run }), clear: () => undefined },
    advance(ms: number) {
      now += ms;
      for (const job of jobs.splice(0).filter((entry) => entry.at <= now)) job.run();
    },
  };
}

describe('an external tool returns a picture', () => {
  const bytes = png(0x55);

  async function answered(h: Host, time = manualTime()) {
    const { client, server } = await connect(() => ({ content: [{ type: 'text', text: 'The jetty, drawn.' }, { type: 'image', data: base64(bytes), mimeType: 'image/png' }] }));
    const stager = createImageStager({ staging: h.staging, now: time.now, timers: time.timers });
    const outcome = await callGetMap(client, stager);
    if (!outcome.ok) throw new Error(outcome.error.message);
    return { stager, result: outcome.value, server, time };
  }

  it('gives the model a stub over the wire and no bytes, then saves the staged picture with the server and tool as its source', async () => {
    const h = host(UUID_A);
    const { stager, result, server } = await answered(h);

    expect(server.posts.some((post) => post.method === 'tools/call')).toBe(true);
    expect(result.untrusted).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'The jetty, drawn.' });
    const stub = (result.content[1] as { text: string }).text;
    expect(stub).toMatch(/^\[image 1: image\/png, 1 KB, staged as stg_[0-9A-Z]+\]$/);
    expect(JSON.stringify(result)).not.toContain(base64(bytes).slice(0, 40));

    const stagingId = result.staged?.[0]?.stagingId ?? '';
    expect(stub).toContain(stagingId);
    const source = stager.provenanceOf(stagingId);
    expect(source).toEqual({ kind: 'mcp', server: 'Map Maker', tool: 'get_map' });

    const imported = await h.run({ stagingId, links: [{ kind: 'node', nodeId: LANDING }], caption: 'The jetty', ...(source === undefined ? {} : { source }) });
    if (!imported.ok) throw new Error(imported.error.message);
    const record = imported.value.result as { assetId: string; path: string; created: boolean };

    expect(record.created).toBe(true);
    expect(h.state.manifest.assets).toEqual([expect.objectContaining({ id: record.assetId, mime: 'image/png', caption: 'The jetty', source: { kind: 'mcp', server: 'Map Maker', tool: 'get_map' } })]);
    expect(h.state.manifest.assetLinks).toEqual([expect.objectContaining({ assetId: record.assetId, target: { kind: 'node', nodeId: LANDING } })]);

    // A view reads the file by its record; an export carries it in the bundle.
    const stored = h.files.get(record.path);
    expect(stored).toBeDefined();
    const exported = await exportProjectZip(h.state, { now: NOW, assets: Object.fromEntries(h.files) });
    expect(exported.entries).toContain(record.path);
    const unpacked = await importProjectZip(exported.bytes);
    expect((await readProject(unpacked.fs)).state.manifest.assets).toEqual(h.state.manifest.assets);
    expect(Array.from(unpacked.assets[record.path] ?? [])).toEqual(Array.from(stored ?? []));

    // Imported once: the staged bytes are gone, so the same id cannot be imported twice.
    const again = await h.run({ stagingId });
    expect(again.ok).toBe(false);
  });

  it('writes nothing and leaves no staged bytes when the writer declines', async () => {
    const h = host(UUID_A);
    const { stager, result } = await answered(h);
    const stagingId = result.staged?.[0]?.stagingId ?? '';
    expect(stager.heldIds()).toEqual([stagingId]);

    stager.discard([stagingId]);

    expect(stager.heldIds()).toEqual([]);
    expect(h.staging.take(stagingId)).toBeUndefined();
    expect(h.writes).toEqual([]);
    expect(h.state.manifest.assets ?? []).toEqual([]);
    const late = await h.run({ stagingId });
    if (late.ok) throw new Error('expected a refusal');
    expect(late.error.code).toBe('not-found');
    expect(h.writes).toEqual([]);
  });

  it('refuses a stale id once the lifetime has run out, and writes nothing', async () => {
    const h = host(UUID_A);
    const { stager, result, time } = await answered(h);
    const stagingId = result.staged?.[0]?.stagingId ?? '';

    time.advance(STAGED_IMAGE_LIFETIME_MS);

    expect(stager.heldIds()).toEqual([]);
    const stale = await h.run({ stagingId });
    if (stale.ok) throw new Error('expected a refusal');
    expect(stale.error.code).toBe('not-found');
    expect(h.writes).toEqual([]);
    expect(h.state.manifest.assets ?? []).toEqual([]);
  });

  it('refuses an id that was never staged', async () => {
    const h = host(UUID_A);
    const refused = await h.run({ stagingId: 'stg_NEVERSTAGED' });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.error.code).toBe('not-found');
    expect(h.writes).toEqual([]);
  });

  it("refuses another project's staged picture, and writes nothing into either project", async () => {
    const a = host(UUID_A);
    const { result } = await answered(a);
    const stagingId = result.staged?.[0]?.stagingId ?? '';
    const b = host(UUID_B, a.staging);
    expect(b.state.manifest.project.id).not.toBe(a.state.manifest.project.id);

    const refused = await b.run({ stagingId });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.error.code).toBe('not-found');
    expect(refused.error.message).toContain('another project');
    expect(b.writes).toEqual([]);
    expect(b.state.manifest.assets ?? []).toEqual([]);
    expect(a.writes).toEqual([]);
  });

  it('lets go of every staged picture when the project closes', async () => {
    const h = host(UUID_A);
    const { stager, result } = await answered(h);
    const stagingId = result.staged?.[0]?.stagingId ?? '';

    stager.releaseAll();

    expect(h.staging.take(stagingId)).toBeUndefined();
    expect(stager.heldIds()).toEqual([]);
  });

  it('refuses a mislabelled picture over the wire and stages nothing', async () => {
    const h = host(UUID_A);
    const { client } = await connect(() => ({ content: [{ type: 'image', data: base64(bytes), mimeType: 'image/jpeg' }] }));
    const stager = createImageStager({ staging: h.staging });
    const outcome = await callGetMap(client, stager);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('postcondition');
    expect(stager.heldIds()).toEqual([]);
    stager.releaseAll();
  });
});
