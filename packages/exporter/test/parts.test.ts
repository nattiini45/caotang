/**
 * Parts (#269): a folder that holds chapters compiles as a part heading, with its chapters one level down and chapter numbers
 * running on across parts. The fixture is two parts of three chapters of two scenes, with a prologue and an epilogue beside
 * the parts (parts-fixture.ts). The Markdown is pinned whole against `golden/parts-book.md`; Word, EPUB and plain text are
 * checked clause by clause, as their own tests check a book without parts. A book without parts is covered by the existing
 * tests, which are unchanged: its output is byte for byte what it was.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate/browser';
import { EpubCheck } from '@likecoin/epubcheck-ts';
import { addFolder, addDocument } from '@caotang/store';
import { flatten } from '../src/flatten.js';
import { renderDocx } from '../src/render-docx.js';
import { renderEpub } from '../src/render-epub.js';
import { chapterHeadings, contentsEntries, type RenderInput } from '../src/render-input.js';
import { renderMarkdown, renderText } from '../src/render-text.js';
import { DEFAULT_TEMPLATE, chapterLabel, partLabel, type ExportTemplate } from '../src/template.js';
import type { FlatBlock } from '../src/types.js';
import { makeProject } from './fixture.js';
import { PARTS_PROJECT_NAME, PART_IDS, makePartsProject } from './parts-fixture.js';

const GOLDEN_MD = fileURLToPath(new URL('./golden/parts-book.md', import.meta.url));

function blocksOf(state = makePartsProject()): readonly FlatBlock[] {
  return flatten(state, { includeRootIds: ['manuscript'] }, { titlePage: true }).blocks;
}

function input(blocks: readonly FlatBlock[] = blocksOf(), template: ExportTemplate = DEFAULT_TEMPLATE): RenderInput {
  return { blocks, title: PARTS_PROJECT_NAME, author: 'M. Ortega', date: '2026-10-31', template, toc: true };
}

function headingsOnly(blocks: readonly FlatBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.kind === 'chapter' ? [`${block.part === true ? 'part' : 'chapter'} ${block.number} L${block.level} ${block.title}`] : [],
  );
}

describe('flatten — parts are headings of their own, and chapter numbers run on', () => {
  it('writes each part once, ahead of its first chapter, numbered among the parts', () => {
    expect(headingsOnly(blocksOf())).toEqual([
      'chapter 1 L1 Prologue',
      'part 1 L1 Part One',
      'chapter 2 L2 The Harbour',
      'chapter 3 L2 The Island',
      'chapter 4 L2 The Lamp',
      'part 2 L1 Part Two',
      'chapter 5 L2 The Storm',
      'chapter 6 L2 The Wreck',
      'chapter 7 L2 The Dawn',
      'chapter 8 L1 Epilogue',
    ]);
  });

  it('counts chapters and parts apart, and every scene', () => {
    const flat = flatten(makePartsProject(), { includeRootIds: ['manuscript'] }, { titlePage: false });
    expect(flat.chapterCount).toBe(8);
    expect(flat.partCount).toBe(2);
    expect(flat.sceneCount).toBe(14);
  });

  it('puts no separator at a part boundary: only between scenes of one chapter', () => {
    const blocks = blocksOf();
    blocks.forEach((block, index) => {
      if (block.kind !== 'separator') return;
      expect(blocks[index - 1]?.kind).toBe('scene');
      expect(blocks[index + 1]?.kind).toBe('scene');
    });
  });

  it('writes a part heading lazily: a part whose scenes are all empty has none, and a selected chapter brings its part', () => {
    const state = makePartsProject();
    for (const doc of state.documents.values()) doc.body = '';
    const flat = flatten(state, { includeRootIds: ['manuscript'] }, { titlePage: false });
    expect(flat.partCount).toBe(0);

    const one = flatten(makePartsProject(), { includeRootIds: [PART_IDS.harbour] }, { titlePage: false });
    expect(headingsOnly(one.blocks)).toEqual(['part 1 L1 Part One', 'chapter 1 L2 The Harbour']);
  });

  it('heads a scene filed directly in a part with the part alone', () => {
    const state = makePartsProject();
    addDocument(state, { parentId: PART_IDS.partTwo, title: 'Interlude', body: 'Between the parts.' });
    const blocks = blocksOf(state);
    const interlude = blocks.findIndex((block) => block.kind === 'scene' && block.title === 'Interlude');
    // Part Two's heading went out with its first scene (in The Storm); the interlude, its last child, follows The Dawn's scenes.
    expect(blocks[interlude - 1]?.kind).toBe('scene');
    expect(headingsOnly(blocks).filter((line) => line.includes('Part Two'))).toEqual(['part 2 L1 Part Two']);
  });

  it('does not make a chapter with a storyboard a part', () => {
    const state = makeProject();
    const chapterOne = state.manifest.tree.find((node) => node.title === 'Chapter One');
    if (chapterOne === undefined) throw new Error('the fixture has no Chapter One');
    const board = addFolder(state, { parentId: chapterOne.id, title: 'The Landing — Shots' });
    board.kind = 'storyboard';
    expect(blocksOf(state).some((block) => block.kind === 'chapter' && block.part === true)).toBe(false);
  });

  it('makes every folder that holds folders a part, at any depth (Book → Part → Chapter)', () => {
    const state = makePartsProject();
    const book = addFolder(state, { parentId: 'manuscript', title: 'Book Two' });
    const part = addFolder(state, { parentId: book.id, title: 'Part Three' });
    const chapter = addFolder(state, { parentId: part.id, title: 'The Return' });
    addDocument(state, { parentId: chapter.id, title: 'Home', body: 'Home at last.' });
    expect(headingsOnly(blocksOf(state)).slice(-3)).toEqual(['part 3 L1 Book Two', 'part 4 L2 Part Three', 'chapter 9 L3 The Return']);
  });
});

describe('the template — part labels and the part a chapter sits in', () => {
  it('labels a part by its title by default, and fills {partNumber} and {partTitle}', () => {
    expect(partLabel(DEFAULT_TEMPLATE, 2, 'Part Two')).toBe('Part Two');
    const numbered: ExportTemplate = { ...DEFAULT_TEMPLATE, partLabel: 'Part {partNumber}: {partTitle}' };
    expect(partLabel(numbered, 2, 'The Sea')).toBe('Part 2: The Sea');
  });

  it('fills a chapter label with its enclosing part, and leaves both empty outside a part', () => {
    const template: ExportTemplate = { ...DEFAULT_TEMPLATE, chapterLabel: '{partNumber}.{chapterNumber} {chapterTitle} ({partTitle})' };
    expect(chapterLabel(template, 3, 'The Island', { number: 1, title: 'Part One' })).toBe('1.3 The Island (Part One)');
    expect(chapterLabel(template, 1, 'Prologue')).toBe('.1 Prologue ()');
    const labels = chapterHeadings(input(blocksOf(), template)).map((heading) => heading.label);
    expect(labels).toContain('1.2 The Harbour (Part One)');
    expect(labels).toContain('2.5 The Storm (Part Two)');
    // The epilogue comes after Part Two closes, so it is in no part.
    expect(labels).toContain('.8 Epilogue ()');
  });
});

describe('Markdown — parts are ##, their chapters ###, and the contents nest', () => {
  it('matches the golden file', () => {
    expect(renderMarkdown(input())).toBe(readFileSync(GOLDEN_MD, 'utf8'));
  });
});

describe('plain text — a part is its label in capitals', () => {
  it('writes PART ONE above CHAPTER 2', () => {
    const text = renderText(input());
    expect(text).toContain('PART ONE\n\nCHAPTER 2. THE HARBOUR');
    expect(text).toContain('PART TWO\n\nCHAPTER 5. THE STORM');
    expect(text).toContain('CHAPTER 8. EPILOGUE');
  });
});

describe('Word — a part is Heading 1 and its chapters Heading 2', () => {
  async function documentXml(blocks?: readonly FlatBlock[]): Promise<{ body: string; styles: string }> {
    const files = unzipSync(await renderDocx(input(blocks)));
    return { body: strFromU8(files['word/document.xml'] ?? new Uint8Array()), styles: strFromU8(files['word/styles.xml'] ?? new Uint8Array()) };
  }

  function headingOf(body: string, text: string): string | undefined {
    // A heading paragraph: its style, then (in docx's order) its run with the text.
    const at = body.indexOf(`<w:t xml:space="preserve">${text}</w:t>`);
    if (at < 0) return undefined;
    const paragraph = body.slice(body.lastIndexOf('<w:p>', at), at);
    return /<w:pStyle w:val="(Heading\d)"\/>/.exec(paragraph)?.[1];
  }

  it('sets each heading at its folder depth, with a page break before each', async () => {
    const { body } = await documentXml();
    expect(headingOf(body, 'Part One')).toBe('Heading1');
    expect(headingOf(body, '2. The Harbour')).toBe('Heading2');
    expect(headingOf(body, '1. Prologue')).toBe('Heading1');
    expect(headingOf(body, '8. Epilogue')).toBe('Heading1');
    // Ten headings (two parts, eight chapters), each starting a page; the contents list has its own break besides.
    expect(body.match(/<w:pStyle w:val="Heading\d"\/><w:pageBreakBefore\/>/g)?.length).toBe(10);
  });

  it('lists parts and chapters in the cached contents, chapters one level down', () => {
    const entries = contentsEntries(input());
    expect(entries.slice(0, 3)).toEqual([
      { label: '1. Prologue', level: 1 },
      { label: 'Part One', level: 1 },
      { label: '2. The Harbour', level: 2 },
    ]);
  });

  it('widens the field to Heading 3 when a chapter in a part has a section scene, and defines the styles it uses', async () => {
    const blocks = blocksOf().map((block) =>
      block.kind === 'scene' && block.title === 'Arrival' ? { ...block, style: 'section' } : block,
    );
    const { body, styles } = await documentXml(blocks);
    expect(body).toContain('TOC \\h \\o &quot;1-3&quot;');
    expect(headingOf(body, 'Arrival')).toBe('Heading3');
    expect(styles).toContain('w:styleId="TOC3"');
    expect(contentsEntries(input(blocks))).toContainEqual({ label: 'Arrival', level: 3 });
  });

  it('keeps the 1-2 field and no Heading 3 style for a book with parts and no section scenes', async () => {
    const { body, styles } = await documentXml();
    expect(body).toContain('TOC \\h \\o &quot;1-2&quot;');
    expect(styles).not.toContain('w:styleId="TOC3"');
  });
});

describe('EPUB — a part is a file of its own, and the contents nest', () => {
  async function book(): Promise<Record<string, string>> {
    const bytes = await renderEpub({
      ...input(),
      language: 'en',
      identifier: 'urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d',
      modified: '2026-10-31T09:00:00Z',
      mtime: new Date('2026-10-31T09:00:00Z'),
    });
    const out: Record<string, string> = {};
    for (const [name, data] of Object.entries(unzipSync(bytes))) if (!name.endsWith('.png')) out[name] = strFromU8(data);
    return out;
  }

  it('writes a part file with epub:type part, and nests its chapters in nav.xhtml and toc.ncx', async () => {
    const files = await book();
    const partFile = Object.entries(files).find(([name, text]) => name.startsWith('OEBPS/chapter-') && text.includes('<h1>Part One</h1>'));
    expect(partFile?.[1]).toContain('epub:type="part"');
    const nav = files['OEBPS/nav.xhtml'] ?? '';
    expect(nav).toMatch(/<li><a href="chapter-\d+\.xhtml">Part One<\/a>\s*<ol>\s*<li><a href="chapter-\d+\.xhtml">2\. The Harbour<\/a><\/li>/);
    // The epilogue is a top-level entry again, after Part Two's list closes.
    expect(nav).toMatch(/<\/ol>\s*<\/li>\s*<li><a href="chapter-\d+\.xhtml">8\. Epilogue<\/a><\/li>\s*<\/ol>/);
    const ncx = files['OEBPS/toc.ncx'] ?? '';
    expect(ncx).toContain('<meta name="dtb:depth" content="2"/>');
    expect(ncx).toMatch(/<text>Part One<\/text><\/navLabel>\s*<content src="chapter-\d+\.xhtml"\/>\s*<navPoint/);
  });

  it('passes epubcheck', async () => {
    const bytes = await renderEpub({
      ...input(),
      language: 'en',
      identifier: 'urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d',
      modified: '2026-10-31T09:00:00Z',
      mtime: new Date('2026-10-31T09:00:00Z'),
    });
    const result = await EpubCheck.validate(bytes, { version: '3.3' });
    expect(result.messages.filter((m) => m.severity === 'error' || m.severity === 'fatal').map((m) => `${m.id}: ${m.message}`)).toEqual([]);
  }, 30_000);
});
