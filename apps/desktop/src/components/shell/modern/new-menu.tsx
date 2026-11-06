/**
 * Modern's **+ New** (modern-interface.md §7.8, #477): the one primary capsule of the top ornament and its glass menu. The menu lists
 * app/new-menu.ts's kinds under **Write** and **Script and story**, each with one short line, and says in its last line where they go
 * (`Goes into Chapter 3`, or that a chapter is made first). Choosing one makes it there and opens it.
 *
 * Keys: as **⋯** (APG menu button): ArrowDown on the button opens it, the arrow keys, Home and End move, Enter or Space chooses,
 * Escape or Tab closes and focus returns to **+ New**. Ctrl+Shift+N (Cmd+Shift+N) and the palette open it too (`newMenuChannel`).
 */
/* lingui-set comment="Modern interface, the + New menu in the top ornament." */

import { t } from '@lingui/core/macro';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import { DESKTOP_VIEW_KINDS, newGroups, type NewKind } from '../../../app/new-menu.js';
import { isImeEnter, keyFacts, resolveKey, shortcutLabel } from '../../../app/keymap.js';
import type { ShellCreate } from '../regions.js';
import { GlassPopover } from './glass-popover.js';
import { Icon } from './icons.js';
import { newMenuChannel } from './requests.js';

export function NewButton({ create, narrow }: { create: ShellCreate; narrow: boolean }): ReactNode {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<'closed' | 'open' | 'closing'>('closed');
  const [opening, setOpening] = useState(0);
  const open = (): void => {
    setOpening((count) => count + 1);
    setMenu('open');
  };
  const toggle = (): void => (menu === 'open' ? setMenu('closing') : open());
  useEffect(() => newMenuChannel.listen(() => open()), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const inTextField = event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(event.target.tagName));
      if (resolveKey({ ...keyFacts(event), composing: isImeEnter(event) }, { inTextField, inBinder: false, shell: 'modern' }) !== 'new-menu') return;
      event.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const chord = shortcutLabel('new-menu');
  return (
    <>
      <button
        ref={button}
        type="button"
        className="modern-capsule modern-new"
        title={t`New (${{ shortcut: chord }})`}
        aria-haspopup="menu"
        aria-expanded={menu === 'open'}
        aria-controls={menu === 'closed' ? undefined : 'modern-new-menu'}
        data-testid="new-menu"
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && menu !== 'open') {
            event.preventDefault();
            event.stopPropagation();
            open();
          }
        }}
      >
        <Icon name="plus" />
        <span className="modern-label">{t`New`}</span>
      </button>
      {menu === 'closed' ? null : (
        <GlassPopover
          key={opening}
          opener={button}
          prefer="below"
          align="end"
          className="modern-menu-popover"
          closing={menu === 'closing'}
          onDismiss={() => setMenu((state) => (state === 'open' ? 'closing' : state))}
          onClosed={() => setMenu('closed')}
          testId="modern-new-popover"
        >
          <NewMenu
            create={create}
            narrow={narrow}
            onChoose={(kind) => {
              setMenu('closing');
              create.make(kind);
            }}
            onClose={() => setMenu('closing')}
          />
        </GlassPopover>
      )}
    </>
  );
}

function NewMenu({
  create,
  narrow,
  onChoose,
  onClose,
}: {
  create: ShellCreate;
  narrow: boolean;
  onChoose: (kind: NewKind) => void;
  onClose: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const groups = newGroups(create.order);
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = list.indexOf(event.target as HTMLElement);
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = (at + 1) % list.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else if (event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    if (next === null || list.length === 0) return;
    event.preventDefault();
    list[next]?.focus();
  };
  const first = groups[0]?.entries[0]?.kind;
  return (
    <div ref={ref} id="modern-new-menu" role="menu" aria-label={t`New`} className="modern-menu modern-new-menu" onKeyDown={onKeyDown}>
      {groups.map((group, index) => (
        <div key={group.id} role="group" aria-labelledby={`modern-new-head-${group.id}`} className="modern-menu-section">
          {index === 0 ? null : <div role="separator" className="modern-menu-rule" />}
          <div id={`modern-new-head-${group.id}`} className="modern-menu-heading" role="presentation">
            {group.head}
          </div>
          {group.entries.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              role="menuitem"
              className="modern-menu-item modern-new-item"
              tabIndex={entry.kind === first ? 0 : -1}
              data-testid={entry.testId}
              onClick={() => onChoose(entry.kind)}
            >
              <span className="modern-new-text">
                <span className="modern-menu-label">{entry.label}</span>
                <span className="modern-new-detail">
                  {narrow && DESKTOP_VIEW_KINDS.includes(entry.kind) ? t`${{ detail: entry.detail }} · opens on desktop` : entry.detail}
                </span>
              </span>
            </button>
          ))}
        </div>
      ))}
      <p className="modern-new-target" data-testid="new-target">
        {create.target === null ? t`Goes into a new chapter` : t`Goes into ${{ chapter: create.target }}`}
      </p>
    </div>
  );
}
