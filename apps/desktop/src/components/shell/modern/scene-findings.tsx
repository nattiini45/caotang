/**
 * Scene info's open findings (modern-interface.md §7.2): the open findings that quote the selected scene, each with **Show in Findings**,
 * which opens the sidebar's Findings tab on its fact group, as the timeline's **Open in Findings** does. A popover Scene info closes so
 * the tab is in view; a docked one stays. Nothing while the scene has no open finding.
 */
/* lingui-set comment="Modern interface: Scene info's list of the scene's open findings." */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useId, type ReactNode } from 'react';

import { findingMessageText } from '../../../app/findings-model.js';
import type { ShellRegions } from '../regions.js';
import { closeSceneInfo, sceneInfoState } from './scene-info-store.js';

export function SceneFindings({ regions }: { regions: ShellRegions }): ReactNode {
  const id = useId();
  const findings = regions.sceneFindings;
  if (findings.length === 0) return null;
  return (
    <section className="scene-info-findings" aria-labelledby={id} data-testid="scene-info-findings">
      <h3 id={id} className="field-label">
        <Trans>Open findings in this scene</Trans>
      </h3>
      <ul>
        {findings.map((finding) => (
          <li key={finding.id}>
            <span id={`${id}-${finding.id}`}>
              <b>{finding.typeLabel}</b> {findingMessageText(finding)}
            </span>
            <button
              type="button"
              className="modern-capsule"
              aria-describedby={`${id}-${finding.id}`}
              onClick={() => {
                if (!sceneInfoState().docked) closeSceneInfo({ returnFocus: false });
                regions.showInFindings(finding.factGroup);
              }}
            >
              {t`Show in Findings`}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
