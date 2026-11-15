/**
 * The Recurring tasks section of the agent panel (agent-harness.md §12): the definitions in `tasks.json`, made and changed here, each
 * with its schedule, what it does, whether it calls a model, and the runs on this machine with what they used. Nothing in it starts a
 * task but a click; what is due is offered in `TaskOffers`. The agent has no tool for any of this.
 */

import { useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from 'react';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { WEEKDAYS, readPlanText } from '@caotang/tasks';

import { EMPTY_DRAFT, planSelfStartNote, planStarter, SELF_START_NOTE, type RecurringTasks, type RunView, type TaskDraft, type TaskRowView } from '../app/recurring-tasks.js';
import { ConfirmDialog } from './shared.js';
import { DATE_AND_TIME, formatCount, formatDateTime } from '../i18n/locale.js';
import './recurring-tasks.css';

const WEEKDAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' } as const;

const STATUS_WORDS = { done: 'Done', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped' } as const;

function usedWords(run: RunView): string {
  if (run.requests === 0) return 'no model calls';
  return `${run.requests} ${run.requests === 1 ? 'model call' : 'model calls'}, ${formatCount(run.promptTokens + run.completionTokens)} tokens`;
}

interface Editing {
  /** The task being changed, or `null` for a new one. */
  readonly id: string | null;
  readonly draft: TaskDraft;
  readonly error: string | null;
  /** The last refusal was about the plan's steps, so the editor is marked invalid and takes focus. */
  readonly stepsInvalid: boolean;
}

export function RecurringTasksPanel({
  recurring,
  headingLevel = 4,
}: {
  recurring: RecurringTasks;
  /** The section heading's level: 4 in Classic's drawer, 3 in Modern's window, whose title is the h2 (modern-interface.md §9.1). */
  headingLevel?: 3 | 4;
}): ReactNode {
  useLingui();
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  const snapshot = useSyncExternalStore(recurring.subscribe, recurring.snapshot);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<TaskRowView | null>(null);
  const [restoring, setRestoring] = useState<{ readonly turnId: string; readonly name: string } | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const newTaskRef = useRef<HTMLButtonElement | null>(null);
  const stepsRef = useRef<HTMLTextAreaElement | null>(null);
  const editSerial = useRef(0);

  const startNew = (): void => {
    editSerial.current += 1;
    setSaving(false);
    setEditing({ id: null, draft: EMPTY_DRAFT, error: null, stepsInvalid: false });
  };
  const edit = (task: TaskRowView): void => {
    editSerial.current += 1;
    setSaving(false);
    setEditing({ id: task.id, draft: task.draft, error: null, stepsInvalid: false });
  };
  const focusAfterEdit = (id: string | null): void => {
    requestAnimationFrame(() => {
      const row = id === null ? null : sectionRef.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"] [data-action="edit"]`);
      (row ?? newTaskRef.current)?.focus();
    });
  };
  const cancelEdit = (): void => {
    const id = editing?.id ?? null;
    editSerial.current += 1;
    setSaving(false);
    setEditing(null);
    focusAfterEdit(id);
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (editing === null || saving) return;
    const session = editing;
    const serial = editSerial.current;
    setSaving(true);
    void recurring.save(session.draft, session.id ?? undefined).then((failure) => {
      if (editSerial.current !== serial) return;
      setSaving(false);
      if (failure === null) {
        const saved = session.id ?? recurring.snapshot().tasks.filter((task) => task.name === session.draft.name.trim()).at(-1)?.id ?? null;
        setEditing(null);
        focusAfterEdit(saved);
        return;
      }
      const stepsInvalid = session.draft.body === 'plan' && !readPlanText(session.draft.steps).ok;
      setEditing((now) => (now === null ? now : { ...now, error: failure, stepsInvalid }));
      if (stepsInvalid) stepsRef.current?.focus();
    });
  };

  const confirmRemove = (): void => {
    const task = removing;
    setRemoving(null);
    if (task !== null) void recurring.remove(task.id);
  };

  const confirmRestore = (): void => {
    const run = restoring;
    setRestoring(null);
    if (run !== null) void recurring.restoreRun(run.turnId).then((failure) => setRestoreMessage(failure ?? 'Restored to before that run.'));
  };

  const { status } = snapshot;
  return (
    <section ref={sectionRef} className="recurring" aria-label={t`Recurring tasks`} data-testid="recurring-tasks">
      <Heading><Trans>Recurring tasks</Trans></Heading>
      <p className="recurring-note muted">
        A task runs only while this project is open in a visible tab. When one is due you are offered it, and a continuity scan, which reads
        your project and calls no model, may start by itself. Tasks live in tasks.json beside caotang.json; when each last ran is kept in
        this browser only.
      </p>
      {status.notices.length > 0 ? (
        <ul className="recurring-notices" aria-label="About the tasks file">
          {status.notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      ) : null}
      {status.saveFailure === null ? null : (
        <p className="form-message is-error" role="alert">
          {status.saveFailure}
        </p>
      )}
      {restoreMessage === null ? null : (
        <p className="form-message is-info" role="status">
          {restoreMessage}
        </p>
      )}
      {snapshot.message !== null && snapshot.offers.length === 0 ? (
        <p className="form-message is-error" role="alert">
          {snapshot.message}
        </p>
      ) : null}
      {snapshot.tasks.length === 0 && editing === null ? <p className="muted recurring-empty">No tasks yet.</p> : null}
      <ul className="recurring-list">
        {snapshot.tasks.map((task) => (
          <li key={task.id} className="recurring-task" data-task={task.id} data-enabled={task.enabled}>
            <p className="recurring-task-title">
              <strong>{task.name}</strong>
              {task.enabled ? null : <span className="recurring-off"> (off)</span>}
              {task.running ? <span className="recurring-running"> Running…</span> : null}
            </p>
            <p className="recurring-task-meta muted">
              {task.schedule} · {task.doing} · {task.usesModel ? 'Uses the model' : 'Calls no model'} ·{' '}
              {task.permission === 'read-only' ? 'May not change anything' : 'Asks before it changes anything'}
              {task.maxModelCalls === null ? '' : ` · at most ${task.maxModelCalls} model calls`}
            </p>
            {task.problem === null ? null : <p className="recurring-problem">{task.problem}</p>}
            {task.note === null ? null : <p className="recurring-task-meta">{task.note}</p>}
            <div className="recurring-actions">
              <button type="button" className="button" disabled={snapshot.running !== null || task.problem !== null} onClick={() => void recurring.runNow(task.id)}>
                Run now
                <span className="visually-hidden"> {task.name}</span>
              </button>
              <button type="button" className="button" data-action="edit" onClick={() => edit(task)}>
                Edit
                <span className="visually-hidden"> {task.name}</span>
              </button>
              <button type="button" className="button" aria-pressed={!task.enabled} onClick={() => void recurring.setEnabled(task.id, !task.enabled)}>
                {task.enabled ? 'Turn off' : 'Turn on'}
                <span className="visually-hidden"> {task.name}</span>
              </button>
              <button type="button" className="button is-quiet" onClick={() => setRemoving(task)}>
                Delete
                <span className="visually-hidden"> {task.name}</span>
              </button>
            </div>
            {task.history.length === 0 ? null : (
              <details className="recurring-history">
                <summary>
                  Runs on this machine ({task.history.length})<span className="visually-hidden"> of {task.name}</span>
                </summary>
                <ol aria-label={`Runs of ${task.name}`}>
                  {task.history.map((run) => (
                    <li key={`${run.at}:${run.status}`} data-status={run.status}>
                      <span className="recurring-run-when">{formatDateTime(new Date(run.at), DATE_AND_TIME)}</span> — <strong>{STATUS_WORDS[run.status]}</strong>
                      {run.trigger === 'manual' ? ' (started by you)' : ''}. {run.summary}{' '}
                      <span className="muted">({usedWords(run)})</span>
                      {run.canRestore && run.turnId !== undefined ? (
                        <>
                          {' '}
                          <button type="button" className="status-link" onClick={() => setRestoring({ turnId: run.turnId ?? '', name: task.name })}>
                            Restore to before this run
                          </button>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        ))}
      </ul>

      {editing === null ? (
        <button ref={newTaskRef} type="button" className="button" onClick={startNew} disabled={!status.writable}>
          <Trans>New task</Trans>
        </button>
      ) : (
        <TaskForm editing={editing} saving={saving} stepsRef={stepsRef} onChange={(draft) => setEditing({ ...editing, draft, error: null, stepsInvalid: false })} onSubmit={save} onCancel={cancelEdit} />
      )}
      {!status.writable ? <p className="muted recurring-note">The tasks file cannot be saved here, so tasks cannot be made or changed.</p> : null}

      <ConfirmDialog open={removing !== null} title="Delete this task?" confirmLabel="Delete" onCancel={() => setRemoving(null)} onConfirm={confirmRemove}>
        <p>
          “{removing?.name}” is removed from tasks.json, and the runs kept for it in this browser go with it. Nothing it did to your project
          is undone.
        </p>
      </ConfirmDialog>
      <ConfirmDialog open={restoring !== null} title="Restore to before this run?" confirmLabel="Restore" onCancel={() => setRestoring(null)} onConfirm={confirmRestore}>
        <p>
          This restores the project to its state before the run of “{restoring?.name}”. Everything you changed since then is included in the
          restore.
        </p>
      </ConfirmDialog>
    </section>
  );
}

function TaskForm({
  editing,
  saving,
  stepsRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  editing: Editing;
  saving: boolean;
  stepsRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (draft: TaskDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}): ReactNode {
  useLingui();
  const { draft } = editing;
  const stepsHelp = useId();
  const errorId = useId();
  const set = (patch: Partial<TaskDraft>): void => onChange({ ...draft, ...patch });
  const timed = draft.schedule === 'daily' || draft.schedule === 'weekly';
  const model = draft.body === 'intent' || draft.body === 'plan';
  return (
    <form className="recurring-form settings-form" noValidate aria-label={editing.id === null ? t`New task` : t`Edit task`} onSubmit={onSubmit}>
      <label>
        <span>Task name</span>
        <input type="text" autoFocus value={draft.name} maxLength={80} onChange={(event) => set({ name: event.target.value })} />
      </label>
      <label>
        <span>What it does</span>
        <select aria-label="What it does" value={draft.body} onChange={(event) => {
          const body = event.target.value as TaskDraft['body'];
          set(body === 'plan' && draft.steps === '' ? { body, steps: planStarter() } : { body });
        }}>
          <option value="intent">Ask the agent</option>
          <option value="plan">{t`Run a plan`}</option>
          <option value="scan">Scan for continuity problems</option>
        </select>
      </label>
      {draft.body === 'intent' ? (
        <label>
          <span>What to ask</span>
          <textarea aria-label="What to ask" rows={3} value={draft.text} onChange={(event) => set({ text: event.target.value })} />
        </label>
      ) : null}
      {draft.body === 'plan' ? (
        <>
          <label>
            <span>{t`Plan steps`}</span>
            <textarea ref={stepsRef} className="recurring-steps" aria-label={t`Plan steps`} aria-describedby={editing.error === null ? stepsHelp : `${stepsHelp} ${errorId}`} aria-invalid={editing.stepsInvalid} rows={8} spellCheck={false} value={draft.steps} onChange={(event) => set({ steps: event.target.value })} />
          </label>
          <p id={stepsHelp} className="muted">
            <Trans>Write the steps as a list in JSON, each with a tool, its params and what to expect. They are checked as the agent’s own plans are when you save, and the task’s permission limits what the plan may do.</Trans>
          </p>
        </>
      ) : null}
      {draft.body === 'scan' ? (
        <label>
          <span>What to scan</span>
          <select aria-label="What to scan" value={draft.scope} onChange={(event) => set({ scope: event.target.value as TaskDraft['scope'] })}>
            <option value="changed">What changed since the last scan</option>
            <option value="full">The whole manuscript</option>
          </select>
        </label>
      ) : null}
      <label>
        <span>When</span>
        <select aria-label="When" value={draft.schedule} onChange={(event) => set({ schedule: event.target.value as TaskDraft['schedule'] })}>
          <option value="manual">Only when I run it</option>
          <option value="on-open">Each time the project opens</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
        </select>
      </label>
      {draft.schedule === 'weekly' ? (
        <label>
          <span>On</span>
          <select aria-label="On" value={draft.day} onChange={(event) => set({ day: event.target.value as TaskDraft['day'] })}>
            {WEEKDAYS.map((day) => (
              <option key={day} value={day}>
                {WEEKDAY_NAMES[day]}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {timed ? (
        <label>
          <span>From</span>
          <input type="time" value={draft.at} onChange={(event) => set({ at: event.target.value })} />
        </label>
      ) : null}
      <label>
        <span>When it is due</span>
        <select aria-label="When it is due" value={draft.whenDue} onChange={(event) => set({ whenDue: event.target.value as TaskDraft['whenDue'] })}>
          <option value="offer">Offer it to me</option>
          <option value="run">Start it by itself</option>
        </select>
      </label>
      {draft.whenDue === 'run' && draft.body !== 'scan' ? <p className="muted">{draft.body === 'plan' ? planSelfStartNote() : SELF_START_NOTE}</p> : null}
      <label>
        <span>What it may do</span>
        <select aria-label="What it may do" value={draft.permission} onChange={(event) => set({ permission: event.target.value as TaskDraft['permission'] })}>
          <option value="ask">Ask before it changes anything</option>
          <option value="read-only">Change nothing</option>
        </select>
      </label>
      {model ? (
        <label>
          <span>Most model calls in a run</span>
          <input type="number" min={1} max={100} step={1} placeholder="the usual limit" value={draft.maxModelCalls} onChange={(event) => set({ maxModelCalls: event.target.value })} />
        </label>
      ) : null}
      {editing.error === null ? null : (
        <p id={errorId} className="form-message is-error" role="alert">
          {editing.error}
        </p>
      )}
      <div className="recurring-actions">
        <button type="submit" className="button is-primary" disabled={saving}>
          {saving ? t`Saving…` : t`Save task`}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
