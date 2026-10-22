/**
 * What every renderer is handed — the flat blocks and the template variables —
 * and the one helper they all need: the chapter headings in order, which is the
 * binder chapter list the contents lists are built from (exporter.md §3a: "the
 * **same binder chapter list** the MD/DOCX TOC renderers consume").
 */

import type { ExportTemplate } from './template.js';
import { chapterLabel } from './template.js';
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
  /** The heading as it reads, `1. The Landing`. */
  readonly label: string;
  readonly number: number;
  readonly title: string;
}

/** The chapter headings in document order, with the label each renders under. */
export function chapterHeadings(input: RenderInput): ChapterHeading[] {
  const out: ChapterHeading[] = [];
  for (const block of input.blocks) {
    if (block.kind !== 'chapter') continue;
    out.push({
      label: chapterLabel(input.template, block.number, block.title),
      number: block.number,
      title: block.title,
    });
  }
  return out;
}

/** The heading a `section` scene prints, or `undefined` for any other scene or a section with a blank title. */
export function sectionTitle(block: FlatBlock): string | undefined {
  return block.kind === 'scene' && block.style === 'section' && block.title.trim() !== '' ? block.title.trim() : undefined;
}

export interface ContentsEntry {
  readonly label: string;
  /** 1 for a chapter, 2 for a `section` scene's heading. */
  readonly level: 1 | 2;
}

/** The Word contents list's entries in document order: each chapter heading, and each section heading under it. */
export function contentsEntries(input: RenderInput): ContentsEntry[] {
  const out: ContentsEntry[] = [];
  for (const block of input.blocks) {
    if (block.kind === 'chapter') out.push({ label: chapterLabel(input.template, block.number, block.title), level: 1 });
    const section = sectionTitle(block);
    if (section !== undefined) out.push({ label: section, level: 2 });
  }
  return out;
}

export function hasTitlePage(input: RenderInput): boolean {
  return input.blocks.some((block) => block.kind === 'frontmatter' && block.fmKind === 'titlepage');
}
