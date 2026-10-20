/**
 * The binder's footer (binder-filters §5, goals-progress §2.2 and §4, the sprint timer): the saved filters, the project goals
 * with their progress and pace, the sprint timer, and the totals for the project and for today. Each part is a view over the
 * project. The goals and the saved filters are saved in the manifest, through the bus commands the furniture store makes
 * (furniture-store.ts). The footer also offers back the words a stopped tab kept in this browser (UnsentWords.tsx).
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  goalProgress,
  localDayOf,
  orderGoalsForFooter,
  sprintView,
  vocabularyIds,
  type GoalProbe,
  type LocalDay,
  type ProjectGoal,
  type SavedFilter,
  type SprintView,
} from '@caotang/furniture';

import { SPRINT_CHOICES, formatRemaining, goalSentence, goalStateWords, unitOf } from '../app/footer-model.js';
import type { RuntimeStore, SessionRecord } from '@caotang/store';

import { filterResultFor, furnitureFor, goalProbeOf, unknownTermsOf } from '../app/furniture-store.js';
import { nextReadDelay, sessionsEverywhere, todayLine, type TargetProgress } from '../app/session-progress.js';
import type { ProjectSession } from '../app/session.js';
import { selectNode } from './actions.js';
import { formatCount, useSession } from './shared.js';
import { UnsentWords } from './UnsentWords.js';
import { WritingHistory } from './WritingHistory.js';

export function BinderFooter({
  session,
  runtime,
  target,
}: {
  session: ProjectSession;
  /** The runtime store, which the writing history reads the sessions log from (goals-progress §9.1). */
  runtime: RuntimeStore;
  target: TargetProgress;
}): ReactNode {
  useSession(session);
  const store = furnitureFor(session);
  const furniture = useSyncExternalStore(store.subscribe, store.snapshot);
  const totalWords = Object.values(session.state.manifest.derived.wordCounts).reduce((sum, count) => sum + count, 0);

  // The lines the weekly and monthly goals count over are read from every project's log, and read again whenever this project
  // changes, so the windows follow the writing (goals-progress §9.3). A log that cannot be read leaves the windows at zero. Only a
  // session-window goal reads the log, so a project without one reads nothing here.
  const hasWindowGoal = furniture.goals.some((goal) => goal.kind === 'weekly' || goal.kind === 'monthly');
  useEffect(() => {
    if (!hasWindowGoal) return;
    let alive = true;
    let lastReadAt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = (): void => {
      lastReadAt = Date.now();
      void sessionsEverywhere(runtime).then(
        (records) => {
          if (alive) store.setSessions(records);
        },
        () => {},
      );
    };
    // The log only moves when a sitting is recorded, so a change of the session does not need its own reading of it: the reading
    // waits for the window, and the last change of a burst still gets one. Reading every project's log on every keystroke is what
    // this waits out.
    const schedule = (): void => {
      if (timer !== null) return;
      timer = setTimeout(
        () => {
          timer = null;
          load();
        },
        nextReadDelay(lastReadAt, Date.now()),
      );
    };
    load();
    const unsubscribe = session.subscribe(schedule);
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [hasWindowGoal, runtime, session, store]);

  return (
    <footer className="binder-footer" aria-label="Binder footer" data-testid="binder-footer">
      <UnsentWords session={session} />
      <SavedFilterList session={session} filters={furniture.filters} appliedId={furniture.applied?.savedId ?? null} />
      <GoalList session={session} goals={furniture.goals} sessions={furniture.sessions} />
      <SprintTimer session={session} />
      <WritingHistory store={runtime} target={target} />
      <p className="binder-totals" data-testid="binder-totals">
        <span>{formatCount(totalWords)} words in the project</span>
        <span>{todayLine(target)}</span>
      </p>
      {furniture.notices.map((notice) => (
        <p key={notice} className="field-note" role="status">
          {notice}
        </p>
      ))}
      {furniture.failure !== null ? (
        <p className="form-message is-error" role="alert">
          {furniture.failure}
        </p>
      ) : null}
    </footer>
  );
}

function SavedFilterList({
  session,
  filters,
  appliedId,
}: {
  session: ProjectSession;
  filters: readonly SavedFilter[];
  appliedId: string | null;
}): ReactNode {
  const store = furnitureFor(session);
  const vocabulary = vocabularyIds(session.state.manifest.vocabulary);
  return (
    <section className="footer-section" aria-label="Saved filters">
      <h3 className="footer-title">Saved filters</h3>
      {filters.length === 0 ? (
        <p className="field-note">None yet. Set the filter bar, then choose Save current.</p>
      ) : (
        <ul className="saved-filters">
          {filters.map((filter) => {
            const applied = filter.id === appliedId;
            return (
              <li key={filter.id} className="saved-filter" data-filter={filter.name}>
                <button
                  type="button"
                  className={`saved-filter-apply${applied ? ' is-applied' : ''}`}
                  aria-pressed={applied}
                  onClick={() => store.applySaved(filter)}
                >
                  {filter.name}
                  {applied ? <span className="rail-badge" aria-label="Scenes matching">{filterResultFor(session.state, filter.criteria, new Date()).matchCount}</span> : null}
                </button>
                {/* A term the project no longer holds matches nothing, so the row says so (binder-filters §2). */}
                {unknownTermsOf(filter.criteria, vocabulary).map((word) => (
                  <span key={word} className="filter-chip" data-kind="unknown" title="The project no longer has this term, so this filter matches nothing.">
                    {word}
                  </span>
                ))}
                <button type="button" className="button is-quiet" aria-label={`Edit ${filter.name}`} onClick={() => store.applySaved(filter)}>
                  Edit
                </button>
                <button type="button" className="button is-quiet" aria-label={`Delete ${filter.name}`} onClick={() => store.deleteFilter(filter.id)}>
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function GoalList({
  session,
  goals,
  sessions,
}: {
  session: ProjectSession;
  goals: readonly ProjectGoal[];
  sessions: readonly SessionRecord[];
}): ReactNode {
  const probe = goalProbeOf(session, sessions);
  const today = localDayOf(new Date());
  // The footer keeps one line: the nearest project goal by deadline (goals-progress §4). The weekly and monthly goals are session
  // windows, and the inspector shows them beside the manuscript. Adding, changing and removing goals is the inspector's.
  const [nearest] = orderGoalsForFooter(goals.filter((goal) => (goal.kind ?? 'project') === 'project'));
  return (
    <section className="footer-section" aria-label="Project goals">
      <h3 className="footer-title">Goals</h3>
      {nearest === undefined ? (
        <p className="field-note">No project goals yet. Select the manuscript or a folder, then add one in the inspector.</p>
      ) : (
        <GoalSummary session={session} goal={nearest} probe={probe} today={today} />
      )}
    </section>
  );
}

/**
 * The nearest goal as one line: its sentence, and its progress. A click selects the goal's node, which opens the inspector's Goals
 * section, where the goal is changed or removed (goals-progress §4).
 */
function GoalSummary({
  session,
  goal,
  probe,
  today,
}: {
  session: ProjectSession;
  goal: ProjectGoal;
  probe: GoalProbe;
  today: LocalDay;
}): ReactNode {
  const node = session.state.manifest.tree.find((candidate) => candidate.id === goal.nodeId);
  const title = node === undefined ? 'a folder that is gone' : node.title;
  const progress = goalProgress(goal, probe, today);
  return (
    <button
      type="button"
      className={`goal-summary is-${progress.state}`}
      data-goal={goal.id}
      data-goal-state={progress.state}
      title="Open its goals in the inspector"
      onClick={() => selectNode(session, goal.nodeId)}
    >
      <span className="goal-sentence">{goalSentence(goal, title)}</span>{' '}
      <span className="goal-line" data-testid="goal-progress">
        {formatCount(progress.current)} of {formatCount(goal.target)} {unitOf(goal)} · {goalStateWords(progress.state)}
      </span>
    </button>
  );
}

/** The sprint timer (sprint.ts): a countdown the writer starts, with the words typed while it runs. View state, not saved. */
export function SprintTimer({ session }: { session: ProjectSession }): ReactNode {
  useSession(session);
  const store = furnitureFor(session);
  const furniture = useSyncExternalStore(store.subscribe, store.snapshot);
  const [now, setNow] = useState(() => Date.now());
  const running = furniture.sprint.status === 'running';

  // While the sprint runs, the display and the sprint's clock move once a second.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const at = Date.now();
      store.sprintEvent({ type: 'tick', at, words: store.sittingWords() });
      setNow(at);
    }, 1000);
    return () => clearInterval(timer);
  }, [running, store]);

  const reading: SprintView = sprintView(furniture.sprint, now);
  const minutes = Math.round(furniture.sprint.durationMs / 60_000);
  return (
    <section className="footer-section sprint" aria-label="Sprint timer" data-testid="sprint">
      <h3 className="footer-title">Sprint</h3>
      <p className="sprint-reading" data-testid="sprint-reading">
        {reading.status === 'finished' ? (reading.endReason === 'time-up' ? 'Time is up.' : 'Stopped.') : formatRemaining(reading.remainingMs)}
        {reading.wordsGained > 0 ? ` · ${formatCount(reading.wordsGained)} ${reading.wordsGained === 1 ? 'word' : 'words'}` : ''}
        {reading.wpm !== null ? ` · ${Math.round(reading.wpm)} wpm` : ''}
      </p>
      {/* The sprint's end is said once, here: the reading above moves every second, and a live region on it would talk all the time. */}
      <p className="visually-hidden" role="status">
        {reading.status === 'finished' ? (reading.endReason === 'time-up' ? 'Time is up.' : 'Stopped.') : ''}
      </p>
      <div className="sprint-actions">
        {furniture.sprint.status === 'idle' || furniture.sprint.status === 'finished' ? (
          <button
            type="button"
            className="button is-primary"
            onClick={() => {
              // A finished sprint takes only a reset (sprint.ts), so the next one is started from a reset.
              if (furniture.sprint.status === 'finished') store.sprintEvent({ type: 'reset' });
              store.sprintEvent({ type: 'start', at: Date.now(), words: store.sittingWords() });
            }}
          >
            Start sprint
          </button>
        ) : null}
        {furniture.sprint.status === 'running' ? (
          <button type="button" className="button" onClick={() => store.sprintEvent({ type: 'pause', at: Date.now(), words: store.sittingWords() })}>
            Pause
          </button>
        ) : null}
        {furniture.sprint.status === 'paused' ? (
          <button type="button" className="button is-primary" onClick={() => store.sprintEvent({ type: 'resume', at: Date.now(), words: store.sittingWords() })}>
            Resume
          </button>
        ) : null}
        {furniture.sprint.status === 'running' || furniture.sprint.status === 'paused' ? (
          <button type="button" className="button is-quiet" onClick={() => store.sprintEvent({ type: 'stop', at: Date.now(), words: store.sittingWords() })}>
            Stop
          </button>
        ) : null}
        {furniture.sprint.status !== 'idle' ? (
          <button type="button" className="button is-quiet" onClick={() => store.sprintEvent({ type: 'reset' })}>
            Reset
          </button>
        ) : null}
        <label className="sprint-length">
          <span>Minutes</span>
          <select
            aria-label="Sprint length in minutes"
            value={String(minutes)}
            disabled={furniture.sprint.status !== 'idle' && furniture.sprint.status !== 'finished'}
            onChange={(event) => {
              if (furniture.sprint.status === 'finished') store.sprintEvent({ type: 'reset' });
              store.sprintEvent({ type: 'setDuration', minutes: Number(event.target.value) });
            }}
          >
            {SPRINT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
