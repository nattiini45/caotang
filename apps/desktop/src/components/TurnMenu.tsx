/**
 * The rewind menu of one turn (agent-harness §5): the project and the conversation are restored apart or together. A disclosure, not
 * an ARIA menu: the actions are plain buttons in tab order, Escape closes it and puts focus back on the button that opened it, and
 * leaving it by Tab or a click elsewhere closes it too.
 */

import { useEffect, useId, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export interface TurnMenuItem {
  readonly label: string;
  /** One line under the label, said to a screen reader as well. */
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export function TurnMenu({
  label,
  toggleLabel = 'Rewind',
  items,
  note,
  testId,
}: {
  /** What the button is called for a screen reader, for example the turn it belongs to. */
  label: string;
  toggleLabel?: string;
  items: readonly TurnMenuItem[];
  /** A scope note shown with the actions, such as the one a turn that called an external tool carries. */
  note?: string;
  testId?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // A click outside the menu closes it; focus stays where the click put it.
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    // Escape closes the menu and nothing behind it (the panel's Escape would stop the turn).
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget) !== true) setOpen(false);
  };

  return (
    <div className="turn-menu" ref={root} onKeyDown={onKey} onBlur={onBlur} data-testid={testId}>
      <button
        type="button"
        ref={button}
        className="button is-quiet turn-menu-toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        onClick={() => setOpen((was) => !was)}
      >
        {toggleLabel}
      </button>
      {open ? (
        <div id={panelId} className="turn-menu-panel" role="group" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              className="button is-quiet turn-menu-item"
              disabled={item.disabled === true}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.hint === undefined ? null : <span className="muted turn-menu-hint">{item.hint}</span>}
            </button>
          ))}
          {note === undefined ? null : <p className="muted turn-menu-note">{note}</p>}
        </div>
      ) : null}
    </div>
  );
}
