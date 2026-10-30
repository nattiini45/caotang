/**
 * The agent panel's Intent box as a WAI-ARIA combobox (agent-harness §2 "Slash commands", ui-modules §1): a leading `/` opens the list of
 * commands filtered by what is typed. Focus stays in the box and the list is followed with `aria-activedescendant`, so the box keeps
 * working as a text field. Down and Up move through the list, Tab completes the command and its space, Enter completes the command
 * (and runs it, when it needs no argument), Escape closes the list and keeps the text.
 *
 * The list never opens while an IME composition is in progress, and the full-width `／` is text, not a trigger.
 */

import { useId, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { matchCommands, menuQuery, type BuiltinCommand } from '@caotang/harness';

import { radioStep } from './radio-keys.js';
import { isImeEnter } from '../app/ime.js';

export interface CommandComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Runs a line the list completed whole: Enter on a command that needs no argument. */
  readonly onRun: (line: string) => void;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

/** The arguments of a command as the list shows them: `<doc> [draft|continue]`. */
const hintOf = (command: BuiltinCommand): string => command.args.map((arg) => arg.hint).join(' ');

export function CommandComposer({ value, onChange, onRun, placeholder, disabled, inputRef }: CommandComposerProps): ReactNode {
  const listId = useId();
  const [composing, setComposing] = useState(false);
  // Escape closes the list for the text it was pressed on; the next keystroke opens it again.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ readonly forText: string; readonly name: string } | null>(null);

  const query = menuQuery(value);
  const matches = query === undefined ? [] : matchCommands(query);
  const visible = !disabled && !composing && closedFor !== value && matches.length > 0;
  const active = (picked?.forText === value ? matches.find((command) => command.name === picked.name) : undefined) ?? matches[0];
  const optionId = (command: BuiltinCommand): string => `${listId}-${command.name}`;

  const complete = (command: BuiltinCommand): void => {
    onChange(`/${command.name} `);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isImeEnter(event)) {
      // The Intent box is in a form, and an Enter left to its default submits the form. The key the input method owns is cancelled
      // (the input method has already handled it), or the Enter that confirms a candidate would send the half-typed line; Safari's
      // comes after compositionend with only keyCode 229 (#188).
      event.preventDefault();
      return;
    }
    if (!visible || active === undefined) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setClosedFor(value);
    } else if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      complete(active);
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      // The name typed in full is the line; send it as it is. A partial name is completed, and sent when it needs nothing more.
      if (value.trim().toLowerCase() === `/${active.name}`) return;
      event.preventDefault();
      if (active.args.some((arg) => arg.required)) complete(active);
      else {
        onChange(`/${active.name}`);
        onRun(`/${active.name}`);
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = radioStep(matches.map((command) => command.name), active.name, event.key);
      if (next !== null) setPicked({ forText: value, name: next });
    }
  };

  return (
    <div className="command-composer">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Intent"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? listId : undefined}
        aria-activedescendant={visible && active !== undefined ? optionId(active) : undefined}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        autoComplete="off"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          setClosedFor(null);
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
      {visible ? (
        <>
          <ul id={listId} role="listbox" aria-label="Commands" className="command-menu" data-testid="command-menu">
            {matches.map((command) => (
              // Mouse down must not take the focus from the box; the click completes the command.
              <li
                key={command.name}
                id={optionId(command)}
                role="option"
                aria-selected={command.name === active?.name}
                className={command.name === active?.name ? 'is-active' : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => complete(command)}
              >
                <span className="command-name">/{command.name}</span>
                {command.args.length === 0 ? null : <span className="command-hint">{hintOf(command)}</span>}
                <span className="command-description">{command.description}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {/* The count is announced when the list opens or narrows; the region is always there so a screen reader hears the change. */}
      <span className="visually-hidden" role="status">
        {visible ? (matches.length === 1 ? '1 command' : `${matches.length} commands`) : ''}
      </span>
    </div>
  );
}
