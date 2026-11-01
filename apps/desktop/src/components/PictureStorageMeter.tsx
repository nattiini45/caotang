/**
 * The picture storage meter of Settings › Data (pictures.md §6.1, §6.6): the weight of the project's pictures against the 500 MB soft
 * budget. The budget is a warning and never a refusal. What the browser says about keeping them is the storage row's sentence, said
 * once more only where it applies; nothing here claims what a browser will do under storage pressure beyond what it reported.
 */

import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { pictureStorageReport } from '@caotang/store';
import type { ReactNode } from 'react';

import type { Durability } from '../app/session.js';
import { formatBytes } from '../app/storage.js';

/* lingui-set comment="Interpolated values: size and budget are formatted sizes; count is a number." */

export function PictureStorageMeter({ report, durability }: { readonly report: ReturnType<typeof pictureStorageReport>; readonly durability: Durability | null }): ReactNode {
  const count = report.recordCount;
  const size = formatBytes(report.totalBytes);
  const budget = formatBytes(report.budgetBytes);
  return (
    <section aria-labelledby="settings-pictures" data-testid="picture-storage">
      <h4 id="settings-pictures">
        <Trans>Pictures</Trans>
      </h4>
      <dl className="budget" data-testid="picture-budget">
        <dt>
          <Trans>Kept</Trans>
        </dt>
        <dd>{t`${plural(count, { one: '# picture', other: '# pictures' })}`}</dd>
        <dt>
          <Trans>Size</Trans>
        </dt>
        <dd>{size}</dd>
        <dt>
          <Trans>Soft budget</Trans>
        </dt>
        <dd>{t`${{ budget }} for this project`}</dd>
      </dl>
      {report.overBudget ? (
        <p className="field-note is-complaint" role="status" data-testid="picture-over-budget">
          {t`These pictures take ${{ size }}, which is over the ${{ budget }} the project is meant to hold. Nothing is refused. Delete pictures you no longer need and sweep unused files, or store 4096 px working copies, on the Pictures board.`}
        </p>
      ) : null}
      {durability?.persisted === false ? (
        <p className="muted">
          <Trans>This browser has not promised to keep these pictures. Attach a folder, or export a bundle, for a copy of them that stays yours.</Trans>
        </p>
      ) : null}
    </section>
  );
}
