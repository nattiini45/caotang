/**
 * The report a Twee import shows before anything is written (dialogue-narrative.md §4). A Twine story format is a programming
 * environment, so what the import strips is counted here first: the writer confirms having read it, or cancels and nothing changes.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { describeTweeReport, type TweeImportPlan } from '@caotang/dialogue';
import { isolate } from '@caotang/i18n';

import { ChoiceDialog } from './shared.js';

/* lingui-set comment="Interpolated values: file, title" */

export function TweeImportDialog({
  fileName,
  plan,
  onImport,
  onCancel,
}: {
  /** The file being read, or null while no file is waiting on an answer. */
  fileName: string | null;
  plan: TweeImportPlan | null;
  onImport: () => void;
  onCancel: () => void;
}): ReactNode {
  const open = fileName !== null && plan !== null;
  const file = isolate(fileName ?? '');
  const title = isolate(plan?.container?.title ?? (fileName ?? ''));
  return (
    <ChoiceDialog
      open={open}
      title={t`Import this Twee story?`}
      choices={[{ label: t`Import`, onChoose: onImport }]}
      onCancel={onCancel}
    >
      {open ? (
        <div className="twee-report">
          <p>
            <Trans>
              <strong>{title}</strong> ({file}) will be one dialogue container. Read what the import changes first.
            </Trans>
          </p>
          <ul aria-label={t`What the import does`}>
            {describeTweeReport(plan.report).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {plan.report.warnings.length > 0 ? (
            <>
              <h3>
                <Trans>Warnings</Trans>
              </h3>
              <ul aria-label={t`Warnings`}>
                {plan.report.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </ChoiceDialog>
  );
}
