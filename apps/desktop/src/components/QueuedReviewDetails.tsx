import { plural, select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { isolate } from '@caotang/i18n';
import type { ReactNode } from 'react';

import { checkLabelForRun } from '../app/findings-model.js';
import { formatUsd } from '../app/plan-preview.js';
import type { QueuedReviewPreview } from '../app/queued-review.js';
import { formatCount } from '../i18n/locale.js';
import { UserText } from '../i18n/UserText.js';
import './queued-review.css';

/* lingui-set comment="Background review approval. Counts are documents, findings, calls or estimated tokens; titles and model labels are supplied text; money uses the interface locale." */

export function QueuedReviewDetails({ preview, stepNumber }: { readonly preview: Omit<QueuedReviewPreview, 'id'>; readonly stepNumber?: number }): ReactNode {
  const { plan, route, callBound, cost } = preview;
  const thinking = route.thinking ?? 'default';
  const documents = plan.documents.length;
  const extraction = callBound.extractCalls;
  const promptLabel = stepNumber === undefined ? undefined : t`First prompt for background review step ${{ step: formatCount(stepNumber) }}: ${{ titles: preview.scopeTitles.map(isolate).join(', ') }}.`;
  const level = select(thinking, {
    off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum', other: 'Provider default',
  });
  return (
    <div className="queued-review-details" data-testid="queued-review-details">
      <h4>{stepNumber === undefined ? t`Background review` : t`Background review: step ${{ step: formatCount(stepNumber) }}`}</h4>
      <p className="plan-offer-calls"><Trans>Background model:</Trans> <UserText value={route.label} /></p>
      <p className="plan-offer-calls">{t`Thinking level: ${{ level }}.`}</p>
      <p className="plan-offer-calls">{t`Reads ${plural(documents, { one: '# document', other: '# documents' })}: ${{ titles: preview.scopeTitles.map(isolate).join(', ') }}.`}</p>
      <p className="plan-offer-calls">{t`Checks: ${{ categories: plan.categories.map((category) => checkLabelForRun(`llm:${category}`)).join(', ') }}. At most ${{ findings: formatCount(plan.maxFindings) }} findings are kept.`}</p>
      <p className="plan-offer-calls">
        {t`${plural(extraction, { one: '# model call', other: '# model calls' })} to read the documents, then up to ${{ verification: formatCount(callBound.verifyCallsAtMost) }} to check their pairs. Up to ${{ tokens: formatCount(plan.estimate.totalTokensAtMost) }} tokens (an estimate).`}
      </p>
      <p className="plan-offer-calls">
        {cost === undefined
          ? t`A price estimate is unavailable. These model calls may still incur charges.`
          : cost.includesThinking === true
            ? t`About ${{ cost: formatUsd(cost.totalUsd) }} for this review, including thinking, at the Background model’s prices.`
            : t`About ${{ cost: formatUsd(cost.totalUsd) }} for this review, at the Background model’s prices.`}
      </p>
      {cost === undefined && preview.costUnknownReason !== null ? <p className="plan-offer-calls muted"><UserText value={preview.costUnknownReason} /></p> : null}
      {preview.exclusions.length > 0 ? (
        <div className="queued-review-exclusions">
          <p className="plan-offer-calls"><Trans>Left out of this review:</Trans></p>
          <ul>{[...new Set(preview.exclusions)].map((reason) => <li key={reason}><UserText value={reason} /></li>)}</ul>
        </div>
      ) : null}
      {plan.overGuard ? <p className="form-message is-error"><Trans>This scope is over the 20-document guard. Queueing the review approves reading all the documents shown above.</Trans></p> : null}
      <Collapsible className="queued-review-prompt">
        <CollapsibleTrigger className="button is-quiet" aria-label={promptLabel}>{stepNumber === undefined ? t`First prompt for this background review` : t`First prompt for background review step ${{ step: formatCount(stepNumber) }}`}</CollapsibleTrigger>
        <CollapsiblePanel><pre>{plan.promptPreview}</pre></CollapsiblePanel>
      </Collapsible>
      <p className="plan-offer-calls muted"><Trans>This review records findings, not manuscript edits. Its report appears in the Review Inbox. Other changes in the plan still wait for your approval.</Trans></p>
      <p className="plan-offer-calls muted"><Trans>The project must stay open in this tab. Changed text, read access or model settings can stop the review and require a new preview.</Trans></p>
    </div>
  );
}
