/**
 * What the export dialog's Preview lists (exporter.md §4, the Draft): the exporter's block list as rows a writer reads, and the words for
 * the counts a compile will log. Pure, so the listing and its cap are tested without a page.
 */

import { plural, t } from '@lingui/core/macro';
import { countBody } from '@caotang/store';
import type { FlatBlock } from '@caotang/exporter';
import { formatCount } from '../i18n/locale.js';

/* lingui-set comment="The export dialog's count sentences. Interpolated values: chapters, scenes, sections, lines, shots, words, pages and panels are counts grouped for the formatter locale." */

/** The scenes the list shows. A longer book says how many it holds, and the counts above the list are never capped. */
export const PREVIEW_SCENE_CAP = 300;

export type PreviewRow =
  // `part` is a part heading (a folder that holds chapters): its `number` counts parts, and the list shows it by its title alone.
  | { readonly kind: 'chapter'; readonly key: string; readonly title: string; readonly level: number; readonly number: number; readonly part: boolean }
  | { readonly kind: 'scene'; readonly key: string; readonly title: string; readonly number: number; readonly words: number }
  | { readonly kind: 'break'; readonly key: string };

export interface DraftListing {
  readonly rows: readonly PreviewRow[];
  /** Whether the compile leads with a title page. */
  readonly titlePage: boolean;
  /** The scenes in `rows`, and the scenes the compile holds. They differ when the list is capped. */
  readonly shownScenes: number;
  readonly totalScenes: number;
}

/**
 * The rows of a Draft: each chapter with its scenes, in the compile's order, and the breaks between scenes. The list stops at `cap` scenes, and
 * ends on a scene: a chapter heading or a break that would have led to the first scene left out is not shown.
 */
export function draftListing(blocks: readonly FlatBlock[], cap: number = PREVIEW_SCENE_CAP): DraftListing {
  const rows: PreviewRow[] = [];
  let titlePage = false;
  let scenes = 0;
  let total = 0;
  let capped = false;
  blocks.forEach((block, index) => {
    if (block.kind === 'scene') total += 1;
    if (capped) return;
    switch (block.kind) {
      case 'frontmatter':
        if (block.fmKind === 'titlepage') titlePage = true;
        return;
      case 'chapter':
        rows.push({ kind: 'chapter', key: `c${index}`, title: block.title, level: block.level, number: block.number, part: block.part === true });
        return;
      case 'scene':
        if (scenes >= cap) {
          capped = true;
          return;
        }
        scenes += 1;
        rows.push({ kind: 'scene', key: `s${index}`, title: block.title, number: block.number, words: countBody(block.body).words });
        return;
      case 'separator':
        rows.push({ kind: 'break', key: `b${index}` });
        return;
      case 'backmatter':
        return;
    }
  });
  if (capped) {
    while (rows.length > 0 && rows[rows.length - 1]?.kind !== 'scene') rows.pop();
  }
  return { rows, titlePage, shownScenes: scenes, totalScenes: total };
}

/** A count and its noun, in the singular or the plural: "1 scene", "3 scenes", "1,204 words". */
export function countPhrase(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** The facts of a compile that its sentence is made from. A digest and a Draft both carry them. */
export interface CompileCounts {
  readonly format: string;
  readonly chapterCount: number;
  readonly sceneCount: number;
  readonly blockCount: number;
  readonly wordCount: number;
}

/**
 * What a compile's file holds, in the words of its format (media-track.md). A script counts its scenes and sections, a
 * table its lines and containers, a shot list or a prompt pack its shots, and an Ink story its containers. A prose format
 * counts chapters, scenes and words, as it always has. The counts are the compile's own, so the sentence says what was written.
 */
export function holdsOf(counts: CompileCounts, comicPanels?: number): string {
  // Each count is grouped for the formatter locale and picks its noun's form from the same number, inside one message.
  const sceneCount = counts.sceneCount;
  const sectionCount = counts.chapterCount;
  const chapterCount = counts.chapterCount;
  const lineCount = counts.blockCount;
  const shotCount = counts.blockCount;
  const wordCount = counts.wordCount;
  const scenes = formatCount(sceneCount);
  const sections = formatCount(sectionCount);
  const chapters = formatCount(chapterCount);
  const lines = formatCount(lineCount);
  const shots = formatCount(shotCount);
  const words = formatCount(wordCount);
  switch (counts.format) {
    case 'fountain':
    case 'fdx':
    case 'pdf':
      return t`${scenes} ${plural(sceneCount, { one: 'scene', other: 'scenes' })} in ${sections} ${plural(sectionCount, { one: 'section', other: 'sections' })}, ${words} ${plural(wordCount, { one: 'word', other: 'words' })}`;
    case 'ink-json':
      return t`${scenes} ${plural(sceneCount, { one: 'container', other: 'containers' })}`;
    case 'dialogue-csv':
    case 'dialogue-xlsx':
      return t`${lines} ${plural(lineCount, { one: 'line', other: 'lines' })} in ${scenes} ${plural(sceneCount, { one: 'container', other: 'containers' })}, ${words} ${plural(wordCount, { one: 'word', other: 'words' })}`;
    case 'shot-list-csv':
    case 'shot-list-xlsx':
    case 'promptpack':
    case 'contact-sheet-pdf':
      return t`${shots} ${plural(shotCount, { one: 'shot', other: 'shots' })}`;
    case 'comic-pdf':
    case 'cbz':
    case 'comic-epub': {
      // A comic compile counts pages in `blockCount`; its chapter, scene and word counts are always zero and are never said.
      const pageCount = counts.blockCount;
      const pages = formatCount(pageCount);
      if (comicPanels === undefined) return t`${pages} ${plural(pageCount, { one: 'page', other: 'pages' })}`;
      const panels = formatCount(comicPanels);
      return t`${pages} ${plural(pageCount, { one: 'page', other: 'pages' })}, ${panels} ${plural(comicPanels, { one: 'panel', other: 'panels' })}`;
    }
    case 'coherence-md':
    case 'coherence-json':
      return t`the coherence report`;
    default:
      return t`${chapters} ${plural(chapterCount, { one: 'chapter', other: 'chapters' })}, ${scenes} ${plural(sceneCount, { one: 'scene', other: 'scenes' })}, ${words} ${plural(wordCount, { one: 'word', other: 'words' })}`;
  }
}
