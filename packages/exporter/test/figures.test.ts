/**
 * The figure model (figures.ts, pictures.md §4): a placement resolved against the project. Asset identity and the placement text
 * (the body first, the registry record second), one read and one payload for a picture placed twice or stored twice, the log notes for
 * what cannot be embedded, the weight summary, and the host's `ProcessPicture` for a profile that needs a transcode — a refusal there
 * degrades one picture to its caption and never fails the compile.
 */

import { describe, expect, it } from 'vitest';
import { encodePlacementTitle, PictureRefusal, type PictureBytes } from '@caotang/pictures';

import { assetRefOfUrl, formatBytes, resolveFigures, usedAssetFilesOf, type ResolvedFigure } from '../src/figures.js';
import { copySpec, docxSpec, DOCX_IMAGE_MAX_EDGE, epubSpec } from '../src/picture-profile.js';
import type { FlatBlock } from '../src/types.js';
import {
  hasMarker,
  hostOf,
  ID_A,
  ID_B,
  ID_C,
  ID_D,
  ID_E,
  ID_F,
  jpgFile,
  paddedPng,
  placement,
  pngFile,
  solidJpeg,
  solidPng,
  stubProcess,
  urlOf,
  withPngXmp,
} from './figure-fixtures.js';
import { webpFixture } from './webp-fixtures.js';

const copy = { ...copySpec({}), embed: true };
const epub = { ...epubSpec({}), embed: true };

const figureOf = (pack: { readonly figures: ReadonlyMap<string, ResolvedFigure> }, url: string): ResolvedFigure => {
  const found = pack.figures.get(url);
  if (found === undefined) throw new Error(`no figure resolved for ${url}`);
  return found;
};

describe('asset identity', () => {
  it('names the asset and the stored file a ../assets/ destination points at', () => {
    expect(assetRefOfUrl(urlOf(pngFile(ID_A)))).toEqual({ assetId: ID_A, file: pngFile(ID_A) });
    expect(assetRefOfUrl(urlOf(jpgFile(ID_A)))).toEqual({ assetId: ID_A, file: jpgFile(ID_A) });
  });

  it('knows no asset in any other spelling of a path', () => {
    for (const url of [pngFile(ID_A), `assets/${pngFile(ID_A)}`, `https://example.com/${pngFile(ID_A)}`, '../assets/cover.png', '../assets/a_8K3QZ2M7RD.gif', `../assets/${pngFile(ID_A)}?x=1`, '../assets/../x.png']) {
      expect(assetRefOfUrl(url), url).toBeUndefined();
    }
  });

  it('resolves the placement to the asset id and file, with the bytes read from assets/', async () => {
    const { host, reads } = hostOf({ [`assets/${pngFile(ID_A)}`]: solidPng(4, 3) });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'A harbour')], host, copy);
    const figure = figureOf(pack, urlOf(pngFile(ID_A)));
    expect([figure.assetId, figure.fileName, figure.missing]).toEqual([ID_A, pngFile(ID_A), false]);
    expect(figure.image).toMatchObject({ name: pngFile(ID_A), mime: 'image/png', width: 4, height: 3 });
    expect(reads).toEqual([`assets/${pngFile(ID_A)}`]);
  });

  it('reads the placement text from the body first and the registry record second', async () => {
    const { host } = hostOf({}, { records: [{ id: ID_A, caption: 'Record caption', alt: 'Record alt' }, { id: ID_B, caption: 'Record caption', alt: 'Record alt', decorative: true }] });
    const pack = await resolveFigures(
      [placement(urlOf(pngFile(ID_A)), '', null), placement(urlOf(pngFile(ID_B)), 'Body alt', 'Body caption'), placement(urlOf(pngFile(ID_C)), '', encodePlacementTitle({ caption: 'Cap', decorative: true }))],
      host,
      { ...copy, embed: false },
    );
    expect(figureOf(pack, urlOf(pngFile(ID_A)))).toMatchObject({ alt: 'Record alt', caption: 'Record caption', decorative: false });
    expect(figureOf(pack, urlOf(pngFile(ID_B)))).toMatchObject({ alt: 'Body alt', caption: 'Body caption', decorative: true });
    expect(figureOf(pack, urlOf(pngFile(ID_C)))).toMatchObject({ caption: 'Cap', decorative: true });
  });

  it('keeps a title with a suffix version this build cannot read whole, and says so', async () => {
    const title = 'Cap [caotang-image v9;mystery]';
    const { host } = hostOf({ [`assets/${pngFile(ID_A)}`]: solidPng(2, 2) });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt', title)], host, copy);
    expect(figureOf(pack, urlOf(pngFile(ID_A)))).toMatchObject({ opaqueTitle: title, caption: title });
    expect(pack.notes.join('\n')).toContain(`${pngFile(ID_A)}'s title carries a picture-suffix version this build cannot decode`);
  });
});

describe('shared bytes and payload dedup', () => {
  it('reads, packs and shares one payload for a picture placed twice', async () => {
    const { host, reads } = hostOf({ [`assets/${pngFile(ID_A)}`]: solidPng(4, 3) });
    const url = urlOf(pngFile(ID_A));
    const pack = await resolveFigures([placement(url, 'First'), placement(url, 'Again', 'Another caption')], host, copy);
    expect(reads).toEqual([`assets/${pngFile(ID_A)}`]);
    expect(pack.images).toHaveLength(1);
    expect(figureOf(pack, url).image).toBe(pack.images[0]);
  });

  it('shares one payload between two assets whose converted bytes are identical, under the first one\'s name', async () => {
    const bytes = solidPng(5, 5);
    const { host } = hostOf({ [`assets/${pngFile(ID_A)}`]: bytes, [`assets/${pngFile(ID_B)}`]: bytes });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A))), placement(urlOf(pngFile(ID_B)))], host, copy);
    expect(pack.images.map((image) => image.name)).toEqual([pngFile(ID_A)]);
    expect(figureOf(pack, urlOf(pngFile(ID_B))).image).toBe(figureOf(pack, urlOf(pngFile(ID_A))).image);
  });

  it('lists the used asset files once each, in first-use order, for a Markdown copy', () => {
    const body = [`![a](${urlOf(pngFile(ID_B))})`, `![b](${urlOf(pngFile(ID_A))})`, `![again](${urlOf(pngFile(ID_B))})`, '![outside](https://example.com/x.png)'].join('\n\n');
    const blocks: FlatBlock[] = [{ kind: 'scene', docId: 'n_SCENE00001', title: 'S', body, number: 1 }];
    expect(usedAssetFilesOf(blocks)).toEqual([pngFile(ID_B), pngFile(ID_A)]);
  });
});

describe('what cannot be embedded degrades to its caption, with a note', () => {
  it('notes a file the manuscript names but assets/ does not hold', async () => {
    const { host } = hostOf({});
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt', 'Cap')], host, copy);
    expect(figureOf(pack, urlOf(pngFile(ID_A)))).toMatchObject({ missing: true, caption: 'Cap' });
    expect(figureOf(pack, urlOf(pngFile(ID_A))).image).toBeUndefined();
    expect(pack.images).toEqual([]);
    expect(pack.notes).toEqual([`${pngFile(ID_A)} is placed in the manuscript but its file is not in assets/, so the caption is exported instead`]);
  });

  it('notes a destination outside the project\'s assets/ and exports its alt text', async () => {
    const { host, reads } = hostOf({});
    const pack = await resolveFigures([placement('https://example.com/x.png', 'Remote', null)], host, copy);
    expect(figureOf(pack, 'https://example.com/x.png')).toMatchObject({ missing: true, alt: 'Remote' });
    expect(pack.notes).toEqual(["a picture at https://example.com/x.png is not in the project's assets/, so its alt text is exported instead"]);
    expect(reads).toEqual([]);
  });

  it('notes a stored file that is not a PNG, JPEG or WebP picture', async () => {
    const { host } = hostOf({ [`assets/${pngFile(ID_A)}`]: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt')], host, copy);
    expect(figureOf(pack, urlOf(pngFile(ID_A))).missing).toBe(true);
    expect(pack.notes.join('\n')).toContain(`${pngFile(ID_A)} is not a PNG, JPEG or WebP picture`);
  });

  it('notes a missing alt: the caption stands in, or there is nothing to say', async () => {
    const { host } = hostOf({ [`assets/${pngFile(ID_A)}`]: solidPng(2, 2), [`assets/${pngFile(ID_B)}`]: solidPng(3, 3), [`assets/${pngFile(ID_C)}`]: solidPng(4, 4) });
    const pack = await resolveFigures(
      [
        placement(urlOf(pngFile(ID_A)), '', 'Only a caption'),
        placement(urlOf(pngFile(ID_B)), '', null),
        placement(urlOf(pngFile(ID_C)), '', encodePlacementTitle({ caption: '', decorative: true })),
      ],
      host,
      copy,
    );
    expect(figureOf(pack, urlOf(pngFile(ID_A))).alt).toBe('Only a caption');
    expect(pack.notes).toContain(`${pngFile(ID_A)} has no alt text, so its caption is used as the alt text`);
    expect(pack.notes).toContain(`${pngFile(ID_B)} has no alt text and no caption`);
    expect(pack.notes.filter((note) => !note.startsWith('pictures: ')).join('\n')).not.toContain(pngFile(ID_C));
  });

  it('reads the files of a text export only to name the missing ones, and converts nothing', async () => {
    const { host, reads, processed } = hostOf({ [`assets/${pngFile(ID_A)}`]: solidPng(2, 2) }, { process: stubProcess() });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt'), placement(urlOf(pngFile(ID_B)), 'Gone')], host, { ...epubSpec({}), embed: false });
    expect(reads).toEqual([`assets/${pngFile(ID_A)}`, `assets/${pngFile(ID_B)}`]);
    expect(processed).toEqual([]);
    expect(pack.images).toEqual([]);
    expect(pack.notes).toEqual([`${pngFile(ID_B)} is placed in the manuscript but its file is not in assets/, so the caption is exported instead`]);
  });
});

describe('the weight log', () => {
  it('reports the total and the five heaviest pictures, heaviest first', async () => {
    const ids = [ID_A, ID_B, ID_C, ID_D, ID_E, ID_F];
    const files: Record<string, Uint8Array> = {};
    ids.forEach((id, index) => {
      files[`assets/${pngFile(id)}`] = paddedPng(solidPng(2 + index, 2), 3000 * (index + 1));
    });
    const { host } = hostOf(files);
    const pack = await resolveFigures(ids.map((id) => placement(urlOf(pngFile(id)), 'x')), host, copy);

    const total = pack.images.reduce((sum, image) => sum + image.bytes.length, 0);
    const heaviest = ids.slice().reverse().slice(0, 5);
    const note = pack.notes.find((candidate) => candidate.startsWith('pictures: '));
    expect(note).toBe(
      `pictures: 6 pictures weigh ${formatBytes(total)} in this export; the heaviest: ${heaviest
        .map((id) => `${pngFile(id)} (${formatBytes(files[`assets/${pngFile(id)}`]?.length ?? 0)})`)
        .join(', ')}`,
    );
    expect(note).not.toContain(pngFile(ID_A));
  });

  it('says "1 picture" for one, and logs nothing when no picture is embedded', async () => {
    const one = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'x')], hostOf({ [`assets/${pngFile(ID_A)}`]: solidPng(2, 2) }).host, copy);
    expect(one.notes.find((note) => note.startsWith('pictures: '))).toMatch(/^pictures: 1 picture weigh /);
    const none = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'x')], hostOf({}).host, copy);
    expect(none.notes.some((note) => note.startsWith('pictures: '))).toBe(false);
  });

  it('formats bytes the way a writer reads them', () => {
    expect([formatBytes(812), formatBytes(1024), formatBytes(34_560), formatBytes(1_258_291)]).toEqual(['812 B', '1.0 kB', '34 kB', '1.2 MB']);
  });
});

describe('a profile that needs a transcode runs through the host\'s ProcessPicture', () => {
  const source = solidPng(40, 20);
  const files = { [`assets/${pngFile(ID_A)}`]: source };

  it('hands the EPUB profile to the host: 1600 px, 0.85, flattened, stripped, and packs what comes back', async () => {
    const { host, processed } = hostOf(files, { process: stubProcess(12, 8) });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt')], host, epub);
    expect(processed).toHaveLength(1);
    expect(processed[0]?.input).toMatchObject({ mime: 'image/png', width: 40, height: 20 });
    expect(processed[0]?.profile).toEqual({ maxEdge: 1600, output: 'preserve', jpegQuality: 0.85, flattenAlpha: true, stripMetadata: true });
    expect(pack.images).toEqual([expect.objectContaining({ name: pngFile(ID_A), mime: 'image/png', width: 12, height: 8 })]);
  });

  it('carries the recipe\'s long edge and its keep-metadata choice into the profile', async () => {
    const { host, processed } = hostOf(files, { process: stubProcess() });
    await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt')], host, { ...epubSpec({ maxPx: 800, keepMetadata: true }), embed: true });
    expect(processed[0]?.profile).toMatchObject({ maxEdge: 800, stripMetadata: false });
  });

  it('asks DOCX for no flattening and a pixel cap of twice the text width at 300 ppi, so a small PNG goes through untouched', async () => {
    expect(DOCX_IMAGE_MAX_EDGE).toBe(3761);
    const { host, processed } = hostOf(files, { process: stubProcess() });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt')], host, { ...docxSpec({}), embed: true });
    expect(processed).toEqual([]);
    expect(pack.images[0]).toMatchObject({ name: pngFile(ID_A), width: 40, height: 20 });
  });

  it('converts a lossy WebP to JPEG and an alpha or lossless one to PNG, unless the EPUB keeps WebP', async () => {
    const asJpeg = async (_input: PictureBytes): Promise<PictureBytes> => ({ bytes: solidJpeg(6, 4), mime: 'image/jpeg', width: 6, height: 4 });
    const lossy = hostOf({ [`assets/${ID_A}.webp`]: webpFixture('lossy') }, { process: asJpeg });
    const lossyPack = await resolveFigures([placement(urlOf(`${ID_A}.webp`), 'x')], lossy.host, epub);
    expect(lossy.processed[0]?.profile.output).toBe('jpeg');
    expect(lossyPack.images[0]).toMatchObject({ name: jpgFile(ID_A), mime: 'image/jpeg' });

    for (const kind of ['lossless', 'alpha'] as const) {
      const host = hostOf({ [`assets/${ID_A}.webp`]: webpFixture(kind) }, { process: stubProcess() });
      await resolveFigures([placement(urlOf(`${ID_A}.webp`), 'x')], host.host, epub);
      expect(host.processed[0]?.profile.output, kind).toBe('png');
    }

    const kept = hostOf({ [`assets/${ID_A}.webp`]: webpFixture('lossy') }, { process: stubProcess() });
    const keptPack = await resolveFigures([placement(urlOf(`${ID_A}.webp`), 'x')], kept.host, { ...epubSpec({ keepWebp: true }), embed: true });
    expect(kept.processed).toEqual([]);
    expect(keptPack.images[0]).toMatchObject({ name: `${ID_A}.webp`, mime: 'image/webp' });
  });

  it('degrades a refused picture to its caption with a note, and still embeds the others', async () => {
    const process = async (input: PictureBytes): Promise<PictureBytes> => {
      if (input.width === 40) throw new PictureRefusal('decode-failed', 'The picture could not be decoded.', 'Choose another picture.');
      return { bytes: solidPng(3, 3), mime: 'image/png', width: 3, height: 3 };
    };
    const { host } = hostOf({ ...files, [`assets/${pngFile(ID_B)}`]: solidPng(30, 10) }, { process });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Refused', 'Its caption'), placement(urlOf(pngFile(ID_B)), 'Fine')], host, epub);
    expect(figureOf(pack, urlOf(pngFile(ID_A)))).toMatchObject({ missing: true, caption: 'Its caption' });
    expect(figureOf(pack, urlOf(pngFile(ID_A))).image).toBeUndefined();
    expect(figureOf(pack, urlOf(pngFile(ID_B))).image).toBeDefined();
    expect(pack.images).toHaveLength(1);
    expect(pack.notes).toContain(`${pngFile(ID_A)} could not be prepared for this format: The picture could not be decoded. Choose another picture. The caption is exported instead.`);
  });

  it('degrades the same way on a host with no ProcessPicture, naming what it cannot do', async () => {
    const { host } = hostOf(files);
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt', 'Cap')], host, epub);
    expect(figureOf(pack, urlOf(pngFile(ID_A))).missing).toBe(true);
    expect(pack.notes.join('\n')).toContain(`This host cannot convert pictures, and ${pngFile(ID_A)} needs converting for this format.`);
  });

  it('degrades a picture the plan refuses before any host runs (a PNG cut off inside its header)', async () => {
    const { host, processed } = hostOf({ [`assets/${pngFile(ID_A)}`]: source.subarray(0, 20) }, { process: stubProcess() });
    const pack = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt')], host, epub);
    expect(processed).toEqual([]);
    expect(figureOf(pack, urlOf(pngFile(ID_A))).missing).toBe(true);
    expect(pack.notes.join('\n')).toMatch(/could not be prepared for this format|is not a PNG, JPEG or WebP picture/);
  });

  it('does not swallow a failure that is not a refusal', async () => {
    const { host } = hostOf(files, {
      process: async () => {
        throw new Error('the canvas died');
      },
    });
    await expect(resolveFigures([placement(urlOf(pngFile(ID_A)), 'Alt')], host, epub)).rejects.toThrow('the canvas died');
  });
});

describe('metadata on the way out', () => {
  const marked = withPngXmp(solidPng(6, 6));

  it('strips the private metadata of a copied picture by default and keeps it when the recipe says so', async () => {
    expect(hasMarker(marked)).toBe(true);
    const stripped = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'x')], hostOf({ [`assets/${pngFile(ID_A)}`]: marked }).host, copy);
    expect(hasMarker(stripped.images[0]?.bytes ?? new Uint8Array())).toBe(false);
    const kept = await resolveFigures([placement(urlOf(pngFile(ID_A)), 'x')], hostOf({ [`assets/${pngFile(ID_A)}`]: marked }).host, { ...copySpec({ keepMetadata: true }), embed: true });
    expect(hasMarker(kept.images[0]?.bytes ?? new Uint8Array())).toBe(true);
  });
});
