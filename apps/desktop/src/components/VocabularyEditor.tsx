/**
 * The vocabulary editor — project-format §2's statuses and labels, in a writer's terms: add a term, rename it, recolour
 * it, or remove it. It opens from the "+ Add" entry of a status or label picker, which is how a project gets its first
 * label at all.
 *
 * Every change is a vocabulary command, so each one is an activity-log row and an undo. A removal detaches the items that
 * held the term, and its undo puts the term and each item's value back in one step.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { VocabularyKind } from '@caotang/bus';

import { explain, removeTerm, saveTerm } from './actions.js';
import { useReturnFocus } from './dialog-focus.js';
import { closeDialog, useDialogRequest } from './dialog-requests.js';
import { useStoreDraft } from './store-draft.js';
import { useReport } from './shared.js';
import type { ProjectSession } from '../app/session.js';
import './project-dialogs.css';

/** The vocabulary editor, rendered only while its request is open. */
export function VocabularyEditor({ session }: { session: ProjectSession }): ReactNode {
  const request = useDialogRequest();
  if (request === null || request.kind !== 'vocabulary') return null;
  return <VocabularyEditorDialog session={session} initial={request.term} />;
}

const KIND_LABEL: Readonly<Record<VocabularyKind, { readonly singular: string; readonly plural: string }>> = {
  status: { singular: 'status', plural: 'Statuses' },
  label: { singular: 'label', plural: 'Labels' },
};

function VocabularyEditorDialog({ session, initial }: { session: ProjectSession; initial: VocabularyKind }): ReactNode {
  const report = useReport();
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useReturnFocus();
  const [kind, setKind] = useState<VocabularyKind>(initial);
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState('#8a8a8a');
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const terms = kind === 'status' ? session.state.manifest.vocabulary.statuses : session.state.manifest.vocabulary.labels;
  const word = KIND_LABEL[kind].singular;

  /** Closes the editor, and hands focus back to the control it opened from. */
  const close = (): void => {
    returnFocus();
    closeDialog();
  };

  const add = (): void => {
    const name = draftName.trim();
    if (name === '') {
      setRefusal(`Give the ${word} a name.`);
      return;
    }
    const outcome = saveTerm(session, kind, { name, color: draftColor });
    if (outcome.ok) {
      setDraftName('');
      setRefusal(null);
      report({ text: `Added the ${word} “${name}”.`, tone: 'info' });
    } else {
      setRefusal(explain(outcome.error));
    }
  };

  return (
    <dialog
      ref={dialog}
      className="project-dialog vocabulary-dialog"
      aria-labelledby="vocabulary-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="project-dialog-body">
        <h2 id="vocabulary-dialog-title">Statuses and labels</h2>

        <div className="vocabulary-tabs" role="group" aria-label="Which list to edit">
          {(['status', 'label'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              className={`button${kind === choice ? ' is-primary' : ''}`}
              aria-pressed={kind === choice}
              onClick={() => {
                setKind(choice);
                setRefusal(null);
              }}
            >
              {KIND_LABEL[choice].plural}
            </button>
          ))}
        </div>

        {terms.length === 0 ? (
          <p className="project-dialog-help">No {KIND_LABEL[kind].plural.toLowerCase()} yet. Add the first one below.</p>
        ) : (
          <ul className="vocabulary-list">
            {terms.map((term) => (
              <TermRow
                key={`${kind}-${term.id}`}
                session={session}
                kind={kind}
                id={term.id}
                name={term.name}
                color={term.color}
                onRefusal={setRefusal}
              />
            ))}
          </ul>
        )}

        <div className="vocabulary-add">
          <label className="project-dialog-field">
            <span className="field-label">New {word}</span>
            <input
              type="text"
              value={draftName}
              maxLength={40}
              placeholder={kind === 'status' ? 'For example, Second pass' : 'For example, Act 2'}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') add();
              }}
            />
          </label>
          <label className="vocabulary-colour">
            <span className="field-label">Colour</span>
            <input type="color" value={draftColor} onChange={(event) => setDraftColor(event.target.value)} />
          </label>
          <button type="button" className="button is-primary" onClick={add}>
            Add {word}
          </button>
        </div>

        {refusal !== null ? (
          <p className="project-dialog-error" role="alert">
            {refusal}
          </p>
        ) : null}

        <div className="confirm-actions">
          <button type="button" className="button is-primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}

/**
 * One term: its name and colour, saved on Save, and removed on Remove.
 *
 * The row's drafts follow the project's terms, so a term the project took back — an undo of the
 * rename — leaves the row showing the term the project holds, and the row is not left looking
 * changed.
 */
function TermRow({
  session,
  kind,
  id,
  name,
  color,
  onRefusal,
}: {
  session: ProjectSession;
  kind: VocabularyKind;
  id: string;
  name: string;
  color: string;
  onRefusal: (message: string | null) => void;
}): ReactNode {
  const report = useReport();
  const draftName = useStoreDraft(name);
  const draftColor = useStoreDraft(color);
  const changed = draftName.value.trim() !== name || draftColor.value.toLowerCase() !== color.toLowerCase();

  const save = (): void => {
    const outcome = saveTerm(session, kind, { id, name: draftName.value, color: draftColor.value });
    if (outcome.ok) {
      onRefusal(null);
      report({ text: `Saved the ${KIND_LABEL[kind].singular} “${draftName.value.trim()}”.`, tone: 'info' });
    } else {
      onRefusal(explain(outcome.error));
    }
  };

  const remove = (): void => {
    const outcome = removeTerm(session, kind, id);
    if (outcome.ok) {
      onRefusal(null);
      report({ text: `Removed the ${KIND_LABEL[kind].singular} “${name}”. Undo puts it back.`, tone: 'info' });
    } else {
      onRefusal(explain(outcome.error));
    }
  };

  return (
    <li className="vocabulary-row">
      <input
        type="color"
        aria-label={`Colour of ${name}`}
        value={draftColor.value}
        onChange={(event) => draftColor.change(event.target.value)}
      />
      <input
        type="text"
        aria-label={`Name of ${name}`}
        value={draftName.value}
        maxLength={40}
        onChange={(event) => draftName.change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && changed) save();
        }}
      />
      <button type="button" className="button" disabled={!changed} onClick={save}>
        Save
      </button>
      <button type="button" className="button is-quiet" onClick={remove}>
        Remove
      </button>
    </li>
  );
}
