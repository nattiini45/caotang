/**
 * The recurring tasks that are due (agent-harness.md §12), offered with Run now and Skip. It is shown with the agent drawer closed too,
 * like an interrupted run, because a due task waits for the writer's answer; and it holds the polite live region that announces a task
 * newly due or a run's end. Nothing here starts a task but the writer's click.
 */
/* lingui-set comment="Task offers. Interpolated values: name is a task's name, calls is the model-call cap." */

import { useSyncExternalStore, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';

import type { RecurringTasks } from '../app/recurring-tasks.js';

export function TaskOffers({ recurring }: { recurring: RecurringTasks }): ReactNode {
  useLingui();
  const snapshot = useSyncExternalStore(recurring.subscribe, recurring.snapshot);
  return (
    <section className={`recurring-offers${snapshot.offers.length > 0 ? ' has-offers' : ''}`} aria-label={t`Tasks due`} data-testid="task-offers">
      {snapshot.offers.map((offer) => (
        <div key={offer.id} className="recurring-offer" role="group" aria-label={t`Task due: ${{ name: offer.name }}`} data-task={offer.id}>
          <p className="recurring-offer-title">
            <strong>{offer.name}</strong> <Trans>is due.</Trans>
          </p>
          <p className="recurring-offer-meta muted">
            {offer.doing}.{' '}
            {offer.usesModel
              ? offer.maxModelCalls === null
                ? t`It uses the model.`
                : t`It uses the model, at most ${plural({ calls: offer.maxModelCalls }, { one: '# call', other: '# calls' })}.`
              : t`It calls no model.`}
          </p>
          <div className="recurring-actions">
            <button type="button" className="button is-primary" disabled={snapshot.running !== null} onClick={() => void recurring.runNow(offer.id)}>
              <Trans>Run now</Trans>
              <span className="visually-hidden"> {offer.name}</span>
            </button>
            <button type="button" className="button" onClick={() => void recurring.skip(offer.id)}>
              <Trans>Skip</Trans>
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
