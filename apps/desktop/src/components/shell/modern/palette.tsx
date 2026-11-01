/**
 * Modern's palette — modern-interface.md §8.9, §8.11, §9.1, §9.2. **Search** (#306, through `openPalette` in requests.ts) and
 * Ctrl+K (Cmd+K) open a modal dialog of thick glass named "Search and commands": a combobox over a grouped listbox, the APG
 * combobox pattern with `aria-activedescendant`, so focus stays in the field while the arrow keys move the active option.
 *
 * - The dialog is a native `<dialog>` opened with `showModal()`, so the rest of the page is inert while it is open, and focus goes
 *   back to what opened it when it closes (the opener given, or the element focused before).
 * - Down and Up move (and wrap), PageDown and PageUp jump between groups, Enter runs the active option, Escape closes. An Enter or an
 *   Escape that belongs to an input method's composition is the input method's (`isImeEnter`, i18n §7.3), and a composing Ctrl+K
 *   opens nothing (`resolveKey`'s `composing` fact).
 * - With no match, the one option asks the agent: Enter opens it with the text in the Intent box, **unsent**.
 *
 * What is listed is app/palette-model.ts; what an option does is a handler `Workspace` already has (regions, `ShellSearch`), or a
 * request to the slot that owns the place (requests.ts), falling back to the handler while that slot is not built.
 */
/* lingui-set comment="Modern interface: the search and commands palette (Ctrl+K)." */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import './palette.css';

import { applyInterface, rememberInterface } from '../../../app/interface.js';
import { isImeEnter, keyFacts, keyboardLayoutStore, resolveKey, shortcutLabel } from '../../../app/keymap.js';
import {
  paletteResults,
  stepActive,
  type PaletteItem,
  type PaletteSettingsSection,
  type PaletteTarget,
} from '../../../app/palette-model.js';
import type { SettingsSection } from '../../Settings.js';
import type { ShellRegions } from '../regions.js';
import { paletteChannel, sceneInfoChannel, sidebarChannel, viewChannel } from './requests.js';
import type { ModernSlotProps } from './slots.js';

// Every Settings section is in the palette: a section added to the dialog and not to the model fails to compile here.
type MissingSection = Exclude<SettingsSection, PaletteSettingsSection>;
const EVERY_SECTION: [MissingSection] extends [never] ? true : never = true;
void EVERY_SECTION;

const LIST_ID = 'modern-palette-list';
const optionId = (item: PaletteItem): string => `modern-palette-${item.id}`;

/** The palette slot: listens for Ctrl+K and for **Search**, and shows the dialog while it is open. */
export function Palette({ regions }: ModernSlotProps): ReactNode {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(
    () =>
      paletteChannel.listen((request) => {
        const active = document.activeElement;
        opener.current = request.opener ?? (active instanceof HTMLElement && active !== document.body ? active : null);
        setOpen(true);
      }),
    [],
  );

  // Ctrl+K (Cmd+K), resolved by the keymap with the Modern shell (§8.11). Captured on the window, so a field that keeps its own keys
  // still lets it through; it opens while typing, and never while an input method composes or another modal dialog is up.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const inTextField =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      const action = resolveKey({ ...keyFacts(event), composing: isImeEnter(event) }, { inTextField, inBinder: false, shell: 'modern' });
      if (action !== 'palette') return;
      const modal = document.querySelector('dialog:modal');
      if (modal !== null && !modal.classList.contains('modern-palette')) return;
      event.preventDefault();
      event.stopPropagation();
      if (modal !== null) {
        modal.querySelector<HTMLInputElement>('input')?.select();
        return;
      }
      paletteChannel.send({});
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!open) return null;
  return (
    <PaletteDialog
      regions={regions}
      onClose={() => {
        setOpen(false);
        const back = opener.current;
        opener.current = null;
        if (back !== null && back.isConnected) back.focus();
      }}
    />
  );
}

function PaletteDialog({ regions, onClose }: { regions: ShellRegions; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const keyboardLayout = useSyncExternalStore(keyboardLayoutStore.subscribe, keyboardLayoutStore.snapshot);

  const { search, actions } = regions;
  const results = useMemo(
    () => paletteResults(query, { state: search.state, actions, activeDocId: search.activeDocId }),
    [query, search.state, search.activeDocId, actions],
  );
  const current = results.items[Math.min(active, results.items.length - 1)];

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    input.current?.focus();
    return () => {
      if (dialog?.open === true) dialog.close();
    };
  }, []);

  // The active option stays in view as the arrow keys move it.
  useEffect(() => {
    if (current === undefined) return;
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const close = (): void => {
    ref.current?.close();
    onClose();
  };

  const run = (item: PaletteItem | undefined): void => {
    if (item === undefined || item.disabled === true) return;
    close();
    runTarget(item.target, regions);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (isImeEnter(event)) return;
    if (event.key === 'Enter') {
      if (isImeEnter(event) || composing.current) return;
      event.preventDefault();
      run(current);
      return;
    }
    const next = stepActive(results, active, event.key);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <dialog
      ref={ref}
      className="modern-palette mat-thick"
      aria-label={t`Search and commands`}
      data-testid="modern-palette"
      onCancel={(event) => {
        event.preventDefault();
        // The Escape that cancels a candidate window is the input method's, not the palette's.
        if (composing.current) return;
        close();
      }}
      onClick={(event) => {
        // A click on the backdrop (the dialog element itself, outside its frame) closes it.
        if (event.target === ref.current) close();
      }}
    >
      <div className="modern-palette-frame">
        <div className="modern-palette-field mat-scrim">
          <span className="modern-palette-glass" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label={t`Search scenes, codex and commands`}
            aria-expanded={results.items.length > 0}
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={current === undefined ? undefined : optionId(current)}
            autoComplete="off"
            spellCheck={false}
            placeholder={t`Search scenes, codex and commands`}
            data-testid="modern-palette-input"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className="modern-palette-kbd" aria-hidden="true">
            {t({ message: 'Esc', context: 'keyboard key' })}
          </kbd>
        </div>
        <div ref={list} id={LIST_ID} role="listbox" aria-label={t`Results`} className="modern-palette-list">
          {results.groups.map((group) => (
            <div key={group.id} role="group" aria-labelledby={`modern-palette-group-${group.id}`} className="modern-palette-group">
              <div role="presentation" id={`modern-palette-group-${group.id}`} className="modern-palette-heading">
                {group.label}
              </div>
              {group.items.map((item) => (
                <div
                  key={item.id}
                  id={optionId(item)}
                  role="option"
                  aria-selected={item === current}
                  aria-disabled={item.disabled === true ? true : undefined}
                  className="modern-palette-option"
                  data-icon={item.icon}
                  // The field keeps focus: a press on an option does not take it, and the click runs it.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    const at = results.items.indexOf(item);
                    if (at !== active) setActive(at);
                  }}
                  onClick={() => run(item)}
                >
                  <span className="modern-palette-icon" aria-hidden="true">
                    {ICONS[item.icon]}
                  </span>
                  <span className="modern-palette-words">
                    <span className="modern-palette-label">{item.label}</span>
                    {item.detail === undefined ? null : <span className="modern-palette-detail">{item.detail}</span>}
                  </span>
                  {item.shortcut === undefined ? null : (
                    <kbd className="modern-palette-kbd">{shortcutLabel(item.shortcut, keyboardLayout)}</kbd>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        <p className="modern-palette-hint" role="status">
          {results.noMatch ? (
            <Trans>Nothing found. Enter opens the agent with your words, unsent.</Trans>
          ) : (
            <Trans>Up and Down move, Enter opens, Esc closes.</Trans>
          )}
        </p>
      </div>
    </dialog>
  );
}

/** Decorative glyphs; every option is named by its words. */
const ICONS: Readonly<Record<PaletteItem['icon'], string>> = {
  scene: '¶',
  folder: '▤',
  codex: '◈',
  command: '›',
  view: '▭',
  tab: '☰',
  info: 'ⓘ',
  agent: '✦',
  settings: '⚙',
  interface: '⇄',
};

/** Runs what an option names, through the handler `Workspace` has for it, or the slot that owns the place. */
function runTarget(target: PaletteTarget, regions: ShellRegions): void {
  const { search, view, actions } = regions;
  switch (target.kind) {
    case 'node':
      search.openNode(target.nodeId);
      return;
    case 'codex':
      viewChannel.send({ view: 'codex' });
      search.openCodexEntry(target.entryId);
      return;
    case 'action':
      actions.find((action) => action.id === target.actionId)?.run();
      return;
    case 'view':
      if (viewChannel.send({ view: target.view })) return;
      if (target.view === 'codex') search.showCodex();
      else view.setCenter(target.view);
      return;
    case 'tab':
      if (sidebarChannel.send({ tab: target.tab })) return;
      view.setRail(target.tab);
      if (view.narrow) view.setPanel('rail');
      return;
    case 'scene-info':
      if (!sceneInfoChannel.send({})) search.openSceneInfo();
      return;
    case 'agent':
      search.openAgent(null);
      return;
    case 'ask':
      search.openAgent(target.text);
      return;
    case 'settings':
      search.openSettings(target.section);
      return;
    case 'classic':
      void applyInterface('classic').catch(() => undefined);
      rememberInterface('classic');
      return;
  }
}
