/**
 * The scene styles the prose formats render — [exporter.md §2, Per-scene styling](../../../docs/architecture/exporter.md).
 *
 * The vocabulary is the bus's (`SCENE_STYLES`, which the Inspector and `binder.setMeta` check against). A row here says which formats
 * express a style other than `normal`. Flatten reads a stored value against the rows, so an unknown one is a normal scene, and the
 * compile names a style that its format has no row for, once, in the compile log.
 */

import type { ExportFormat, FlatBlock } from './types.js';

export interface SceneStyleRow {
  readonly id: string;
  /** The prose formats that express the style. */
  readonly formats: readonly ExportFormat[];
}

export const SCENE_STYLE_ROWS: readonly SceneStyleRow[] = [{ id: 'section', formats: ['md', 'txt', 'docx', 'epub'] }];

/** The style a stored value means: the value when a row names it, and `undefined` (a normal scene) for `normal`, absent or unknown. */
export function sceneStyleOf(stored: string | undefined, rows: readonly SceneStyleRow[] = SCENE_STYLE_ROWS): string | undefined {
  return stored !== undefined && rows.some((row) => row.id === stored) ? stored : undefined;
}

const FORMAT_WORDS: Readonly<Partial<Record<ExportFormat, string>>> = {
  md: 'Markdown',
  txt: 'plain-text',
  docx: 'Word',
  epub: 'EPUB',
};

/** One note for each style the blocks carry that `format` has no row for, in the order the styles first appear. */
export function droppedStyleNotes(
  blocks: readonly FlatBlock[],
  format: ExportFormat,
  rows: readonly SceneStyleRow[] = SCENE_STYLE_ROWS,
): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'scene' || block.style === undefined || seen.has(block.style)) continue;
    seen.add(block.style);
    if (rows.find((row) => row.id === block.style)?.formats.includes(format) === true) continue;
    notes.push(`the \`${block.style}\` style has no meaning in the ${FORMAT_WORDS[format] ?? format} format, so it was dropped`);
  }
  return notes;
}
