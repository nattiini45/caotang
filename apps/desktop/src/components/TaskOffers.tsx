/**
 * The recurring tasks that are due (agent-harness.md §12), offered with Run now and Skip. It is shown with the agent drawer closed too,
 * like an interrupted run, because a due task waits for the writer's answer; and it holds the polite live region that announces a task
 * newly due or a run's end. Nothing here starts a task but the writer's click.
 */

import { useSyncExternalStore, type ReactNode } from 'react';

import type { RecurringTasks } from '../app/recurring-tasks.js';

export function TaskOffers({ recurring }: { recurring: RecurringTasks }): ReactNode {
  const snapshot = useSyncExternalStore(recurring.subscribe, recurring.snapshot);
  return (
    <section className={`recurring-offers${snapshot.offers.length > 0 ? ' has-offers' : ''}`} aria-label="Tasks due" data-testid="task-offers">
      {snapshot.offers.map((offer) => (
        <div key={offer.id} className="recurring-offer" role="group" aria-label={`Task due: ${offer.name}`} data-task={offer.id}>
          <p className="recurring-offer-title">
            <strong>{offer.name}</strong> is due.
          </p>
          <p className="recurring-offer-meta muted">
            {offer.doing}.{' '}
            {offer.usesModel
              ? offer.maxModelCalls === null
                ? 'It uses the model.'
                : `It uses the model, at most ${offer.maxModelCalls} ${offer.maxModelCalls === 1 ? 'call' : 'calls'}.`
              : 'It calls no model.'}
          </p>
          <div className="recurring-actions">
            <button type="button" className="button is-primary" disabled={snapshot.running !== null} onClick={() => void recurring.runNow(offer.id)}>
              Run now
              <span className="visually-hidden"> {offer.name}</span>
            </button>
            <button type="button" className="button" onClick={() => void recurring.skip(offer.id)}>
              Skip
              <span className="visually-hidden"> {offer.name}</span>
            </button>
          </div>
        </div>
      ))}
      {snapshot.message !== null && snapshot.offers.length > 0 ? (
        <p className="form-message is-error" role="alert">
          {snapshot.message}
        </p>
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite" data-testid="task-announcement">
        {snapshot.announcement}
      </p>
    </section>
  );
}
