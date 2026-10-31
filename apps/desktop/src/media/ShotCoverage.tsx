/**
 * The dialogue coverage picker (storyboard.md §3.2): the script a shot covers, and the words of it the shot covers. The writer
 * picks a scene or a prose document, selects words in its text, and covers them. The anchor is captured then, against the stored
 * text (coverage-model.ts), and the coverage is one `shot.setMeta`.
 *
 * The text shown is the document's stored body, but a text area holds line feeds only, so for a body stored with carriage returns
 * an offset in the text is not an offset in the body. The capture therefore locates the selected words (coverage-model.ts), not
 * the offsets. The picker is a read-only text area, so the writer selects but cannot change the script from here.
 */

import { accessibleText } from '../i18n/accessible-text.js';
import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useRef, useState, type ReactNode } from 'react';

import { getBody } from '@caotang/store';

import type { ProjectSession } from '../app/session.js';
import { useSession } from '../components/shared.js';
import { commitShotCommand } from './commit.js';
import { captureSelection, coverCommand, coverageRowsOf, scriptChoicesOf, uncoverCommand, type SelectedText } from './coverage-model.js';
import type { MediaPorts } from './ports.js';


/* lingui-set comment="Dialogue coverage on a shot. Interpolated values: text is a passage of the writer's script; the count is a number." */
export interface ShotCoverageProps {
  readonly session: ProjectSession;
  readonly shotId: string;
  readonly ports: MediaPorts | undefined;
}

function selectedText(text: string): string {
  const characters = [...text].length;
  return plural(characters, { one: '# character selected.', other: '# characters selected.' });
}

export function ShotCoverage({ session, shotId, ports }: ShotCoverageProps): ReactNode {
  useLingui();
  useSession(session);
  const choices = scriptChoicesOf(session.state);
  const rows = coverageRowsOf(session.state, shotId);
  const [chosen, setChosen] = useState('');
  const docId = choices.some((choice) => choice.id === chosen) ? chosen : (choices[0]?.id ?? '');
  const body = docId === '' ? '' : getBody(session.state, docId);
  const [selection, setSelection] = useState<SelectedText | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const textArea = useRef<HTMLTextAreaElement | null>(null);
  const editable = ports?.commitShot !== undefined;

  // The words the writer has selected in the text area, read from the area itself, so a keyboard or mouse selection is never missed.
  const current = (): SelectedText | null => {
    const area = textArea.current;
    if (area === null || area.selectionEnd <= area.selectionStart) return null;
    return { from: area.selectionStart, to: area.selectionEnd, text: area.value.slice(area.selectionStart, area.selectionEnd) };
  };
  const sync = (): void => setSelection(current());

  const cover = (): void => {
    const picked = current();
    setSelection(picked);
    if (picked === null) {
      setMessage(t`Select the words the shot covers in the text, then cover them.`);
      return;
    }
    const captured = captureSelection(session.state, docId, picked);
    if (!captured.ok) {
      setMessage(captured.message);
      return;
    }
    const planned = coverCommand(session.state, shotId, docId, captured.anchor);
    if (!planned.ok) {
      setMessage(planned.refusal.message);
      return;
    }
    const result = commitShotCommand(session, planned.value, ports);
    setMessage(result.ok ? t`Covered.` : result.message);
    if (result.ok) setSelection(null);
  };

  const remove = (index: number): void => {
    const planned = uncoverCommand(session.state, shotId, index);
    if (!planned.ok) {
      setMessage(planned.refusal.message);
      return;
    }
    const result = commitShotCommand(session, planned.value, ports);
    setMessage(result.ok ? t`Coverage removed.` : result.message);
  };

  return (
    <section className="sb-coverage" aria-label={t`Script coverage`}>
      <h3 className="field-label"><Trans>Script coverage</Trans></h3>
      {rows.length === 0 ? (
        <p className="muted"><Trans>This shot covers no script text yet.</Trans></p>
      ) : (
        <ul className="sb-covers" aria-label={t`Covered script text`}>
          {rows.map((row) => (
            <li key={`${row.index}:${row.docId}`}>
              <span className="sb-cover-title">{row.title}</span>: <q>{row.text}</q>{' '}
              {editable ? (
                <button type="button" className="button is-quiet" aria-label={accessibleText(t`Remove the coverage of “${{ text: isolate(row.text) }}”`)} onClick={() => remove(row.index)}>
                  <Trans>Remove</Trans>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {choices.length === 0 ? (
        <p className="muted"><Trans>There is no screenplay scene or prose document to cover yet.</Trans></p>
      ) : editable ? (
        <div className="sb-cover-picker">
          <p className="muted"><Trans>Choose a scene or a document, select the words this shot covers in its text, then cover them.</Trans></p>
          <label>
            <span><Trans>Script</Trans></span>
            <select
              aria-label={t`Script to cover from`}
              value={docId}
              onChange={(event) => {
                setChosen(event.target.value);
                setSelection(null);
              }}
            >
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.title}
                  {choice.kind === 'screenplay' ? ' (scene)' : ' (prose)'}
                </option>
              ))}
            </select>
          </label>
          <textarea
            ref={textArea}
            className="sb-cover-text"
            aria-label={t`Script text`}
            readOnly
            rows={8}
            value={body}
            onSelect={sync}
            onKeyUp={sync}
            onMouseUp={sync}
          />
          <p className="muted">{selection === null ? t`No words selected.` : selectedText(selection.text)}</p>
          <button type="button" className="button" onClick={cover}>
            <Trans>Cover the selected text</Trans>
          </button>
        </div>
      ) : null}
      {message === null ? null : (
        <p className="drop-note" role="status" aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}
