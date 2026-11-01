/**
 * The editor status bar's daily target as a control (goals-progress §4): the session ring and today's line are one button, and the
 * button opens a small form that sets the target. Saving writes the app setting `session.dailyTargetWords` through the settings
 * store, not a bus command (goals-progress §4). Zero clears the target, as Settings says. Escape, Cancel and a save all return focus
 * to the button.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { targetQuickSetLine, type TargetProgress } from '../app/session-progress.js';
import { TARGET_MAX_WORDS } from '../app/settings.js';
import { targetDraftOf } from '../app/target-draft.js';
import { SessionRing } from './SessionRing.js';
import { useComposingEnter } from './shared.js';
import './target-quick-set.css';

export function TargetQuickSet({ progress, onSetTarget }: { progress: TargetProgress; onSetTarget: (words: number) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const formId = useId();
  // The form saves on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from setting the target.
  const ime = useComposingEnter();

  // Opening the form puts the writer in its field, with the current target there to change.
  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    field.current?.select();
  }, [open]);

  const openForm = (): void => {
    setText(String(progress.target ?? 0));
    setProblem(null);
    setOpen(true);
  };

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const draft = targetDraftOf(text);
    if (!draft.ok) {
      setProblem(draft.message);
      return;
    }
    onSetTarget(draft.words);
    close();
  };

  const line = targetQuickSetLine(progress);
  return (
    <span className="editor-target" data-testid="session-target">
      <span className="target-quick-set-control">
        <button
          ref={button}
          type="button"
          className="target-button"
          aria-expanded={open}
          aria-controls={open ? formId : undefined}
          title={t`Set the daily target`}
          onClick={() => (open ? close() : openForm())}
        >
          <SessionRing progress={progress} />
          {line}
        </button>
        {open ? (
          <form
            id={formId}
            className="target-quick-set"
            aria-label={t`Daily target`}
            // The form's own check (targetDraftOf) says what is wrong, so the browser's native bubble does not pre-empt it.
            noValidate
            onSubmit={save}
            onKeyDown={(event) => {
              ime.noteKey(event);
              if (event.key !== 'Escape') return;
              event.preventDefault();
              close();
            }}
          >
            <label className="target-quick-set-field">
              <span>
                <Trans>Daily target, in words (0 for none)</Trans>
              </span>
              <input
                ref={field}
                type="number"
                min={0}
                max={TARGET_MAX_WORDS}
                step={1}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setProblem(null);
                }}
              />
            </label>
            {problem !== null ? (
              <p className="form-message is-error" role="alert">
                {problem}
              </p>
            ) : null}
            <div className="target-quick-set-actions">
              <button type="button" className="button is-quiet" onClick={close}>
                <Trans>Cancel</Trans>
              </button>
              <button type="submit" className="button is-primary">
                <Trans>Save target</Trans>
              </button>
            </div>
          </form>
        ) : null}
      </span>
    </span>
  );
}
