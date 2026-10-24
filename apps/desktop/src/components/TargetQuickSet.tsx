/**
 * The editor status bar's daily target as a control (goals-progress §4): the session ring and today's line are one button, and the
 * button opens a small form that sets the target. Saving writes the app setting `session.dailyTargetWords` through the settings
 * store, not a bus command (goals-progress §4). Zero clears the target, as Settings says. Escape, Cancel and a save all return focus
 * to the button.
 */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { todayLine, type TargetProgress } from '../app/session-progress.js';
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

  const line = todayLine(progress);
  return (
    <span className="editor-target" data-testid="session-target">
      <span className="target-quick-set-control">
        <button
          ref={button}
          type="button"
          className="target-button"
          aria-expanded={open}
          aria-controls={open ? formId : undefined}
          title="Set the daily target"
          onClick={() => (open ? close() : openForm())}
        >
          <SessionRing progress={progress} />
          {line}
          {progress.target === undefined ? ' · set a daily target' : ''}
          {progress.met ? '. Today’s target is met.' : ''}
        </button>
        {open ? (
          <form
            id={formId}
            className="target-quick-set"
            aria-label="Daily target"
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
              <span>Daily target, in words (0 for none)</span>
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
                Cancel
              </button>
              <button type="submit" className="button is-primary">
                Save target
              </button>
            </div>
          </form>
        ) : null}
      </span>
    </span>
  );
}
