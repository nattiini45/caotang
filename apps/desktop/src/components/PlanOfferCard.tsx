import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Button } from '@ui-sdk/react/button';
import { useState, type ReactNode } from 'react';

import type { AgentController, OfferView } from '../app/agent.js';
import { QueuedReviewDetails } from './QueuedReviewDetails.js';

/* lingui-set comment="Interpolated values: calls, cap" */

export function PlanOfferCard({ agent, view, onReturnFocus }: { agent: AgentController; view: OfferView; readonly onReturnFocus?: () => void }): ReactNode {
  const { offer, unavailable, error } = view;
  const queueUnavailable = unavailable ?? ((offer.reviews?.length ?? 0) > 1 ? t`Queue one coherence review at a time. Split this plan into one review per task.` : null);
  const [answering, setAnswering] = useState<'now' | 'background' | 'cancel' | null>(null);
  const hasReview = (offer.reviews?.length ?? 0) > 0;
  const over = offer.estimatedCalls > offer.turnCap;
  const calls = offer.estimatedCalls;
  const cap = offer.turnCap;
  const first = hasReview
    ? t`Run now prepares this plan in the current turn. Its review steps still wait for the usual approval.`
    : over
    ? t`Run now drafts in this turn, which may make at most ${{ cap }} model calls, so it would stop short of the end of this plan.`
    : t`Run now drafts in this turn, which may make at most ${{ cap }} model calls.`;
  const second = hasReview
    ? t`Run in background approves the review shown below. It records findings when the review finishes; drafts and other changes still wait for your approval.`
    : t`Run in background drafts one call at a time while you keep writing, up to ${{ calls }} calls. Nothing is applied until you review the drafts.`;
  const answer = async (choice: 'now' | 'background' | 'cancel', button: HTMLElement): Promise<void> => {
    if (answering !== null && choice !== 'cancel') return;
    const focused = button.closest('[data-testid="plan-offer"]')?.contains(document.activeElement) === true;
    setAnswering(choice);
    try {
      await agent.answerOffer(choice);
    } finally {
      setAnswering(null);
    }
    if (focused && !button.isConnected && document.hasFocus() && (document.activeElement === document.body || document.activeElement === null)) onReturnFocus?.();
  };
  return (
    <section className="plan-card is-live plan-offer" aria-label={t`Run this plan`} data-testid="plan-offer">
      <header className="plan-head">
        <h3>{hasReview
          ? t`This plan may use up to ${{ calls }} ${plural(calls, { one: 'model call', other: 'model calls' })}`
          : t`This plan needs ${{ calls }} ${plural(calls, { one: 'model call', other: 'model calls' })}`}</h3>
      </header>
      <ol className="plan-offer-steps" aria-label={t`Steps`}>
        {offer.steps.map((step, index) => (
          <li key={`${index}:${step.tool}`}>
            <span className="muted">{step.tool}</span> {step.expect}
          </li>
        ))}
      </ol>
      <p className="plan-offer-calls">
        {first} {queueUnavailable === null ? second : null}
      </p>
      {offer.reviews?.map((review) => <QueuedReviewDetails key={`${offer.turnId}:${review.stepIndex}`} preview={review} stepNumber={review.stepIndex + 1} />)}
      <p className="plan-offer-calls muted">
        <Trans>A background run goes on only while this project is open in this tab.</Trans>
      </p>
      {queueUnavailable !== null ? (
        <p className="plan-notice is-warn" role="status">
          {queueUnavailable}
        </p>
      ) : null}
      {error !== null ? (
        <p className="plan-notice is-warn" role="status">
          {error}
        </p>
      ) : null}
      <div className="plan-actions">
        <Button className="button" disabled={answering !== null} focusableWhenDisabled={answering !== null} data-agent-confirm={t`Prepares this plan in the current turn and may send draft requests to the model.`} onClick={(event) => answer('now', event.currentTarget)}>
          <Trans>Run now</Trans>
        </Button>
        {queueUnavailable === null ? (
          <Button className="button is-primary" disabled={answering !== null} focusableWhenDisabled={answering !== null} data-agent-confirm={t`Starts this background plan and sends the approved text to its model.`} pendingAnnouncement={answering === 'cancel' ? '' : t`Queuing the plan`} onClick={(event) => answer('background', event.currentTarget)}>
            <Trans>Run in background</Trans>
          </Button>
        ) : null}
        <Button className="button" pendingAnnouncement={t`Cancelling the plan`} onClick={(event) => answer('cancel', event.currentTarget)}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </section>
  );
}
