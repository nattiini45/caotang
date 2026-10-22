/**
 * The paginated preview — screenplay.md §3: a read-only pane that draws the scene page by page, as it would print. It is
 * `paginate()`'s own output, in the page's measures (the indents are in characters, the way the page sets them), so a writer
 * sees where the page breaks fall before anything is exported. It is not a page editor (screenplay.md §3's verdict), and it
 * writes nothing: the Source tab is the only place the text changes. A script page keeps the paginator's occupied rows
 * stacked, as the blank rows stay collapsed, but the two sides of a dual-dialogue pair share their rows, so they stand side by
 * side as the PDF draws them. The lines stay in the paginator's array order in the DOM, which is the reading order.
 */

import { useMemo, type CSSProperties, type ReactNode } from 'react';

import { LAYOUT, paginate, parseFountain, type LayoutLine, type LayoutPage } from '@caotang/screenplay';

import { previewRowsOf } from './preview-rows.js';

export interface ScreenplayPreviewProps {
  /** The Fountain body the preview paginates. */
  readonly source: string;
  /** The fallback title for a title page the source does not carry. */
  readonly title: string;
}

/** The pages of one scene, as the paginator lays them out. Pure over the source, so the same text always pages the same way. */
export function previewPagesOf(source: string, title: string): readonly LayoutPage[] {
  return paginate(parseFountain(source).elements, { title });
}

export function ScreenplayPreview({ source, title }: ScreenplayPreviewProps): ReactNode {
  const pages = useMemo(() => previewPagesOf(source, title), [source, title]);
  if (pages.length === 0) {
    return <p className="muted">Nothing to page yet. Write the scene's heading in the Source tab, and it will appear here.</p>;
  }
  return (
    <div className="sp-preview" aria-label="Paginated preview">
      <p className="field-note">Read only. The page breaks follow the screenplay page: about 55 lines a page, 12 point Courier.</p>
      {pages.map((page) => {
        const rows = page.kind === 'script' ? previewRowsOf(page.lines) : null;
        return (
          <section key={page.number} className={`sp-page-sheet is-${page.kind}`} aria-label={page.kind === 'title' ? 'Title page' : `Page ${page.number}`}>
            {page.lines.map((line, index) => (
              <p key={index} className={`sp-line sp-line-${line.kind}`} style={placeOf(line, rows?.[index])}>
                {line.text}
              </p>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * A line's place. The paginator measures its left edge in points from the page's left edge, and a character is 7.2 points in
 * the page's 12 point Courier, so the indent is that many characters, which keeps the preview in the page's own measures. A
 * script page is a grid of rows, and the line sits in its display row; the indent is a margin, so the box covers only the
 * text and the lines that share a row do not cover each other.
 */
function placeOf(line: LayoutLine, row: number | undefined): CSSProperties {
  const marginLeft = `${line.x / LAYOUT.charWidth}ch`;
  return row === undefined ? { paddingLeft: marginLeft } : { gridRow: row + 1, gridColumn: 1, justifySelf: 'start', marginLeft };
}
