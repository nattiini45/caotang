/**
 * What the editor's load banner says ([editor-engine.md] §3.3 and §5), as the sentences a writer reads.
 *
 * Pure, so the wording is checked without a browser: the banner component renders these strings and
 * nothing else. Nothing here is an error. The text is kept as it was typed, and the banner says what a
 * save will do to it.
 */

import type { LossWarningGroup } from '@caotang/editor';
import { formatCount } from '../i18n/locale.js';

/** The singular and plural a writer reads for each construct a load can name (the mdast type). */
const CONSTRUCTS: Readonly<Record<string, readonly [string, string]>> = {
  table: ['table', 'tables'],
  html: ['raw HTML block', 'raw HTML blocks'],
  definition: ['reference definition', 'reference definitions'],
  linkReference: ['reference link', 'reference links'],
  imageReference: ['reference image', 'reference images'],
  listItem: ['task-list item', 'task-list items'],
  code: ['code block', 'code blocks'],
  emphasis: ['nested emphasis', 'nested emphasis'],
  strong: ['nested bold', 'nested bold'],
  delete: ['nested strikethrough', 'nested strikethrough'],
};

/**
 * One line for one group of losses: how many, what they are, what a save does to them, and where. The effect is
 * a phrase that does not change with the count, so "1 table" and "2 tables" read the same way.
 */
export function describeLossGroup(group: LossWarningGroup): string {
  const [singular, plural] = CONSTRUCTS[group.mdastType] ?? [group.mdastType, group.mdastType];
  const noun = group.nodes === 1 ? singular : plural;
  const where = group.line === null ? '' : ` (line ${group.line})`;
  const effect =
    group.code === 'unsupported-node'
      ? 'kept as plain text'
      : group.code === 'lossy-attribute'
        ? 'a detail not kept'
        : 'structure flattened';
  return `${formatCount(group.nodes)} ${noun}: ${effect}${where}.`;
}

/**
 * The dialect notice's sentence (§5): a save writes these blocks in Caotang's spelling. The words do not change, so
 * the sentence says so.
 */
export function reStyleSentence(blocks: number): string {
  return `Saving will re-style ${formatCount(blocks)} ${blocks === 1 ? 'block' : 'blocks'} to Caotang’s Markdown spelling. The words stay the same.`;
}
