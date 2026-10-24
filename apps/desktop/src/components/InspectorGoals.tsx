/**
 * The inspector's Goals section for a folder or the manuscript (goals-progress §4): the goals attached to this node, with their
 * progress and pace, and the form that adds a goal or changes one. The binder footer keeps one summary line; the goals are made,
 * changed and removed here, beside the node they are about. Every change is a bus command (`project.saveGoal`,
 * `project.deleteGoal`), through the furniture store.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { MONTHLY_RESET_MAX, goalProgress, localDayOf, localeFirstWeekday, type ProjectGoal } from '@caotang/furniture';
import type { TreeNode } from '@caotang/store';

import {
  WEEKDAY_NAMES,
  formatDay,
  goalSentence,
  goalStateWords,
  ordinalDay,
  paceCountOf,
  resetSentence,
  unitOf,
} from '../app/footer-model.js';
import { furnitureFor, goalProbeOf } from '../app/furniture-store.js';
import type { ProjectSession } from '../app/session.js';
import { formatCount, useComposingEnter, useReport, useSession } from './shared.js';

type Comparator = 'at-least' | 'at-most' | 'about';
type Measure = 'words' | 'chars';
type Kind = 'project' | 'weekly' | 'monthly';

export function InspectorGoals({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useSession(session);
  const store = furnitureFor(session);
  const furniture = useSyncExternalStore(store.subscribe, store.snapshot);
  const report = useReport();
  // The form holds one goal's fields: a new goal, or the goal being changed (`editing` names its id).
  const [editing, setEditing] = useState<string | null>(null);
  const [comparator, setComparator] = useState<Comparator>('at-least');
  const [metric, setMetric] = useState<Measure>('words');
  const [kind, setKind] = useState<Kind>('project');
  // A weekly or monthly goal's reset day, as the select holds it: '' for the default, a weekday or day number, or 'last' (§9.3).
  const [reset, setReset] = useState('');
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState('');
  const figure = useRef<HTMLInputElement>(null);
  /** The Edit button that opened the form: Cancel hands the focus back to it, since the Cancel button leaves the page with the form. */
  const opener = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLUListElement>(null);
  // The goal form saves on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from saving a goal.
  const ime = useComposingEnter();

  const goals = furniture.goals.filter((goal) => goal.nodeId === node.id);
  const probe = goalProbeOf(session, furniture.sessions);
  const today = localDayOf(new Date());
  const title = node.id === 'manuscript' ? 'the manuscript' : node.title;
  // A weekly or monthly goal is the manuscript's, a minimum in words with no date (goals-progress §9.3), so only the manuscript offers them.
  const onManuscript = node.id === 'manuscript';
  const windowed = kind !== 'project';
  const measured = metric === 'chars' && !windowed ? 'characters' : 'words';
  // A weekly goal with no reset day of its own starts on the first day of the week in the writer's locale (goals-progress §9.3).
  const firstWeekday = localeFirstWeekday(typeof navigator === 'undefined' ? undefined : navigator.language);

  // Changing a goal puts the focus on its figure, so a writer at the keyboard is already where the change is made.
  useEffect(() => {
    if (editing !== null) figure.current?.focus();
  }, [editing]);

  const clear = (): void => {
    opener.current = null;
    setEditing(null);
    setComparator('at-least');
    setMetric('words');
    setKind('project');
    setReset('');
    setTarget('');
    setDeadline('');
  };

  /** Cancel leaves the form, and the focus returns to the Edit button that opened it, rather than to the body. */
  const cancel = (): void => {
    const back = opener.current;
    clear();
    back?.focus();
  };

  /** Loads a goal into the form, with its id, so the submit changes that goal rather than adding one. */
  const edit = (goal: ProjectGoal, button: HTMLButtonElement): void => {
    opener.current = button;
    setEditing(goal.id);
    setComparator(goal.comparator);
    setMetric(goal.metric === 'chars' ? 'chars' : 'words');
    setKind(goal.kind ?? 'project');
    // A monthly reset on the 1st is the default, which the select offers once, as the default.
    setReset(goal.resetDay === undefined || (goal.kind === 'monthly' && goal.resetDay === 1) ? '' : String(goal.resetDay));
    setTarget(String(goal.target));
    setDeadline(goal.deadline ?? '');
  };

  /**
   * Removes a goal. Its row leaves the page with its Remove button, so the focus moves to the Edit button of the goal that takes
   * its place (the next one, or the one before when it was last), or to the form's figure when no goal is left, rather than to
   * the body.
   */
  const remove = (goal: ProjectGoal, index: number): void => {
    // A goal removed while its form is open leaves the form empty, so a later save cannot bring it back under its id.
    if (editing === goal.id) clear();
    const neighbour = goals[index + 1] ?? goals[index - 1];
    store.deleteGoal(goal.id);
    if (store.snapshot().goals.some((kept) => kept.id === goal.id)) return;
    const next =
      neighbour === undefined
        ? null
        : list.current?.querySelector<HTMLButtonElement>(`li[data-goal="${CSS.escape(neighbour.id)}"] .goal-actions button`);
    (next ?? figure.current)?.focus();
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const amount = Number(target);
    if (!Number.isInteger(amount) || amount <= 0) {
      report({ text: `A goal needs a whole number of ${measured} above zero.`, tone: 'error' });
      return;
    }
    const outcome = store.saveGoal({
      ...(editing === null ? {} : { id: editing }),
      nodeId: windowed ? 'manuscript' : node.id,
      metric: windowed ? 'words' : metric,
      kind,
      resetDay: !windowed || reset === '' ? null : reset === 'last' ? 'last' : Number(reset),
      comparator: windowed ? 'at-least' : comparator,
      target: amount,
      deadline: windowed || deadline === '' ? null : deadline,
    });
    if (!outcome.ok) {
      report({ text: outcome.errors.join(' '), tone: 'error' });
      return;
    }
    clear();
  };

  return (
    <section className="inspector-section inspector-goals" aria-labelledby="inspector-goals-label" data-testid="inspector-goals">
      <h3 id="inspector-goals-label" className="field-label">
        Goals
      </h3>
      {goals.length === 0 ? <p className="field-note">No goals on {title} yet.</p> : null}
      <ul ref={list} className="goal-list">
        {goals.map((goal, index) => {
          const progress = goalProgress(goal, probe, today, { firstWeekday });
          const sentence = goalSentence(goal, node.title);
          const resets = resetSentence(goal, firstWeekday);
          return (
            <li key={goal.id} className={`goal is-${progress.state}`} data-goal={goal.id} data-goal-state={progress.state}>
              <p className="goal-sentence">{sentence}</p>
              {resets === undefined ? null : <p className="field-note goal-reset">{resets}</p>}
              <progress className="goal-progress" max={goal.target} value={Math.min(progress.current, goal.target)} aria-label={`Progress toward ${title}`} />
              <p className="goal-line">
                {formatCount(progress.current)} of {formatCount(goal.target)} {unitOf(goal)} · {goalStateWords(progress.state)}
              </p>
              {progress.pace !== undefined ? (
                <p className="goal-pace">
                  ≈ {paceCountOf(goal, progress.pace.perDay)}/day to finish
                  {goal.kind === 'weekly' ? ' this week' : goal.kind === 'monthly' ? ' this month' : goal.deadline === undefined ? '' : ` by ${formatDay(goal.deadline)}`}
                </p>
              ) : null}
              <div className="goal-actions">
                <button
                  type="button"
                  className="button is-quiet"
                  aria-label={`Edit the goal ${sentence}`}
                  onClick={(event) => edit(goal, event.currentTarget)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button is-quiet"
                  aria-label={`Remove the goal ${sentence}`}
                  onClick={() => remove(goal, index)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <form className="goal-add" aria-label={`${editing === null ? 'Add a goal on' : 'Change a goal on'} ${title}`} onKeyDown={ime.noteKey} onSubmit={submit}>
        <label>
          <span>Comparison</span>
          <select
            aria-label="Inspector goal comparison"
            value={windowed ? 'at-least' : comparator}
            disabled={windowed}
            onChange={(event) => setComparator(event.target.value as Comparator)}
          >
            <option value="at-least">At least</option>
            <option value="at-most">At most</option>
            <option value="about">About</option>
          </select>
        </label>
        <label>
          <span>Measure</span>
          <select
            aria-label="Inspector goal measure"
            value={windowed ? 'words' : metric}
            disabled={windowed}
            onChange={(event) => setMetric(event.target.value as Measure)}
          >
            <option value="words">Words</option>
            <option value="chars">Characters</option>
          </select>
        </label>
        <label>
          <span>Kind</span>
          <select
            aria-label="Inspector goal kind"
            value={kind}
            onChange={(event) => {
              // A weekly reset day is not a monthly one, so a change of kind starts again from the default.
              setKind(event.target.value as Kind);
              setReset('');
            }}
          >
            <option value="project">Project</option>
            {onManuscript ? <option value="weekly">Weekly</option> : null}
            {onManuscript ? <option value="monthly">Monthly</option> : null}
          </select>
        </label>
        {windowed ? (
          <label>
            {/* No aria-label: the wrapping label's visible words name the select (WCAG 2.5.3). */}
            <span>{kind === 'weekly' ? 'Week starts on' : 'Month starts on'}</span>
            <select value={reset} onChange={(event) => setReset(event.target.value)}>
              {kind === 'weekly' ? (
                <>
                  <option value="">{WEEKDAY_NAMES[firstWeekday]}, your locale&apos;s first day</option>
                  {WEEKDAY_NAMES.map((name, day) => (
                    <option key={name} value={String(day)}>
                      {name}
                    </option>
                  ))}
                </>
              ) : (
                <>
                  <option value="">The 1st (the default)</option>
                  {Array.from({ length: MONTHLY_RESET_MAX - 1 }, (_, index) => index + 2).map((day) => (
                    <option key={day} value={String(day)}>
                      The {ordinalDay(day)}
                    </option>
                  ))}
                  <option value="last">The last day of the month</option>
                </>
              )}
            </select>
          </label>
        ) : null}
        <label>
          <span>{windowed || metric === 'words' ? 'Words' : 'Characters'}</span>
          <input
            ref={figure}
            type="number"
            min={1}
            aria-label={windowed || metric === 'words' ? 'Inspector goal words' : 'Inspector goal characters'}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        <label>
          <span>By (optional)</span>
          {/* No aria-label: the wrapping label names the date, so its visible words are its accessible name (WCAG 2.5.3). */}
          <input
            type="date"
            value={deadline}
            disabled={windowed}
            onChange={(event) => setDeadline(event.target.value)}
          />
        </label>
        <div className="goal-form-actions">
          <button type="submit" className="button">
            {editing === null ? 'Add goal' : 'Save goal'}
          </button>
          {editing === null ? null : (
            <button type="button" className="button is-quiet" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
