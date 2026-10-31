/**
 * What every renderer is handed — the flat blocks and the template variables —
 * and the one helper they all need: the chapter headings in order, which is the
 * binder chapter list the contents lists are built from (exporter.md §3a: "the
 * **same binder chapter list** the MD/DOCX TOC renderers consume").
 */

import type { ExportTemplate } from './template.js';
import { chapterLabel, partLabel, type EnclosingPart } from './template.js';
import type { FlatBlock } from './types.js';

export interface RenderInput {
  readonly blocks: readonly FlatBlock[];
  readonly title: string;
  /** Empty when the project has no author on record. */
  readonly author: string;
  /** `YYYY-MM-DD`, the date the title page shows. */
  readonly date: string;
  readonly template: ExportTemplate;
  /** Whether the contents list is wanted for this format and recipe. */
  readonly toc: boolean;
}

export interface ChapterHeading {
  /** The heading as it reads, `1. The Landing`, or a part's own label. */
  readonly label: string;
  readonly number: number;
  readonly title: string;
  /** The folder's depth under the section (the block's `level`): 1 at the top, 2 for a chapter inside a part. */
  readonly level: number;
  /** Whether this heading is a part's (a folder that holds chapters). */
  readonly part: boolean;
  /** The index of the heading's block in `input.blocks`. */
  readonly blockIndex: number;
}

/**
 * Every heading in document order, parts and chapters, with the label each renders under. A chapter's label is filled with the
 * part it sits in: the nearest part heading above it at a lower level, so a prologue after a part's last chapter is in no part.
 */
export function chapterHeadings(input: RenderInput): ChapterHeading[] {
  const out: ChapterHeading[] = [];
  const openParts: (EnclosingPart & { readonly level: number })[] = [];
  input.blocks.forEach((block, blockIndex) => {
    if (block.kind !== 'chapter') return;
    while (openParts.length > 0 && (openParts[openParts.length - 1]?.level ?? 0) >= block.level) openParts.pop();
    const part = block.part === true;
    const label = part
      ? partLabel(input.template, block.number, block.title)
      : chapterLabel(input.template, block.number, block.title, openParts[openParts.length - 1]);
    if (part) openParts.push({ number: block.number, title: block.title, level: block.level });
    out.push({ label, number: block.number, title: block.title, level: block.level, part, blockIndex });
  });
  return out;
}

/** The headings by the index of their block, for a renderer that walks `input.blocks` and needs each heading's label. */
export function headingsByBlock(input: RenderInput): Map<number, ChapterHeading> {
  return new Map(chapterHeadings(input).map((heading) => [heading.blockIndex, heading] as const));
}

/** Whether the compile has a part heading, which moves every chapter heading one level down in Word. */
export function hasParts(input: RenderInput): boolean {
  return input.blocks.some((block) => block.kind === 'chapter' && block.part === true);
}

/** The heading a `section` scene prints, or `undefined` for any other scene or a section with a blank title. */
export function sectionTitle(block: FlatBlock): string | undefined {
  return block.kind === 'scene' && block.style === 'section' && block.title.trim() !== '' ? block.title.trim() : undefined;
}

export interface ContentsEntry {
  readonly label: string;
  /**
   * The entry's outline level: a part or a chapter at its folder depth (1 for a chapter of a book without parts), and a `section`
   * scene's heading one below the heading it follows.
   */
  readonly level: number;
}

/** The Word contents list's entries in document order: each part and chapter heading, and each section heading under it. */
export function contentsEntries(input: RenderInput): ContentsEntry[] {
  const out: ContentsEntry[] = [];
  const headings = headingsByBlock(input);
  let depth = 1;
  input.blocks.forEach((block, index) => {
    const heading = headings.get(index);
    if (heading !== undefined) {
      depth = heading.level;
      out.push({ label: heading.label, level: heading.level });
    }
    const section = sectionTitle(block);
    if (section !== undefined) out.push({ label: section, level: depth + 1 });
  });
  return out;
}

export function hasTitlePage(input: RenderInput): boolean {
  return input.blocks.some((block) => block.kind === 'frontmatter' && block.fmKind === 'titlepage');
}
