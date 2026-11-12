/* lingui-set comment="Interpolated values: reason is a local storage error; count and days are configured upper bounds; size is a formatted byte estimate." */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { readAgentSessions, readRunEvents, readRuns, type RuntimeStore } from '@caotang/store';
import type { AppServices } from '../app/services.js';
import type { ProjectSession } from '../app/session.js';
import { CHECKPOINT_CAP_MAX, CHECKPOINT_DAYS_MAX } from '../app/settings.js';
import { formatBytes } from '../app/storage.js';
import { useComposingEnter } from './shared.js';

function estimatedBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 4;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + estimatedBytes(item), 0);
  if (value !== null && typeof value === 'object') return Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + estimatedBytes(item), 0);
  return 0;
}

export function AgentSessionData({ services, session, store }: { readonly services: AppServices; readonly session: ProjectSession | null; readonly store: RuntimeStore | null }): ReactNode {
  useLingui();
  const limits = services.settings.current().agentSessions;
  const [count, setCount] = useState(String(limits.count));
  const [days, setDays] = useState(String(limits.days));
  const [message, setMessage] = useState<string | null>(null);
  const [size, setSize] = useState<{ sessions: number; runs: number; bytes: number } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const ime = useComposingEnter();
  useEffect(() => {
    let alive = true;
    if (store === null || session === null) return;
    void (async () => {
      const sessions = await readAgentSessions(store, session.projectId);
      const runs = await readRuns(store, session.projectId);
      let bytes = estimatedBytes(sessions) + estimatedBytes(runs);
      for (const run of runs) bytes += estimatedBytes(await readRunEvents(store, run.runId));
      if (alive) { setSize({ sessions: sessions.length, runs: runs.length, bytes }); setFailure(null); }
    })().catch((error: unknown) => {
      if (alive) setFailure(t`The session and log size could not be read: ${{ reason: error instanceof Error ? error.message : String(error) }}. Try again.`);
    });
    return () => { alive = false; };
  }, [session, store, revision]);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ime.takesSubmit()) return;
    const nextCount = Number(count);
    const nextDays = Number(days);
    if (!Number.isSafeInteger(nextCount) || nextCount < 1 || nextCount > CHECKPOINT_CAP_MAX || !Number.isSafeInteger(nextDays) || nextDays < 1 || nextDays > CHECKPOINT_DAYS_MAX) {
      setMessage(t`Use a whole session count from 1 to ${{ count: CHECKPOINT_CAP_MAX }} and days from 1 to ${{ days: CHECKPOINT_DAYS_MAX }}.`);
      return;
    }
    void services.settings.update({ agentSessions: { count: nextCount, days: nextDays } }).then((error) => {
      setMessage(error ?? t`Saved. Session limits apply at the next settled turn or when you reopen the project.`);
    });
  };
  const sessionCount = size?.sessions ?? 0;
  const runCount = size?.runs ?? 0;
  return <section aria-labelledby="settings-agent-sessions">
    <h4 id="settings-agent-sessions"><Trans>Agent sessions and run logs</Trans></h4>
    <p className="muted"><Trans>Conversations can contain manuscript excerpts and model output. They stay in this browser, not in project bundles. Choose Sessions in the agent to export or delete a conversation; Activity lets you discard individual logs.</Trans></p>
    {session === null ? <p className="muted"><Trans>Open a project to see its sessions and log size.</Trans></p> : failure !== null ? <p role="alert">{failure}</p> : size === null ? <p role="status"><Trans>Counting sessions and logs…</Trans></p> : <p data-testid="agent-session-storage">{plural(sessionCount, { one: '# session', other: '# sessions' })} · {plural(runCount, { one: '# run log', other: '# run logs' })} · {t`about ${{ size: formatBytes(size.bytes) }}`}</p>}
    {session === null ? null : <button type="button" className="button is-quiet" onClick={() => setRevision((value) => value + 1)}><Trans>Refresh session and log size</Trans></button>}
    <p className="muted"><Trans>Limits cover the number and age of sessions, not turns or bytes inside one session. The active session stays available. Shared turns remain while a retained session or fork keeps them; other logs use their separate retention. Exported files and folder copies are untouched.</Trans></p>
    <form className="settings-form" onKeyDown={ime.noteKey} onSubmit={save}>
      <label><span><Trans>Agent sessions kept per project</Trans></span><input type="number" min={1} max={CHECKPOINT_CAP_MAX} value={count} onChange={(event) => setCount(event.target.value)} /></label>
      <label><span><Trans>Days an agent session is kept</Trans></span><input type="number" min={1} max={CHECKPOINT_DAYS_MAX} value={days} onChange={(event) => setDays(event.target.value)} /></label>
      <button type="submit" className="button"><Trans>Save session limits</Trans></button>
    </form>
    {message === null ? null : <p role="status">{message}</p>}
  </section>;
}
