/**
 * The Recurring tasks section of the agent panel (agent-harness.md §12): the definitions in `tasks.json`, made and changed here, each
 * with its schedule, what it does, whether it calls a model, and the runs on this machine with what they used. Nothing in it starts a
 * task but a click; what is due is offered in `TaskOffers`. The agent has no tool for any of this.
 */

import { lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from 'react';
import { plural, t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { WEEKDAYS, readPlanText } from '@caotang/tasks';

import { EMPTY_DRAFT, planSelfStartNote, planStarter, selfStartNote, type RecurringTasks, type RunView, type TaskDraft, type TaskRowView } from '../app/recurring-tasks.js';
import { ConfirmDialog } from './shared.js';
import { DATE_AND_TIME, formatCount, formatDateTime } from '../i18n/locale.js';
import './recurring-tasks.css';

const WEEKDAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' } as const;

const STATUS_WORDS = { done: 'Done', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped' } as const;
const TaskAllowanceDialog = lazy(() => import('./TaskAllowanceDialog.js'));

/* lingui-set comment="Interpolated values: calls" */

function usedWords(run: RunView): string {
  if (run.requests === 0) return t`no model calls`;
  const calls = plural({ requests: run.requests }, { one: '# model call', other: '# model calls' });
  const tokens = formatCount(run.promptTokens + run.completionTokens);
  return t`${calls}, ${tokens} tokens`;
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
  const [allowing, setAllowing] = useState<TaskRowView | null>(null);
  const [allowanceLoaded, setAllowanceLoaded] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [allowanceError, setAllowanceError] = useState<string | null>(null);
  const allowanceTaskId = useRef<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const newTaskRef = useRef<HTMLButtonElement | null>(null);
  const stepsRef = useRef<HTMLTextAreaElement | null>(null);
  const editSerial = useRef(0);

  const startNew = (): void => {
    if (saving) return;
    editSerial.current += 1;
    setSaving(false);
    setEditing({ id: null, draft: EMPTY_DRAFT, error: null, stepsInvalid: false });
  };
  const edit = (task: TaskRowView): void => {
    if (saving) return;
    editSerial.current += 1;
    setSaving(false);
    setEditing({ id: task.id, draft: task.draft, error: null, stepsInvalid: false });
  };
  const focusTarget = useRef<string | null | undefined>(undefined);
  const focusInvalidSteps = useRef(false);
  const focusAfterEdit = (id: string | null): void => {
    focusTarget.current = id;
  };
  useEffect(() => {
    if (saving) return;
    if (focusInvalidSteps.current) {
      focusInvalidSteps.current = false;
      if (editing?.stepsInvalid === true) stepsRef.current?.focus();
    }
    if (editing !== null || focusTarget.current === undefined) return;
    const id = focusTarget.current;
    focusTarget.current = undefined;
    const row = id === null ? null : sectionRef.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"] [data-action="edit"]`);
    (row ?? newTaskRef.current)?.focus();
  }, [editing, saving]);
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
      focusInvalidSteps.current = stepsInvalid;
      setEditing((now) => (now === null ? now : { ...now, error: failure, stepsInvalid }));
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
    if (run !== null) void recurring.restoreRun(run.turnId).then((failure) => setRestoreMessage(failure ?? t`Restored to before that run.`));
  };

  const { status } = snapshot;
  return (
    <section ref={sectionRef} className="recurring" aria-label={t`Recurring tasks`} data-testid="recurring-tasks">
      <Heading><Trans>Recurring tasks</Trans></Heading>
      <p className="recurring-note muted">
        <Trans>Tasks run only while this project is open in a visible tab. Scans may start by themselves. Plans need your allowance on this browser; their drafts wait in the Inbox for review. Instructions are offered when due.</Trans>
      </p>
      {allowanceError === null ? null : <p className="form-message is-error" role="alert">{allowanceError}</p>}
      {status.notices.length > 0 ? (
        <ul className="recurring-notices" aria-label={t`About the tasks file`}>
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
      {snapshot.tasks.length === 0 && editing === null ? <p className="muted recurring-empty"><Trans>No tasks yet.</Trans></p> : null}
      <ul className="recurring-list">
        {snapshot.tasks.map((task) => (
          <li key={task.id} className="recurring-task" data-task={task.id} data-enabled={task.enabled}>
            <p className="recurring-task-title">
              <strong>{task.name}</strong>
              {task.enabled ? null : <span className="recurring-off"><Trans> (off)</Trans></span>}
              {task.running ? <span className="recurring-running"><Trans> Running…</Trans></span> : task.staging ? <span className="recurring-running"><Trans> Preparing drafts…</Trans></span> : null}
            </p>
            <p className="recurring-task-meta muted">
              {task.schedule} · {task.doing} · {task.usesModel ? t`Uses the model` : t`Calls no model`} ·{' '}
              {task.permission === 'read-only' ? t`May not change anything` : t`Asks before it changes anything`}
              {task.maxModelCalls === null ? '' : t` · at most ${{ calls: task.maxModelCalls }} model calls`}
            </p>
            {task.problem === null ? null : <p className="recurring-problem">{task.problem}</p>}
            {task.note === null ? null : <p className="recurring-task-meta">{task.note}</p>}
            {task.consent === 'current' && task.selfStart ? <p className="recurring-task-meta"><Trans>Allowed on this browser. Nothing is applied automatically.</Trans></p> : null}
            <div className="recurring-actions">
              <button type="button" className="button" disabled={snapshot.running !== null || task.staging || task.problem !== null} onClick={() => void recurring.runNow(task.id)}>
                <Trans>Run now</Trans>
                <span className="visually-hidden"> {task.name}</span>
              </button>
              <button type="button" className="button" data-action="edit" disabled={saving} onClick={() => edit(task)}>
                <Trans>Edit</Trans>
                <span className="visually-hidden"> {task.name}</span>
              </button>
              <button type="button" className="button" aria-pressed={!task.enabled} onClick={() => void recurring.setEnabled(task.id, !task.enabled)}>
                {task.enabled ? t`Turn off` : t`Turn on`}
                <span className="visually-hidden"> {task.name}</span>
              </button>
              <button type="button" className="button is-quiet" onClick={() => setRemoving(task)}>
                <Trans>Delete</Trans>
                <span className="visually-hidden"> {task.name}</span>
              </button>
              {task.consent === 'current' ? (
                <button type="button" className="button" data-action="allow" disabled={revoking !== null} onClick={() => {
                  setRevoking(task.id);
                  setAllowanceError(null);
                  void recurring.revokeSelfStart(task.id).then((failure) => { setAllowanceError(failure); setRevoking(null); });
                }}>
                  <Trans>Revoke automatic starts</Trans><span className="visually-hidden"> {task.name}</span>
                </button>
              ) : task.canAllow ? (
                <button type="button" className="button" data-action="allow" disabled={saving || revoking !== null} onClick={() => { allowanceTaskId.current = task.id; setAllowanceLoaded(true); setAllowing(task); }}>
                  <Trans>Allow automatic starts</Trans><span className="visually-hidden"> {task.name}</span>
                </button>
              ) : null}
            </div>
            {task.history.length === 0 ? null : (
              <details className="recurring-history">
                <summary>
                  <Trans>Runs on this machine ({{ runs: task.history.length }})<span className="visually-hidden"> of {({ name: task.name }) as unknown as ReactNode}</span></Trans>
                </summary>
                <ol aria-label={t`Runs of ${{ name: task.name }}`}>
                  {task.history.map((run) => (
                    <li key={`${run.at}:${run.status}`} data-status={run.status}>
                      <span className="recurring-run-when">{formatDateTime(new Date(run.at), DATE_AND_TIME)}</span> — <strong>{run.status === 'queued' ? t`Preparing drafts` : run.status === 'ready' ? t`Ready in Inbox` : STATUS_WORDS[run.status]}</strong>
                      {run.trigger === 'manual' ? t` (started by you)` : ''}. {run.summary}{' '}
                      <span className="muted">({usedWords(run)})</span>
                      {run.canRestore && run.turnId !== undefined ? (
                        <>
                          {' '}
                          <button type="button" className="status-link" onClick={() => setRestoring({ turnId: run.turnId ?? '', name: task.name })}>
                            <Trans>Restore to before this run</Trans>
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
        <button ref={newTaskRef} type="button" className="button" onClick={startNew} disabled={!status.writable || saving}>
          <Trans>New task</Trans>
        </button>
      ) : (
        <TaskForm editing={editing} saving={saving} stepsRef={stepsRef} onChange={(draft) => setEditing({ ...editing, draft, error: null, stepsInvalid: false })} onSubmit={save} onCancel={cancelEdit} />
      )}
      {!status.writable ? <p className="muted recurring-note"><Trans>The tasks file cannot be saved here, so tasks cannot be made or changed.</Trans></p> : null}

      <ConfirmDialog open={removing !== null} title={t`Delete this task?`} confirmLabel={t`Delete`} onCancel={() => setRemoving(null)} onConfirm={confirmRemove}>
        <p>
          <Trans>“{{ name: removing?.name ?? '' }}” is removed from tasks.json, and the runs kept for it in this browser go with it. Nothing it did to your project is undone.</Trans>
        </p>
      </ConfirmDialog>
      <ConfirmDialog open={restoring !== null} title={t`Restore to before this run?`} confirmLabel={t`Restore`} onCancel={() => setRestoring(null)} onConfirm={confirmRestore}>
        <p>
          <Trans>This restores the project to its state before the run of “{{ name: restoring?.name ?? '' }}”. Everything you changed since then is included in the restore.</Trans>
        </p>
      </ConfirmDialog>
      <Suspense fallback={<p role="status">{t`Opening allowance…`}</p>}>
      {allowanceLoaded ? <TaskAllowanceDialog task={allowing} recurring={recurring} onClose={() => setAllowing(null)} finalFocus={() => {
        const id = allowanceTaskId.current;
        return id === null ? newTaskRef.current : sectionRef.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"] [data-action="allow"]`) ?? newTaskRef.current;
      }} /> : null}
      </Suspense>
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
    <form className="recurring-form settings-form" noValidate aria-busy={saving} aria-label={editing.id === null ? t`New task` : t`Edit task`} onSubmit={onSubmit}>
      <fieldset className="recurring-form-fields" disabled={saving}>
      <label>
        <span><Trans>Task name</Trans></span>
        <input type="text" autoFocus value={draft.name} maxLength={80} onChange={(event) => set({ name: event.target.value })} />
      </label>
      <label>
        <span><Trans>What it does</Trans></span>
        <select aria-label={t`What it does`} value={draft.body} onChange={(event) => {
          const body = event.target.value as TaskDraft['body'];
          set(body === 'plan' && draft.steps === '' ? { body, steps: planStarter() } : { body });
        }}>
          <option value="intent"><Trans>Ask the agent</Trans></option>
          <option value="plan">{t`Run a plan`}</option>
          <option value="scan"><Trans>Scan for continuity problems</Trans></option>
        </select>
      </label>
      {draft.body === 'intent' ? (
        <label>
          <span><Trans>What to ask</Trans></span>
          <textarea aria-label={t`What to ask`} rows={3} value={draft.text} onChange={(event) => set({ text: event.target.value })} />
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
          <span><Trans>What to scan</Trans></span>
          <select aria-label={t`What to scan`} value={draft.scope} onChange={(event) => set({ scope: event.target.value as TaskDraft['scope'] })}>
            <option value="changed"><Trans>What changed since the last scan</Trans></option>
            <option value="full"><Trans>The whole manuscript</Trans></option>
          </select>
        </label>
      ) : null}
      <label>
        <span><Trans>When</Trans></span>
        <select aria-label={t`When`} value={draft.schedule} onChange={(event) => set({ schedule: event.target.value as TaskDraft['schedule'] })}>
          <option value="manual"><Trans>Only when I run it</Trans></option>
          <option value="on-open"><Trans>Each time the project opens</Trans></option>
          <option value="daily"><Trans>Every day</Trans></option>
          <option value="weekly"><Trans>Every week</Trans></option>
        </select>
      </label>
      {draft.schedule === 'weekly' ? (
        <label>
          <span><Trans>On</Trans></span>
          <select aria-label={t`On`} value={draft.day} onChange={(event) => set({ day: event.target.value as TaskDraft['day'] })}>
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
          <span><Trans>From</Trans></span>
          <input type="time" value={draft.at} onChange={(event) => set({ at: event.target.value })} />
        </label>
      ) : null}
      <label>
        <span><Trans>When it is due</Trans></span>
        <select aria-label={t`When it is due`} value={draft.whenDue} onChange={(event) => set({ whenDue: event.target.value as TaskDraft['whenDue'] })}>
          <option value="offer"><Trans>Offer it to me</Trans></option>
          <option value="run"><Trans>Start it by itself</Trans></option>
        </select>
      </label>
      {draft.whenDue === 'run' && draft.body !== 'scan' ? <p className="muted">{draft.body === 'plan' ? planSelfStartNote() : selfStartNote()}</p> : null}
      <label>
        <span><Trans>What it may do</Trans></span>
        <select aria-label={t`What it may do`} value={draft.permission} onChange={(event) => set({ permission: event.target.value as TaskDraft['permission'] })}>
          <option value="ask"><Trans>Ask before it changes anything</Trans></option>
          <option value="read-only"><Trans>Change nothing</Trans></option>
        </select>
      </label>
      {model ? (
        <label>
          <span><Trans>Most model calls in a run</Trans></span>
          <input type="number" min={1} max={100} step={1} placeholder={t`the usual limit`} value={draft.maxModelCalls} onChange={(event) => set({ maxModelCalls: event.target.value })} />
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
          <Trans>Cancel</Trans>
        </button>
      </div>
      </fieldset>
    </form>
  );
}
