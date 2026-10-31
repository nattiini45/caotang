/**
 * The `assets/` folder — storyboard.md §2.2. Bytes move only through the store's byte port (`readBytes`,
 * `writeBytesAtomic`), the format comes from the leading bytes, unknown files are ignored, and a dangling
 * reference is dropped with a notice and nothing else.
 */

import { describe, expect, it } from 'vitest';

import {
  ASSETS_DIR,
  addShotNode,
  assetFileName,
  danglingImages,
  dropDanglingImages,
  importImage,
  isAssetId,
  listAssets,
  parseAssetFileName,
  presentAssetIds,
  readImage,
  sniffImage,
  unsupportedFormatName,
} from '../src/index.js';

import { CountingFs, NOW, buildFixture, jpegBytes, pngBytes, treeSnapshot, webpBytes } from './fixtures.js';

describe('sniffing the format from the leading bytes', () => {
  it('names PNG, JPEG and WebP by their signatures', () => {
    expect(sniffImage(pngBytes())).toBe('png');
    expect(sniffImage(jpegBytes())).toBe('jpeg');
    expect(sniffImage(webpBytes())).toBe('webp');
  });

  it('does not take a RIFF file that is not WebP for a WebP image', () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffImage(wav)).toBeUndefined();
  });

  it('returns nothing for empty or truncated input, rather than reading past the end', () => {
    expect(sniffImage(new Uint8Array())).toBeUndefined();
    expect(sniffImage(new Uint8Array([0x89, 0x50]))).toBeUndefined();
  });

  it('names the two formats v1 refuses, so the refusal can say what the file is', () => {
    expect(unsupportedFormatName(new Uint8Array([0x38, 0x42, 0x50, 0x53, 0, 0]))).toBe('Photoshop (PSD)');
    expect(unsupportedFormatName(new Uint8Array([0x76, 0x2f, 0x31, 0x01, 0]))).toBe('OpenEXR');
    expect(unsupportedFormatName(pngBytes())).toBeUndefined();
  });
});

describe('asset file names', () => {
  it('names a file a_ + the id + the extension, with JPEG stored as jpg', () => {
    expect(assetFileName('a_7K2QX9M4A1', 'png')).toBe('a_7K2QX9M4A1.png');
    expect(assetFileName('a_7K2QX9M4A1', 'jpeg')).toBe('a_7K2QX9M4A1.jpg');
    expect(assetFileName('a_7K2QX9M4A1', 'webp')).toBe('a_7K2QX9M4A1.webp');
  });

  it('parses only a name that is exactly an asset id and a v1 extension', () => {
    expect(parseAssetFileName('a_7K2QX9M4A1.jpg')).toEqual({ assetId: 'a_7K2QX9M4A1', format: 'jpeg', extension: 'jpg', mime: 'image/jpeg' });
    expect(parseAssetFileName('a_7K2QX9M4A1.jpeg')).toBeUndefined();
    expect(parseAssetFileName('a_7K2QX9M4A1.gif')).toBeUndefined();
    expect(parseAssetFileName('a_7K2QX9M4A1.png.tmp-3')).toBeUndefined();
    expect(parseAssetFileName('notes.txt')).toBeUndefined();
    expect(parseAssetFileName('n_7K2QX9M4A1.png')).toBeUndefined();
  });
});

describe('importing an image', () => {
  it('writes the bytes under assets/ through writeBytesAtomic, and returns the id the shot will hold', async () => {
    const fs = new CountingFs();
    const bytes = pngBytes(40);
    const imported = await importImage(fs, bytes, { taken: new Set() });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value).toMatchObject({ format: 'png', mime: 'image/png', path: `${ASSETS_DIR}/${imported.value.assetId}.png` });
    expect(isAssetId(imported.value.assetId)).toBe(true);
    expect(fs.calls).toContain(`writeBytesAtomic ${imported.value.path}`);
    expect(await fs.readBytes(imported.value.path)).toEqual(bytes);
  });

  it('stores a JPEG as .jpg and a WebP as .webp', async () => {
    const fs = new CountingFs();
    const jpeg = await importImage(fs, jpegBytes(), {});
    const webp = await importImage(fs, webpBytes(), {});
    expect(jpeg.ok && jpeg.value.fileName.endsWith('.jpg')).toBe(true);
    expect(webp.ok && webp.value.fileName.endsWith('.webp')).toBe(true);
  });

  it('never overwrites an existing asset, because the new id is minted against the ones present', async () => {
    const fs = new CountingFs();
    const first = await importImage(fs, pngBytes(), {});
    const second = await importImage(fs, pngBytes(20), {});
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.value.assetId).not.toBe(first.value.assetId);
    expect((await listAssets(fs)).map((asset) => asset.assetId)).toHaveLength(2);
  });

  it('refuses an empty file, with the reason', async () => {
    const result = await importImage(new CountingFs(), new Uint8Array(), {});
    expect(result).toMatchObject({ ok: false, refusal: { code: 'image-empty' } });
  });

  it('refuses a PSD by name, and says the v1 formats', async () => {
    const psd = new Uint8Array([0x38, 0x42, 0x50, 0x53, 0, 1, 0, 0]);
    const result = await importImage(new CountingFs(), psd, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('image-format');
      expect(result.refusal.message).toContain('Photoshop (PSD)');
      expect(result.refusal.message).toContain('PNG, JPEG or WebP');
    }
  });

  it('refuses a file that is not an image, and writes nothing', async () => {
    const fs = new CountingFs();
    const result = await importImage(fs, new TextEncoder().encode('just text'), {});
    expect(result.ok).toBe(false);
    expect(fs.calls).toEqual([]);
  });
});

describe('reading an image back', () => {
  it('returns the bytes exactly as written, with the format they are', async () => {
    const fs = new CountingFs();
    const bytes = webpBytes(64);
    const imported = await importImage(fs, bytes, {});
    if (!imported.ok) throw new Error('import failed');
    const loaded = await readImage(fs, imported.value.assetId);
    expect(loaded).toMatchObject({ assetId: imported.value.assetId, format: 'webp', mime: 'image/webp' });
    expect(loaded?.bytes).toEqual(bytes);
    expect(fs.calls).toContain(`readBytes ${imported.value.path}`);
  });

  it('returns nothing for an id that is absent, malformed, or names a file that is not an image', async () => {
    const fs = new CountingFs();
    expect(await readImage(fs, 'a_7K2QX9M4A1')).toBeUndefined();
    expect(await readImage(fs, '../../etc/passwd')).toBeUndefined();
    fs.putFile(`${ASSETS_DIR}/a_7K2QX9M4A1.png`, 'plain text, not a picture');
    expect(await readImage(fs, 'a_7K2QX9M4A1')).toBeUndefined();
  });

  it('ignores files in assets/ that are not assets, as the loaders ignore unknown files (§1)', async () => {
    const fs = new CountingFs();
    fs.putFile(`${ASSETS_DIR}/readme.txt`, 'hello');
    fs.putFile(`${ASSETS_DIR}/a_7K2QX9M4A1.png.tmp-9`, 'a temp file');
    fs.putFile(`${ASSETS_DIR}/a_SHORT.png`, 'short id');
    expect(await listAssets(fs)).toEqual([]);
  });
});

describe('dangling image references', () => {
  it('finds a shot whose image names no file, and no other shot', async () => {
    const { state } = buildFixture();
    addShotNode(state, { parentId: 'board1', title: 'ok', stored: { image: 'a_AAAAAAAAAA' }, id: 'n_SHOTONE001', now: NOW });
    addShotNode(state, { parentId: 'board1', title: 'gone', stored: { image: 'a_BBBBBBBBBB' }, id: 'n_SHOTTWO001', now: NOW });
    const present = new Set(['a_AAAAAAAAAA']);
    expect(danglingImages(state.manifest.tree, present)).toEqual([{ nodeId: 'n_SHOTTWO001', assetId: 'a_BBBBBBBBBB' }]);
  });

  it('drops only the image key, keeps the rest of the shot, and says what it dropped', () => {
    const { state } = buildFixture();
    addShotNode(state, {
      parentId: 'board1',
      title: 'gone',
      stored: { image: 'a_BBBBBBBBBB', action: 'Elena turns.', shotSize: 'MS' },
      id: 'n_SHOTTWO001',
      now: NOW,
    });
    const notices = dropDanglingImages(state, new Set());
    expect(notices).toHaveLength(1);
    const node = state.manifest.tree.find((candidate) => candidate.id === 'n_SHOTTWO001');
    expect((node as { shot?: unknown }).shot).toEqual({ action: 'Elena turns.', shotSize: 'MS' });
  });

  it('reports the set of present asset ids from the folder, for the caller to check against', async () => {
    const fs = new CountingFs();
    const imported = await importImage(fs, pngBytes(), {});
    if (!imported.ok) throw new Error('import failed');
    expect([...(await presentAssetIds(fs))]).toEqual([imported.value.assetId]);
  });

  it('leaves the tree exactly as it was when nothing dangles', () => {
    const { state } = buildFixture();
    const before = treeSnapshot(state);
    expect(dropDanglingImages(state, new Set())).toEqual([]);
    expect(treeSnapshot(state)).toBe(before);
  });
});
