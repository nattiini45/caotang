/**
 * The project's pictures over MCP, read-only (pictures.md §8.2, §6.4.1): `pictures.list` and `pictures.view` are listed in every
 * mode with a read-only hint, `caotang://assets` carries the registry as JSON, `caotang://asset/{id}` carries one picture as a blob
 * with its type, and a picture this Node host cannot shrink is refused with its size before anything is sent. An unknown id, a
 * traversal and a file that is not the type recorded are refused, a read writes nothing, and a change to the registry reaches a
 * subscribed host without the session being opened again.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { addDocument, addFolder, createEmptyManifest, createProjectState, writeProject, type ProjectState } from '@caotang/store';

import { buildMcpServer, createToolRuntime, NodeArtifactFs, openProject } from '../src/index.js';
import { PICTURES_LIST, PICTURES_VIEW, PICTURE_MAX_SENT_BYTES, VIEW_MAX_EDGE } from '../src/pictures.js';
import { ASSETS_URI, assetUri, changeOf } from '../src/resources.js';
import { CHAPTER_ONE, LANDING, OPENED, acceptConfirm, connectClient, folderBytes, removeDir, resultJson, startOver, tempDir, type Fixture } from './support.js';

const HARBOUR = 'a_HARB000001';
const KESTREL = 'a_KEST000002';
const MAP = 'a_MAPS000003';
const BIG = 'a_BEEF000004';
const HALF_ONE = 'a_HAFT000005';
const HALF_TWO = 'a_HAFT000006';
const SWAPPED = 'a_SWAP000007';
const ABSENT = 'a_NADA000008';
const UNKNOWN = 'a_FAKE000009';

const MIB = 1024 * 1024;
const SERVER_FIXTURE_TIMEOUT = 30_000;

const roots: string[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const root of roots.splice(0)) removeDir(root);
});

/** A PNG header of the given size, padded to `length` bytes: what the sniff and the header read look at, and nothing more. */
function pngBytes(width: number, height: number, length = 96): Uint8Array {
  const bytes = new Uint8Array(Math.max(length, 33));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.fill(7, 33);
  return bytes;
}

/** A JPEG that is only a start of image and a trailer: the size comes from the record, because the header holds none. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xd9]);

type Record_ = NonNullable<ProjectState['manifest']['assets']>[number];

function record(id: string, size: { readonly width: number; readonly height: number }, bytes: number, extra: Record<string, unknown> = {}, ext = 'png'): Record_ {
  return {
    id,
    file: `${id}.${ext}`,
    mime: ext === 'png' ? 'image/png' : 'image/jpeg',
    sha256: 'b'.repeat(64),
    bytes,
    ...size,
    createdAt: OPENED.toISOString(),
    ...extra,
  } as Record_;
}

const FILES: Record<string, Uint8Array> = {
  [`${HARBOUR}.png`]: pngBytes(640, 480),
  [`${KESTREL}.jpg`]: JPEG_BYTES,
  [`${MAP}.png`]: pngBytes(3000, 2000),
  [`${BIG}.png`]: pngBytes(800, 600, 4 * MIB),
  [`${HALF_ONE}.png`]: pngBytes(100, 100, 2 * MIB),
  [`${HALF_TWO}.png`]: pngBytes(100, 100, 2 * MIB),
  [`${SWAPPED}.png`]: JPEG_BYTES,
};

async function pictureFolder(label: string): Promise<string> {
  const root = tempDir(label);
  roots.push(root);
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER_ONE });
  addDocument(state, { parentId: CHAPTER_ONE, title: 'The Landing', body: 'The ferry was late, as always.', now: OPENED, id: LANDING });
  state.manifest.assets = [
    record(HARBOUR, { width: 640, height: 480 }, 96, { caption: 'The harbour at dusk', alt: 'Boats in a harbour', tags: ['harbour', 'dusk'] }),
    record(KESTREL, { width: 400, height: 300 }, JPEG_BYTES.length, { caption: 'A kestrel', tags: ['bird'] }, 'jpg'),
    record(MAP, { width: 3000, height: 2000 }, 96, { caption: 'The island map' }),
    record(BIG, { width: 800, height: 600 }, 4 * MIB, { caption: 'A very large photograph' }),
    record(HALF_ONE, { width: 100, height: 100 }, 2 * MIB),
    record(HALF_TWO, { width: 100, height: 100 }, 2 * MIB),
    record(SWAPPED, { width: 100, height: 100 }, JPEG_BYTES.length),
    record(ABSENT, { width: 100, height: 100 }, 96),
  ];
  state.manifest.assetLinks = [
    { id: 'l_JETTY00001', assetId: HARBOUR, target: { kind: 'node', nodeId: LANDING }, role: 'reference', order: 10, note: 'Use for the arrival' },
    { id: 'l_JETTY00002', assetId: KESTREL, target: { kind: 'project' }, role: 'reference', order: 10 },
  ] as NonNullable<ProjectState['manifest']['assetLinks']>;
  await writeProject(new NodeArtifactFs(root), state, { now: OPENED });
  mkdirSync(join(root, 'assets'), { recursive: true });
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(root, 'assets', name), bytes);
  return root;
}

async function open(root: string, allowWrites: boolean): Promise<Fixture> {
  const fixture = await startOver(root, allowWrites);
  fixtures.push(fixture);
  return fixture;
}

type Contents = Awaited<ReturnType<Client['readResource']>>['contents'][number];

async function contentsOf(client: Client, uri: string): Promise<Contents> {
  const { contents } = await client.readResource({ uri });
  const [first] = contents;
  if (first === undefined) throw new Error(`no contents for ${uri}`);
  return first;
}

async function jsonOf(client: Client, uri: string): Promise<{ pictures: { id: string; [key: string]: unknown }[]; links: { id: string; [key: string]: unknown }[] }> {
  const first = await contentsOf(client, uri);
  if (!('text' in first)) throw new Error(`no text for ${uri}`);
  expect(first.mimeType).toBe('application/json');
  return JSON.parse(first.text) as never;
}

async function rejection(promise: Promise<unknown>): Promise<Error & { code?: number }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: number };
  }
  throw new Error('the call was not refused');
}

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

interface ToolBody {
  readonly summary: string;
  readonly data: { readonly pictures: { id: string; [key: string]: unknown }[]; total?: number; omitted?: number | null };
  readonly notes?: string[];
}

const asBody = (result: unknown): ToolBody => resultJson(result as { content: readonly unknown[] }) as unknown as ToolBody;

describe('the picture tools in the tool list', () => {
  it.each([false, true])('lists pictures.list and pictures.view with a read-only hint and no write posture, with allowWrites %s', async (allowWrites) => {
    const fixture = await open(await pictureFolder('pic-list'), allowWrites);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const { tools } = await client.listTools();
      for (const name of [PICTURES_LIST, PICTURES_VIEW]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool, name).toBeDefined();
        expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
        expect(tool?.description).not.toMatch(/Requires user confirmation/u);
      }
      expect(tools.find((tool) => tool.name === PICTURES_VIEW)?.description).toMatch(/cannot resize/u);
      // The reads are this module's own: no import or transcribe, and the sweep has no tool at all. The three metadata writes are
      // registry rows served by the mapping, so they appear only where writes are allowed (tools.ts).
      expect(tools.filter((tool) => tool.name.startsWith('pictures.') || tool.name.startsWith('asset.')).map((tool) => tool.name).sort()).toEqual(
        allowWrites ? ['pictures.annotate', 'pictures.attach', PICTURES_LIST, 'pictures.place', PICTURES_VIEW] : [PICTURES_LIST, PICTURES_VIEW],
      );
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('refuses a write tool on a read-only server, and has no picture write to call on either', async () => {
    const fixture = await open(await pictureFolder('pic-denied'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const denied = await client.callTool({ name: 'notes.append', arguments: { doc: LANDING, text: 'x' } });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain('read-only');
      for (const name of ['pictures.annotate', 'pictures.attach', 'pictures.import', 'asset.sweep']) {
        const refused = await client.callTool({ name, arguments: {} }).then(
          (result) => result.isError === true,
          () => true,
        );
        expect(refused, name).toBe(true);
      }
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});

describe('caotang://assets', () => {
  it('serves the registry as JSON: the records and the links, without file names or hashes', async () => {
    const fixture = await open(await pictureFolder('pic-assets'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const body = await jsonOf(client, ASSETS_URI);
      expect(body.pictures.map((picture) => picture.id)).toEqual([HARBOUR, KESTREL, MAP, BIG, HALF_ONE, HALF_TWO, SWAPPED, ABSENT]);
      expect(body.pictures[0]).toMatchObject({ mime: 'image/png', bytes: 96, width: 640, height: 480, caption: 'The harbour at dusk', alt: 'Boats in a harbour', tags: ['harbour', 'dusk'] });
      expect(body.pictures[1]).toMatchObject({ mime: 'image/jpeg' });
      expect(body.links.map((link) => link.id)).toEqual(['l_JETTY00001', 'l_JETTY00002']);
      expect(body.links[0]).toMatchObject({ assetId: HARBOUR, role: 'reference', target: { kind: 'node', nodeId: LANDING }, note: 'Use for the arrival' });
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/sha256|\.png|\.jpg/u);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('is listed after the timeline resources, and every picture is listed by id with its type and size', async () => {
    const fixture = await open(await pictureFolder('pic-listed'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris.slice(0, 6)).toEqual(['caotang://project', 'caotang://binder', 'caotang://codex', 'caotang://timeline', 'caotang://timeline.csv', ASSETS_URI]);
      const picture = resources.find((resource) => resource.uri === assetUri(HARBOUR));
      expect(picture).toMatchObject({ name: HARBOUR, title: 'The harbour at dusk', mimeType: 'image/png', size: 96 });
      expect(uris.filter((uri) => uri.startsWith('caotang://asset/'))).toHaveLength(8);
      const { resourceTemplates } = await client.listResourceTemplates();
      expect(resourceTemplates.map((template) => template.uriTemplate)).toContain('caotang://asset/{id}');
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('is an empty registry for a project with no pictures', async () => {
    const root = tempDir('pic-none');
    roots.push(root);
    const state = createProjectState(createEmptyManifest('Bare', OPENED));
    await writeProject(new NodeArtifactFs(root), state, { now: OPENED });
    const fixture = await open(root, false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      expect(await jsonOf(client, ASSETS_URI)).toEqual({ pictures: [], links: [] });
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});

describe('caotang://asset/{id}', () => {
  it('serves a picture as a blob with the type its record names', async () => {
    const fixture = await open(await pictureFolder('pic-blob'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const png = await contentsOf(client, assetUri(HARBOUR));
      expect(png).toMatchObject({ uri: assetUri(HARBOUR), mimeType: 'image/png' });
      expect('blob' in png && png.blob).toBe(base64Of(FILES[`${HARBOUR}.png`] ?? new Uint8Array()));
      const jpeg = await contentsOf(client, assetUri(KESTREL));
      expect(jpeg).toMatchObject({ mimeType: 'image/jpeg' });
      expect('blob' in jpeg && jpeg.blob).toBe(base64Of(JPEG_BYTES));
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('serves a picture of exactly the largest size, and completes an id on a caption or a tag', async () => {
    const root = await pictureFolder('pic-edge');
    writeFileSync(join(root, 'assets', `${HALF_ONE}.png`), pngBytes(100, 100, PICTURE_MAX_SENT_BYTES));
    const fixture = await open(root, false);
    fixture.session.state.manifest.assets?.forEach((entry) => {
      if (entry.id === HALF_ONE) entry.bytes = PICTURE_MAX_SENT_BYTES;
    });
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const edge = await contentsOf(client, assetUri(HALF_ONE));
      expect('blob' in edge && Buffer.from(edge.blob, 'base64').length).toBe(PICTURE_MAX_SENT_BYTES);
      const completed = await client.complete({ ref: { type: 'ref/resource', uri: 'caotang://asset/{id}' }, argument: { name: 'id', value: 'dusk' } });
      expect(completed.completion.values).toEqual([HARBOUR]);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('refuses an unknown id with -32602 and the way to find one', async () => {
    const fixture = await open(await pictureFolder('pic-unknown'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const error = await rejection(client.readResource({ uri: assetUri(UNKNOWN) }));
      expect(error.code).toBe(-32602);
      expect(error.message).toContain(`There is no picture ${UNKNOWN}`);
      expect(error.message).toContain('caotang://assets');
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it.each(['..%2Fcaotang.json', '%2E%2E%2Fcaotang.json', '../caotang.json', `${HARBOUR}%2F..%2Fcaotang.json`, 'assets%2F' + HARBOUR + '.png', `${HARBOUR}.png`, 'a_short'])(
    'refuses %s as an id and never serves a file outside assets/',
    async (id) => {
      const fixture = await open(await pictureFolder('pic-traversal'), false);
      const client = await connectClient(fixture.url, fixture.token);
      try {
        const error = await rejection(client.readResource({ uri: `caotang://asset/${id}` }));
        expect(error.code).toBe(-32602);
        expect(error.message).not.toContain('"tree"');
        expect(error.message).not.toContain('The Lighthouse Keeper');
      } finally {
        await client.close();
      }
    },
    SERVER_FIXTURE_TIMEOUT,
  );

  it('never reads a file a damaged record points at, such as the manifest itself', async () => {
    const fixture = await open(await pictureFolder('pic-damaged'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const damaged = fixture.session.state.manifest.assets?.find((entry) => entry.id === HARBOUR);
      if (damaged === undefined) throw new Error('no record');
      damaged.file = '../caotang.json';
      const error = await rejection(client.readResource({ uri: assetUri(HARBOUR) }));
      expect(error.message).toContain('does not name the file its id and type give');
      expect(error.message).not.toContain('"tree"');
      const viewed = await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [HARBOUR] } });
      expect(viewed.isError).toBe(true);
      expect(JSON.stringify(viewed)).not.toContain('"tree"');
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('refuses a picture over what one message carries, with its size and the remedy, and never claims a downscale', async () => {
    const fixture = await open(await pictureFolder('pic-big'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const error = await rejection(client.readResource({ uri: assetUri(BIG) }));
      expect(error.code).toBe(-32600);
      expect(error.message).toContain('4.0 MiB (4194304 bytes)');
      expect(error.message).toContain(`(${PICTURE_MAX_SENT_BYTES} bytes)`);
      expect(error.message).toMatch(/cannot shrink a picture/u);
      expect(error.message).toMatch(/Caotang app/u);
      expect(error.message).toMatch(/working copy|smaller|below that size/u);
      expect(error.message).not.toMatch(/downscaled|was resized/u);
      // It is still listed, with its size, so the writer can see what it is and what to do about it.
      expect((await client.listResources()).resources.find((resource) => resource.uri === assetUri(BIG))?.size).toBe(4 * MIB);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('validates the type from the bytes: a file that is not the type recorded is refused, and so is a file the folder lacks', async () => {
    const fixture = await open(await pictureFolder('pic-mime'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const swapped = await rejection(client.readResource({ uri: assetUri(SWAPPED) }));
      expect(swapped.message).toContain('is not the image/png the project records');
      const absent = await rejection(client.readResource({ uri: assetUri(ABSENT) }));
      expect(absent.code).toBe(-32602);
      expect(absent.message).toContain("is not in the project's assets folder");
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});

describe('pictures.list', () => {
  it('lists every picture with its links and uses, and narrows by a target or a tag', async () => {
    const fixture = await open(await pictureFolder('pic-tool-list'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const all = asBody(await client.callTool({ name: PICTURES_LIST, arguments: {} }));
      expect(all.summary).toContain('The Lighthouse Keeper');
      expect(all.data.pictures).toHaveLength(8);
      expect(all.data.omitted).toBeNull();
      expect(all.data.pictures[0]).toMatchObject({ id: HARBOUR, caption: 'The harbour at dusk', links: [{ id: 'l_JETTY00001', target: { kind: 'node', nodeId: LANDING } }] });
      expect(JSON.stringify(all)).not.toMatch(/sha256|\.png/u);

      const onLanding = asBody(await client.callTool({ name: PICTURES_LIST, arguments: { target: LANDING } }));
      expect(onLanding.data.pictures.map((picture) => picture.id)).toEqual([HARBOUR]);
      const onProject = asBody(await client.callTool({ name: PICTURES_LIST, arguments: { target: 'project' } }));
      expect(onProject.data.pictures.map((picture) => picture.id)).toEqual([KESTREL]);
      const tagged = asBody(await client.callTool({ name: PICTURES_LIST, arguments: { tag: 'BIRD' } }));
      expect(tagged.data.pictures.map((picture) => picture.id)).toEqual([KESTREL]);
      expect(tagged.summary).toContain('1 of 8 listed');
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('refuses a target that is not a node and a parameter the tool does not have, as tool results', async () => {
    const fixture = await open(await pictureFolder('pic-tool-bad'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const target = await client.callTool({ name: PICTURES_LIST, arguments: { target: 'n_NOTHING001' } });
      expect(target.isError).toBe(true);
      expect(JSON.stringify(target)).toContain('binder.read_tree');
      expect((await client.callTool({ name: PICTURES_LIST, arguments: { colour: 'red' } })).isError).toBe(true);
      expect((await client.callTool({ name: PICTURES_LIST, arguments: { tag: ' ' } })).isError).toBe(true);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('cuts a long answer at whole pictures and says how many were left out', async () => {
    const fixture = await open(await pictureFolder('pic-tool-cap'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const assets = fixture.session.state.manifest.assets;
      if (assets === undefined) throw new Error('no records');
      for (let index = 0; index < 120; index += 1) {
        assets.push(record(`a_BULK${String(index).padStart(6, '0')}`, { width: 10, height: 10 }, 96, { caption: 'x'.repeat(500) }));
      }
      const body = asBody(await client.callTool({ name: PICTURES_LIST, arguments: {} }));
      const left = body.data.omitted;
      expect(typeof left).toBe('number');
      expect(body.data.pictures.length + (left ?? 0)).toBe(128);
      expect(body.data.pictures.length).toBeGreaterThan(8);
      expect(JSON.stringify(body.data.pictures).length).toBeLessThan(8000 * 4 + 4000);
      expect(body.summary).toContain('were left out');
      expect(body.summary).toContain('narrow it with target or tag');
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});

describe('pictures.view', () => {
  it('sends the stored pictures as image blocks, with their text, in the order asked', async () => {
    const fixture = await open(await pictureFolder('pic-view'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const result = await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [KESTREL, HARBOUR, KESTREL] } });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; data?: string; mimeType?: string; text?: string }[];
      expect(content.map((block) => block.type)).toEqual(['text', 'image', 'image']);
      expect(content[1]).toMatchObject({ mimeType: 'image/jpeg', data: base64Of(JPEG_BYTES) });
      expect(content[2]).toMatchObject({ mimeType: 'image/png', data: base64Of(FILES[`${HARBOUR}.png`] ?? new Uint8Array()) });
      const body = asBody(result);
      expect(body.data.pictures.map((picture) => picture.id)).toEqual([KESTREL, HARBOUR]);
      expect(body.data.pictures[1]).toMatchObject({ caption: 'The harbour at dusk', alt: 'Boats in a harbour', width: 640, height: 480 });
      expect(body.summary).toContain('sent as stored');
      expect(body.notes).toBeUndefined();
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('accepts maxPx and says it did not apply it, never claiming a resize', async () => {
    const fixture = await open(await pictureFolder('pic-maxpx'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const result = await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [HARBOUR], maxPx: 256 } });
      expect(result.isError).not.toBe(true);
      const notes = asBody(result).notes ?? [];
      expect(notes.join(' ')).toContain('maxPx 256 was not applied');
      expect(JSON.stringify(asBody(result))).not.toMatch(/downscaled|resized to/u);
      const bad = await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [HARBOUR], maxPx: 0 } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('refuses a picture whose long edge is over the limit before sending any, naming its size and the remedy', async () => {
    const fixture = await open(await pictureFolder('pic-edge-view'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const result = await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [HARBOUR, MAP] } });
      expect(result.isError).toBe(true);
      expect((result.content as { type: string }[]).map((block) => block.type)).toEqual(['text']);
      const text = JSON.stringify(result);
      expect(text).toContain(`${MAP} is 3000 × 2000 px`);
      expect(text).toContain(`over the ${VIEW_MAX_EDGE} px`);
      expect(text).toContain('Caotang app');
      expect(text).toContain('limit-exceeded');
      expect(text).not.toMatch(/downscaled|was resized/u);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('refuses a picture over the byte limit, and pictures that fit one at a time but not together', async () => {
    const fixture = await open(await pictureFolder('pic-bytes-view'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const big = await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [BIG] } });
      expect(big.isError).toBe(true);
      expect(JSON.stringify(big)).toContain('4.0 MiB (4194304 bytes)');
      expect(JSON.stringify(big)).toContain('cannot shrink a picture');
      const alone = await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [HALF_ONE] } });
      expect(alone.isError).not.toBe(true);
      const together = await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [HALF_ONE, HALF_TWO] } });
      expect(together.isError).toBe(true);
      expect((together.content as { type: string }[]).every((block) => block.type === 'text')).toBe(true);
      expect(JSON.stringify(together)).toContain('so none was sent');
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);

  it('refuses an unknown id, a file that is not the type recorded, a missing file, too many ids and a stray parameter', async () => {
    const fixture = await open(await pictureFolder('pic-view-bad'), false);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const call = async (args: Record<string, unknown>) => JSON.stringify(await client.callTool({ name: PICTURES_VIEW, arguments: args }));
      expect(await call({ assetIds: [UNKNOWN] })).toContain('not-found');
      expect(await call({ assetIds: ['../caotang.json'] })).toContain('invalid-params');
      expect(await call({ assetIds: [SWAPPED] })).toContain('is not the image/png');
      expect(await call({ assetIds: [ABSENT] })).toContain('not in the project');
      expect(await call({ assetIds: [HARBOUR, KESTREL, MAP, BIG, SWAPPED] })).toContain('at most 4');
      expect(await call({ assetIds: [] })).toContain('one to four');
      expect(await call({})).toContain('one to four');
      expect(await call({ assetIds: [HARBOUR], colour: 'red' })).toContain('is not a parameter');
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});

describe('a picture read writes nothing', () => {
  it.each([false, true])('leaves every byte of the folder as it was, with allowWrites %s', async (allowWrites) => {
    const fixture = await open(await pictureFolder('pic-nowrite'), allowWrites);
    const client = await connectClient(fixture.url, fixture.token);
    try {
      const before = folderBytes(fixture.root);
      const logged = fixture.session.harness.log.length;
      await client.callTool({ name: PICTURES_LIST, arguments: {} });
      await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [HARBOUR] } });
      await client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [BIG] } });
      await jsonOf(client, ASSETS_URI);
      await contentsOf(client, assetUri(HARBOUR));
      await rejection(client.readResource({ uri: assetUri(BIG) }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(folderBytes(fixture.root)).toEqual(before);
      expect(fixture.session.harness.log.length).toBe(logged);
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});

describe('what a log row changes for the pictures', () => {
  const row = (command: string) => ({ at: 0, command, issuedBy: 'agent' as const, source: 'mcp' as const, affected: [], summary: command });

  it('refreshes the registry on any project change, and every picture on a picture command', async () => {
    const fixture = await open(await pictureFolder('pic-rows'), false);
    const { state } = fixture.session;
    expect(changeOf(state, [row('notes.append')]).updated).toContain(ASSETS_URI);
    expect(changeOf(state, [row('notes.append')]).updated).not.toContain(assetUri(HARBOUR));

    const meta = changeOf(state, [row('asset.setMeta')]);
    expect(meta.updated).toEqual(expect.arrayContaining([ASSETS_URI, ...[HARBOUR, KESTREL, MAP, BIG].map(assetUri)]));
    expect(meta.listChanged).toBe(false);
    for (const command of ['asset.import', 'asset.importBatch', 'asset.delete']) expect(changeOf(state, [row(command)]).listChanged, command).toBe(true);

    expect(changeOf(state, [row('view.setScroll'), row('export.compile')])).toEqual({ updated: [], listChanged: false });
  }, SERVER_FIXTURE_TIMEOUT);

  it('tells a subscribed host, and a read shows the change without opening the session again', async () => {
    const fixture = await open(await pictureFolder('pic-refresh'), true);
    const client = await connectClient(fixture.url, fixture.token, acceptConfirm);
    try {
      const updated: string[] = [];
      client.setNotificationHandler('notifications/resources/updated', (notification) => {
        updated.push(notification.params.uri);
      });
      const subscription = await client.listen({ resourceSubscriptions: [ASSETS_URI, assetUri(HARBOUR)] });
      const waitFor = async (uri: string): Promise<void> => {
        const stop = Date.now() + 5000;
        while (!updated.includes(uri)) {
          if (Date.now() > stop) throw new Error(`timed out waiting for ${uri}; saw ${updated.join(', ')}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      // A real write the server accepts touches the registry's resource, because links follow the tree and the bodies.
      const renamed = await client.callTool({ name: 'binder.restructure', arguments: { ops: [{ action: 'rename', node: LANDING, title: 'The Arrival' }] } });
      expect(renamed.isError).not.toBe(true);
      await waitFor(ASSETS_URI);
      updated.length = 0;

      // A picture command changes a record in the session's state and announces what the save would, as the session does after a write.
      expect((await jsonOf(client, ASSETS_URI)).pictures[0]).toMatchObject({ caption: 'The harbour at dusk' });
      const harbour = fixture.session.state.manifest.assets?.find((entry) => entry.id === HARBOUR);
      if (harbour === undefined) throw new Error('no record');
      harbour.caption = 'The harbour at dawn';
      fixture.session.changes.emit(changeOf(fixture.session.state, [row('asset.setMeta')]));
      await waitFor(ASSETS_URI);
      await waitFor(assetUri(HARBOUR));
      expect((await jsonOf(client, ASSETS_URI)).pictures[0]).toMatchObject({ caption: 'The harbour at dawn' });
      const called = asBody(await client.callTool({ name: PICTURES_LIST, arguments: { tag: 'dusk' } }));
      expect(called.data.pictures[0]).toMatchObject({ caption: 'The harbour at dawn' });

      // A picture added to the registry is read at once, and the list is announced as changed.
      const assets = fixture.session.state.manifest.assets;
      assets?.push(record('a_NEWT000010', { width: 50, height: 50 }, 96, { caption: 'New' }));
      writeFileSync(join(fixture.root, 'assets', 'a_NEWT000010.png'), pngBytes(50, 50));
      expect(await contentsOf(client, assetUri('a_NEWT000010'))).toMatchObject({ mimeType: 'image/png' });
      expect((await jsonOf(client, ASSETS_URI)).pictures.map((picture) => picture.id)).toContain('a_NEWT000010');
      await subscription.close();
    } finally {
      await client.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});

describe('over stdio', () => {
  /** A server on one end of an in-memory pair, as `startStdioServer` builds it, and a client on the other. */
  async function pair(root: string, modern: boolean) {
    const session = await openProject({ root, allowWrites: false });
    const runtime = createToolRuntime(session);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => buildMcpServer(runtime, { live: true }), { legacy: 'serve', transport: serverSide });
    const client = new Client({ name: 'stdio-picture-host', version: '0.0.0' }, modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    await client.connect(clientSide);
    return {
      client,
      async close() {
        await client.close();
        await handle.close();
        await session.close();
      },
    };
  }

  it.each([true, false])('serves the registry as JSON and a picture as a blob, and refuses an oversize one, on a modern connection %s', async (modern) => {
    const host = await pair(await pictureFolder('pic-stdio'), modern);
    try {
      const registry = await jsonOf(host.client, ASSETS_URI);
      expect(registry.pictures.map((picture) => picture.id)).toContain(HARBOUR);
      const blob = await contentsOf(host.client, assetUri(HARBOUR));
      expect(blob).toMatchObject({ mimeType: 'image/png' });
      expect('blob' in blob && blob.blob).toBe(base64Of(FILES[`${HARBOUR}.png`] ?? new Uint8Array()));
      expect((await rejection(host.client.readResource({ uri: assetUri(BIG) }))).message).toContain('cannot shrink a picture');
      const viewed = await host.client.callTool({ name: PICTURES_VIEW, arguments: { assetIds: [HARBOUR] } });
      expect((viewed.content as { type: string }[]).map((block) => block.type)).toEqual(['text', 'image']);
    } finally {
      await host.close();
    }
  }, SERVER_FIXTURE_TIMEOUT);
});
