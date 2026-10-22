/** The rows of the paginated preview (ScreenplayPreview.tsx): which display row each line of a script page sits in. */

import type { LayoutLine } from '@caotang/screenplay';

/**
 * The display row of each line of a script page, from zero. The page's occupied rows are numbered in order, so a blank row
 * stays collapsed and the two sides of a dual pair, which carry the same paginator rows, share a display row. A scene number
 * has no row of its own; it follows its heading and takes that line's row. A line that has none and follows nothing, the page
 * number, takes the next row after the last, which is where the flow put it.
 */
export function previewRowsOf(lines: readonly LayoutLine[]): readonly number[] {
  const occupied = [...new Set(lines.flatMap((line) => (line.row === null ? [] : [line.row])))].sort((a, b) => a - b);
  const displayOf = new Map(occupied.map((row, index) => [row, index]));
  let next = occupied.length;
  const rows: number[] = [];
  lines.forEach((line, index) => {
    const rowed = line.row === null ? undefined : displayOf.get(line.row);
    if (rowed !== undefined) rows.push(rowed);
    else if (line.kind === 'sceneNumber' && index > 0) rows.push(rows[index - 1] ?? 0);
    else rows.push(next++);
  });
  return rows;
}
