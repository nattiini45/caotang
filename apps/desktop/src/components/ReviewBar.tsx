/**
 * The review bar (editor-engine §15): the keyboard-reachable way to keep or put back the words an agent edit changed.
 *
 * Every control is a button, so Tab reaches it and Enter or Space presses it. Previous and Next move the editor's selection to the
 * next marked change; Accept and Reject act on the change the selection is in, and are off when it is in none; Accept all and Reject
 * all act on every change in the scene. The count is in a polite live region that is always on the page, so a screen reader hears it
 * change when the marks appear or go. Accepting changes nothing in the saved scene, because the agent's text is already saved;
 * rejecting is the writer's own edit and is saved as one.
 */
/* lingui-set comment="Review bar copy. Interpolated values: removed and added are the suggestion's old and new text." */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useSyncExternalStore, type ReactNode } from 'react';
import type { ReviewApi, ReviewSuggestion } from '@caotang/editor';

import { isModern } from '../app/interface.js';
import { pendingLabel } from '../app/review-text.js';

/** What one suggestion does, in words: the added and removed text is quoted, shortened by the editor. */
export function describeSuggestion(suggestion: ReviewSuggestion): string {
  if (suggestion.kind === 'replace') return t`Replaces “${{ removed: suggestion.removed }}” with “${{ added: suggestion.added }}”`;
  if (suggestion.kind === 'delete') return suggestion.removed === '' ? t`Removes a paragraph` : t`Removes “${{ removed: suggestion.removed }}”`;
  return suggestion.added === '' ? t`Adds a paragraph` : t`Adds “${{ added: suggestion.added }}”`;
}

/** `onUnsettled` hears of a button that was pressed with something to resolve and settled none of it. */
export function ReviewBar({ review, onUnsettled }: { review: ReviewApi; onUnsettled?: () => void }): ReactNode {
  useLingui();
  const state = useSyncExternalStore(review.subscribe, review.state);
  const { pending, current, position, selected } = state;
  const resolve = (call: () => number, asked: number): void => {
    if (call() === 0 && asked > 0) onUnsettled?.();
  };
  const modern = isModern();
  const all = (
    <>
      <button type="button" className="button" onClick={() => resolve(() => review.acceptAll(), pending)}>
        <Trans>Accept all</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={() => resolve(() => review.rejectAll(), pending)}>
        <Trans>Reject all</Trans>
      </button>
    </>
  );
  return (
    <>
      <span className="visually-hidden" role="status" aria-live="polite" data-testid="review-live">
        {pending > 0 ? pendingLabel(pending) : ''}
      </span>
      {pending > 0 ? (
        <section className="review-bar" aria-label={t`Review the agent’s changes`} data-testid="review-bar">
          <p className="review-count">
            {pendingLabel(pending)}
            {current === null ? '' : t` · ${position} of ${pending}`}
          </p>
          <p className="review-current muted">
            {current === null
              ? t`Choose Next to go to the first change.`
              : selected > 1
                ? t`${selected} changes are selected. Accept and Reject act on all of them.`
                : describeSuggestion(current)}
          </p>
          <div className="review-actions">
            <button type="button" className="button" onClick={() => review.previous()}>
              <Trans>Previous</Trans>
            </button>
            <button type="button" className="button" onClick={() => review.next()}>
              <Trans>Next</Trans>
            </button>
            <button type="button" className="button is-primary" disabled={selected === 0} onClick={() => resolve(() => review.accept(), selected)}>
              <Trans>Accept</Trans>
            </button>
            <button type="button" className="button" disabled={selected === 0} onClick={() => resolve(() => review.reject(), selected)}>
              <Trans>Reject</Trans>
            </button>
            {/* Modern keeps Accept the one primary in view and the whole-scene actions in a disclosure (#361); Classic shows all six. */}
            {modern ? (
              <details className="k-more">
                <summary>{t`More`}</summary>
                {all}
              </details>
            ) : (
              all
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
