/**
 * A source field: a text input with its decorations drawn under it (screenplay.md §3, dialogue-narrative.md §3). The input
 * keeps the text, the caret and the selection, and it is what the writer types into and what the accessible name is on. A
 * layer of spans behind it carries the styling. The two share their metrics in media.css, and the layer scrolls with the
 * input, so each styled run sits under the characters it is about. The layer is hidden from assistive technology: the
 * input's text is the one a reader hears.
 */

import { Fragment, useRef, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

import type { Segment } from './source-decor.js';

export interface SourceFieldProps {
  /** The input's accessible name, which the views and their tests find it by. */
  readonly label: string;
  readonly value: string;
  /** The decorations of `value`, from `source-decor.ts`: segments that cover the whole value in order. */
  readonly segments: readonly Segment[];
  readonly onChange: (text: string) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
  /** The input's element, for the views that place the caret or focus it. */
  readonly inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** The view's own classes for the input, kept so its existing styling still applies. */
  readonly inputClassName: string;
  readonly rows?: number;
}

export function SourceField({
  label,
  value,
  segments,
  onChange,
  onKeyDown,
  onBlur,
  inputRef,
  inputClassName,
  rows,
}: SourceFieldProps): ReactNode {
  const layer = useRef<HTMLDivElement>(null);
  return (
    <div className="src-field">
      {/* The layer takes the input's view class too, so the two share the font, size, spacing and wrapping that class sets. */}
      <div ref={layer} className={`src-layer ${inputClassName}`} aria-hidden="true">
        {segments.map((segment, index) => {
          const text = value.slice(segment.from, segment.to);
          return segment.cls === null ? (
            <Fragment key={index}>{text}</Fragment>
          ) : (
            <span key={index} className={segment.cls}>
              {text}
            </span>
          );
        })}
        {/* A trailing newline needs a line of its own in the layer, or the last line of the input has no height under it. */}
        {'\n'}
      </div>
      <textarea
        ref={inputRef}
        className={`src-input ${inputClassName}`}
        aria-label={label}
        value={value}
        rows={rows}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onScroll={(event) => {
          // The layer follows the input in both directions, so a long line that scrolls sideways keeps its styling under it.
          if (layer.current === null) return;
          layer.current.scrollTop = event.currentTarget.scrollTop;
          layer.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
      />
    </div>
  );
}
