/**
 * The agent panel's Intent box as a WAI-ARIA combobox (agent-harness §2 "Slash commands", ui-modules §1): a leading `/` opens the list of
 * commands filtered by what is typed. Focus stays in the box and the list is followed with `aria-activedescendant`, so the box keeps
 * working as a text field. Down and Up move through the list, Tab completes the command and its space, Enter completes the command
 * (and runs it, when it needs no argument), Escape closes the list and keeps the text.
 *
 * The list never opens while an IME composition is in progress, and the full-width `／` is text, not a trigger.
 */

import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useId, useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { BUILTIN_COMMANDS, menuQuery } from '@caotang/harness';
import { canonical, caseFold } from '@caotang/codex';
import type { CommandChoice } from '../app/project-commands.js';
import { contextKey, type ContextChoice } from '../app/context-choices.js';

import { radioStep } from './radio-keys.js';
import { isImeEnter } from '../app/ime.js';
import { formatCount } from './shared.js';

/* lingui-set comment="Interpolated values: commandCount (how many commands match what is typed), shown (displayed context matches), total (all readable context matches)" */

export interface CommandComposerProps {
  readonly contextChoices?: readonly ContextChoice[];
  readonly documentPinLimitReached?: boolean;
  readonly onPin?: (choice: ContextChoice) => void;
  readonly commands?: readonly CommandChoice[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Runs a line the list completed whole: Enter on a command that needs no argument. */
  readonly onRun: (line: string) => void;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

/** The arguments of a command as the list shows them: `<doc> [draft|continue]`. */
const hintOf = (command: CommandChoice): string => command.argumentHint ?? command.args.map((arg) => arg.hint).join(' ');
const fold = (text: string): string => caseFold(canonical(text));

interface Completion {
  readonly key: string;
  readonly command?: CommandChoice;
  readonly context?: ContextChoice;
}

export function CommandComposer({ value, onChange, onRun, placeholder, disabled, inputRef, commands = [], contextChoices = [], documentPinLimitReached = false, onPin }: CommandComposerProps): ReactNode {
  const listId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  // Escape closes the list for the text it was pressed on; the next keystroke opens it again.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ readonly forText: string; readonly name: string } | null>(null);

  const query = menuQuery(value);
  const mention = query === undefined ? /(?:^|\s)@([^\s@]*)$/u.exec(value) : null;
  const needle = mention?.[1] === undefined ? undefined : fold(mention[1]);
  const contextMatches = needle === undefined ? [] : contextChoices.filter((choice) => fold(choice.label).includes(needle) || fold(choice.id).includes(needle));
  const matches: Completion[] = needle === undefined
    ? query === undefined ? [] : [...BUILTIN_COMMANDS, ...commands].filter((command) => command.name.startsWith(query)).map((command) => ({ key: command.name, command }))
    : contextMatches.slice(0, 8).map((context) => ({ key: contextKey(context), context }));
  const visible = !disabled && !composing && closedFor !== value && (matches.length > 0 || needle !== undefined);
  const active = (picked?.forText === value ? matches.find((choice) => choice.key === picked.name) : undefined) ?? matches[0];
  const optionId = (choice: Completion): string => `${listId}-${encodeURIComponent(choice.key)}`;
  const activeKey = active?.key;
  useLayoutEffect(() => {
    const list = menu.current;
    const input = inputRef.current;
    if (!visible || list === null || input === null) return;
    const place = (): void => {
      const box = input.getBoundingClientRect();
      const below = window.innerHeight - box.bottom - 8;
      const above = box.top - 8;
      list.style.position = 'fixed';
      list.style.inset = 'auto';
      list.style.left = `${box.left}px`;
      list.style.width = `${box.width}px`;
      list.style.maxHeight = `${Math.min(260, Math.max(above, below))}px`;
      list.style.top = `${below >= Math.min(260, above) ? box.bottom + 2 : box.top - list.offsetHeight - 2}px`;
    };
    list.showPopover?.();
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      if (list.isConnected) list.hidePopover?.();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [visible, value, inputRef]);
  useLayoutEffect(() => {
    const list = menu.current?.querySelector<HTMLElement>('[role="listbox"]');
    const picked = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!visible || list === undefined || list === null || picked === undefined || picked === null) return;
    const top = picked.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + picked.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + picked.offsetHeight - list.clientHeight;
  }, [visible, activeKey]);

  const complete = (choice: Completion): void => {
    if (choice.context !== undefined) {
      onPin?.(choice.context);
      onChange(value.slice(0, value.length - (mention?.[1]?.length ?? 0) - 1));
    } else if (choice.command !== undefined) onChange(`/${choice.command.name} `);
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
    if (!visible) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setClosedFor(value);
      return;
    }
    if (event.key === 'Enter') {
      if (active === undefined) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (active.context !== undefined) {
        event.preventDefault();
        complete(active);
        return;
      }
      const command = active.command;
      if (command === undefined) return;
      // The name typed in full is the line; send it as it is. A partial name is completed, and sent when it needs nothing more.
      if (value.trim().toLowerCase() === `/${command.name}`) return;
      event.preventDefault();
      if (command.args.some((arg) => arg.required)) complete(active);
      else {
        onChange(`/${command.name}`);
        onRun(`/${command.name}`);
      }
      return;
    }
    if (active === undefined) return;
    if (event.key === 'Tab' && !event.shiftKey) {
      event.preventDefault();
      complete(active);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = radioStep(matches.map((choice) => choice.key), active.key, event.key);
      if (next !== null) setPicked({ forText: value, name: next });
    }
  };

  const commandCount = matches.length;
  const shown = formatCount(matches.length);
  const total = formatCount(contextMatches.length);
  const menuProps = { id: listId, role: 'listbox' };
  const options = <>
    {matches.map((choice) => (
      // Mouse down must not take the focus from the box; the click completes the command.
      <li
        key={choice.key}
        id={optionId(choice)}
        role="option"
        aria-selected={choice.key === active?.key}
        className={choice.key === active?.key ? 'is-active' : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => complete(choice)}
      >
        {choice.command === undefined ? null : <>
          <span className="command-name"><bdi>/{choice.command.name}</bdi></span>
          {choice.command.args.length === 0 ? null : <span className="command-hint">{hintOf(choice.command)}</span>}
          <span className="command-description"><bdi>{choice.command.description}</bdi></span>
          {'source' in choice.command ? <span className="command-description"><bdi>{choice.command.source}</bdi></span> : null}
        </>}
        {choice.context === undefined ? null : <>
          <span className="command-name"><bdi>{choice.context.label}</bdi></span>
          <span className="command-description">{choice.context.kind === 'doc' ? t`Document` : t`Codex`} · <bdi>{choice.context.id}</bdi></span>
        </>}
      </li>
    ))}

  </>;
  return (
    <div className="command-composer">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={t`Intent`}
        aria-autocomplete="list"
        aria-describedby={onPin === undefined ? undefined : listId + '-cue'}
        aria-expanded={visible && matches.length > 0}
        aria-controls={visible && matches.length > 0 ? listId : undefined}
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
        onFocus={() => { if (needle !== undefined) setClosedFor(null); }}
        onBlur={() => setClosedFor(value)}
      />
      {onPin === undefined ? null : <small id={listId + '-cue'} className="muted context-cue"><Trans>Type @ to pin context. Up to three documents.</Trans></small>}
      {visible ? (
        <div ref={menu} popover="manual" className="command-menu" data-testid="command-menu">
          {matches.length === 0 ? null : needle === undefined ? <ul {...menuProps} aria-label={t`Commands`}>{options}</ul> : <ul {...menuProps} aria-label={t`Context to include`}>{options}</ul>}
          {needle === undefined ? null : <div className="command-guidance">
            <div role="status">
              {matches.length === 0 ? <p><Trans>No readable context matches. Refine the name, or press Escape to keep this as text.</Trans></p> : null}
              {documentPinLimitReached ? <p><Trans>Three documents are pinned. Remove a document pin to choose another document.</Trans></p> : null}
              {contextMatches.length > matches.length ? <p><Trans>Showing {shown} of {total} matches. Type more to narrow the list.</Trans></p> : null}
            </div>
            {matches.length === 0 ? null : <p><Trans>Up and Down choose. Enter or Tab pins. Escape keeps the text.</Trans></p>}
          </div>}
        </div>
      ) : null}
      {/* The count is announced when the list opens or narrows; the region is always there so a screen reader hears the change. */}
      <span className="visually-hidden" role="status">
        {visible ? needle === undefined ? plural(commandCount, { one: '# command', other: '# commands' }) : plural(commandCount, { one: '# context item', other: '# context items' }) : ''}
      </span>
    </div>
  );
}
