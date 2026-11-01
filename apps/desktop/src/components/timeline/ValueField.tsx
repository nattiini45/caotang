/**
 * A whole-number field for the tray and the Agenda: it holds what the writer types, and Enter or leaving the field asks for the change.
 * A value that is not a number of days the timeline can hold marks the field invalid and asks for nothing; Escape gives the typed text up.
 */

import { useState, type ReactNode } from 'react';

import { isImeEnter } from '../../app/keymap.js';
import { parseDayText } from '../../app/timeline-edit-model.js';
import { isProposableDay } from '../../app/timeline-proposals.js';

export interface ValueFieldProps {
  readonly label: string;
  readonly value: number | null;
  /** Clearing the field asks for `null`. Without it an empty field is invalid. */
  readonly clearable?: boolean;
  /** Smallest value taken; a duration is not negative. Default: any day. */
  readonly min?: number;
  readonly wide?: boolean;
  readonly onCommit: (value: number | null) => void;
}

export function ValueField({ label, value, clearable = false, min, wide = false, onCommit }: ValueFieldProps): ReactNode {
  const [draft, setDraft] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const shown = draft ?? (value === null ? '' : String(value).replace('-', '\u2212'));
  const commit = (): void => {
    if (draft === null) return;
    if (draft.trim() === '' && clearable) {
      setBad(false);
      setDraft(null);
      if (value !== null) onCommit(null);
      return;
    }
    const parsed = parseDayText(draft);
    if (parsed === null || !isProposableDay(parsed) || (min !== undefined && parsed < min)) {
      setBad(true);
      return;
    }
    setBad(false);
    setDraft(null);
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      className={`tl-value${wide ? ' is-wide' : ''}`}
      aria-label={label}
      aria-invalid={bad ? true : undefined}
      value={shown}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape' && draft !== null) {
          event.stopPropagation();
          setDraft(null);
          setBad(false);
        }
      }}
    />
  );
}
