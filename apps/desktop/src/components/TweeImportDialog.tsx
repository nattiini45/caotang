/**
 * The report a Twee import shows before anything is written (dialogue-narrative.md §4). A Twine story format is a programming
 * environment, so what the import strips is counted here first: the writer confirms having read it, or cancels and nothing changes.
 */

import type { ReactNode } from 'react';

import { describeTweeReport, type TweeImportPlan } from '@caotang/dialogue';

import { ChoiceDialog } from './shared.js';

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
  return (
    <ChoiceDialog open={open} title="Import this Twee story?" choices={[{ label: 'Import', onChoose: onImport }]} onCancel={onCancel}>
      {open ? (
        <div className="twee-report">
          <p>
            <strong>{plan.container?.title ?? fileName}</strong> ({fileName}) will be one dialogue container. Read what the import changes first.
          </p>
          <ul aria-label="What the import does">
            {describeTweeReport(plan.report).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {plan.report.warnings.length > 0 ? (
            <>
              <h3>Warnings</h3>
              <ul aria-label="Warnings">
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
