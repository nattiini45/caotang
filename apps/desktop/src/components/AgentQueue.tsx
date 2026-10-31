/**
 * The messages typed while a turn runs (agent-harness §8, "Stop and steer"): the notes sent to the running turn that it has not read
 * yet, and the queue of future turns. Each queued message is a chip the writer can edit, remove, move (with the arrow buttons or by
 * dragging) and promote to a note for the running turn. "Queued messages" here are foreground turns typed behind the running one; a
 * background task list is a different thing and is named differently.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';

import type { AgentController, AgentSnapshot, QueuedMessage } from '../app/agent.js';
import { isImeEnter } from '../app/keymap.js';
import { queuePausedText } from '../app/agent.js';
import { UserText } from '../i18n/UserText.js';

/* lingui-set comment="Messages the writer typed while a turn runs. Interpolated values: number is the position in the queue." */

/** The note the writer wrote while a card waits. The card is neither approved nor dropped by it: the writer chooses what happens to both. */
export interface HeldNote {
  readonly text: string;
  /** The queued message the note came from, when it was promoted from a chip. */
  readonly queuedId?: string;
  /** The showing of the card the note waits on: the note is dropped from view when that card is decided. */
  readonly cardKey: string;
}

export function AgentQueue({
  agent,
  snapshot,
  held,
  cardKey,
  onHold,
  onRelease,
}: {
  agent: AgentController;
  snapshot: AgentSnapshot;
  held: HeldNote | null;
  /** The card that waits now, as the panel keys it, or null. */
  cardKey: string | null;
  onHold: (note: HeldNote) => void;
  onRelease: () => void;
}): ReactNode {
  useLingui();
  const { queue, notes } = snapshot;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);

  const startEdit = (entry: QueuedMessage): void => {
    setEditing(entry.id);
    setDraft(entry.intent);
  };
  // Escape saves the field it is in, then leaves it (decisions.md: Escape saves the focused field first), and the key stops here:
  // it must not reach the panel, where it would stop the turn.
  const finishEdit = (id: string): void => {
    if (draft.trim() !== '') agent.editQueued(id, draft);
    setEditing(null);
  };
  const onEditKey = (event: KeyboardEvent<HTMLInputElement>, id: string): void => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    // The Enter that commits an IME candidate is the input method's: it neither edits the queued message nor leaves the field.
    if (event.key === 'Enter' && isImeEnter(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    finishEdit(id);
  };

  const steerNow = (entry: QueuedMessage): void => {
    if (agent.steerQueued(entry.id) === 'card-waiting' && cardKey !== null) onHold({ text: entry.intent, queuedId: entry.id, cardKey });
  };

  const onDrop = (event: DragEvent<HTMLLIElement>, to: number): void => {
    event.preventDefault();
    if (dragging !== null) agent.moveQueued(dragging, to);
    setDragging(null);
  };

  return (
    <>
      {held !== null ? (
        <div className="agent-held" role="group" aria-label={t`A note while a card waits`}>
          <p>
            <Trans>
              A card is waiting for your decision. Your note: <q><UserText value={held.text} /></q>
            </Trans>
          </p>
          <div className="agent-held-actions">
            <button
              type="button"
              className="button is-primary"
              onClick={() => {
                agent.sendWithCancel(held.text);
                if (held.queuedId !== undefined) agent.removeQueued(held.queuedId);
                onRelease();
              }}
            >
              <Trans>Send with Cancel</Trans>
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                // A note promoted from a chip is queued already.
                if (held.queuedId === undefined) agent.enqueue(held.text);
                onRelease();
              }}
            >
              <Trans>Queue as next turn</Trans>
            </button>
            <button type="button" className="button is-quiet" onClick={onRelease}>
              <Trans>Keep waiting</Trans>
            </button>
          </div>
        </div>
      ) : null}

      {notes.length > 0 ? (
        <ul className="agent-notes" aria-label={t`Notes sent to the agent`}>
          {notes.map((note) => (
            <li key={note.noteId}>
              <span className="muted">{note.lands === 'after-decision' ? t`Note, read after your decision:` : t`Note, read at the next step:`}</span> <UserText value={note.text} />
            </li>
          ))}
        </ul>
      ) : null}

      {queue.length > 0 ? (
        <section className="agent-queue" aria-label={t`Queued messages`} data-testid="agent-queue">
          <h4><Trans>Queued messages</Trans></h4>
          {snapshot.queuePaused ? (
            <p className="agent-queue-paused">
              {queuePausedText()}{' '}
              <button type="button" className="button" onClick={() => agent.runQueue()}>
                <Trans>Run the queue</Trans>
              </button>
            </p>
          ) : null}
          <ol className="agent-queue-list">
            {queue.map((entry, index) => {
              const number = index + 1;
              return (
              <li
                key={entry.id}
                className={`agent-chip${dragging === entry.id ? ' is-dragging' : ''}`}
                data-queued={entry.id}
                draggable={editing !== entry.id}
                onDragStart={() => setDragging(entry.id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => onDrop(event, index)}
              >
                {editing === entry.id ? (
                  <input
                    type="text"
                    className="agent-chip-edit"
                    aria-label={t`Edit queued message ${number}`}
                    value={draft}
                    autoFocus
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => onEditKey(event, entry.id)}
                    onBlur={() => finishEdit(entry.id)}
                  />
                ) : (
                  <span className="agent-chip-text">
                    {entry.fromUndeliveredNote === true ? <span className="badge is-warn"><Trans>Note not read in time</Trans></span> : null} <UserText value={entry.intent} />
                  </span>
                )}
                <span className="agent-chip-actions">
                  <button type="button" className="button is-quiet" disabled={index === 0} aria-label={t`Move queued message ${number} up`} onClick={() => agent.moveQueued(entry.id, index - 1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="button is-quiet"
                    disabled={index === queue.length - 1}
                    aria-label={t`Move queued message ${number} down`}
                    onClick={() => agent.moveQueued(entry.id, index + 1)}
                  >
                    ↓
                  </button>
                  <button type="button" className="button is-quiet" aria-label={t`Edit queued message ${number}`} onClick={() => startEdit(entry)}>
                    <Trans>Edit</Trans>
                  </button>
                  {snapshot.busy ? (
                    <button type="button" className="button is-quiet" aria-label={t`Steer now with queued message ${number}`} onClick={() => steerNow(entry)}>
                      <Trans>Steer now</Trans>
                    </button>
                  ) : null}
                  <button type="button" className="button is-quiet is-danger" aria-label={t`Remove queued message ${number}`} onClick={() => agent.removeQueued(entry.id)}>
                    <Trans>Remove</Trans>
                  </button>
                </span>
              </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </>
  );
}
