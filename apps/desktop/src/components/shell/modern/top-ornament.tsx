/**
 * Modern's top ornament (modern-interface.md §6, §7.1, §8.1, §8.2): a glass capsule centred on the page's top edge, a toolbar named
 * "Scene". It holds the **title capsule** (the project's name, the view when it is not Write, and a dot while a finding is open),
 * **+ New** (new-menu.tsx, #477; the surface's one primary) and **⋯**, the menu of every shell action (app/shell-actions.ts) with
 * **Appearance** inside. The views live in the bottom ornament (#475); ⋯'s View section only points there for one release. The save state
 * sits beside the title (Scene info's Progress repeats it), so a failed save's **Export a backup** is never out of reach until the
 * notices (#311) show it as a persistent toast.
 *
 * Keys: Tab enters the toolbar on its current control and leaves it; the arrow keys, Home and End move inside it (APG toolbar). In
 * the menu, the arrow keys, Home and End move, Enter or Space chooses, Escape or Tab closes, and focus returns to **⋯**.
 *
 * The title capsule is Scene info's opener (#308, `useSceneInfoOpener` in scene-info-store.ts): a click toggles the popover, which
 * anchors under the capsule, grows out of it and gives focus back to it on Escape. Project details stays in **⋯**.
 *
 * On the Board (the corkboard, §7.3) the card size, S/M/L, sits before **⋯**: the corkboard's own `ZoomControl` on the same state
 * (`view.zoom`), drawn as the ornament's capsules, so the page's copy is hidden in Modern. It is one stop of the toolbar, on its checked size; the arrow keys inside it
 * change the size, as the radio pattern has them.
 */
/* lingui-set comment="Modern interface, the top ornament: the project's title capsule and the More (⋯) menu." */

import { plural, t } from '@lingui/core/macro';
import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { applyInterface, rememberInterface } from '../../../app/interface.js';
import { shortcutLabel } from '../../../app/keymap.js';
import { readModernPreferences, setModernPreference } from '../../../app/modern-preferences.js';
import { CLASSIC_MENU_SECTIONS, type ShellAction, type ShellActionGroup } from '../../../app/shell-actions.js';
import { activeTheme } from '../../../app/theme.js';
import { inlineKey } from '../../../i18n/direction.js';
import { ZoomControl } from '../../ZoomControl.js';
import { DocumentModeOutlet } from '../../DocumentModes.js';
import { GlassPopover } from './glass-popover.js';
import { Icon } from './icons.js';
import type { ModernSlotProps } from './slots.js';
import { useSceneInfoOpener } from './scene-info-store.js';
import { useNewMenu } from './new-menu.js';
import { modernViewOf } from './views.js';
import type { ModernView } from './layout.js';

const VIEW_NAMES: Readonly<Record<ModernView, () => string>> = {
  write: () => t`Write`,
  board: () => t`Board`,
  codex: () => t`Codex`,
  timeline: () => t`Timeline`,
  pictures: () => t`Pictures`,
};

const DOCUMENT_ICONS = { scene: 'scene', screenplay: 'screenplay', dialogue: 'ask', storyboard: 'board', 'comic-page': 'comic' } as const;

/** A view's visible name, for the title capsule's breadcrumb and **⋯**. */
export function viewName(view: ModernView): string {
  return VIEW_NAMES[view]();
}

/** The focusable controls of a toolbar, in order. A radio group counts once, on its checked radio. */
function toolbarControls(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(toolbar.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea')).filter(
    (node) =>
      !node.hasAttribute('disabled') &&
      node.closest('[inert]') === null &&
      !(node.getAttribute('role') === 'radio' && node.getAttribute('aria-checked') !== 'true'),
  );
}

/**
 * The APG toolbar's roving tab stop over every control in `ref`, including ones another component draws there (the save state's
 * **Export a backup**): one is in the tab order (the one last used), the arrow keys, Home and End move between them.
 */
export function useRovingToolbar(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (toolbar === null) return;
    let current = 0;
    const settle = (controls: readonly HTMLElement[], at: number): void => {
      current = at;
      controls.forEach((control, index) => (control.tabIndex = index === at ? 0 : -1));
    };
    const refresh = (): void => {
      const controls = toolbarControls(toolbar);
      const focused = controls.indexOf(document.activeElement as HTMLElement);
      settle(controls, focused === -1 ? Math.max(0, Math.min(current, controls.length - 1)) : focused);
    };
    const onFocus = (): void => refresh();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !(event.target instanceof HTMLElement) || event.target.closest('[role="radiogroup"]') !== null) return;
      const controls = toolbarControls(toolbar);
      const at = controls.indexOf(event.target as HTMLElement);
      if (at === -1) return;
      const key = inlineKey(event.key);
      let next: number | null = null;
      if (key === 'ArrowRight') next = (at + 1) % controls.length;
      else if (key === 'ArrowLeft') next = (at - 1 + controls.length) % controls.length;
      else if (key === 'Home') next = 0;
      else if (key === 'End') next = controls.length - 1;
      if (next === null) return;
      event.preventDefault();
      settle(controls, next);
      controls[next]?.focus();
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-checked', 'disabled', 'hidden'] });
    toolbar.addEventListener('focusin', onFocus);
    toolbar.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      toolbar.removeEventListener('focusin', onFocus);
      toolbar.removeEventListener('keydown', onKeyDown);
    };
  }, [ref]);
}

export function TopOrnament({ regions }: ModernSlotProps): ReactNode {
  const { actions, view } = regions;
  const toolbar = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<'closed' | 'open' | 'closing'>('closed');
  useRovingToolbar(toolbar);
  const sceneInfo = useSceneInfoOpener();
  const current = modernViewOf(view.rail, view.center);
  const findings = regions.findingsBadge;
  // The corkboard is on the page (not a storyboard's shot board, which has its own size, nor the narrow "Open on desktop").
  const boardZoom = current === 'board' && regions.media === null && !view.narrow;
  const newMenu = useNewMenu({ create: regions.create, narrow: view.narrow });

  // Each opening is a fresh popover (its key), so ⋯ pressed while the last one is still shrinking opens a new one at once.
  const [opening, setOpening] = useState(0);
  const toggle = (): void => {
    if (menu === 'open') {
      setMenu('closing');
      return;
    }
    setOpening((count) => count + 1);
    setMenu('open');
  };

  return (
    <>
      <div
        ref={toolbar}
        className="modern-ornament is-top mat-glass"
        role="toolbar"
        aria-label={t`Scene`}
        data-testid="modern-top-ornament"
      >
        <button
          {...sceneInfo.buttonProps}
          type="button"
          className="modern-capsule modern-title"
          data-testid="modern-title-capsule"
          title={t`Scene info`}
        >
          {regions.documentKind === undefined || regions.documentKind === null ? null : (
            <span data-document-kind={regions.documentKind}>
              <Icon name={DOCUMENT_ICONS[regions.documentKind]} />
            </span>
          )}
          <span className="modern-title-name">{regions.projectName}</span>
          {current === 'write' ? null : (
            <span className="modern-title-crumb">
              <span aria-hidden="true">›</span> {viewName(current)}
            </span>
          )}
          {findings > 0 ? (
            <span className="modern-title-dot" data-testid="modern-title-dot">
              <span className="visually-hidden">{plural(findings, { one: '# open finding', other: '# open findings' })}</span>
            </span>
          ) : null}
        </button>
        <DocumentModeOutlet />
        <span className="modern-ornament-state">{regions.saveState}</span>
        {boardZoom ? <ZoomControl zoom={view.zoom} onZoom={view.setZoom} className="modern-zoom" itemClassName="modern-capsule" /> : null}
        {newMenu.button}
        <button
          ref={more}
          type="button"
          className="modern-capsule is-icon"
          aria-label={t`More`}
          title={t`More`}
          aria-haspopup="menu"
          aria-expanded={menu === 'open'}
          aria-controls={menu === 'closed' ? undefined : 'modern-more-menu'}
          data-testid="modern-more"
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && menu !== 'open') {
              event.preventDefault();
              event.stopPropagation();
              toggle();
            }
          }}
        >
          <Icon name="more" />
        </button>
      </div>
      {newMenu.popover}
      {menu === 'closed' ? null : (
        <GlassPopover
          key={opening}
          opener={more}
          prefer="below"
          align="end"
          className="modern-menu-popover"
          closing={menu === 'closing'}
          onDismiss={() => setMenu((state) => (state === 'open' ? 'closing' : state))}
          onClosed={() => setMenu('closed')}
          testId="modern-more-popover"
        >
          <MoreMenu actions={actions} onClose={() => setMenu('closing')} />
        </GlassPopover>
      )}
    </>
  );
}

interface Entry {
  readonly key: string;
  readonly role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
  readonly label: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly chord?: string;
  readonly testId?: string;
  readonly run: () => void;
}

/** A group of the menu, under its subhead when it has more than one kind of thing to say (Settings stands alone). */
interface Section {
  readonly head?: string;
  readonly entries: Entry[];
}

/** The menu's sections: the shell actions as Classic's More menu groups them, each under its subhead (#358). */
function actionSections(actions: readonly ShellAction[]): Section[] {
  const sectionOf = (group: ShellActionGroup): number => CLASSIC_MENU_SECTIONS.findIndex((groups) => groups.includes(group));
  const heads = [t`Project`, t`Agent`, t`Export`];
  const sections: Entry[][] = CLASSIC_MENU_SECTIONS.map(() => []);
  for (const action of actions) {
    if (action.id === 'theme') continue; // Appearance's Light and Dark.
    sections[sectionOf(action.group)]?.push({
      key: action.id,
      role: 'menuitem',
      label: action.label,
      ...(action.disabled ? { disabled: true } : {}),
      ...(action.hint === undefined ? {} : { title: action.hint }),
      ...(action.shortcut === undefined ? {} : { chord: shortcutLabel(action.shortcut) }),
      ...(action.testId === undefined ? {} : { testId: `modern-${action.testId}` }),
      run: action.run,
    });
  }
  return sections.flatMap((entries, at) => (entries.length > 0 ? [{ head: heads[at], entries }] : []));
}

function MoreMenu({ actions, onClose }: { actions: readonly ShellAction[]; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const theme = actions.find((action) => action.id === 'theme');
  const dark = activeTheme() === 'dark';
  const solid = readModernPreferences().reduceTransparency;

  const sections = actionSections(actions);
  // The views moved to the bottom ornament (#475). For one release the View section only says so (docs/decisions.md 2026-11-06).
  const views: Entry[] = [{ key: 'view-moved', role: 'menuitem', label: t`Views are in the bar below`, disabled: true, run: () => undefined }];
  // The pointer goes before the app's own section (Settings).
  sections.splice(Math.max(0, sections.length - 1), 0, { head: t`View`, entries: views });
  const appearance: Entry[] = [
    { key: 'light', role: 'menuitemradio', label: t`Light`, checked: !dark, run: () => (dark ? theme?.run() : undefined) },
    { key: 'dark', role: 'menuitemradio', label: t`Dark`, checked: dark, run: () => (dark ? undefined : theme?.run()) },
    {
      key: 'transparency',
      role: 'menuitemcheckbox',
      label: t`Reduce transparency`,
      checked: solid,
      run: () => void setModernPreference('reduceTransparency', !solid),
    },
    {
      key: 'classic',
      role: 'menuitem',
      label: t`Use the Classic interface`,
      run: () => {
        rememberInterface('classic');
        void applyInterface('classic').catch(() => undefined);
      },
    },
  ];

  useLayoutEffect(() => {
    // Focus moves in as the menu opens (the morph does not wait), to its first item that can be chosen.
    items(ref.current)[0]?.focus();
  }, []);

  const choose = (entry: Entry): void => {
    onClose();
    entry.run();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const list = items(ref.current);
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

  // A roving tab stop on the first item that can be chosen, so the menu, which can scroll, is reachable by keyboard (axe).
  const first = sections.flatMap(({ entries }) => entries).find((entry) => entry.disabled !== true)?.key;
  const render = (entry: Entry): ReactNode => (
    <button
      key={entry.key}
      type="button"
      role={entry.role}
      className="modern-menu-item"
      tabIndex={entry.key === first ? 0 : -1}
      disabled={entry.disabled}
      aria-checked={entry.role === 'menuitem' ? undefined : entry.checked === true}
      title={entry.title}
      data-testid={entry.testId}
      onClick={() => choose(entry)}
    >
      <span className="modern-menu-check" aria-hidden="true">
        {entry.checked === true ? <Icon name="check" /> : null}
      </span>
      <span className="modern-menu-label">{entry.label}</span>
      {entry.chord === undefined ? null : (
        <span className="modern-menu-chord" aria-hidden="true">
          {entry.chord}
        </span>
      )}
    </button>
  );

  sections.push({ head: t`Appearance`, entries: appearance });

  return (
    <div ref={ref} id="modern-more-menu" role="menu" aria-label={t`More`} className="modern-menu" onKeyDown={onKeyDown}>
      {sections.map(({ head, entries }, index) => (
        <div key={entries[0]?.key ?? index} role="group" aria-labelledby={head === undefined ? undefined : `modern-menu-head-${index}`} className="modern-menu-section">
          {index === 0 ? null : <div role="separator" className="modern-menu-rule" />}
          {head === undefined ? null : (
            <div id={`modern-menu-head-${index}`} className="modern-menu-heading" role="presentation">
              {head}
            </div>
          )}
          {entries.map(render)}
        </div>
      ))}
    </div>
  );
}

function items(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter((node) => !node.hasAttribute('disabled'));
}
