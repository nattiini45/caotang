import { describe, expect, it } from 'vitest';

import { openFolder, type FolderFile } from '@caotang/import-read/zip';

import { readRtfd, rtfdTextPath } from '../src/index.js';
import { lossMessages, mdOf, PIXEL_PNG } from './helpers.js';

const file = (path: string, data: Uint8Array): FolderFile => ({ path, size: data.length, read: async () => data });
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** TextEdit's shape: the attachment group, then the attachment character (¬ in cp1252) the reader must not keep. */
const TXT = `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2822
{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}
\\pard\\pardirnatural\\partightenfactor0
\\f0\\fs24 \\cf0 Before\\
{{\\NeXTGraphic pixel.png \\width20 \\height20 \\appleattachmentpadding0 \\appleembedtype0 \\appleaqc
}\\'ac}\\
Inline {{\\NeXTGraphic Pasted Graphic.tiff \\width20 \\height20
}\\uc0\\u65532 } after\\
}`;

describe('.rtfd packages', () => {
  it('reads TXT.rtf with its PNG attachment, and names an attachment it cannot read and one the text never shows', async () => {
    const opened = openFolder([
      file('Story.rtfd/TXT.rtf', text(TXT)),
      file('Story.rtfd/pixel.png', PIXEL_PNG),
      file('Story.rtfd/Pasted Graphic.tiff', new Uint8Array([0x4d, 0x4d, 0, 42])),
      file('Story.rtfd/unused.png', PIXEL_PNG),
    ]);
    if (!opened.ok) throw opened.error;
    expect(rtfdTextPath(opened.value)).toBe('Story.rtfd/TXT.rtf');
    const result = await readRtfd(opened.value);
    if (!result.ok) throw result.error;
    expect(mdOf(result.value)).toEqual(['Before', '<image rtf-image-1.png>', 'Inline  after']);
    expect(result.value.document.assets).toEqual([{ ref: 'rtf-image-1.png', name: 'pixel.png', mime: 'image/png', bytes: PIXEL_PNG.length }]);
    expect(lossMessages(result.value)).toEqual([
      'embedded-object: The attached file "Pasted Graphic.tiff" is not a PNG or JPEG picture, so it is not imported.',
      'embedded-object: Files in the package that the text does not show are not imported: unused.png.',
    ]);
  });

  it('reads only the files the text attaches: an unreadable or large file it never names neither fails the import nor is read', async () => {
    const opened_: string[] = [];
    const spy = (path: string, data: Uint8Array): FolderFile => ({
      path,
      size: data.length,
      read: async () => {
        opened_.push(path);
        return data;
      },
    });
    const opened = openFolder([
      spy('Story.rtfd/TXT.rtf', text(TXT)),
      spy('Story.rtfd/pixel.png', PIXEL_PNG),
      spy('Story.rtfd/Pasted Graphic.tiff', new Uint8Array([0x4d, 0x4d, 0, 42])),
      {
        path: 'Story.rtfd/locked.bin',
        size: 8,
        read: async () => {
          throw new Error('encrypted');
        },
      },
      spy('Story.rtfd/huge.mov', new Uint8Array(4096)),
    ]);
    if (!opened.ok) throw opened.error;
    const result = await readRtfd(opened.value);
    if (!result.ok) throw result.error;
    expect(opened_.sort()).toEqual(['Story.rtfd/Pasted Graphic.tiff', 'Story.rtfd/TXT.rtf', 'Story.rtfd/pixel.png']);
    expect(mdOf(result.value)).toEqual(['Before', '<image rtf-image-1.png>', 'Inline  after']);
    expect(lossMessages(result.value)).toContain(
      'embedded-object: Files in the package that the text does not show are not imported: locked.bin, huge.mov. ×2',
    );
  });

  it('holds attachments to the per-picture cap, and does not read one the package declares larger than it', async () => {
    let readBig = false;
    const opened = openFolder([
      file('Story.rtfd/TXT.rtf', text(TXT)),
      {
        path: 'Story.rtfd/pixel.png',
        size: PIXEL_PNG.length,
        read: async () => {
          readBig = true;
          return PIXEL_PNG;
        },
      },
    ]);
    if (!opened.ok) throw opened.error;
    const result = await readRtfd(opened.value, { limits: { maxImageBytes: PIXEL_PNG.length - 1 } });
    if (!result.ok) throw result.error;
    expect(readBig).toBe(false);
    expect(result.value.document.assets ?? []).toEqual([]);
    expect(result.value.assetData.size).toBe(0);
    expect(lossMessages(result.value)).toContain('image-unreadable: A picture larger than 0 MB is not imported.');
    expect(lossMessages(result.value).some((m) => m.includes('does not show'))).toBe(false);
  });

  it('names an attachment the package does not hold', async () => {
    const opened = openFolder([file('TXT.rtf', text(TXT))]);
    if (!opened.ok) throw opened.error;
    const result = await readRtfd(opened.value);
    if (!result.ok) throw result.error;
    expect(lossMessages(result.value)).toContain('image-unreadable: The attached file "pixel.png" is not in the package, so it is not imported.');
  });

  it('refuses a package with no TXT.rtf as not RTF', async () => {
    const opened = openFolder([file('a.rtfd/image.png', PIXEL_PNG)]);
    if (!opened.ok) throw opened.error;
    const result = await readRtfd(opened.value);
    expect(result.ok ? 'read' : result.error.name).toBe('RtfReadError');
  });
});
