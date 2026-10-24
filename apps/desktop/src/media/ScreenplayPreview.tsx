/**
 * The paginated preview — screenplay.md §3: a pane that draws the scene page by page, as it would print. It is
 * `paginate()`'s own output, in the page's measures (the indents are in characters, the way the page sets them), so a writer
 * sees where the page breaks fall before anything is exported. It writes nothing: a line that prints an element of the script
 * opens that element in the Source tab (`LayoutLine.source`), and the Source tab is the only place the text changes. The page
 * editor the owner decided on (docs/decisions.md) is built on this mapping, a milestone at a time. A script page keeps the paginator's occupied rows
 * stacked, as the blank rows stay collapsed, but the two sides of a dual-dialogue pair share their rows, so they stand side by
 * side as the PDF draws them. The lines stay in the paginator's array order in the DOM, which is the reading order.
 */

import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import { LAYOUT, paginate, parseFountain, type LayoutLine, type LayoutPage, type TextRange } from '@caotang/screenplay';

import { isImeEnter } from '../app/keymap.js';
import { previewRowsOf } from './preview-rows.js';

export interface ScreenplayPreviewProps {
  /** The Fountain body the preview paginates. */
  readonly source: string;
  /** The fallback title for a title page the source does not carry. */
  readonly title: string;
  /** Called with the span of the element a line prints, when the writer clicks the line or presses Enter on it. */
  readonly onOpenSource?: (range: TextRange) => void;
}

/** The pages of one scene, as the paginator lays them out. Pure over the source, so the same text always pages the same way. */
export function previewPagesOf(source: string, title: string): readonly LayoutPage[] {
  return paginate(parseFountain(source).elements, { title });
}

export function ScreenplayPreview({ source, title, onOpenSource }: ScreenplayPreviewProps): ReactNode {
  const pages = useMemo(() => previewPagesOf(source, title), [source, title]);
  const root = useRef<HTMLDivElement>(null);
  // The one line in the tab order (a roving tabindex), by its page and index; the first linked line while that one is gone.
  const [stop, setStop] = useState<string | null>(null);
  if (pages.length === 0) {
    return <p className="muted">Nothing to page yet. Write the scene's heading in the Source tab, and it will appear here.</p>;
  }
  const open = (line: LayoutLine): void => {
    if (line.source !== null) onOpenSource?.(line.source);
  };
  const linked = onOpenSource === undefined ? [] : pages.flatMap((page) => page.lines.flatMap((line, index) => (line.source === null ? [] : [keyOf(page, index)])));
  const tabbable = stop !== null && linked.includes(stop) ? stop : (linked[0] ?? null);
  // Up and Down move between the lines that open the Source tab, in the page's reading order.
  const onKey = (event: KeyboardEvent<HTMLElement>, line: LayoutLine): void => {
    // The Enter that commits an IME candidate opens nothing; it is the candidate window's key.
    if (event.key === 'Enter' && isImeEnter(event.nativeEvent)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(line);
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-source]') ?? []);
    const next = items[items.indexOf(event.currentTarget) + step];
    if (next === undefined) return;
    event.preventDefault();
    setStop(next.dataset.key ?? null);
    next.focus();
  };
  return (
    <div ref={root} className="sp-preview" aria-label="Paginated preview">
      <p className="field-note">
        {onOpenSource === undefined
          ? 'The page breaks follow the screenplay page: about 55 lines a page, 12 point Courier.'
          : 'Choose a line to open it in the Source tab. The page breaks follow the screenplay page: about 55 lines a page, 12 point Courier.'}
      </p>
      {pages.map((page) => {
        const rows = page.kind === 'script' ? previewRowsOf(page.lines) : null;
        return (
          <section key={page.number} className={`sp-page-sheet is-${page.kind}`} aria-label={page.kind === 'title' ? 'Title page' : `Page ${page.number}`}>
            {page.lines.map((line, index) => {
              const className = `sp-line sp-line-${line.kind}`;
              const style = placeOf(line, rows?.[index]);
              if (onOpenSource === undefined || line.source === null) {
                return (
                  <p key={index} className={className} style={style}>
                    {line.text}
                  </p>
                );
              }
              const key = keyOf(page, index);
              return (
                <p
                  key={index}
                  role="button"
                  data-source=""
                  data-key={key}
                  tabIndex={tabbable === key ? 0 : -1}
                  title="Open in the Source tab"
                  className={`${className} is-linked`}
                  style={style}
                  onClick={() => open(line)}
                  onFocus={() => setStop(key)}
                  onKeyDown={(event) => onKey(event, line)}
                >
                  {line.text}
                </p>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function keyOf(page: LayoutPage, index: number): string {
  return `${page.number}:${index}`;
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
