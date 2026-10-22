/**
 * Small pieces every panel uses: the session hook, the status channel, a menu, a
 * confirm dialog, an inline text editor, and the debounced text field that carries the
 * 800 ms cadence ui-modules §4.1 specifies for synopsis and notes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import type { ProjectSession } from '../app/session.js';

/** Re-renders the caller whenever the session commits, saves or undoes anything. */
export function useSession(session: ProjectSession): number {
  return useSyncExternalStore(session.subscribe, session.getVersion);
}

/* ------------------------------------------------------------------ *
 * The status channel: one line the user can read, for the last thing
 * that went wrong or was worth saying.
 * ------------------------------------------------------------------ */

export interface StatusMessage {
  readonly text: string;
  readonly tone: 'info' | 'error';
  /**
   * A place the sentence names and the writer can go to, drawn as a link-looking button straight after `text`, with `after` (its closing
   * punctuation) following it. The button's visible words are its accessible name.
   */
  readonly link?: { readonly label: string; readonly after: string; readonly onClick: () => void };
}

export type Report = (message: StatusMessage) => void;

export const ReportContext = createContext<Report>(() => {});

export function useReport(): Report {
  return useContext(ReportContext);
}

/* ------------------------------------------------------------------ *
 * Menus — the context menu and the status/label pickers.
 * ------------------------------------------------------------------ */

export interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Set for a radio-style choice (a picker): the item that is currently chosen. */
  readonly checked?: boolean;
  readonly danger?: boolean;
  /** A rule above this item, for grouping. */
  readonly separatorBefore?: boolean;
  /** One character that chooses this item while the menu is open, shown at its end. */
  readonly shortcut?: string;
  /** A key chord that does the same outside the menu, shown beside the item. Display only: the menu does not act on it. */
  readonly chord?: string;
}

export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
}

/**
 * A positioned list of actions. Arrow keys move, Enter or Space chooses, Escape or a
 * click outside closes. It takes focus on open, so the keyboard works without a click.
 */
export function Menu({
  label,
  anchor,
  items,
  onClose,
}: {
  label: string;
  anchor: MenuAnchor;
  items: readonly MenuItem[];
  onClose: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = items.filter((item) => !item.disabled);
  // The close callback is read through a ref so a parent that re-renders does not
  // re-run the focus-on-open effect and pull focus back to the first item.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  // The control that opened the menu takes focus back when the menu closes, so the keyboard is where it was (ExportDialog
  // does the same). It is read on the first render, before the focus-on-open effect moves focus into the menu.
  const [opener] = useState<Element | null>(() => document.activeElement);
  useEffect(
    () => () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    },
    [opener],
  );

  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    // Keep the menu on screen: open upward when it would run off the bottom, and shift it in
    // from the right edge. A fixed menu is not scrolled into view by anything else.
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(4, anchor.y - rect.height - 36)}px`;
    }
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 8)}px`;
    }
    // Focus the first item that can be chosen. A menu whose only entry is disabled takes
    // focus itself, so Escape still reaches it.
    const first = menu.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled])');
    if (first) first.focus();
    else menu.focus();
    // Escape closes the menu wherever focus is, including on the control that opened it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [anchor.x, anchor.y]);

  const move = (current: HTMLElement, step: number) => {
    const nodes = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"]') ?? [],
    ).filter((node) => !node.hasAttribute('disabled'));
    if (nodes.length === 0) return;
    const at = nodes.indexOf(current);
    const next = nodes[(at + step + nodes.length) % nodes.length];
    next?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // An item's own key chooses it, as a click does. A key with a modifier is not one.
    const keyed =
      event.ctrlKey || event.metaKey || event.altKey
        ? undefined
        : enabled.find((item) => item.shortcut !== undefined && item.shortcut.toLowerCase() === event.key.toLowerCase());
    if (keyed !== undefined) {
      event.preventDefault();
      onClose();
      keyed.onSelect();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(target, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(target, -1);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      className="menu"
      style={{ left: anchor.x, top: anchor.y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <div key={item.key} className="menu-entry">
          {item.separatorBefore ? <div role="separator" className="menu-rule" /> : null}
          <button
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            disabled={item.disabled}
            aria-keyshortcuts={item.shortcut}
            className={`menu-item${item.danger ? ' is-danger' : ''}${item.checked ? ' is-checked' : ''}`}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
            {item.shortcut === undefined ? null : (
              <span className="menu-key" aria-hidden="true">
                {item.shortcut}
              </span>
            )}
            {item.chord === undefined ? null : (
              <span className="menu-key menu-chord" aria-hidden="true">
                {item.chord}
              </span>
            )}
          </button>
        </div>
      ))}
      {enabled.length === 0 ? <p className="menu-empty">Nothing to choose.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The one destructive dialog: a native <dialog>, so focus is trapped and
 * Escape cancels for free.
 * ------------------------------------------------------------------ */

export function ConfirmDialog({
  open,
  title,
  onConfirm,
  onCancel,
  confirmLabel,
  children,
}: {
  open: boolean;
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel: string;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  // Each dialog names itself with its own id: two confirmations can be in the page at once (a delete, and a restore).
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form method="dialog" className="confirm-body">
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-text">{children}</div>
        <div className="confirm-actions">
          <button type="button" className="button" autoFocus onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button is-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** One answer a {@link ChoiceDialog} offers. `danger` marks the answer that writes over something. */
export interface DialogChoice {
  readonly label: string;
  readonly onChoose: () => void;
  readonly danger?: boolean;
}

/**
 * A question with more than one way forward: the same native <dialog> as {@link ConfirmDialog}, with its answers in the order given
 * and Cancel last. Cancel takes the focus as the dialog opens, so Enter never writes over anything, and Escape cancels too.
 */
export function ChoiceDialog({
  open,
  title,
  choices,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  choices: readonly DialogChoice[];
  onCancel: () => void;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form method="dialog" className="confirm-body">
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-text">{children}</div>
        <div className="confirm-actions">
          {choices.map((choice) => (
            <button key={choice.label} type="button" className={choice.danger === true ? 'button is-danger' : 'button'} onClick={choice.onChoose}>
              {choice.label}
            </button>
          ))}
          <button type="button" className="button" autoFocus onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Inline text: rename a node in place. Enter and blur commit, Escape cancels.
 * ------------------------------------------------------------------ */

export function InlineText({
  initial,
  label,
  onCommit,
  onCancel,
  className,
}: {
  initial: string;
  label: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
  className?: string;
}): ReactNode {
  const [value, setValue] = useState(initial);
  const finished = useRef(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  // Enter and blur can both fire for one edit; only the first decides it.
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) onCommit(value.trim());
    else onCancel();
  };

  return (
    <input
      ref={ref}
      type="text"
      aria-label={label}
      className={`inline-text ${className ?? ''}`.trim()}
      value={value}
      maxLength={120}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Debounced text: the draft shown while typing, committed 800 ms after the last
 * keystroke (or at once on blur, or when the field unmounts).
 *
 * The display is `draft ?? storeValue`, so the field follows the store whenever the
 * user is not mid-edit — an undo or a structural change shows up without an effect.
 * A refused commit keeps the draft, so what the writer typed is never silently lost.
 * ------------------------------------------------------------------ */

export function useDebouncedText(
  storeValue: string,
  commit: (text: string) => boolean,
  delayMs = 800,
): { value: string; change: (text: string) => void; flush: () => void } {
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useRef({ commit, storeValue });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    latest.current = { commit, storeValue };
  });

  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const flush = useCallback(() => {
    clearTimer();
    const text = pending.current;
    pending.current = null;
    if (text === null) return;
    if (text === latest.current.storeValue) {
      setDraft(null);
      return;
    }
    const accepted = latest.current.commit(text);
    // Only a commit that landed releases the draft; a refused one keeps what was typed.
    if (accepted) setDraft(null);
  }, []);

  const change = useCallback(
    (text: string) => {
      setDraft(text);
      pending.current = text;
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        flush();
      }, delayMs);
    },
    [delayMs, flush],
  );

  // A field that unmounts mid-edit still saves what was typed.
  useEffect(() => () => flush(), [flush]);

  return { value: draft ?? storeValue, change, flush };
}

/* ------------------------------------------------------------------ *
 * Small presentational pieces.
 * ------------------------------------------------------------------ */

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <section className="empty-state" aria-label={title}>
      <h2>{title}</h2>
      {children ? <div className="empty-text">{children}</div> : null}
      {actions ? <div className="empty-actions">{actions}</div> : null}
    </section>
  );
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function wordsLabel(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'word' : 'words'}`;
}
