/**
 * The OpenDocument reader (#298, epic #263): synthetic ODT packages and a flat `.fodt`, written to ODF's own shape —
 * `text:h` outline levels, a style chain, a list, a footnote, an annotation, tracked changes, pictures and a table.
 * No real document is copied.
 */

import { describe, expect, it } from 'vitest';

import { splitImport } from '@caotang/import-core';
import { rawZip } from '../../import-read/test/zip-fixtures.js';

import { readOdt } from '../src/reader.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';

const STYLES =
  '<style:style style:name="Standard" style:family="paragraph"/>' +
  '<style:style style:name="Chapter" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center"/></style:style>' +
  '<style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>' +
  '<style:style style:name="Under" style:family="text"><style:text-properties style:text-underline-style="solid"/></style:style>' +
  '<style:style style:name="Quotation" style:family="paragraph" style:parent-style-name="Standard"/>' +
  '<style:style style:name="Break" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>';

const h = (text: string, level = 1): string => `<text:h text:outline-level="${level}">${text}</text:h>`;
const p = (text: string, style?: string): string => `<text:p${style === undefined ? '' : ` text:style-name="${style}"`}>${text}</text:p>`;

function odt(body: string, extra: { styles?: string; meta?: string; pictures?: Record<string, Uint8Array> } = {}): Uint8Array {
  const files = [
    { name: 'mimetype', data: enc('application/vnd.oasis.opendocument.text') },
    { name: 'content.xml', data: enc(`<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>${extra.styles ?? STYLES}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`) },
    { name: 'styles.xml', data: enc(`<?xml version="1.0"?><office:document-styles ${NS}><office:styles><style:style style:name="Standard" style:family="paragraph"/></office:styles></office:document-styles>`) },
  ];
  if (extra.meta !== undefined) files.push({ name: 'meta.xml', data: enc(`<?xml version="1.0"?><office:document-meta ${NS}><office:meta>${extra.meta}</office:meta></office:document-meta>`) });
  for (const [name, data] of Object.entries(extra.pictures ?? {})) files.push({ name, data });
  return rawZip(files);
}

const srcOf = (block: { kind: string } | undefined): Record<string, unknown> | undefined => (block !== undefined && 'src' in block ? (block.src as Record<string, unknown> | undefined) : undefined);

describe('the ODF body (#298)', () => {
  it('reads outline levels as headings and splits into chapters', async () => {
    const read = await readOdt(odt(h('The Landing') + p('The ferry came at noon.') + h('Salt') + p('The letter arrived.')));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.document.blocks.map((block) => block.kind)).toEqual(['heading', 'para', 'heading', 'para']);
    const split = splitImport(read.value.document);
    expect(split.tree.map((node) => node.title)).toEqual(['The Landing', 'Salt']);
  });

  it('reads the style chain, lists, quotes and a page break', async () => {
    const body =
      p('A centred line', 'Chapter') +
      '<text:list><text:list-item>' + p('First') + '</text:list-item><text:list-item>' + p('Second') + '<text:list><text:list-item>' + p('Nested') + '</text:list-item></text:list></text:list-item></text:list>' +
      p('Something said', 'Quotation') +
      p('After the break', 'Break');
    const read = await readOdt(odt(body));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const md = read.value.document.blocks.map((block) => (block.kind === 'para' ? block.md : block.kind));
    expect(md).toContain('A centred line');
    expect(md).toContain('- First');
    expect(md).toContain('- Second');
    expect(md).toContain('  - Nested');
    expect(md).toContain('> Something said');
    expect(md).toContain('pagebreak');
    expect(srcOf(read.value.document.blocks[0])?.['align']).toBe('center');
  });

  it('writes bold, italics and underline, and keeps a safe link only', async () => {
    const body = p('A <text:span text:style-name="Bold">bold</text:span> and <text:span text:style-name="Under">underlined</text:span> word.') +
      p('<text:a xlink:href="javascript:alert(1)">bad</text:a> and <text:a xlink:href="https://example.com/">good</text:a>');
    const read = await readOdt(odt(body));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const md = read.value.document.blocks.map((block) => (block.kind === 'para' ? block.md : ''));
    expect(md[0]).toBe('A **bold** and *underlined* word.');
    expect(md[1]).toBe('bad and [good](https://example.com/)');
    expect(read.value.dropped.underline).toBe(1);
    expect(read.value.dropped.unsafeLinks).toBe(1);
    const off = await readOdt(odt(body), { underlineAs: 'none' });
    expect(off.ok && off.value.document.blocks[0]?.kind === 'para' ? off.value.document.blocks[0].md : '').toBe('A **bold** and underlined word.');
  });

  it('writes a footnote inline and an annotation as a note', async () => {
    const body = p('The ferry came<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body>' + p('At noon exactly.') + '</text:note-body></text:note>.') +
      p('Check this<office:annotation><dc:creator>Mara Vale</dc:creator><dc:date>2026-11-01T10:00:00Z</dc:date>' + p('Is the time right?') + '</office:annotation>');
    const read = await readOdt(odt(body));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.document.blocks[0]?.kind === 'para' ? read.value.document.blocks[0].md : '').toBe('The ferry came[^1].');
    expect(read.value.document.footnotes?.[0]?.md).toBe('At noon exactly.');
    const note = read.value.document.comments?.[0];
    expect(note?.md).toContain('Is the time right?');
    expect(note?.md).toContain('— Mara Vale, 2026-11-01');
    expect(note?.md).toContain('> “Check this”');
  });

  it('reads a table as paragraphs and counts the loss', async () => {
    const body = '<text:table><text:table-row><text:table-cell>' + p('Elena') + '</text:table-cell><text:table-cell>' + p('Mara') + '</text:table-cell></text:table-row></text:table>';
    const read = await readOdt(odt(body));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.document.blocks[0]?.kind === 'para' ? read.value.document.blocks[0].md : '').toBe('Elena — Mara');
    expect(read.value.document.losses?.some((loss) => loss.code === 'table')).toBe(true);
  });
});

describe('tracked changes (#298)', () => {
  const regions = '<text:tracked-changes><text:changed-region text:id="i1"><text:insertion><dc:creator>Mara</dc:creator></text:insertion></text:changed-region><text:changed-region text:id="d1"><text:deletion>' + p('left at dawn') + '</text:deletion></text:changed-region></text:tracked-changes>';
  const body = regions + p('The ferry <text:change-start text:change-id="i1"/>came at noon<text:change-end text:change-id="i1"/><text:change text:change-id="d1"/>.');

  it('accepts, rejects or keeps, and counts both kinds', async () => {
    const accept = await readOdt(odt(body));
    const reject = await readOdt(odt(body), { tracked: 'reject' });
    const keep = await readOdt(odt(body), { tracked: 'keep' });
    for (const read of [accept, reject, keep]) {
      expect(read.ok).toBe(true);
      if (!read.ok) continue;
      expect(read.value.changes).toEqual({ insertions: 1, deletions: 1 });
    }
    const mdOf = (read: typeof accept): string => (read.ok && read.value.document.blocks[0]?.kind === 'para' ? read.value.document.blocks[0].md : '');
    expect(mdOf(accept)).toBe('The ferry came at noon.');
    expect(mdOf(reject)).toBe('The ferry left at dawn.');
    expect(mdOf(keep)).toBe('The ferry came at noon.');
    expect(keep.ok ? keep.value.deletions : []).toEqual([{ blockIndex: 0, text: 'left at dawn' }]);
  });
});

describe('pictures, metadata and the flat form (#298)', () => {
  const frame = (href: string, alt: string): string => `<text:p><draw:frame><draw:image xlink:href="${href}"><svg:desc>${alt}</svg:desc></draw:image></draw:frame></text:p>`;

  it('reads a numbered list style as 1. and keeps two pictures in one paragraph', async () => {
    const styles = STYLES +
      '<text:list-style style:name="Num"><text:list-level-style-number text:level="1" style:num-format="1"/></text:list-style>' +
      '<text:list-style style:name="Bul"><text:list-level-style-bullet text:level="1" text:bullet-char="-"/></text:list-style>';
    const twoFrames = '<text:p><draw:frame><draw:image xlink:href="Pictures/a.png"><svg:desc>Alpha</svg:desc></draw:image></draw:frame><draw:frame><draw:image xlink:href="Pictures/b.png"><svg:desc>Beta</svg:desc></draw:image></draw:frame></text:p>';
    const body =
      '<text:list text:style-name="Num"><text:list-item>' + p('One') + '</text:list-item><text:list-item>' + p('Two') + '</text:list-item></text:list>' +
      '<text:list text:style-name="Bul"><text:list-item>' + p('Dot') + '</text:list-item></text:list>' +
      twoFrames;
    const read = await readOdt(odt(body, { styles, pictures: { 'Pictures/a.png': PNG, 'Pictures/b.png': PNG } }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const md = read.value.document.blocks.map((block) => (block.kind === 'para' ? block.md : block.kind));
    expect(md).toContain('1. One');
    expect(md).toContain('1. Two');
    expect(md).toContain('- Dot');
    const images = read.value.document.blocks.filter((block) => block.kind === 'image');
    expect(images).toHaveLength(2);
    const alts = images.map((block) => (block.kind === 'image' ? block.alt : ''));
    expect(alts).toEqual(['Alpha', 'Beta']);
    expect(read.value.assetData.size).toBe(2);
  });

  it('reject mode drops notes and pictures inside a rejected insertion', async () => {
    const regions = '<text:tracked-changes><text:changed-region text:id="i1"><text:insertion/></text:changed-region></text:tracked-changes>';
    const body = regions +
      '<text:p>The ferry <text:change-start text:change-id="i1"/>came<text:note><text:note-body><text:p>hidden note</text:p></text:note-body></text:note><draw:frame><draw:image xlink:href="Pictures/x.png"><svg:desc>hidden pic</svg:desc></draw:image></draw:frame> at noon<text:change-end text:change-id="i1"/>.</text:p>';
    const read = await readOdt(odt(body, { pictures: { 'Pictures/x.png': PNG } }), { tracked: 'reject' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const para = read.value.document.blocks.find((block) => block.kind === 'para');
    expect(para !== undefined && para.kind === 'para' ? para.md : '').toBe('The ferry .');
    expect(read.value.document.blocks.filter((block) => block.kind === 'image')).toHaveLength(0);
    expect(read.value.document.footnotes ?? []).toHaveLength(0);
    expect(read.value.assetData.size).toBe(0);
  });

  it('brings a PNG in, refuses an SVG and lists a remote picture', async () => {
    const read = await readOdt(odt(frame('Pictures/100.png', 'The harbour') + frame('Pictures/vector.svg', 'Vector') + frame('https://example.com/x.png', 'Remote'), { pictures: { 'Pictures/100.png': PNG } }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const images = read.value.document.blocks.filter((block) => block.kind === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]?.kind === 'image' ? images[0].alt : '').toBe('The harbour');
    expect(read.value.assetData.size).toBe(1);
    expect(read.value.dropped.svg).toBe(1);
    expect(read.value.remoteImages).toEqual(['https://example.com/x.png']);
  });

  it('reads the metadata and refuses a file that is not ODF', async () => {
    const read = await readOdt(odt(p('A line'), { meta: '<dc:title>The Ninth Wave</dc:title><meta:initial-creator>Mara Vale</meta:initial-creator><dc:language>en</dc:language>' }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('The Ninth Wave');
    expect(read.value.author).toBe('Mara Vale');
    expect(read.value.document.metadata?.language).toBe('en');

    const notOdf = await readOdt(rawZip([{ name: 'notes.txt', data: enc('a letter') }]));
    expect(notOdf.ok).toBe(false);
    if (notOdf.ok) return;
    expect(notOdf.error.kind).toBe('not-odt');
  });

  it('reads a flat .fodt, with the picture it carries inside the XML', async () => {
    const flat = `<?xml version="1.0"?><office:document ${NS} office:mimetype="application/vnd.oasis.opendocument.text"><office:meta><dc:title>Flat</dc:title></office:meta><office:automatic-styles>${STYLES}</office:automatic-styles><office:body><office:text>${h('One')}${p('A line')}<text:p><draw:frame><draw:image><office:binary-data>${PNG_BASE64}</office:binary-data></draw:image></draw:frame></text:p></office:text></office:body></office:document>`;
    const read = await readOdt(enc(flat));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('Flat');
    expect(read.value.document.blocks.map((block) => block.kind)).toEqual(['heading', 'para', 'image']);
    expect(read.value.assetData.size).toBe(1);
  });
});
