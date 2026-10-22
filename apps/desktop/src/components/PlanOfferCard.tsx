/**
 * The offer shown before a big plan is staged (agent-harness §2, "Background runs"): the plan's steps, what it will cost in model
 * calls, and three answers. Run now stages it in this turn as every plan is; Run in background queues it and lets the writer go on;
 * Cancel drops it. Nothing has been spent when this shows but the planner's own call.
 */

import type { ReactNode } from 'react';

import type { AgentController, OfferView } from '../app/agent.js';

export function PlanOfferCard({ agent, view }: { agent: AgentController; view: OfferView }): ReactNode {
  const { offer, unavailable, error } = view;
  const over = offer.estimatedCalls > offer.turnCap;
  return (
    <section className="plan-card is-live plan-offer" aria-label="Run this plan" data-testid="plan-offer">
      <header className="plan-head">
        <h3>This plan needs {offer.estimatedCalls} model calls</h3>
      </header>
      <ol className="plan-offer-steps" aria-label="Steps">
        {offer.steps.map((step, index) => (
          <li key={`${index}:${step.tool}`}>
            <span className="muted">{step.tool}</span> {step.expect}
          </li>
        ))}
      </ol>
      <p className="plan-offer-calls">
        Run now drafts in this turn, which may make at most {offer.turnCap} model calls{over ? ', so it would stop short of the end of this plan' : ''}.
        Run in background drafts one call at a time while you keep writing, up to {offer.estimatedCalls} calls. Nothing is applied until you
        review the drafts.
      </p>
      <p className="plan-offer-calls muted">A background run goes on only while this project is open in this tab.</p>
      {unavailable !== null ? (
        <p className="plan-notice is-warn" role="status">
          {unavailable}
        </p>
      ) : null}
      {error !== null ? (
        <p className="plan-notice is-warn" role="status">
          {error}
        </p>
      ) : null}
      <div className="plan-actions">
        <button type="button" className="button" onClick={() => void agent.answerOffer('now')}>
          Run now
        </button>
        {unavailable === null ? (
          <button type="button" className="button is-primary" onClick={() => void agent.answerOffer('background')}>
            Run in background
          </button>
        ) : null}
        <button type="button" className="button" onClick={() => void agent.answerOffer('cancel')}>
          Cancel
        </button>
      </div>
    </section>
  );
}
