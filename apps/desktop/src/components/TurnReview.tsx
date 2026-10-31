/** A turn card's line for the suggestions the turn's edits still have marked in the editor (editor-engine §15). Fetched when any turn has some. */

import type { ReactNode } from 'react';

import type { ReviewView } from '../app/agent.js';
import { pendingLabel } from '../app/review-text.js';

export function TurnReview({
  turnId,
  reviews,
  onResolve,
}: {
  turnId: string;
  reviews: readonly ReviewView[];
  onResolve: (turnId: string, mode: 'accept' | 'reject') => void;
}): ReactNode {
  const pending = reviews.reduce((sum, entry) => (entry.turnId === turnId ? sum + entry.pending : sum), 0);
  if (pending === 0) return null;
  return (
    <p className="agent-review" data-testid="turn-review">
      <span>{pendingLabel(pending)}</span>
      <button type="button" className="button" onClick={() => onResolve(turnId, 'accept')}>
        Accept all
      </button>
      <button type="button" className="button is-quiet" onClick={() => onResolve(turnId, 'reject')}>
        Reject all
      </button>
    </p>
  );
}
