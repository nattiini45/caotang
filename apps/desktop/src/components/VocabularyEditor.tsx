/**
 * The vocabulary editor — project-format §2's statuses and labels, in a writer's terms: add a term, rename it, recolour
 * it, or remove it. It opens from the "+ Add" entry of a status or label picker, which is how a project gets its first
 * label at all.
 *
 * Every change is a vocabulary command, so each one is an activity-log row and an undo. A removal detaches the items that
 * held the term, and its undo puts the term and each item's value back in one step.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import { accessibleText } from '../i18n/accessible-text.js';

import type { VocabularyKind } from '@caotang/bus';

import { isImeEnter } from '../app/keymap.js';
import { explain, removeTerm, saveTerm } from './actions.js';
import { useReturnFocus } from './dialog-focus.js';
import { closeDialog, useDialogRequest } from './dialog-requests.js';
import { useStoreDraft } from './store-draft.js';
import { useReport } from './shared.js';
import type { ProjectSession } from '../app/session.js';
import './project-dialogs.css';

/* lingui-set comment="Interpolated values: name" */

/** The vocabulary editor, rendered only while its request is open. */
export function VocabularyEditor({ session }: { session: ProjectSession }): ReactNode {
  const request = useDialogRequest();
  if (request === null || request.kind !== 'vocabulary') return null;
  return <VocabularyEditorDialog session={session} initial={request.term} />;
}

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

  /** Closes the editor, and hands focus back to the control it opened from. */
  const close = (): void => {
    returnFocus();
    closeDialog();
  };

  const add = (): void => {
    const name = draftName.trim();
    if (name === '') {
      setRefusal(t`Give the ${select(kind, { status: 'status', label: 'label', other: 'status' })} a name.`);
      return;
    }
    const outcome = saveTerm(session, kind, { name, color: draftColor });
    if (outcome.ok) {
      setDraftName('');
      setRefusal(null);
      report({ text: t`Added the ${select(kind, { status: 'status', label: 'label', other: 'status' })} “${{ name: isolate(name) }}”.`, tone: 'info' });
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
        <h2 id="vocabulary-dialog-title"><Trans>Statuses and labels</Trans></h2>

        <div className="vocabulary-tabs" role="group" aria-label={t`Which list to edit`}>
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
              {choice === 'status' ? <Trans>Statuses</Trans> : <Trans>Labels</Trans>}
            </button>
          ))}
        </div>

        {terms.length === 0 ? (
          <p className="project-dialog-help">
            {kind === 'status' ? <Trans>No statuses yet. Add the first one below.</Trans> : <Trans>No labels yet. Add the first one below.</Trans>}
          </p>
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
            <span className="field-label">{t`New ${select(kind, { status: 'status', label: 'label', other: 'status' })}`}</span>
            <input
              type="text"
              value={draftName}
              maxLength={40}
              placeholder={kind === 'status' ? t`For example, Second pass` : t`For example, Act 2`}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                // The Enter that commits an IME candidate adds nothing; the candidate's text is still being composed.
                if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) add();
              }}
            />
          </label>
          <label className="vocabulary-colour">
            <span className="field-label"><Trans>Colour</Trans></span>
            <input type="color" value={draftColor} onChange={(event) => setDraftColor(event.target.value)} />
          </label>
          <button type="button" className="button is-primary" onClick={add}>
            {t`Add ${select(kind, { status: 'status', label: 'label', other: 'status' })}`}
          </button>
        </div>

        {refusal !== null ? (
          <p className="project-dialog-error" role="alert">
            {refusal}
          </p>
        ) : null}

        <div className="confirm-actions">
          <button type="button" className="button is-primary" onClick={close}>
            <Trans>Done</Trans>
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
      report({ text: t`Saved the ${select(kind, { status: 'status', label: 'label', other: 'status' })} “${{ name: isolate(draftName.value.trim()) }}”.`, tone: 'info' });
    } else {
      onRefusal(explain(outcome.error));
    }
  };

  const remove = (): void => {
    const outcome = removeTerm(session, kind, id);
    if (outcome.ok) {
      onRefusal(null);
      report({ text: t`Removed the ${select(kind, { status: 'status', label: 'label', other: 'status' })} “${{ name: isolate(name) }}”. Undo puts it back.`, tone: 'info' });
    } else {
      onRefusal(explain(outcome.error));
    }
  };

  return (
    <li className="vocabulary-row">
      <input
        type="color"
        aria-label={t`Colour of ${{ name: accessibleText(name) }}`}
        value={draftColor.value}
        onChange={(event) => draftColor.change(event.target.value)}
      />
      <input
        type="text"
        aria-label={t`Name of ${{ name: accessibleText(name) }}`}
        value={draftName.value}
        maxLength={40}
        onChange={(event) => draftName.change(event.target.value)}
        onKeyDown={(event) => {
          // The Enter that commits an IME candidate saves nothing; the candidate's text is still being composed.
          if (event.key === 'Enter' && changed && !isImeEnter(event.nativeEvent)) save();
        }}
      />
      <button type="button" className="button" disabled={!changed} onClick={save}>
        <Trans>Save</Trans>
      </button>
      <button type="button" className="button is-quiet" onClick={remove}>
        <Trans>Remove</Trans>
      </button>
    </li>
  );
}
