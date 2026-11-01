/**
 * The picture reads a Node host makes (pictures.md §6.1, §6.4.1, §8.2): the registry as summaries, a list narrowed by target or
 * tag, and one file's bytes by asset id, refused for a bad id, an unknown id, a damaged record, a size over the bound and bytes that
 * are not the record's type.
 */

import { addDocument, addFolder, ArtifactNotFoundError, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { ArtifactPathError, PictureReadError, pictureListOf, pictureRegistryOf, readPictureFile, tooLargeMessage } from '../src/folder-api.js';
import { OPENED } from './fixture.js';

const CHAPTER = 'n_CHAPTR0001';
const LANDING = 'n_BEACH00001';
const STORM = 'n_TEMPEST001';
const HARBOUR = 'a_HARB000001';
const KESTREL = 'a_KEST000002';
const MAP = 'a_MAPS000003';

/** A PNG header with the given size: enough for the sniff and the header read, which is all the port looks at. */
function pngBytes(width: number, height: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(length, 33));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function record(id: string, extra: Record<string, unknown> = {}): NonNullable<ProjectState['manifest']['assets']>[number] {
  return {
    id,
    file: `${id}.png`,
    mime: 'image/png',
    sha256: 'a'.repeat(64),
    bytes: 64,
    width: 800,
    height: 600,
    createdAt: OPENED.toISOString(),
    ...extra,
  } as NonNullable<ProjectState['manifest']['assets']>[number];
}

function projectWithPictures(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: OPENED, id: CHAPTER });
  addDocument(state, { parentId: CHAPTER, title: 'The Landing', body: 'The ferry was late.', now: OPENED, id: LANDING });
  addDocument(state, { parentId: CHAPTER, title: 'The Storm', body: `Rain.\n\n![the map](../assets/${MAP}.png)\n`, now: OPENED, id: STORM });
  state.manifest.assets = [
    record(HARBOUR, { caption: 'The harbour at dusk', tags: ['Harbour', 'dusk'], source: { kind: 'import', label: 'harbour photo' } }),
    record(KESTREL, { tags: ['bird'], transcription: { text: 'kestrel over the pier', at: OPENED.toISOString() } }),
    record(MAP),
  ];
  state.manifest.assetLinks = [
    { id: 'l_JETTY00001', assetId: HARBOUR, target: { kind: 'node', nodeId: LANDING }, role: 'reference', order: 10, note: 'Use for the arrival' },
    { id: 'l_JETTY00002', assetId: KESTREL, target: { kind: 'project' }, role: 'reference', order: 10 },
    {
      id: 'l_JETTY00003',
      assetId: KESTREL,
      target: {
        kind: 'paragraph',
        nodeId: LANDING,
        anchor: { from: 0, to: 4, exact: 'The ferry', prefix: '', suffix: ' was late', capturedRevision: 1, blockHash: 'abc', ordinal: 0 },
        orphaned: true,
      },
      role: 'reference',
      order: 20,
    },
  ] as NonNullable<ProjectState['manifest']['assetLinks']>;
  return state;
}

/** A folder port over a map, which counts its reads so a test can say a refusal came before any file was touched. */
function folderOf(files: Record<string, Uint8Array>): { readonly fs: { readBytes(path: string): Promise<Uint8Array> }; readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fs: {
      async readBytes(path: string) {
        reads.push(path);
        const found = files[path];
        if (found === undefined) throw new ArtifactNotFoundError(path);
        return found;
      },
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<PictureReadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PictureReadError) return error;
    throw error;
  }
  throw new Error('the read was not refused');
}

describe('the registry as a host reads it', () => {
  it('lists every record and link, without the stored file name or the hash', () => {
    const registry = pictureRegistryOf(projectWithPictures());
    expect(registry.pictures.map((picture) => picture.id)).toEqual([HARBOUR, KESTREL, MAP]);
    const text = JSON.stringify(registry);
    expect(text).not.toContain('sha256');
    expect(text).not.toContain('.png"');
    expect(registry.pictures[0]).toMatchObject({ id: HARBOUR, mime: 'image/png', bytes: 64, width: 800, height: 600, caption: 'The harbour at dusk' });
  });

  it('gives a paragraph link its quote and its flags in place of the whole anchor', () => {
    const { links } = pictureRegistryOf(projectWithPictures());
    expect(links.find((link) => link.id === 'l_JETTY00003')?.target).toEqual({ kind: 'paragraph', nodeId: LANDING, quote: 'The ferry', orphaned: true });
    expect(JSON.stringify(links)).not.toContain('blockHash');
    expect(links.find((link) => link.id === 'l_JETTY00001')).toMatchObject({ role: 'reference', order: 10, note: 'Use for the arrival', target: { kind: 'node', nodeId: LANDING } });
  });

  it('is empty for a project with no pictures', () => {
    expect(pictureRegistryOf(createProjectState(createEmptyManifest('Empty', OPENED)))).toEqual({ pictures: [], links: [] });
  });
});

describe('a picture list', () => {
  it('narrows by a node, counting a paragraph of the node, and by the project', () => {
    const state = projectWithPictures();
    expect(pictureListOf(state, { target: LANDING }).map((entry) => entry.picture.id)).toEqual([HARBOUR, KESTREL]);
    expect(pictureListOf(state, { target: STORM })).toEqual([]);
    expect(pictureListOf(state, { target: 'project' }).map((entry) => entry.picture.id)).toEqual([KESTREL]);
  });

  it('narrows by a tag, ignoring case', () => {
    const state = projectWithPictures();
    expect(pictureListOf(state, { tag: 'HARBOUR' }).map((entry) => entry.picture.id)).toEqual([HARBOUR]);
    expect(pictureListOf(state, { tag: 'nothing' })).toEqual([]);
    expect(pictureListOf(state, { target: LANDING, tag: 'bird' }).map((entry) => entry.picture.id)).toEqual([KESTREL]);
  });

  it('adds each picture’s links and its uses other than links, such as an inline image in a document', () => {
    const entries = pictureListOf(projectWithPictures());
    const harbour = entries.find((entry) => entry.picture.id === HARBOUR);
    expect(harbour?.links.map((link) => link.id)).toEqual(['l_JETTY00001']);
    expect(harbour?.uses).toEqual([]);
    const map = entries.find((entry) => entry.picture.id === MAP);
    expect(map?.uses).toEqual([{ kind: 'inline', nodeId: STORM }]);
  });

  it('refuses a target that is neither the project nor a node', async () => {
    expect(() => pictureListOf(projectWithPictures(), { target: 'n_NOTHING001' })).toThrowError(PictureReadError);
    try {
      pictureListOf(projectWithPictures(), { target: 'n_NOTHING001' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'unknown-target' });
      expect((error as Error).message).toContain('binder.read_tree');
    }
  });
});

describe('reading one picture', () => {
  it('returns the bytes with the record, and the display size from the header', async () => {
    const state = projectWithPictures();
    const bytes = pngBytes(640, 480);
    const { fs, reads } = folderOf({ [`assets/${HARBOUR}.png`]: bytes });
    const read = await readPictureFile(fs, state, HARBOUR, { maxBytes: 1024 });
    expect(read.bytes).toEqual(bytes);
    expect(read.mime).toBe('image/png');
    expect(read.record.id).toBe(HARBOUR);
    expect(read.display).toEqual({ width: 640, height: 480 });
    expect(reads).toEqual([`assets/${HARBOUR}.png`]);
  });

  it.each(['../caotang', '..', 'a_HARB000001/..', 'a_HARB00000', 'A_HARB000001', 'a_HARB000001.png', 'assets/a_HARB000001.png', 'C:/x', '', 'a_HARB00000\0'])(
    'refuses %j as an id, before any file is read',
    async (id) => {
      const { fs, reads } = folderOf({});
      const error = await refusal(readPictureFile(fs, projectWithPictures(), id, { maxBytes: 1024 }));
      expect(error.code).toBe('bad-id');
      expect(reads).toEqual([]);
    },
  );

  it('refuses an id the registry does not hold, even when the file is in the folder', async () => {
    const { fs, reads } = folderOf({ 'assets/a_FAKE000009.png': pngBytes(10, 10) });
    const error = await refusal(readPictureFile(fs, projectWithPictures(), 'a_FAKE000009', { maxBytes: 1024 }));
    expect(error.code).toBe('unknown-picture');
    expect(error.message).toContain('pictures.list');
    expect(reads).toEqual([]);
  });

  it.each(['../caotang.json', '../../outside.png', 'assets/a_HARB000001.png', 'a_KEST000002.png', 'a_HARB000001.jpg', ''])(
    'never reads a record whose stored file is %j',
    async (file) => {
      const state = projectWithPictures();
      const damaged = state.manifest.assets?.[0];
      if (damaged === undefined) throw new Error('no record');
      damaged.file = file;
      const { fs, reads } = folderOf({ [file]: pngBytes(10, 10), [`assets/${HARBOUR}.png`]: pngBytes(10, 10) });
      const error = await refusal(readPictureFile(fs, state, HARBOUR, { maxBytes: 1024 }));
      expect(error.code).toBe('damaged-record');
      expect(reads).toEqual([]);
    },
  );

  it('says a path the folder port refuses is a damaged record, not a crash', async () => {
    const fs = {
      async readBytes(path: string): Promise<Uint8Array> {
        throw new ArtifactPathError(path, 'resolves through a link outside the project folder');
      },
    };
    expect((await refusal(readPictureFile(fs, projectWithPictures(), HARBOUR, { maxBytes: 1024 }))).code).toBe('damaged-record');
  });

  it('refuses a picture whose record is over the bound without reading the file, naming the size and the remedy', async () => {
    const state = projectWithPictures();
    const big = state.manifest.assets?.[0];
    if (big === undefined) throw new Error('no record');
    big.bytes = 5 * 1024 * 1024;
    const { fs, reads } = folderOf({ [`assets/${HARBOUR}.png`]: pngBytes(10, 10) });
    const error = await refusal(readPictureFile(fs, state, HARBOUR, { maxBytes: 3 * 1024 * 1024 }));
    expect(error.code).toBe('too-large');
    expect(error.detail).toEqual({ bytes: 5 * 1024 * 1024, limit: 3 * 1024 * 1024 });
    expect(error.message).toContain('5.0 MiB (5242880 bytes)');
    expect(error.message).toContain('3.0 MiB');
    expect(error.message).toMatch(/cannot shrink/u);
    expect(error.message).toMatch(/Caotang app/u);
    expect(error.message).not.toMatch(/downscaled|resized to/u);
    expect(reads).toEqual([]);
  });

  it('refuses a file larger than its record says, so a stale record cannot carry a big file past the bound', async () => {
    const state = projectWithPictures();
    const { fs } = folderOf({ [`assets/${HARBOUR}.png`]: pngBytes(10, 10, 4096) });
    const error = await refusal(readPictureFile(fs, state, HARBOUR, { maxBytes: 1024 }));
    expect(error.code).toBe('too-large');
    expect(error.detail).toEqual({ bytes: 4096, limit: 1024 });
  });

  it('serves a file of exactly the bound', async () => {
    const state = projectWithPictures();
    const { fs } = folderOf({ [`assets/${HARBOUR}.png`]: pngBytes(10, 10, 64) });
    expect((await readPictureFile(fs, state, HARBOUR, { maxBytes: 64 })).bytes).toHaveLength(64);
  });

  it('refuses a file the folder does not hold', async () => {
    const { fs } = folderOf({});
    expect((await refusal(readPictureFile(fs, projectWithPictures(), HARBOUR, { maxBytes: 1024 }))).code).toBe('missing-file');
  });

  it('validates the type from the bytes, never from the name: JPEG bytes under a PNG record, and a file that is no picture', async () => {
    const state = projectWithPictures();
    const jpeg = folderOf({ [`assets/${HARBOUR}.png`]: JPEG_BYTES });
    expect((await refusal(readPictureFile(jpeg.fs, state, HARBOUR, { maxBytes: 1024 }))).code).toBe('wrong-type');
    const text = folderOf({ [`assets/${HARBOUR}.png`]: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>') });
    expect((await refusal(readPictureFile(text.fs, state, HARBOUR, { maxBytes: 1024 }))).code).toBe('wrong-type');
    const empty = folderOf({ [`assets/${HARBOUR}.png`]: new Uint8Array(0) });
    expect((await refusal(readPictureFile(empty.fs, state, HARBOUR, { maxBytes: 1024 }))).code).toBe('wrong-type');
  });

  it('serves a JPEG record from a .jpg file', async () => {
    const state = projectWithPictures();
    const jpeg = state.manifest.assets?.[0];
    if (jpeg === undefined) throw new Error('no record');
    jpeg.file = `${HARBOUR}.jpg`;
    jpeg.mime = 'image/jpeg';
    const { fs } = folderOf({ [`assets/${HARBOUR}.jpg`]: JPEG_BYTES });
    const read = await readPictureFile(fs, state, HARBOUR, { maxBytes: 1024 });
    expect(read.mime).toBe('image/jpeg');
    expect(read.display).toBeUndefined();
  });

  it('words the oversize refusal without claiming a downscale', () => {
    const message = tooLargeMessage('Picture a_X', 4_000_000, 1_000_000);
    expect(message).toContain('3.8 MiB (4000000 bytes)');
    expect(message).toContain('977 KiB (1000000 bytes)');
  });
});
