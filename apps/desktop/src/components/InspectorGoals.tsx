/**
 * The inspector's Goals section for a folder or the manuscript (goals-progress §4): the goals attached to this node, with their
 * progress and pace, and the form that adds a goal or changes one. The binder footer keeps one summary line; the goals are made,
 * changed and removed here, beside the node they are about. Every change is a bus command (`project.saveGoal`,
 * `project.deleteGoal`), through the furniture store.
 */

import { isolate } from '@caotang/i18n';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { MONTHLY_RESET_MAX, goalProgress, localDayOf, localeFirstWeekday, type ProjectGoal } from '@caotang/furniture';
import type { TreeNode } from '@caotang/store';

import {
  formatDay,
  goalSentence,
  goalStateWords,
  ordinalDay,
  paceCountOf,
  resetSentence,
  unitOf,
  weekdayName,
} from '../app/footer-model.js';
import { furnitureFor, goalProbeOf } from '../app/furniture-store.js';
import type { ProjectSession } from '../app/session.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { formatterLocale } from '../i18n/format-locale.js';
import { formatCount, useComposingEnter, useReport, useSession } from './shared.js';


/* lingui-set comment="Goals in the Inspector. Interpolated values: title is the writer's own title for the item; current, target and pace are counts; unit and state are words; sentence is a whole goal sentence; weekday and day name a day." */
type Comparator = 'at-least' | 'at-most' | 'about';
type Measure = 'words' | 'chars';
type Kind = 'project' | 'weekly' | 'monthly';

function paceSentence(goal: ProjectGoal, pace: string): string {
  if (goal.kind === 'weekly') return t`≈ ${{ pace }}/day to finish this week`;
  if (goal.kind === 'monthly') return t`≈ ${{ pace }}/day to finish this month`;
  if (goal.deadline === undefined) return t`≈ ${{ pace }}/day to finish`;
  const by = formatDay(goal.deadline);
  return t`≈ ${{ pace }}/day to finish by ${{ by }}`;
}

export function InspectorGoals({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useLingui();
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
  // A weekly or monthly goal is the manuscript's, a minimum in words with no date (goals-progress §9.3), so only the manuscript offers them.
  const onManuscript = node.id === 'manuscript';
  const windowed = kind !== 'project';
  const measured = metric === 'chars' && !windowed ? 'characters' : 'words';
  // A weekly goal with no reset day of its own starts on the first day of the week in the writer's locale (goals-progress §9.3).
  // The week a goal resets on follows the formatter locale, not the system locale (i18n.md §4.2): a German UI on an American
  // machine starts its weeks on Monday.
  const firstWeekday = localeFirstWeekday(formatterLocale());

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
      report({ text: measured === 'characters' ? t`A goal needs a whole number of characters above zero.` : t`A goal needs a whole number of words above zero.`, tone: 'error' });
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
        <Trans>Goals</Trans>
      </h3>
      {goals.length === 0 ? <p className="field-note">{onManuscript ? t`No goals on the manuscript yet.` : t`No goals on ${{ title: isolate(node.title) }} yet.`}</p> : null}
      <ul ref={list} className="goal-list">
        {goals.map((goal, index) => {
          const progress = goalProgress(goal, probe, today, { firstWeekday });
          const sentence = goalSentence(goal, node.title);
          const resets = resetSentence(goal, firstWeekday);
          return (
            <li key={goal.id} className={`goal is-${progress.state}`} data-goal={goal.id} data-goal-state={progress.state}>
              <p className="goal-sentence">{sentence}</p>
              {resets === undefined ? null : <p className="field-note goal-reset">{resets}</p>}
              <progress className="goal-progress" max={goal.target} value={Math.min(progress.current, goal.target)} aria-label={accessibleText(onManuscript ? t`Progress toward the manuscript` : t`Progress toward ${{ title: isolate(node.title) }}`)} />
              <p className="goal-line">
                {t`${{ current: formatCount(progress.current) }} of ${{ target: formatCount(goal.target) }} ${{ unit: unitOf(goal) }} · ${{ state: goalStateWords(progress.state) }}`}
              </p>
              {progress.pace !== undefined ? (
                <p className="goal-pace">
                  {paceSentence(goal, paceCountOf(goal, progress.pace.perDay))}
                </p>
              ) : null}
              <div className="goal-actions">
                <button
                  type="button"
                  className="button is-quiet"
                  aria-label={accessibleText(t`Edit the goal ${{ sentence }}`)}
                  onClick={(event) => edit(goal, event.currentTarget)}
                >
                  <Trans>Edit</Trans>
                </button>
                <button
                  type="button"
                  className="button is-quiet"
                  aria-label={accessibleText(t`Remove the goal ${{ sentence }}`)}
                  onClick={() => remove(goal, index)}
                >
                  <Trans>Remove</Trans>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <form className="goal-add" aria-label={accessibleText(editing === null ? (onManuscript ? t`Add a goal on the manuscript` : t`Add a goal on ${{ title: isolate(node.title) }}`) : onManuscript ? t`Change a goal on the manuscript` : t`Change a goal on ${{ title: isolate(node.title) }}`)} onKeyDown={ime.noteKey} onSubmit={submit}>
        <label>
          <span><Trans>Comparison</Trans></span>
          <select
            aria-label={t`Inspector goal comparison`}
            value={windowed ? 'at-least' : comparator}
            disabled={windowed}
            onChange={(event) => setComparator(event.target.value as Comparator)}
          >
            <option value="at-least"><Trans>At least</Trans></option>
            <option value="at-most"><Trans>At most</Trans></option>
            <option value="about"><Trans>About</Trans></option>
          </select>
        </label>
        <label>
          <span><Trans>Measure</Trans></span>
          <select
            aria-label={t`Inspector goal measure`}
            value={windowed ? 'words' : metric}
            disabled={windowed}
            onChange={(event) => setMetric(event.target.value as Measure)}
          >
            <option value="words"><Trans>Words</Trans></option>
            <option value="chars"><Trans>Characters</Trans></option>
          </select>
        </label>
        <label>
          <span><Trans>Kind</Trans></span>
          <select
            aria-label={t`Inspector goal kind`}
            value={kind}
            onChange={(event) => {
              // A weekly reset day is not a monthly one, so a change of kind starts again from the default.
              setKind(event.target.value as Kind);
              setReset('');
            }}
          >
            <option value="project"><Trans>Project</Trans></option>
            {onManuscript ? <option value="weekly"><Trans>Weekly</Trans></option> : null}
            {onManuscript ? <option value="monthly"><Trans>Monthly</Trans></option> : null}
          </select>
        </label>
        {windowed ? (
          <label>
            {/* No aria-label: the wrapping label's visible words name the select (WCAG 2.5.3). */}
            <span>{kind === 'weekly' ? t`Week starts on` : t`Month starts on`}</span>
            <select value={reset} onChange={(event) => setReset(event.target.value)}>
              {kind === 'weekly' ? (
                <>
                  <option value="">{t`${{ weekday: weekdayName(firstWeekday) }}, your locale’s first day`}</option>
                  {Array.from({ length: 7 }, (_, day) => weekdayName(day)).map((name, day) => (
                    <option key={name} value={String(day)}>
                      {name}
                    </option>
                  ))}
                </>
              ) : (
                <>
                  <option value=""><Trans>The 1st (the default)</Trans></option>
                  {Array.from({ length: MONTHLY_RESET_MAX - 1 }, (_, index) => index + 2).map((day) => (
                    <option key={day} value={String(day)}>
                      {t`The ${{ day: ordinalDay(day) }}`}
                    </option>
                  ))}
                  <option value="last"><Trans>The last day of the month</Trans></option>
                </>
              )}
            </select>
          </label>
        ) : null}
        <label>
          <span>{windowed || metric === 'words' ? t`Words` : t`Characters`}</span>
          <input
            ref={figure}
            type="number"
            min={1}
            aria-label={windowed || metric === 'words' ? t`Inspector goal words` : t`Inspector goal characters`}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        <label>
          <span><Trans>By (optional)</Trans></span>
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
            {editing === null ? t`Add goal` : t`Save goal`}
          </button>
          {editing === null ? null : (
            <button type="button" className="button is-quiet" onClick={cancel}>
              <Trans>Cancel</Trans>
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
