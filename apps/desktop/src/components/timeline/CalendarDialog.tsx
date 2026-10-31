/**
 * The timeline's calendar: which lens names the story's days, and the definition of the project's own calendar
 * ([timeline.md §3.8](docs/architecture/timeline.md)). A native dialog with plain controls, reachable by keyboard from the toolbar's
 * Calendar button. The definition is the project's own data as JSON; a start-from example fills the box, the box says at once whether
 * it is usable and how it would name a few days, and Save is a single `project.setCalendar` dispatch. Choosing the day numbers keeps
 * the calendar as it was, so switching back and forth never loses it, and no scene's day, duration or part is ever changed here.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import type { DayLensOptions } from '@caotang/timeline';

import { setCalendar } from '../../app/calendar-actions.js';
import { draftOf, previewOf, savePlan, textOfCalendar } from '../../app/calendar-editor-model.js';
import type { ProjectSession } from '../../app/session.js';
import { useReturnFocus } from '../dialog-focus.js';
import { calendarExamples, type CalendarExample } from './calendar-examples.js';

/* lingui-set comment="The timeline's calendar dialog. Interpolated values: day is a day number of the story, label is that day written in the project's calendar, detail is the reason a text is not valid JSON, count is a number of problems, field names the part of the calendar a problem is about, message says what is wrong with it." */

export interface CalendarDialogProps {
  readonly session: ProjectSession;
  /** The locale and messages the preview writes its labels in: the same the timeline uses. */
  readonly lensOptions: DayLensOptions;
  readonly onClose: () => void;
}

type Choice = 'day' | 'calendar';

function exampleLabel(key: CalendarExample['key']): string {
  return key === 'gregorian' ? t`Gregorian, with its leap years` : t`An invented calendar with its own months, extra days and eras`;
}

export function CalendarDialog({ session, lensOptions, onClose }: CalendarDialogProps): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useReturnFocus();
  const ids = useId();
  const stored = session.state.manifest.timeline;
  const [choice, setChoice] = useState<Choice>(stored?.lens ?? (stored?.calendar === undefined ? 'day' : 'calendar'));
  const [text, setText] = useState(() => textOfCalendar(stored?.calendar));
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const examples = calendarExamples();
  const draft = useMemo(() => draftOf(text), [text]);
  const preview = useMemo(() => (draft.kind === 'valid' ? previewOf(draft.definition, lensOptions) : []), [draft, lensOptions]);
  const plan = savePlan(choice, draft);

  const finish = (): void => {
    returnFocus();
    dialog.current?.close();
  };

  const save = (): void => {
    if (plan === null) return;
    const result = setCalendar(session, plan);
    if (!result.ok) {
      setRefused(result.error.message);
      return;
    }
    finish();
  };

  const remove = (): void => {
    const result = setCalendar(session, { calendar: null });
    if (!result.ok) {
      setRefused(result.error.message);
      return;
    }
    finish();
  };

  const statusId = `${ids}-status`;
  const boxId = `${ids}-box`;
  return (
    <dialog ref={dialog} className="tl-calendar" aria-labelledby={`${ids}-title`} data-testid="calendar-dialog" onClose={onClose}>
      <div className="tl-calendar-body">
        <h2 id={`${ids}-title`}>
          <Trans>Calendar</Trans>
        </h2>
        <p className="tl-calendar-lede">
          <Trans>Choose how the timeline names the days of your story. The days you set on scenes stay as they are, whichever you choose.</Trans>
        </p>

        <fieldset className="tl-calendar-choice">
          <legend>
            <Trans>The timeline names days by</Trans>
          </legend>
          <label>
            <input type="radio" name={`${ids}-lens`} checked={choice === 'day'} onChange={() => setChoice('day')} />
            <span>
              <Trans>Day numbers</Trans>
            </span>
          </label>
          <label>
            <input type="radio" name={`${ids}-lens`} checked={choice === 'calendar'} onChange={() => setChoice('calendar')} />
            <span>
              <Trans>The project calendar below</Trans>
            </span>
          </label>
        </fieldset>

        <label className="tl-calendar-field">
          <span className="field-label">
            <Trans>Start from an example</Trans>
          </span>
          <select
            value=""
            onChange={(event) => {
              const example = examples.find((candidate) => candidate.key === event.target.value);
              if (example !== undefined) setText(textOfCalendar(example.definition));
            }}
          >
            <option value="">{t`Choose an example to fill the box`}</option>
            {examples.map((example) => (
              <option key={example.key} value={example.key}>
                {exampleLabel(example.key)}
              </option>
            ))}
          </select>
        </label>

        <label className="tl-calendar-field" htmlFor={boxId}>
          <span className="field-label">
            <Trans>Calendar definition</Trans>
          </span>
        </label>
        <textarea
          id={boxId}
          className="tl-calendar-box"
          value={text}
          rows={14}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          dir="ltr"
          aria-describedby={statusId}
          aria-invalid={draft.kind === 'syntax' || draft.kind === 'invalid' || draft.kind === 'too-long'}
          onChange={(event) => {
            setText(event.target.value);
            setRefused(null);
          }}
        />

        <div id={statusId} className="tl-calendar-status" role="status" aria-live="polite">
          {draft.kind === 'empty' ? (
            <p>
              <Trans>There is no calendar yet. Pick an example above, or paste a definition, to use one.</Trans>
            </p>
          ) : null}
          {draft.kind === 'too-long' ? (
            <p className="is-error">
              <Trans>This definition is too long to keep in a project. Shorten the names, or remove months, eras or days you do not use.</Trans>
            </p>
          ) : null}
          {draft.kind === 'syntax' ? (
            <p className="is-error">{t`This is not valid JSON, so it cannot be a calendar yet: ${{ detail: draft.detail }}`}</p>
          ) : null}
          {draft.kind === 'invalid' ? (
            <>
              <p className="is-error">
                <Trans>This calendar cannot be used yet. Fix these and the timeline can use it:</Trans>
              </p>
              <ul className="tl-calendar-problems">
                {draft.problems.map((problem, index) => (
                  <li key={`${problem.field}-${index}`}>{t`${{ field: problem.field }}: ${{ message: problem.message }}`}</li>
                ))}
              </ul>
            </>
          ) : null}
          {draft.kind === 'valid' ? (
            <>
              <p>
                <Trans>This calendar can be used. The timeline would name these days:</Trans>
              </p>
              <ul className="tl-calendar-preview" data-testid="calendar-preview">
                {preview.map((entry) => (
                  <li key={entry.day}>{t`Day ${{ day: entry.day }} is ${{ label: isolate(entry.label) }}`}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>

        {refused === null ? null : (
          <p className="tl-calendar-refused" role="alert">
            {refused}
          </p>
        )}

        <div className="tl-calendar-actions">
          <button type="button" className="tl-save" disabled={plan === null} data-testid="calendar-save" onClick={save}>
            <Trans>Save</Trans>
          </button>
          {stored?.calendar === undefined ? null : (
            <button type="button" className="tl-save" data-testid="calendar-remove" onClick={remove}>
              <Trans>Remove the calendar</Trans>
            </button>
          )}
          <button type="button" className="tl-save" data-testid="calendar-cancel" onClick={finish}>
            <Trans>Cancel</Trans>
          </button>
        </div>
      </div>
    </dialog>
  );
}
