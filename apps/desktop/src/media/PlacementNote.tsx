/** A placement's note: a field that commits when the writer leaves it, so one edit is one undo step. */

import { PICTURE_LIMITS } from '@caotang/pictures';
import { useState, type ReactNode } from 'react';

import { isImeEnter } from '../app/keymap.js';

export function PlacementNote({ initial, label, onCommit }: { readonly initial: string; readonly label: string; readonly onCommit: (text: string) => void }): ReactNode {
  const [value, setValue] = useState(initial);
  return (
    <input
      type="text"
      className="pb-note"
      aria-label={label}
      placeholder={label}
      maxLength={PICTURE_LIMITS.note}
      dir="auto"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (value !== initial) onCommit(value);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || isImeEnter(event.nativeEvent)) return;
        event.preventDefault();
        if (value !== initial) onCommit(value);
      }}
    />
  );
}
