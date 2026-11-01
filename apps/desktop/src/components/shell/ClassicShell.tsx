/**
 * The Classic shell — ui-modules §1, modern-interface.md §4.1 and §14. A toolbar on top; a left rail with the binder, codex,
 * activity, trace and findings tabs; the centre (the Editor / Corkboard switch, the storage banner, the editor or a media view, the
 * agent drawer); the inspector on the right; the status line. In the narrow layout the rail is a drawer, the inspector a bottom
 * sheet, and the toolbar's actions are in the More menu.
 *
 * It arranges the regions `Workspace` built and renders the toolbar and the More menu from the shell actions; the state, the
 * handlers and the dialogs stay in `Workspace`. The workspace element itself is the frame `Shell` draws (Shell.tsx), with the
 * dialogs as its last children, where they always were; the frame is shared with Modern, so a switch keeps the dialogs mounted.
 */
/* lingui-set comment="The workspace shell: its toolbar, panels and centre views. count is a number of open findings." */

import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { togglePanel } from '../../app/narrow-model.js';
import { classicMenu, classicToolbarSlot, type ShellAction } from '../../app/shell-actions.js';
import { inlineKey } from '../../i18n/direction.js';
import type { CenterMode } from '../Binder.js';
import { LazyBoundary } from '../lazy-view.js';
import { OpenOnDesktop } from '../narrow.js';
import { Menu } from '../shared.js';
import type { RailTab, ShellRegions } from './regions.js';

/** The rail's tabs in the order the arrow keys walk them (WAI-ARIA tabs). */
export const RAIL_TABS: readonly RailTab[] = ['binder', 'codex', 'activity', 'trace', 'findings'];
/** The centre views, in the order the arrow keys walk the radio group. */
export const CENTER_VIEWS: readonly CenterMode[] = ['editor', 'corkboard', 'timeline', 'pictures'];

/** The id of a rail tab, which its tabpanel names itself by (`aria-labelledby`). */
export function railTabId(tab: RailTab): string {
  return `rail-tab-${tab}`;
}

/**
 * The item an arrow, Home or End key moves to from `current`, or `null` for any other key. Arrows wrap at both ends, as the
 * WAI-ARIA tab and radio patterns have them, and Home and End go to the first and last item. Left and right follow the reading
 * direction (`inlineKey`), so in a right-to-left interface the right arrow walks back.
 */
export function keyStep<T>(items: readonly T[], current: T, pressed: string): T | null {
  const at = items.indexOf(current);
  if (at === -1) return null;
  const key = inlineKey(pressed);
  if (key === 'ArrowRight' || key === 'ArrowDown') return items[(at + 1) % items.length] ?? null;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return items[(at - 1 + items.length) % items.length] ?? null;
  if (key === 'Home') return items[0] ?? null;
  if (key === 'End') return items[items.length - 1] ?? null;
  return null;
}

/** The class of Classic's workspace element (the frame Shell.tsx draws): the grid, and focus mode's single column. */
export function classicFrameClass(hideRails: boolean): string {
  return `workspace${hideRails ? ' is-focus' : ''}`;
}

/** Classic's layout: everything inside the workspace element but the dialogs, which Shell.tsx puts after it. */
export function ClassicLayout({ regions }: { regions: ShellRegions }): ReactNode {
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
    <>
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
                <Trans>Binder</Trans>
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
                <Trans>Inspector</Trans>
              </button>
            )}
            <button type="button" className="button" aria-haspopup="menu" aria-expanded={overflow !== null} onClick={view.openOverflow}>
              <Trans>More</Trans>
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
          aria-label={t`Project panels`}
          onKeyDown={narrow ? onPanelKey : undefined}
        >
          {narrow ? (
            <div className="panel-head">
              <span className="panel-title">
                <Trans>Project panels</Trans>
              </span>
              <button type="button" className="button" aria-label={t`Close panels`} onClick={() => setPanel(null)}>
                <Trans>Close</Trans>
              </button>
            </div>
          ) : null}
          <div role="tablist" aria-label={t`Panels`} className="rail-tabs" onKeyDown={onRailTabKey}>
            <RailTabButton tab="binder" current={rail} label={t`Binder`} onSelect={setRail} />
            <RailTabButton tab="codex" current={rail} label={t`Codex`} onSelect={setRail} />
            <RailTabButton tab="activity" current={rail} label={t`Activity`} onSelect={setRail} />
            <RailTabButton tab="trace" current={rail} label={t`Trace`} onSelect={setRail} />
            <RailTabButton tab="findings" current={rail} label={t`Findings`} badge={regions.findingsBadge} onSelect={setRail} />
          </div>
          <div role="tabpanel" id="rail-panel" aria-labelledby={railTabId(rail)} className="rail-panel">
            {rail === 'binder'
              ? <>{regions.binder}{regions.binderFooter}</>
              : rail === 'codex'
                ? regions.codex
                : rail === 'findings'
                  ? <LazyBoundary label={t`Findings`}>{regions.findings}</LazyBoundary>
                  : rail === 'trace'
                    ? <LazyBoundary label={t`Trace`}>{regions.trace}</LazyBoundary>
                    : <LazyBoundary label={t`Activity`}>{regions.activity}</LazyBoundary>}
          </div>
        </nav>
      )}

      <main className="center" inert={openPanel !== null}>
        <div role="radiogroup" aria-label={t`Centre view`} className="center-switch" onKeyDown={onCenterKey}>
          <button
            type="button"
            id="center-editor"
            role="radio"
            aria-checked={center === 'editor'}
            tabIndex={center === 'editor' ? 0 : -1}
            className="segmented-item"
            onClick={() => setCenter('editor')}
          >
            <Trans>Editor</Trans>
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
            <Trans>Corkboard</Trans>
          </button>
          <button
            type="button"
            id="center-timeline"
            role="radio"
            aria-checked={center === 'timeline'}
            tabIndex={center === 'timeline' ? 0 : -1}
            className="segmented-item"
            onClick={() => setCenter('timeline')}
          >
            <Trans>Timeline</Trans>
          </button>
          <button
            type="button"
            id="center-pictures"
            role="radio"
            aria-checked={center === 'pictures'}
            tabIndex={center === 'pictures' ? 0 : -1}
            className="segmented-item"
            onClick={() => setCenter('pictures')}
          >
            <Trans>Pictures</Trans>
          </button>
        </div>
        {regions.storageBanner}
        {/* The picture-aware notices take the general banner's place, never sit beside it. */}
        {regions.storageBanner === null ? regions.pictureNotices : null}
        {regions.media}
        {/* Kept mounted while the corkboard is shown, so the editor keeps its undo history and its place. */}
        {regions.editor}
        {center === 'corkboard' && regions.media === null && narrow ? (
          <OpenOnDesktop
            feature="corkboard"
            actions={
              <button type="button" className="button" onClick={() => setCenter('editor')}>
                <Trans>Back to the editor</Trans>
              </button>
            }
          />
        ) : null}
        {center === 'corkboard' && regions.media === null && !narrow ? regions.corkboard : null}
        {center === 'pictures' ? <LazyBoundary label={t`the pictures`}>{regions.pictures}</LazyBoundary> : null}
        {center === 'timeline' ? <LazyBoundary label={t`the timeline`}>{regions.timeline}</LazyBoundary> : null}
        {hideRails ? null : <LazyBoundary label={t`the agent`}>{regions.agent}</LazyBoundary>}
      </main>

      {hideRails ? null : narrow ? (
        <div id="narrow-sheet" className={`sheet${openPanel === 'inspector' ? ' is-open' : ''}`} onKeyDown={onPanelKey}>
          <div className="panel-head">
            <span className="panel-title">
              <Trans>Inspector</Trans>
            </span>
            <button type="button" id="narrow-close-inspector" className="button" aria-label={t`Close inspector`} onClick={() => setPanel(null)}>
              <Trans>Close</Trans>
            </button>
          </div>
          {regions.inspector}
        </div>
      ) : (
        regions.inspector
      )}
      {openPanel === null ? null : <div className="scrim" data-testid="panel-scrim" aria-hidden="true" onClick={() => setPanel(null)} />}
      {overflow === null ? null : <Menu label={t`More`} anchor={overflow} items={classicMenu(actions)} onClose={view.closeOverflow} />}

      {regions.status}
    </>
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
      data-testid={action.testId}
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
export function RailTabButton({
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
        <span className="rail-badge" aria-label={t`${plural(badge, { one: '# open', other: '# open' })}`} data-testid={`${tab}-badge`}>
          {badge}
        </span>
      ) : null}
    </button>
  );
}
