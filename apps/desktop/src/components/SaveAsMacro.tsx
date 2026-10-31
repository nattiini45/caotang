/**
 * "Save as macro…" under a plan the writer approved and the agent ran ([extensibility.md §10](../../../../docs/architecture/extensibility.md)).
 * The writer names the macro and marks which values of the plan are to be filled in each time; every other value stays as the plan had it.
 * The dialog shows what the macro would be, and a macro that would not run as exactly the plan it came from is not offered for saving, so
 * a saved macro always reproduces the plan it was made from.
 *
 * It speaks of "macros", "steps" and "values". The agent never makes a macro: this is the writer's gesture, on a plan the writer approved.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import type { PlanStepView } from '@caotang/harness';

import { leafKey, leavesOf, macroFromPlan, pathLabel, paramNameFor, slugFromName, type MarkedLeaves } from '../app/macro-model.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { useReport } from './shared.js';
import './macros.css';
import './project-dialogs.css';

/** The longest a value is shown in the list; the value itself is kept whole. */
const SHOWN_MAX = 80;

const shown = (value: string | number | boolean): string => {
  const text = typeof value === 'string' ? `“${value}”` : String(value);
  return [...text].length > SHOWN_MAX ? `${[...text].slice(0, SHOWN_MAX).join('')}…` : text;
};

/** The button under an approved plan, and the dialog it opens. */
export function SaveAsMacro({ session, steps, intent }: { session: ProjectSession; steps: readonly PlanStepView[]; intent: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-save-macro">
      <button type="button" className="button is-quiet" data-testid="save-as-macro" onClick={() => setOpen(true)}>
        Save as macro…
      </button>
      {open ? <SaveDialog session={session} steps={steps} intent={intent} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function SaveDialog({ session, steps, intent, onClose }: { session: ProjectSession; steps: readonly PlanStepView[]; intent: string; onClose: () => void }): ReactNode {
  const report = useReport();
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [marks, setMarks] = useState<MarkedLeaves>({});
  const [problem, setProblem] = useState<string | null>(null);
  const leaves = leavesOf(steps);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const plan = steps.map((step) => ({ tool: step.tool, params: step.params, expect: step.expect }));
  const made = macroFromPlan(plan, { name, description, slug: '' }, marks);
  const mark = (key: string, on: boolean, fallback: string): void => {
    const next = { ...marks };
    if (on) next[key] = fallback;
    else delete next[key];
    setMarks(next);
  };

  const save = (): void => {
    if ('problem' in made) {
      setProblem(made.problem);
      return;
    }
    const result = session.saveMacro(made.draft);
    if (!result.ok) {
      setProblem(explain(result.error));
      return;
    }
    report({ text: `Saved the macro “${made.draft.name}”. Run it from Settings › Macros.`, tone: 'info' });
    onClose();
  };

  return (
    <dialog
      ref={dialog}
      className="project-dialog macro-save-dialog"
      aria-labelledby="macro-save-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="project-dialog-body">
        <h2 id="macro-save-title">Save as macro</h2>
        <p className="project-dialog-help">
          Saves these {steps.length === 1 ? 'step' : `${steps.length} steps`} so you can run them again. Mark the values that change from one run to the
          next; they are asked for each time and start as they are here. Everything else stays as it is in the plan.
        </p>
        <div className="project-dialog-field">
          <label htmlFor="macro-save-name">Name</label>
          <input
            id="macro-save-name"
            type="text"
            value={name}
            placeholder={intent.slice(0, 60)}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
          />
          {name.trim() !== '' && slugFromName(name) === '' ? <span className="project-dialog-help">Use some letters or digits in the name.</span> : null}
        </div>
        <div className="project-dialog-field">
          <label htmlFor="macro-save-description">Description (optional)</label>
          <input id="macro-save-description" type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        {leaves.length === 0 ? null : (
          <fieldset className="macros-values">
            <legend>Values to fill in each time</legend>
            <ul className="macro-leaves">
              {leaves.map((leaf) => {
                const key = leafKey(leaf);
                const label = `Step ${leaf.step + 1}, ${pathLabel(leaf.path)}`;
                return (
                  <li key={key} className="macro-leaf">
                    <input
                      type="checkbox"
                      aria-label={`Ask for ${label}`}
                      checked={marks[key] !== undefined}
                      onChange={(event) => mark(key, event.target.checked, paramNameFor(leaf.path))}
                    />
                    <span className="macro-leaf-value">
                      {label}: {shown(leaf.value)}
                    </span>
                    {marks[key] === undefined ? null : (
                      <input
                        type="text"
                        className="macro-leaf-name"
                        aria-label={`Name of the value for ${label}`}
                        value={marks[key]}
                        onChange={(event) => setMarks({ ...marks, [key]: event.target.value })}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        {problem !== null ? (
          <p className="project-dialog-error" role="alert">
            {problem}
          </p>
        ) : 'problem' in made && name.trim() !== '' ? (
          <p className="project-dialog-error" role="status">
            {made.problem}
          </p>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="button is-primary" disabled={'problem' in made} onClick={save}>
            Save macro
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
