/**
 * M4's provisional ornaments (#305): glass capsules on the page's edges, built from what Classic already has, so Modern (Preview) is
 * usable before #306. The top one shows the project's name (Project details), the save state and Classic's More menu (every shell
 * action, app/shell-actions.ts); the bottom one is the centre's view radio group, with Classic's ids and keys. #306 replaces both with
 * the title capsule, **⋯** and Write / Board / Codex (modern-interface.md §6, §8.1) and deletes this file.
 */
/* lingui-set comment="Modern interface, provisional controls on the page's edges." */

import { t } from '@lingui/core/macro';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { classicMenu } from '../../../app/shell-actions.js';
import type { CenterMode } from '../../Binder.js';
import { Menu } from '../../shared.js';
import { CENTER_VIEWS, keyStep } from '../ClassicShell.js';
import type { ModernSlotProps } from './slots.js';

export function InterimTopOrnament({ regions }: ModernSlotProps): ReactNode {
  const { view, actions } = regions;
  const details = actions.find((action) => action.id === 'details');
  return (
    <>
      <div className="modern-ornament is-top mat-glass" role="group" aria-label={t`Project`} data-testid="modern-top-ornament">
        {details === undefined ? (
          <span className="modern-ornament-title mat-scrim">{regions.projectName}</span>
        ) : (
          <button type="button" className="modern-capsule" title={details.hint} onClick={details.run}>
            {regions.projectName}
          </button>
        )}
        <span className="mat-scrim modern-ornament-state">{regions.saveState}</span>
        <button type="button" className="modern-capsule" aria-haspopup="menu" aria-expanded={view.overflow !== null} onClick={view.openOverflow}>
          {t`More`}
        </button>
      </div>
      {view.overflow === null ? null : <Menu label={t`More`} anchor={view.overflow} items={classicMenu(actions)} onClose={view.closeOverflow} />}
    </>
  );
}

const VIEW_LABELS: Readonly<Record<CenterMode, () => string>> = {
  editor: () => t`Editor`,
  corkboard: () => t`Corkboard`,
  timeline: () => t`Timeline`,
  pictures: () => t`Pictures`,
};

export function InterimBottomOrnament({ regions }: ModernSlotProps): ReactNode {
  const { center, setCenter } = regions.view;
  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = keyStep(CENTER_VIEWS, center, event.key);
    if (next === null) return;
    event.preventDefault();
    setCenter(next);
    document.getElementById(`center-${next}`)?.focus();
  };
  return (
    <div
      className="modern-ornament is-bottom mat-glass"
      role="radiogroup"
      aria-label={t`Centre view`}
      data-testid="modern-bottom-ornament"
      onKeyDown={onKey}
    >
      {CENTER_VIEWS.map((mode) => (
        <button
          key={mode}
          type="button"
          id={`center-${mode}`}
          role="radio"
          aria-checked={center === mode}
          tabIndex={center === mode ? 0 : -1}
          className="modern-capsule"
          onClick={() => setCenter(mode)}
        >
          {VIEW_LABELS[mode]()}
        </button>
      ))}
    </div>
  );
}
