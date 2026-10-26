/**
 * The Recurring tasks section of the agent panel (agent-harness.md §12): the definitions in `tasks.json`, made and changed here, each
 * with its schedule, what it does, whether it calls a model, and the runs on this machine with what they used. Nothing in it starts a
 * task but a click; what is due is offered in `TaskOffers`. The agent has no tool for any of this.
 */

import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';

import { WEEKDAYS } from '@caotang/tasks';

import { EMPTY_DRAFT, SELF_START_NOTE, type RecurringTasks, type RunView, type TaskDraft, type TaskRowView } from '../app/recurring-tasks.js';
import { ConfirmDialog } from './shared.js';

const WEEKDAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' } as const;

const STATUS_WORDS = { done: 'Done', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped' } as const;

function usedWords(run: RunView): string {
  if (run.requests === 0) return 'no model calls';
  return `${run.requests} ${run.requests === 1 ? 'model call' : 'model calls'}, ${(run.promptTokens + run.completionTokens).toLocaleString('en-US')} tokens`;
}

interface Editing {
  /** The task being changed, or `null` for a new one. */
  readonly id: string | null;
  readonly draft: TaskDraft;
  readonly bodyEditable: boolean;
  readonly error: string | null;
}

export function RecurringTasksPanel({ recurring }: { recurring: RecurringTasks }): ReactNode {
  const snapshot = useSyncExternalStore(recurring.subscribe, recurring.snapshot);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<TaskRowView | null>(null);
  const [restoring, setRestoring] = useState<{ readonly turnId: string; readonly name: string } | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

  const startNew = (): void => setEditing({ id: null, draft: EMPTY_DRAFT, bodyEditable: true, error: null });
  const edit = (task: TaskRowView): void => setEditing({ id: task.id, draft: task.draft, bodyEditable: task.bodyEditable, error: null });

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (editing === null) return;
    void recurring.save(editing.draft, editing.id ?? undefined).then((failure) => {
      if (failure === null) setEditing(null);
      else setEditing((now) => (now === null ? now : { ...now, error: failure }));
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
    <section className="recurring" aria-label="Recurring tasks" data-testid="recurring-tasks">
      <h4>Recurring tasks</h4>
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
              <button type="button" className="button" onClick={() => edit(task)}>
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
                      <span className="recurring-run-when">{new Date(run.at).toLocaleString()}</span> — <strong>{STATUS_WORDS[run.status]}</strong>
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
        <button type="button" className="button" onClick={startNew} disabled={!status.writable}>
          New task
        </button>
      ) : (
        <TaskForm editing={editing} onChange={(draft) => setEditing({ ...editing, draft, error: null })} onSubmit={save} onCancel={() => setEditing(null)} />
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
  onChange,
  onSubmit,
  onCancel,
}: {
  editing: Editing;
  onChange: (draft: TaskDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}): ReactNode {
  const { draft } = editing;
  const set = (patch: Partial<TaskDraft>): void => onChange({ ...draft, ...patch });
  const timed = draft.schedule === 'daily' || draft.schedule === 'weekly';
  const model = draft.body === 'intent';
  return (
    <form className="recurring-form settings-form" noValidate aria-label={editing.id === null ? 'New task' : 'Edit task'} onSubmit={onSubmit}>
      <label>
        <span>Task name</span>
        <input type="text" value={draft.name} maxLength={80} onChange={(event) => set({ name: event.target.value })} />
      </label>
      {editing.bodyEditable ? (
        <label>
          <span>What it does</span>
          <select aria-label="What it does" value={draft.body} onChange={(event) => set({ body: event.target.value as TaskDraft['body'] })}>
            <option value="intent">Ask the agent</option>
            <option value="scan">Scan for continuity problems</option>
          </select>
        </label>
      ) : (
        <p className="muted">This task runs a plan. Change its steps in tasks.json.</p>
      )}
      {editing.bodyEditable && draft.body === 'intent' ? (
        <label>
          <span>What to ask</span>
          <textarea aria-label="What to ask" rows={3} value={draft.text} onChange={(event) => set({ text: event.target.value })} />
        </label>
      ) : null}
      {editing.bodyEditable && draft.body === 'scan' ? (
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
      {model && draft.whenDue === 'run' ? <p className="muted">{SELF_START_NOTE}</p> : null}
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
        <p className="form-message is-error" role="alert">
          {editing.error}
        </p>
      )}
      <div className="recurring-actions">
        <button type="submit" className="button is-primary">
          Save task
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
