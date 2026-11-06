/**
 * Modern's bottom ornament (modern-interface.md §6, §7.3, §8.1): a glass capsule centred on the page's bottom edge, a `nav` named
 * "Views and tools". It holds **Write**, **Board**, **Timeline**, **Codex** and **Pictures** as one radio group, always visible
 * (#475; Classic's ids `center-editor`, `center-corkboard`, `center-timeline`, `center-pictures`, and `center-codex`), with a glass
 * lens that slides to the chosen one, then **Ask** and **Search**. A hall may reorder the views (`viewOrder`, #482); none is dropped.
 * Below 1180 px the view labels give way to their icons and a tooltip.
 *
 * Keys (APG radio): Tab enters the group on the chosen view; the arrow keys, Home and End choose and move; Tab goes on to Ask and
 * Search.
 *
 * **Ask** opens and closes the agent's companion window (#309, companion-actions.ts): `id` {@link ASK_ID}, so Escape and **Close** give
 * focus back to it and Ctrl+J grows the window out of it; `aria-controls` the window, `aria-expanded` while it is open, and a dot
 * while the agent works or waits for an answer with the window closed (`data-activity`, §8.10). **Search** opens the palette (#310,
 * `openPalette` in requests.ts), as Ctrl+K (Cmd+K) does.
 */
/* lingui-set comment="Modern interface, the bottom ornament: the Write, Board, Timeline, Codex and Pictures views, Ask (the agent) and Search." */

import { t } from '@lingui/core/macro';
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import { shortcutLabel } from '../../../app/keymap.js';
import { keyStep } from '../ClassicShell.js';
import { ASK_ID, COMPANION_ID, askState, toggleCompanion } from './companion-actions.js';
import { GlassPopover } from './glass-popover.js';
import { Icon } from './icons.js';
import { BINDER_BUTTON_ID, DRAWER_ID } from './narrow-ids.js';
import { openPalette } from './requests.js';
import type { ModernSlotProps } from './slots.js';
import { viewName } from './top-ornament.js';
import type { ModernView } from './layout.js';
import { chooseView, modernViewOf, orderViews, viewControlId } from './views.js';

export function BottomOrnament({ regions, pageId }: ModernSlotProps): ReactNode {
  const { view } = regions;
  const chosen = modernViewOf(view.rail, view.center);
  const ordered = orderViews(regions.viewOrder);
  // On a phone (#480) the bar is Write · Binder · Views · Ask · Search: the other views are in the Views sheet.
  const shown: readonly ModernView[] = view.narrow ? ['write'] : ordered;
  const group = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLSpanElement>(null);

  // The lens follows the chosen radio: its place and width written through the CSSOM, the slide is a CSS transition (none under
  // reduced motion). Measured again when the group's size changes (another language, a narrower window).
  useLayoutEffect(() => {
    const root = group.current;
    const glass = lens.current;
    if (root === null || glass === null) return;
    const place = (): void => {
      const target = root.querySelector<HTMLElement>(`#${viewControlId(chosen)}`);
      if (target === null) {
        glass.dataset['shown'] = 'false';
        return;
      }
      glass.dataset['shown'] = 'true';
      // Physical, as offsetLeft is: the lens is placed from the group's left edge in either direction.
      glass.style.left = '0px';
      glass.style.transform = `translateX(${target.offsetLeft}px)`;
      glass.style.inlineSize = `${target.offsetWidth}px`;
    };
    place();
    // Slide only after the first placement, so the lens does not fly in when the ornament appears.
    const ready = requestAnimationFrame(() => (glass.dataset['ready'] = 'true'));
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(root);
    return () => {
      cancelAnimationFrame(ready);
      observer?.disconnect();
    };
  }, [chosen]);

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = keyStep(shown, chosen, event.key);
    if (next === null) return;
    event.preventDefault();
    chooseView(view, next);
    document.getElementById(viewControlId(next))?.focus();
  };

  const searchKey = shortcutLabel('palette');
  const askKey = shortcutLabel('agent-toggle');
  const ask = askState(view);
  // The sheet renders beside the ornament, not inside its glass: a `backdrop-filter` makes the ornament the containing block of
  // the fixed popover, so it would be placed from the ornament's edge (off screen in WebKit), as + New's was.
  const viewsMenu = useViewsMenu({ views: ordered.filter((name) => name !== 'write'), chosen, onChoose: (name) => chooseView(view, name) });
  return (
    <>
      <nav className="modern-ornament is-bottom mat-glass" aria-label={t`Views and tools`} data-testid="modern-bottom-ornament">
        <div ref={group} className="modern-views" role="radiogroup" aria-label={t`View`} onKeyDown={onKey}>
          <span ref={lens} className="modern-lens" aria-hidden="true" data-testid="modern-lens" />
          {shown.map((name) => {
            const checked = chosen === name;
            return (
              <button
                key={name}
                type="button"
                id={viewControlId(name)}
                role="radio"
                aria-checked={checked}
                aria-controls={pageId}
                tabIndex={checked ? 0 : -1}
                className="modern-capsule modern-view"
                title={viewName(name)}
                onClick={() => chooseView(view, name)}
              >
                <Icon name={name} />
                <span className="modern-label">{viewName(name)}</span>
              </button>
            );
          })}
        </div>
        {view.narrow ? (
          <>
            <button
              type="button"
              id={BINDER_BUTTON_ID}
              className="modern-capsule"
              aria-expanded={view.openPanel === 'rail'}
              aria-controls={DRAWER_ID}
              data-testid="modern-narrow-binder"
              onClick={() => view.setPanel(view.openPanel === 'rail' ? null : 'rail')}
            >
              <Icon name="binder" />
              <span className="modern-label">{t`Binder`}</span>
            </button>
            {viewsMenu.button}
          </>
        ) : null}
        <button
          type="button"
          id={ASK_ID}
          className="modern-capsule modern-ask"
          data-testid="modern-ask"
          title={t`Ask the agent (${{ shortcut: askKey }})`}
          aria-controls={COMPANION_ID}
          aria-expanded={ask.expanded}
          data-activity={ask.activity}
          onClick={(event) => toggleCompanion(view, event.currentTarget)}
        >
          <Icon name="ask" />
          <span className="modern-label">{t`Ask`}</span>
          {ask.activity === 'idle' || ask.expanded ? null : (
            <span className="modern-ask-dot" data-testid="modern-ask-activity">
              <span className="visually-hidden">{ask.activity === 'working' ? t`The agent is working` : t`The agent is waiting for you`}</span>
            </span>
          )}
        </button>
        <button
          type="button"
          className="modern-capsule"
          data-testid="modern-search"
          title={t`Search and commands (${{ shortcut: searchKey }})`}
          aria-haspopup="dialog"
          onClick={(event) => openPalette(event.currentTarget)}
        >
          <Icon name="search" />
          <span className="modern-label">{t`Search`}</span>
          <kbd className="modern-kbd" aria-hidden="true">
            {searchKey}
          </kbd>
        </button>
      </nav>
      {view.narrow ? viewsMenu.popover : null}
    </>
  );
}

/** The phone's **Views** tab (#480): named for the view on the page when it is not Write, and a sheet of the other views. */
function useViewsMenu({
  views,
  chosen,
  onChoose,
}: {
  views: readonly ModernView[];
  chosen: ModernView;
  onChoose: (view: ModernView) => void;
}): { button: ReactNode; popover: ReactNode } {
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<'closed' | 'open' | 'closing'>('closed');
  const on = views.includes(chosen);
  useLayoutEffect(() => {
    if (menu === 'open') list.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus();
  }, [menu]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const at = items.indexOf(event.target as HTMLElement);
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length : null;
    if (event.key === 'Tab') {
      event.preventDefault();
      setMenu('closing');
      return;
    }
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };
  return {
    button: (
      <button
        ref={button}
        type="button"
        className="modern-capsule"
        aria-haspopup="menu"
        aria-expanded={menu === 'open'}
        aria-pressed={on}
        data-testid="modern-narrow-views"
        onClick={() => setMenu(menu === 'open' ? 'closing' : 'open')}
      >
        <Icon name={on ? chosen : 'board'} />
        <span className="modern-label">{on ? viewName(chosen) : t`Views`}</span>
      </button>
    ),
    popover:
      menu === 'closed' ? null : (
        <GlassPopover
          opener={button}
          prefer="above"
          align="end"
          className="modern-menu-popover"
          closing={menu === 'closing'}
          onDismiss={() => setMenu((state) => (state === 'open' ? 'closing' : state))}
          onClosed={() => setMenu('closed')}
          testId="modern-views-popover"
        >
          <div ref={list} role="menu" aria-label={t`Views`} className="modern-menu" onKeyDown={onKeyDown}>
            {views.map((name, index) => (
              <button
                key={name}
                type="button"
                role="menuitemradio"
                aria-checked={chosen === name}
                tabIndex={index === 0 ? 0 : -1}
                className="modern-menu-item"
                data-testid={`modern-views-${name}`}
                onClick={() => {
                  setMenu('closing');
                  onChoose(name);
                }}
              >
                <span className="modern-menu-check" aria-hidden="true">
                  {chosen === name ? <Icon name="check" /> : null}
                </span>
                <span className="modern-menu-label">{name === 'board' ? t`${{ view: viewName(name) }} (desktop)` : viewName(name)}</span>
              </button>
            ))}
          </div>
        </GlassPopover>
      ),
  };
}
