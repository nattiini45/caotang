/**
 * The EPUB reader (#296, epic #263): the OPF, the navigation, the spine cut at nav fragments, landmarks as
 * matter, footnotes, the cover, DRM refusal and the losses. Synthetic fixtures only, written as real zips.
 */

import { describe, expect, it } from 'vitest';

import { splitImport } from '@caotang/import-core';
import { rawZip } from '../../import-read/test/zip-fixtures.js';

import { containerOpfPath, encryptionIsDrm, parseOpf, resolveHref } from '../src/opf.js';
import { parseLandmarks, parseNav, parseNcx } from '../src/nav.js';
import { readEpub } from '../src/reader.js';

const enc = new TextEncoder();
const zipOf = (files: Record<string, string | Uint8Array>): Uint8Array =>
  rawZip(Object.entries(files).map(([path, value]) => ({ name: path, data: typeof value === 'string' ? enc.encode(value) : value })));

/** A 1×1 PNG, so a picture's bytes are a real picture. */
const PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);

const CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

const page = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head><body>${body}</body></html>`;

interface BookOptions {
  readonly items?: string;
  readonly spine?: string;
  readonly spineAttrs?: string;
  readonly meta?: string;
  readonly files?: Record<string, string | Uint8Array>;
  readonly guide?: string;
}

/** An EPUB 3 with a nav, three chapters and a cover, as Vellum, Atticus and Calibre write them. */
function book(options: BookOptions = {}): Uint8Array {
  const items =
    options.items ??
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
      '<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>' +
      '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="c3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>';
  const spine = options.spine ?? '<itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>';
  const opf =
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">' +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Lighthouse Keeper</dc:title><dc:creator>Mara Vale</dc:creator><dc:language>en</dc:language>${options.meta ?? ''}</metadata>` +
    `<manifest>${items}</manifest><spine${options.spineAttrs ?? ''}>${spine}</spine>${options.guide ?? ''}</package>`;
  return zipOf({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': page(
      '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Chapter One: The Landing</a></li><li><a href="text/ch2.xhtml">Chapter Two: Salt</a></li><li><a href="text/ch3.xhtml">Chapter Three: The Lantern</a></li></ol></nav>' +
        '<nav epub:type="landmarks"><ol><li><a epub:type="cover" href="text/ch1.xhtml">Cover</a></li></ol></nav>',
    ),
    'OEBPS/images/cover.png': PNG,
    'OEBPS/text/ch1.xhtml': page('<h1>Chapter One: The Landing</h1><p>The ferry came at noon.</p><hr/><p>By evening the wind had turned.</p>'),
    'OEBPS/text/ch2.xhtml': page('<h1>Chapter Two: Salt</h1><p>The letter arrived on a Tuesday.</p>'),
    'OEBPS/text/ch3.xhtml': page('<h1>Chapter Three: The Lantern</h1><p>The lantern swung in the wind.</p>'),
    ...options.files,
  });
}

describe('the OPF (#296)', () => {
  it('reads the container’s rootfile', () => {
    expect(containerOpfPath(CONTAINER)).toBe('OEBPS/content.opf');
    expect(containerOpfPath('<container/>')).toBeNull();
  });

  it('resolves hrefs against the OPF folder, with .. and percent escapes', () => {
    expect(resolveHref('OEBPS', 'text/ch1.xhtml')).toBe('OEBPS/text/ch1.xhtml');
    expect(resolveHref('OEBPS/text', '../images/cover.png')).toBe('OEBPS/images/cover.png');
    expect(resolveHref('OEBPS', 'text/Chapter%20One.xhtml#part-2')).toBe('OEBPS/text/Chapter One.xhtml');
    expect(resolveHref('', 'text/ch1.xhtml')).toBe('text/ch1.xhtml');
  });

  it('reads metadata, manifest, spine, nav and cover, and the fixed layout', async () => {
    const read = await readEpub(book({ meta: '<meta property="rendition:layout">pre-paginated</meta>' }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('The Lighthouse Keeper');
    expect(read.value.document.metadata).toMatchObject({ title: 'The Lighthouse Keeper', author: 'Mara Vale', language: 'en' });
    expect(read.value.fixedLayout).toBe(true);
    expect(read.value.document.losses?.some((loss) => loss.message?.includes('fixed layout'))).toBe(true);
    expect(read.value.cover).toMatchObject({ name: 'cover.png', bytes: PNG.length });
    expect(read.value.spineItems).toBe(3);
  });

  it('reads an EPUB 2 package: the spine’s toc and the meta cover', () => {
    const opf =
      '<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Old Book</dc:title><meta name="cover" content="cover"/></metadata>' +
      '<manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="cover" href="cover.jpg" media-type="image/jpeg"/><item id="c1" href="ch1.html" media-type="application/xhtml+xml"/></manifest>' +
      '<spine toc="ncx"><itemref idref="c1"/></spine><guide><reference type="toc" title="Contents" href="toc.html"/></guide></package>';
    const parsed = parseOpf(opf, 'content.opf');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.title).toBe('Old Book');
    expect(parsed.value.ncxHref).toBe('toc.ncx');
    expect(parsed.value.coverHref).toBe('cover.jpg');
    expect(parsed.value.guide).toEqual([{ type: 'toc', href: 'toc.html', title: 'Contents' }]);
  });
});

describe('the navigation (#296)', () => {
  it('reads the nav’s titles, fragments and depth', () => {
    const nav = page('<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">One</a><ol><li><a href="text/ch1.xhtml#s2">A scene</a></li></ol></li><li><a href="text/ch2.xhtml">Two</a></li></ol></nav>');
    expect(parseNav(nav, 'OEBPS/nav.xhtml')).toEqual([
      { href: 'OEBPS/text/ch1.xhtml', fragment: '', title: 'One', depth: 0 },
      { href: 'OEBPS/text/ch1.xhtml', fragment: 's2', title: 'A scene', depth: 1 },
      { href: 'OEBPS/text/ch2.xhtml', fragment: '', title: 'Two', depth: 0 },
    ]);
  });

  it('reads the landmarks', () => {
    const nav = page('<nav epub:type="landmarks"><ol><li><a epub:type="cover" href="cover.xhtml">Cover</a></li><li><a epub:type="bodymatter" href="ch1.xhtml">Start</a></li></ol></nav>');
    expect(parseLandmarks(nav, 'OEBPS/nav.xhtml')).toEqual([
      { type: 'cover', href: 'OEBPS/cover.xhtml', title: 'Cover' },
      { type: 'bodymatter', href: 'OEBPS/ch1.xhtml', title: 'Start' },
    ]);
  });

  it('reads an EPUB 2 NCX', () => {
    const ncx = '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="n1"><navLabel><text>One</text></navLabel><content src="text/ch1.xhtml"/></navPoint><navPoint id="n2"><navLabel><text>Two</text></navLabel><content src="text/ch2.xhtml#a"/></navPoint></navMap></ncx>';
    expect(parseNcx(ncx, 'OEBPS/toc.ncx')).toEqual([
      { href: 'OEBPS/text/ch1.xhtml', fragment: '', title: 'One', depth: 0 },
      { href: 'OEBPS/text/ch2.xhtml', fragment: 'a', title: 'Two', depth: 0 },
    ]);
  });
});

describe('the EPUB reader (#296)', () => {
  it('reads the spine in order, with the navigation’s chapter titles', async () => {
    const read = await readEpub(book());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.chapters.map((chapter) => chapter.title)).toEqual(['Chapter One: The Landing', 'Chapter Two: Salt', 'Chapter Three: The Lantern']);
    const split = splitImport(read.value.document);
    expect(split.detected.chapterRule).toEqual({ kind: 'heading', level: 1 });
    expect(split.tree.map((node) => node.title)).toEqual(['Chapter One: The Landing', 'Chapter Two: Salt', 'Chapter Three: The Lantern']);
    expect(read.value.document.blocks.some((block) => block.kind === 'break')).toBe(true);
  });

  it('cuts one XHTML file into a chapter per nav fragment', async () => {
    const read = await readEpub(
      book({
        items:
          '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/book.xhtml" media-type="application/xhtml+xml"/>',
        spine: '<itemref idref="c1"/>',
        files: {
          'OEBPS/nav.xhtml': page('<nav epub:type="toc"><ol><li><a href="text/book.xhtml#one">One</a></li><li><a href="text/book.xhtml#two">Two</a></li></ol></nav>'),
          'OEBPS/text/book.xhtml': page('<div id="one"><h1>One</h1><p>The ferry.</p></div><div id="two"><h1>Two</h1><p>The letter.</p></div>'),
        },
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.chapters).toEqual([
      { unit: 'OEBPS/text/book.xhtml#one', title: 'One', depth: 0 },
      { unit: 'OEBPS/text/book.xhtml#two', title: 'Two', depth: 0 },
    ]);
    const units = read.value.document.blocks.map((block) => ('src' in block ? block.src?.sourceUnit : undefined));
    expect(units).toEqual([
      'OEBPS/text/book.xhtml#one',
      'OEBPS/text/book.xhtml#one',
      'OEBPS/text/book.xhtml#two',
      'OEBPS/text/book.xhtml#two',
    ]);
  });

  it('reads an EPUB 2 book through its NCX', async () => {
    const read = await readEpub(
      book({
        items:
          '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>',
        spine: '<itemref idref="c1"/><itemref idref="c2"/>',
        spineAttrs: ' toc="ncx"',
        files: {
          'OEBPS/toc.ncx':
            '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="n1"><navLabel><text>First</text></navLabel><content src="text/ch1.xhtml"/></navPoint><navPoint id="n2"><navLabel><text>Second</text></navLabel><content src="text/ch2.xhtml"/></navPoint></navMap></ncx>',
        },
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.chapters.map((chapter) => chapter.title)).toEqual(['First', 'Second']);
  });

  it('offers landmarks and non-linear spine items as front or back matter', async () => {
    const read = await readEpub(
      book({
        items:
          '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
          '<item id="tp" href="text/title.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>' +
          '<item id="ack" href="text/ack.xhtml" media-type="application/xhtml+xml"/>',
        spine: '<itemref idref="tp"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="ack" linear="no"/>',
        files: {
          'OEBPS/nav.xhtml': page(
            '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">One</a></li><li><a href="text/ch2.xhtml">Two</a></li></ol></nav>' +
              '<nav epub:type="landmarks"><ol><li><a epub:type="titlepage" href="text/title.xhtml">Title page</a></li><li><a epub:type="acknowledgments" href="text/ack.xhtml">Thanks</a></li></ol></nav>',
          ),
          'OEBPS/text/title.xhtml': page('<p>The Lighthouse Keeper</p>'),
          'OEBPS/text/ack.xhtml': page('<h1>Thanks</h1><p>For the keepers.</p>'),
        },
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.matter).toEqual([
      { unit: 'OEBPS/text/title.xhtml', kind: 'front', title: 'Title page' },
      { unit: 'OEBPS/text/ack.xhtml', kind: 'back', title: 'Thanks' },
    ]);
  });

  it('keeps footnotes as [^n] with their note out of the text', async () => {
    const read = await readEpub(
      book({
        files: {
          'OEBPS/text/ch2.xhtml': page('<h1>Chapter Two: Salt</h1><p>A claim<a epub:type="noteref" href="#fn1">1</a>.</p><aside epub:type="footnote" id="fn1">The note itself.</aside>'),
        },
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const bodies = read.value.document.blocks.map((block) => (block.kind === 'para' ? block.md : ''));
    expect(bodies).toContain('A claim[^1].');
    expect(bodies.join(' ')).not.toContain('The note itself.');
    expect(read.value.document.footnotes).toEqual([{ blockIndex: expect.any(Number), label: '1', md: 'The note itself.' }]);
    const split = splitImport(read.value.document);
    const bodiesAfter = JSON.stringify(split.tree);
    expect(bodiesAfter).toContain('The note itself.');
    expect(bodiesAfter).toContain('[^1]');
  });

  it('keeps the cover and a chapter picture with their bytes', async () => {
    const read = await readEpub(
      book({
        files: { 'OEBPS/text/ch2.xhtml': page('<h1>Chapter Two: Salt</h1><p><img src="../images/pier.png" alt="The pier"/></p>'), 'OEBPS/images/pier.png': PNG },
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.assetData.size).toBe(2);
    expect(read.value.document.assets?.map((asset) => asset.name).sort()).toEqual(['cover.png', 'pier.png']);
    expect([...read.value.assetData.values()].every((bytes) => bytes.length === PNG.length)).toBe(true);
  });

  it('lists a remote picture instead of fetching it, and counts a dropped script and player', async () => {
    const read = await readEpub(
      book({
        files: {
          'OEBPS/text/ch2.xhtml': page('<h1>Chapter Two: Salt</h1><script>alert(1)</script><p><img src="https://example.com/x.png" alt="x"/></p><video src="v.mp4"/>'),
        },
      }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.remoteImages).toEqual(['https://example.com/x.png']);
    expect(read.value.dropped.scripts).toBe(1);
    expect(read.value.dropped.media).toBe(1);
    expect(JSON.stringify(read.value.document.blocks)).not.toContain('alert(1)');
  });

  it('refuses a DRM book, and reads one whose only encryption is a font', async () => {
    const drm = await readEpub(
      book({
        files: {
          'META-INF/encryption.xml':
            '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><CipherData><CipherReference URI="OEBPS/text/ch1.xhtml"/></CipherData></enc:EncryptedData></encryption>',
        },
      }),
    );
    expect(drm.ok).toBe(false);
    if (drm.ok) return;
    expect(drm.error.kind).toBe('drm');

    const fontOnly = await readEpub(
      book({
        files: {
          'META-INF/encryption.xml':
            '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/><CipherData><CipherReference URI="OEBPS/fonts/f.otf"/></CipherData></enc:EncryptedData></encryption>',
        },
      }),
    );
    expect(fontOnly.ok).toBe(true);

    const rights = await readEpub(book({ files: { 'META-INF/rights.xml': '<rights/>' } }));
    expect(rights.ok).toBe(false);
    if (rights.ok) return;
    expect(rights.error.kind).toBe('drm');
  });

  it('names an encryption file it cannot read as DRM', () => {
    expect(encryptionIsDrm('<encryption')).toBe(true);
    expect(encryptionIsDrm('<encryption/>')).toBe(false);
  });

  it('refuses a zip that is no EPUB, and one whose spine holds nothing', async () => {
    const noContainer = await readEpub(zipOf({ 'readme.txt': 'nothing' }));
    expect(noContainer.ok).toBe(false);
    if (noContainer.ok) return;
    expect(noContainer.error.kind).toBe('no-opf');

    const emptySpine = await readEpub(book({ spine: '' }));
    expect(emptySpine.ok).toBe(false);
    if (emptySpine.ok) return;
    expect(emptySpine.error.kind).toBe('empty');
  });
});
