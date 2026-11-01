/**
 * The Classic shell — ui-modules §1, modern-interface.md §4.1 and §14. A toolbar on top; a left rail with the binder, codex,
 * activity, trace and findings tabs; the centre (the Editor / Corkboard switch, the storage banner, the editor or a media view, the
 * agent drawer); the inspector on the right; the status line. In the narrow layout the rail is a drawer, the inspector a bottom
 * sheet, and the toolbar's actions are in the More menu.
 *
 * It arranges the regions `Workspace` built and renders the toolbar and the More menu from the shell actions; the state, the
 * handlers and the dialogs stay in `Workspace`, which passes the dialogs as children so they sit where they always have.
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { togglePanel } from '../../app/narrow-model.js';
import { classicMenu, classicToolbarSlot, type ShellAction } from '../../app/shell-actions.js';
import type { CenterMode } from '../Binder.js';
import { OpenOnDesktop } from '../narrow.js';
import { Menu } from '../shared.js';
import type { RailTab, ShellRegions } from './regions.js';

/** The rail's tabs in the order the arrow keys walk them (WAI-ARIA tabs). */
const RAIL_TABS: readonly RailTab[] = ['binder', 'codex', 'activity', 'trace', 'findings'];
/** The centre views, in the order the arrow keys walk the radio group. */
const CENTER_VIEWS: readonly CenterMode[] = ['editor', 'corkboard'];

/** The id of a rail tab, which its tabpanel names itself by (`aria-labelledby`). */
export function railTabId(tab: RailTab): string {
  return `rail-tab-${tab}`;
}

/**
 * The item an arrow, Home or End key moves to from `current`, or `null` for any other key. Arrows wrap at both ends, as the
 * WAI-ARIA tab and radio patterns have them, and Home and End go to the first and last item.
 */
function keyStep<T>(items: readonly T[], current: T, key: string): T | null {
  const at = items.indexOf(current);
  if (at === -1) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return items[(at + 1) % items.length] ?? null;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return items[(at - 1 + items.length) % items.length] ?? null;
  if (key === 'Home') return items[0] ?? null;
  if (key === 'End') return items[items.length - 1] ?? null;
  return null;
}

export function ClassicShell({ regions, children }: { regions: ShellRegions; children?: ReactNode }): ReactNode {
  const { view, actions } = regions;
  const { rail, setRail, center, setCenter, hideRails, narrow, openPanel, setPanel, overflow } = view;

  const onPanelKey = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    setPanel(null);
  };

  // The rail's tabs and the centre's radio group: arrows (and Home and End) move the selection and its focus together.
  const onRailTabKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = keyStep(RAIL_TABS, rail, event.key);
    if (next === null) return;
    event.preventDefault();
    setRail(next);
    document.getElementById(railTabId(next))?.focus();
  };
  const onCenterKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = keyStep(CENTER_VIEWS, center, event.key);
    if (next === null) return;
    event.preventDefault();
    setCenter(next);
    document.getElementById(`center-${next}`)?.focus();
  };

  const [details] = classicToolbarSlot(actions, 'title');

  return (
    <div className={`workspace${hideRails ? ' is-focus' : ''}`}>
      <header className="toolbar" inert={openPanel !== null}>
        <div className="toolbar-start">
          {narrow ? (
            hideRails ? null : (
              <button
                type="button"
                id="narrow-toggle-rail"
                className="button"
                aria-expanded={openPanel === 'rail'}
                aria-controls="narrow-rail"
                onClick={() => setPanel(togglePanel(openPanel, 'rail'))}
              >
                Binder
              </button>
            )
          ) : (
            classicToolbarSlot(actions, 'start').map((action) => <ToolbarButton key={action.id} action={action} quiet />)
          )}
          {narrow ? (
            // The save state sits under the name: a toolbar of three buttons has no room for a sentence beside them.
            <div className="toolbar-title">
              <h1 className="project-name">{regions.projectName}</h1>
              {regions.saveState}
            </div>
          ) : details === undefined ? (
            <h1 className="project-name">{regions.projectName}</h1>
          ) : (
            <h1 className="project-name">
              {/* The name opens the project panel, where the title, author, language, ISBN and cover are set. */}
              <button type="button" className="project-name-button" title={details.hint} onClick={details.run}>
                {regions.projectName}
              </button>
            </h1>
          )}
        </div>
        {narrow ? (
          // Narrow: the rail and the inspector open from here, and every other control is in the overflow menu (ui-modules §1).
          <div className="toolbar-end">
            {hideRails ? null : (
              <button
                type="button"
                id="narrow-toggle-inspector"
                className="button"
                aria-expanded={openPanel === 'inspector'}
                aria-controls="narrow-sheet"
                onClick={() => setPanel(togglePanel(openPanel, 'inspector'))}
              >
                Inspector
              </button>
            )}
            <button type="button" className="button" aria-haspopup="menu" aria-expanded={overflow !== null} onClick={view.openOverflow}>
              More
            </button>
          </div>
        ) : (
          <div className="toolbar-end">
            {classicToolbarSlot(actions, 'end').map((action) => (
              <ToolbarButton key={action.id} action={action} />
            ))}
            {regions.saveState}
          </div>
        )}
      </header>

      {hideRails ? null : (
        <nav
          id="narrow-rail"
          className={`rail${narrow ? ' is-drawer' : ''}${openPanel === 'rail' ? ' is-open' : ''}`}
          aria-label="Project panels"
          onKeyDown={narrow ? onPanelKey : undefined}
        >
          {narrow ? (
            <div className="panel-head">
              <span className="panel-title">Project panels</span>
              <button type="button" className="button" aria-label="Close panels" onClick={() => setPanel(null)}>
                Close
              </button>
            </div>
          ) : null}
          <div role="tablist" aria-label="Panels" className="rail-tabs" onKeyDown={onRailTabKey}>
            <RailTabButton tab="binder" current={rail} label="Binder" onSelect={setRail} />
            <RailTabButton tab="codex" current={rail} label="Codex" onSelect={setRail} />
            <RailTabButton tab="activity" current={rail} label="Activity" onSelect={setRail} />
            <RailTabButton tab="trace" current={rail} label="Trace" onSelect={setRail} />
            <RailTabButton tab="findings" current={rail} label="Findings" badge={regions.findingsBadge} onSelect={setRail} />
          </div>
          <div role="tabpanel" id="rail-panel" aria-labelledby={railTabId(rail)} className="rail-panel">
            {rail === 'binder'
              ? regions.binder
              : rail === 'codex'
                ? regions.codex
                : rail === 'findings'
                  ? regions.findings
                  : rail === 'trace'
                    ? regions.trace
                    : regions.activity}
          </div>
        </nav>
      )}

      <main className="center" inert={openPanel !== null}>
        <div role="radiogroup" aria-label="Centre view" className="center-switch" onKeyDown={onCenterKey}>
          <button
            type="button"
            id="center-editor"
            role="radio"
            aria-checked={center === 'editor'}
            tabIndex={center === 'editor' ? 0 : -1}
            className="segmented-item"
            onClick={() => setCenter('editor')}
          >
            Editor
          </button>
          <button
            type="button"
            id="center-corkboard"
            role="radio"
            aria-checked={center === 'corkboard'}
            tabIndex={center === 'corkboard' ? 0 : -1}
            className="segmented-item"
            onClick={() => setCenter('corkboard')}
          >
            Corkboard
          </button>
        </div>
        {regions.storageBanner}
        {regions.media}
        {/* Kept mounted while the corkboard is shown, so the editor keeps its undo history and its place. */}
        {regions.editor}
        {center === 'corkboard' && regions.media === null && narrow ? (
          <OpenOnDesktop
            feature="corkboard"
            actions={
              <button type="button" className="button" onClick={() => setCenter('editor')}>
                Back to the editor
              </button>
            }
          />
        ) : null}
        {center === 'corkboard' && regions.media === null && !narrow ? regions.corkboard : null}
        {hideRails ? null : regions.agent}
      </main>

      {hideRails ? null : narrow ? (
        <div id="narrow-sheet" className={`sheet${openPanel === 'inspector' ? ' is-open' : ''}`} onKeyDown={onPanelKey}>
          <div className="panel-head">
            <span className="panel-title">Inspector</span>
            <button type="button" id="narrow-close-inspector" className="button" aria-label="Close inspector" onClick={() => setPanel(null)}>
              Close
            </button>
          </div>
          {regions.inspector}
        </div>
      ) : (
        regions.inspector
      )}
      {openPanel === null ? null : <div className="scrim" data-testid="panel-scrim" aria-hidden="true" onClick={() => setPanel(null)} />}
      {overflow === null ? null : <Menu label="More" anchor={overflow} items={classicMenu(actions)} onClose={view.closeOverflow} />}

      {regions.status}

      {children}
    </div>
  );
}

/**
 * One shell action as a Classic toolbar button: its toolbar words, its hint as the title, and its pressed state when it is a toggle.
 * Projects is the quiet button at the start; the rest sit at the end.
 */
function ToolbarButton({ action, quiet = false }: { action: ShellAction; quiet?: boolean }): ReactNode {
  return (
    <button
      type="button"
      className={quiet ? 'button is-quiet' : 'button'}
      disabled={action.disabled}
      aria-pressed={action.pressed}
      aria-label={action.ariaLabel}
      title={action.hint}
      onClick={action.run}
    >
      {action.toolbarLabel ?? action.label}
    </button>
  );
}

/**
 * One rail tab. Roving tabindex: the selected tab is the one Tab reaches, and the arrow keys (handled by the tab list) move
 * between the rest. The tabpanel names itself by this tab's id.
 */
function RailTabButton({
  tab,
  current,
  label,
  badge = 0,
  onSelect,
}: {
  tab: RailTab;
  current: RailTab;
  label: string;
  /** A count the tab shows beside its name (the open findings). Zero shows nothing. */
  badge?: number;
  onSelect: (tab: RailTab) => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      id={railTabId(tab)}
      aria-selected={current === tab}
      aria-controls="rail-panel"
      tabIndex={current === tab ? 0 : -1}
      className={`rail-tab${current === tab ? ' is-current' : ''}`}
      onClick={() => onSelect(tab)}
    >
      {label}
      {badge > 0 ? (
        <span className="rail-badge" aria-label={`${badge} open`} data-testid={`${tab}-badge`}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}
