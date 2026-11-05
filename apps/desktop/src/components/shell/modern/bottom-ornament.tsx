/**
 * Modern's bottom ornament (modern-interface.md §6, §7.3, §8.1): a glass capsule centred on the page's bottom edge, a `nav` named
 * "Views and tools". It holds **Write**, **Board** and **Codex** as one radio group (Classic's ids, `center-editor` and
 * `center-corkboard`, and `center-codex`) with a glass lens that slides to the chosen one, then **Ask** and **Search**.
 *
 * Keys (APG radio): Tab enters the group on the chosen view; the arrow keys, Home and End choose and move; Tab goes on to Ask and
 * Search. When the page shows the timeline or the pictures (chosen in **⋯**), the group shows that view too, as a fourth radio, checked,
 * so the ornament always says which view is on (Stageshow polish, #361); it goes when another view is chosen.
 *
 * **Ask** opens and closes the agent's companion window (#309, companion-actions.ts): `id` {@link ASK_ID}, so Escape and **Close** give
 * focus back to it and Ctrl+J grows the window out of it; `aria-controls` the window, `aria-expanded` while it is open, and a dot
 * while the agent works or waits for an answer with the window closed (`data-activity`, §8.10). **Search** opens the palette (#310,
 * `openPalette` in requests.ts), as Ctrl+K (Cmd+K) does.
 */
/* lingui-set comment="Modern interface, the bottom ornament: the Write, Board and Codex views, Ask (the agent) and Search." */

import { t } from '@lingui/core/macro';
import { useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import { shortcutLabel } from '../../../app/keymap.js';
import { keyStep } from '../ClassicShell.js';
import { ASK_ID, COMPANION_ID, askState, toggleCompanion } from './companion-actions.js';
import { Icon } from './icons.js';
import { openPalette } from './requests.js';
import type { ModernSlotProps } from './slots.js';
import { viewName } from './top-ornament.js';
import type { ModernView } from './layout.js';
import { ORNAMENT_VIEWS, chooseView, modernViewOf, viewControlId } from './views.js';

export function BottomOrnament({ regions, pageId }: ModernSlotProps): ReactNode {
  const { view } = regions;
  const chosen = modernViewOf(view.rail, view.center);
  const shown: readonly ModernView[] = (ORNAMENT_VIEWS as readonly string[]).includes(chosen) ? ORNAMENT_VIEWS : [...ORNAMENT_VIEWS, chosen];
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
  return (
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
              onClick={() => chooseView(view, name)}
            >
              <Icon name={name} />
              <span className="modern-label">{viewName(name)}</span>
            </button>
          );
        })}
      </div>
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
  );
}
