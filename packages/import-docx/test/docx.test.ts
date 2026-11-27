/**
 * The Word reader (#279, epic #263): synthetic `.docx` zips written to WordprocessingML's own shape — heading styles
 * and a `basedOn` chain, a Shunn manuscript, German style names, a TOC field, tracked changes, notes, comments,
 * lists, a table, a text box and pictures. No real manuscript is copied.
 */

import { describe, expect, it } from 'vitest';

import { splitImport } from '@caotang/import-core';
import { rawZip } from '../../import-read/test/zip-fixtures.js';

import { parseStyles, resolveStyle } from '../src/parts.js';
import { readDocx, readDocxZip } from '../src/reader.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

const wrap = (name: string, body: string): string => `<?xml version="1.0" encoding="UTF-8"?><w:${name} ${W_NS}>${body}</w:${name}>`;

interface Parts {
  body: string;
  styles?: string;
  numbering?: string;
  rels?: string;
  footnotes?: string;
  endnotes?: string;
  comments?: string;
  core?: string;
  media?: Record<string, Uint8Array>;
}

function docx(parts: Parts): Uint8Array {
  const files: { name: string; data: Uint8Array }[] = [
    { name: '[Content_Types].xml', data: enc('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    { name: 'word/document.xml', data: enc(wrap('document', `<w:body>${parts.body}</w:body>`)) },
  ];
  if (parts.styles !== undefined) files.push({ name: 'word/styles.xml', data: enc(wrap('styles', parts.styles)) });
  if (parts.numbering !== undefined) files.push({ name: 'word/numbering.xml', data: enc(wrap('numbering', parts.numbering)) });
  if (parts.rels !== undefined) files.push({ name: 'word/_rels/document.xml.rels', data: enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.rels}</Relationships>`) });
  if (parts.footnotes !== undefined) files.push({ name: 'word/footnotes.xml', data: enc(wrap('footnotes', parts.footnotes)) });
  if (parts.endnotes !== undefined) files.push({ name: 'word/endnotes.xml', data: enc(wrap('endnotes', parts.endnotes)) });
  if (parts.comments !== undefined) files.push({ name: 'word/comments.xml', data: enc(wrap('comments', parts.comments)) });
  if (parts.core !== undefined) files.push({ name: 'docProps/core.xml', data: enc(`<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">${parts.core}</cp:coreProperties>`) });
  for (const [name, data] of Object.entries(parts.media ?? {})) files.push({ name: `word/media/${name}`, data });
  return rawZip(files);
}

const srcOf = (block: { kind: string } | undefined): Record<string, unknown> | undefined => (block !== undefined && 'src' in block ? (block.src as Record<string, unknown> | undefined) : undefined);

const p = (text: string, style?: string, extra = ''): string =>
  `<w:p><w:pPr>${style === undefined ? '' : `<w:pStyle w:val="${style}"/>`}${extra}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const STYLES =
  '<w:style w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>' +
  '<w:style w:styleId="ChapterTitle"><w:name w:val="Chapter Title"/><w:basedOn w:val="Heading1"/></w:style>' +
  '<w:style w:styleId="Ueberschrift2"><w:name w:val="Überschrift 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>' +
  '<w:style w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/></w:style>' +
  '<w:style w:styleId="Loop"><w:name w:val="Loop"/><w:basedOn w:val="Loop"/></w:style>';

describe('styles (#279)', () => {
  it('resolves a basedOn chain and stops at a cycle', () => {
    const styles = parseStyles(wrap('styles', STYLES));
    const chapter = resolveStyle(styles, 'ChapterTitle');
    expect(chapter?.name).toBe('Chapter Title');
    expect(chapter?.outlineLevel).toBe(1);
    expect(chapter?.bold).toBe(true);
    expect(chapter?.size).toBe(32);
    expect(resolveStyle(styles, 'Loop')?.name).toBe('Loop');
    expect(resolveStyle(styles, 'Missing')).toBeNull();
  });
});

describe('the body (#279)', () => {
  it('reads heading styles, keeps the style name, and splits into chapters', async () => {
    const read = await readDocx(docx({ styles: STYLES, body: p('The Ninth Wave', 'ChapterTitle') + p('The ferry came at noon.') + p('Salt', 'Heading1') + p('The letter arrived.') }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const blocks = read.value.document.blocks;
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'para', 'heading', 'para']);
    expect(blocks[0]?.kind === 'heading' ? blocks[0].level : 0).toBe(1);
    expect(srcOf(blocks[0])?.['styleName']).toBe('Chapter Title');
    const split = splitImport(read.value.document);
    expect(split.tree.map((node) => node.title)).toEqual(['The Ninth Wave', 'Salt']);
  });

  it('reads a localised heading name and a Shunn manuscript’s centred chapter line', async () => {
    const read = await readDocx(docx({ styles: STYLES, body: p('Kapitel 1', 'Ueberschrift2') + p('Chapter One', undefined, '<w:jc w:val="center"/>') + p('#') + p('The ferry came.') }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const blocks = read.value.document.blocks;
    expect(blocks[0]?.kind === 'heading' ? blocks[0].level : 0).toBe(2);
    expect(srcOf(blocks[1])?.['align']).toBe('center');
    expect(blocks[2]?.kind === 'para' && blocks[2].md).toBe('#');
    const split = splitImport(read.value.document);
    expect(split.tree.length).toBeGreaterThan(0);
  });

  it('never lets a table of contents become chapters', async () => {
    const toc = '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="TOC"/></w:docPartObj></w:sdtPr><w:sdtContent>' + p('Chapter One .... 3', 'Heading1') + p('Chapter Two .... 9', 'Heading1') + '</w:sdtContent></w:sdt>';
    const read = await readDocx(docx({ styles: STYLES, body: toc + p('Chapter One', 'Heading1') + p('The ferry came.') + p('Chapter Two', 'Heading1') + p('The letter arrived.') }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.dropped.toc).toBe(2);
    expect(read.value.document.blocks.filter((block) => srcOf(block)?.['toc'] === true)).toHaveLength(2);
    const split = splitImport(read.value.document);
    expect(split.tree.map((node) => node.title)).toEqual(['Chapter One', 'Chapter Two']);
  });

  it('reads lists, quotes, tables and text boxes, and counts what it approximates', async () => {
    const numbering = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const list = p('First', undefined, '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    const nested = p('Second', undefined, '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>');
    const table = '<w:tbl><w:tr><w:tc>' + p('Elena') + '</w:tc><w:tc>' + p('Mara') + '</w:tc></w:tr></w:tbl>';
    const textBox = '<w:p><w:r><w:txbxContent>' + p('A note in a box') + '</w:txbxContent></w:r></w:p>';
    const read = await readDocx(docx({ styles: STYLES, numbering, body: list + nested + p('Something said', 'Quote') + table + textBox }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const md = read.value.document.blocks.map((block) => (block.kind === 'para' ? block.md : ''));
    expect(md).toContain('- First');
    expect(md).toContain('  1. Second');
    expect(md).toContain('> Something said');
    expect(md).toContain('Elena — Mara');
    expect(md).toContain('A note in a box');
    expect(read.value.document.losses?.some((loss) => loss.code === 'table')).toBe(true);
    expect(read.value.dropped.textBoxes).toBe(1);
  });

  it('keeps literal Markdown punctuation as prose beside real formatting, links and notes', async () => {
    const literal = '<w:p><w:r><w:t xml:space="preserve"># Chapter *door* `code` [name](target)</w:t></w:r></w:p>';
    const formatted =
      '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>' +
      '<w:hyperlink r:id="rId1"><w:r><w:t>good</w:t></w:r></w:hyperlink>' +
      '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>';
    const footnotes = '<w:footnote w:id="1">' + p('The *note*.') + '</w:footnote>';
    const rels = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>';
    const read = await readDocx(docx({ body: literal + formatted, rels, footnotes }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const paras = read.value.document.blocks.filter((block) => block.kind === 'para');
    expect(paras[0]?.kind === 'para' ? paras[0].md : '').toBe('\\# Chapter \\*door\\* \\`code\\` \\[name\\](target)');
    expect(paras[0]?.kind === 'para' ? paras[0].text : '').toBe('# Chapter *door* `code` [name](target)');
    expect(paras[1]?.kind === 'para' ? paras[1].md : '').toBe('**bold**[good](https://example.com/)[^1]');
    expect(read.value.document.footnotes?.map((note) => [note.label, note.md])).toEqual([['1', 'The \\*note\\*.']]);
  });

  it('flattens text boxes nested in a Word drawing and in VML', async () => {
    const drawingBox =
      '<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData>' +
      '<wps:txbx xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:txbxContent><w:p><w:r><w:t>Drawing box</w:t></w:r></w:p></w:txbxContent></wps:txbx>' +
      '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    const vmlBox =
      '<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent><w:p><w:r><w:t>VML box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>';
    const read = await readDocx(docx({ body: drawingBox + vmlBox }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const md = read.value.document.blocks.map((block) => (block.kind === 'para' ? block.md : ''));
    expect(md).toEqual(['Drawing box', 'VML box']);
    expect(read.value.dropped.textBoxes).toBe(2);
    expect(read.value.document.losses?.filter((loss) => loss.code === 'text-box')).toHaveLength(2);
  });
});

describe('tracked changes (#279)', () => {
  const body = '<w:p><w:r><w:t xml:space="preserve">The ferry </w:t></w:r><w:ins w:id="1" w:author="A"><w:r><w:t xml:space="preserve">came at noon</w:t></w:r></w:ins><w:del w:id="2" w:author="A"><w:r><w:delText xml:space="preserve">left at dawn</w:delText></w:r></w:del><w:r><w:t xml:space="preserve">.</w:t></w:r></w:p>';

  it('accepts, rejects or keeps, and counts both kinds', async () => {
    const accept = await readDocx(docx({ body }));
    const reject = await readDocx(docx({ body }), { tracked: 'reject' });
    const keep = await readDocx(docx({ body }), { tracked: 'keep' });
    for (const read of [accept, reject, keep]) {
      expect(read.ok).toBe(true);
      if (!read.ok) continue;
      expect(read.value.changes).toMatchObject({ insertions: 1, deletions: 1 });
    }
    expect(accept.ok && accept.value.document.blocks[0]?.kind === 'para' ? accept.value.document.blocks[0].md : '').toBe('The ferry came at noon.');
    expect(reject.ok && reject.value.document.blocks[0]?.kind === 'para' ? reject.value.document.blocks[0].md : '').toBe('The ferry left at dawn.');
    expect(keep.ok && keep.value.document.blocks[0]?.kind === 'para' ? keep.value.document.blocks[0].md : '').toBe('The ferry came at noon.');
    expect(keep.ok ? keep.value.deletions : []).toEqual([{ blockIndex: 0, text: 'left at dawn' }]);
    // The mode's own promise: the deleted text reaches the document's comments, which become the scene's notes.
    expect(keep.ok ? keep.value.document.comments : []).toEqual([{ blockIndex: 0, md: 'left at dawn' }]);
    expect(accept.ok ? accept.value.document.comments : []).toEqual([]);
    expect(reject.ok ? reject.value.document.comments : []).toEqual([]);
  });
});

describe('notes, comments and pictures (#279)', () => {
  it('writes footnotes and endnotes inline with their definitions', async () => {
    const body = '<w:p><w:r><w:t xml:space="preserve">The ferry came</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>';
    const footnotes = '<w:footnote w:id="-1"><w:p><w:r><w:t>sep</w:t></w:r></w:p></w:footnote><w:footnote w:id="1">' + p('At noon exactly.') + '</w:footnote>';
    const endnotes = '<w:endnote w:id="1">' + p('See the harbour log.') + '</w:endnote>';
    const read = await readDocx(docx({ body, footnotes, endnotes }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const block = read.value.document.blocks[0];
    expect(block?.kind === 'para' ? block.md : '').toBe('The ferry came[^1][^2]');
    expect(read.value.document.footnotes?.map((note) => [note.label, note.md, note.blockIndex])).toEqual([
      ['1', 'At noon exactly.', 0],
      ['2', 'See the harbour log.', 0],
    ]);
  });

  it('turns a comment into a note with its anchored text, author and date', async () => {
    const body = '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t xml:space="preserve">The ferry came</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>';
    const comments = '<w:comment w:id="1" w:author="Mara Vale" w:date="2026-11-01T10:00:00Z">' + p('Check the time.') + '</w:comment>';
    const read = await readDocx(docx({ body, comments }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const note = read.value.document.comments?.[0];
    expect(note?.blockIndex).toBe(0);
    expect(note?.md).toContain('> “The ferry came”');
    expect(note?.md).toContain('Check the time.');
    expect(note?.md).toContain('— Mara Vale, 2026-11-01');
    const off = await readDocx(docx({ body, comments }), { comments: false });
    expect(off.ok && off.value.document.comments).toEqual([]);
  });

  it('brings a PNG in, lists an EMF, refuses an SVG and keeps a safe link only', async () => {
    const drawing = (id: string, alt: string): string => `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" descr="${alt}"/><a:graphic><a:graphicData><a:blip r:embed="${id}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const rels =
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/old.emf"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/vector.svg"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/>';
    const links = '<w:p><w:hyperlink r:id="rId4"><w:r><w:t>bad</w:t></w:r></w:hyperlink><w:hyperlink r:id="rId5"><w:r><w:t>good</w:t></w:r></w:hyperlink></w:p>';
    const read = await readDocx(docx({ body: drawing('rId1', 'The harbour') + drawing('rId2', 'Old') + drawing('rId3', 'Vector') + links, rels, media: { 'pic.png': PNG } }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const images = read.value.document.blocks.filter((block) => block.kind === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]?.kind === 'image' ? images[0].alt : '').toBe('The harbour');
    expect(read.value.assetData.size).toBe(1);
    expect(read.value.dropped.emf).toBe(1);
    expect(read.value.dropped.svg).toBe(1);
    expect(read.value.dropped.unsafeLinks).toBe(1);
    const last = read.value.document.blocks[read.value.document.blocks.length - 1];
    expect(last?.kind === 'para' ? last.md : '').toBe('bad[good](https://example.com/)');
  });

  it('keeps both pictures of a picture-only paragraph in order with their own alt text', async () => {
    const imageRun = (id: string, alt: string): string =>
      `<w:r><w:drawing><wp:inline><wp:docPr id="${id}" descr="${alt}"/><a:graphic><a:graphicData><a:blip r:embed="rId${id}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const rels =
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/first.png"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/second.png"/>';
    const body = `<w:p>${imageRun('1', 'First picture')}${imageRun('2', 'Second picture')}</w:p>`;
    const read = await readDocx(docx({ body, rels, media: { 'first.png': PNG, 'second.png': PNG } }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const images = read.value.document.blocks.filter((block) => block.kind === 'image');
    expect(images.map((block) => (block.kind === 'image' ? block.alt : ''))).toEqual(['First picture', 'Second picture']);
    const refs = images.map((block) => (block.kind === 'image' ? block.assetRef : ''));
    expect(refs[0]).not.toBe('');
    expect(refs[1]).not.toBe('');
    expect(refs[0]).not.toBe(refs[1]);
    expect(read.value.document.assets?.map((asset) => asset.name)).toEqual(['first.png', 'second.png']);
  });

  it('keeps literal punctuation plain in a heading title and escaped only in its Markdown', async () => {
    const read = await readDocx(docx({ styles: STYLES, body: p('*door* [name](target)', 'Heading1') }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const heading = read.value.document.blocks[0];
    expect(heading?.kind === 'heading' ? heading.text : '').toBe('*door* [name](target)');
    expect(heading?.kind === 'heading' ? heading.md : '').toBe('# \\*door\\* \\[name\\](target)');
  });

  it('keeps entity-looking source text literal across Word text fragments', async () => {
    const fragmented = '<w:p><w:r><w:t>&amp;amp</w:t><w:t>;</w:t></w:r></w:p>';
    const read = await readDocx(docx({ body: fragmented }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const para = read.value.document.blocks[0];
    expect(para?.kind === 'para' ? para.md : '').toBe('\\&amp;');
    expect(para?.kind === 'para' ? para.text : '').toBe('&amp;');
  });

  it('keeps strike-looking source text literal across Word text fragments', async () => {
    const fragmented = '<w:p><w:r><w:t>~</w:t><w:t>~deleted~</w:t><w:t>~</w:t></w:r></w:p>';
    const read = await readDocx(docx({ body: fragmented }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const para = read.value.document.blocks[0];
    expect(para?.kind === 'para' ? para.md : '').toBe('\\~\\~deleted\\~\\~');
    expect(para?.kind === 'para' ? para.text : '').toBe('~~deleted~~');
  });

  it('keeps the boundary between paragraphs flattened out of one text box', async () => {
    const textBox = `<w:p><w:r><w:txbxContent>${p('First.')}${p('Second.')}</w:txbxContent></w:r></w:p>`;
    const read = await readDocx(docx({ body: textBox }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const para = read.value.document.blocks[0];
    expect(para?.kind === 'para' ? para.md : '').toBe('First.\n\nSecond.');
  });

  it('flattens grouped text boxes in document order', async () => {
    const box = (text: string): string => `<w:txbxContent>${p(text)}</w:txbxContent>`;
    const drawing = `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData>${box('First box')}${box('Second box')}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const read = await readDocx(docx({ body: drawing }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const para = read.value.document.blocks.find((block) => block.kind === 'para');
    expect(para?.kind === 'para' ? para.text : '').toBe('First box\n\nSecond box');
  });

  it('flattens a text box nested inside another text box once', async () => {
    const innerBox = `<w:txbxContent>${p('Inner box')}</w:txbxContent>`;
    const outerBox = `<w:txbxContent>${p('Outer box')}<w:p><w:r>${innerBox}</w:r></w:p></w:txbxContent>`;
    const drawing = `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData>${outerBox}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const read = await readDocx(docx({ body: drawing }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const para = read.value.document.blocks.find((block) => block.kind === 'para');
    expect(para?.kind === 'para' ? para.text : '').toBe('Outer box\n\nInner box');
    expect(read.value.dropped.textBoxes).toBe(2);
  });

  it('imports a picture inside a nested text box once', async () => {
    const inner = '<w:r><w:drawing><wp:inline><wp:docPr id="1" descr="Boxed picture"/><a:graphic><a:graphicData><a:blip r:embed="rId1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    const outer = `<w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><w:txbxContent><w:p>${inner}</w:p></w:txbxContent></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const rels = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/boxed.png"/>';
    const read = await readDocx(docx({ body: outer, rels, media: { 'boxed.png': PNG } }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.document.blocks.filter((block) => block.kind === 'image')).toHaveLength(1);
    expect(read.value.document.assets).toHaveLength(1);
  });

  it('reads the core properties, a page break and underline as italics', async () => {
    const body = '<w:p><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>underlined</w:t></w:r></w:p>' + p('After the break', undefined, '<w:pageBreakBefore/>');
    const read = await readDocx(docx({ body, core: '<dc:title>The Ninth Wave</dc:title><dc:creator>Mara Vale</dc:creator><dc:language>en</dc:language>' }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.title).toBe('The Ninth Wave');
    expect(read.value.author).toBe('Mara Vale');
    expect(read.value.document.metadata?.language).toBe('en');
    expect(read.value.document.blocks.map((block) => block.kind)).toEqual(['para', 'pagebreak', 'para']);
    expect(read.value.document.blocks[0]?.kind === 'para' ? read.value.document.blocks[0].md : '').toBe('*underlined*');
    expect(read.value.dropped.underline).toBe(1);
    const off = await readDocx(docx({ body }), { underlineAs: 'none' });
    expect(off.ok && off.value.document.blocks[0]?.kind === 'para' ? off.value.document.blocks[0].md : '').toBe('underlined');
  });
});

describe('refusals and batches (#279)', () => {
  it('refuses a zip that is not a Word file, and an empty body', async () => {
    const notWord = await readDocx(rawZip([{ name: 'notes.txt', data: enc('a letter') }]));
    expect(notWord.ok).toBe(false);
    if (notWord.ok) return;
    expect(notWord.error.kind).toBe('not-docx');
    const empty = await readDocx(docx({ body: '' }));
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.kind).toBe('empty');
  });

  it('reads a zip of Word files as one unit per file, with its own picture refs', async () => {
    const one = docx({ styles: STYLES, body: p('One', 'Heading1') + p('The ferry came.') });
    const two = docx({ styles: STYLES, body: p('Two', 'Heading1') + p('The letter arrived.') });
    const batch = await readDocxZip(rawZip([{ name: 'a.docx', data: one }, { name: 'b.docx', data: two }]));
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    const units = new Set(batch.value.document.blocks.map((block) => srcOf(block)?.['sourceUnit']));
    expect([...units]).toEqual(['a.docx', 'b.docx']);
    const split = splitImport(batch.value.document);
    expect(split.tree.map((node) => node.title)).toEqual(['One', 'Two']);
  });

  it('names every unreadable member of a batch zip and keeps the readable files', async () => {
    const good = docx({ styles: STYLES, body: p('Kept', 'Heading1') + p('The ferry came.') });
    const notWord = rawZip([{ name: 'notes.txt', data: enc('not a Word file') }]);
    const batch = await readDocxZip(rawZip([
      { name: 'good.docx', data: good },
      { name: 'broken.docx', data: enc('these bytes are not a zip') },
      { name: 'not-word.docx', data: notWord },
    ]));
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value.document.blocks.some((block) => block.kind === 'heading')).toBe(true);
    const skipped = batch.value.document.losses?.filter((loss) => loss.code === 'unsupported').map((loss) => loss.message ?? '') ?? [];
    expect(skipped.some((message) => message.includes('broken.docx'))).toBe(true);
    expect(skipped.some((message) => message.includes('not-word.docx'))).toBe(true);
  });

  it('names a valid empty member as having no importable text', async () => {
    const batch = await readDocxZip(rawZip([
      { name: 'empty.docx', data: docx({ body: '' }) },
      { name: 'filled.docx', data: docx({ body: p('The ferry came.') }) },
    ]));
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value.document.blocks).toHaveLength(1);
    const skipped = batch.value.document.losses?.filter((loss) => loss.code === 'unsupported').map((loss) => loss.message ?? '') ?? [];
    expect(skipped.some((message) => message.includes('empty.docx') && message.includes('no importable text'))).toBe(true);
    expect(skipped.some((message) => message.includes('empty.docx') && message.includes('could not be read'))).toBe(false);
  });

  it('says no batch member contained importable text when every valid member is empty', async () => {
    const batch = await readDocxZip(rawZip([{ name: 'empty.docx', data: docx({ body: '' }) }]));
    expect(batch.ok).toBe(false);
    if (batch.ok) return;
    const message = batch.error.kind === 'empty' ? batch.error.message ?? '' : '';
    expect(message).toContain('contained importable text');
    expect(message).toContain('empty.docx');
    expect(message).not.toContain('could not be read');
  });

  it('names every member when no file in a batch zip can be read', async () => {
    const notWord = rawZip([{ name: 'notes.txt', data: enc('not a Word file') }]);
    const batch = await readDocxZip(rawZip([
      { name: 'broken.docx', data: enc('these bytes are not a zip') },
      { name: 'not-word.docx', data: notWord },
    ]));
    expect(batch.ok).toBe(false);
    if (batch.ok) return;
    expect(batch.error.kind).toBe('empty');
    expect(batch.error.kind === 'empty' ? batch.error.message ?? '' : '').toContain('broken.docx');
    expect(batch.error.kind === 'empty' ? batch.error.message ?? '' : '').toContain('not-word.docx');
  });
});
