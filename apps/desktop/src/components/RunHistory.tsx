import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import type { ProjectSession } from '../app/session.js';
import type { AgentController } from '../app/agent.js';
import { agentFor, whenAgent } from '../app/agent-registry.js';
import { InterruptedRuns } from './InterruptedRuns.js';

export function RunHistory({ session, onResume }: { session: ProjectSession; onResume: () => void }): ReactNode {
  const [agent, setAgent] = useState(() => agentFor(session));
  useEffect(() => {
    let active = true;
    void whenAgent(session).then((controller) => { if (active) setAgent(controller); });
    return () => { active = false; };
  }, [session]);
  return agent === undefined ? <p role="status"><Trans>Loading retained agent runs…</Trans></p> : <History agent={agent} session={session} onResume={onResume} />;
}

function History({ agent, session, onResume }: { agent: AgentController; session: ProjectSession; onResume: () => void }): ReactNode {
  const snapshot = useSyncExternalStore(agent.subscribe, agent.snapshot);
  const [copy, setCopy] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preferenceFailed, setPreferenceFailed] = useState(false);
  const folder = session.folderBaseline()?.folder;
  useEffect(() => {
    let active = true;
    void agent.folderCopyEnabled().then((enabled) => { if (active) { setCopy(enabled); setPreferenceFailed(false); } }, () => { if (active) { setCopy(null); setPreferenceFailed(true); setError(t`The folder-copy preference could not be read. Reopen Activity to try again.`); } });
    return () => { active = false; };
  }, [agent, folder]);
  const changeCopy = async (enabled: boolean): Promise<void> => {
    setSaving(true);
    setError(null);
    try { await agent.setFolderCopy(enabled); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally {
      try { setCopy(await agent.folderCopyEnabled()); setPreferenceFailed(false); }
      catch { setCopy(null); setPreferenceFailed(true); setError(t`The folder-copy preference could not be read. Reopen Activity to try again.`); }
      setSaving(false);
    }
  };
  const retryCopy = async (): Promise<void> => {
    setSaving(true);
    try {
      if (preferenceFailed) { setCopy(await agent.folderCopyEnabled()); setPreferenceFailed(false); }
      else await agent.retryFolderCopy();
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return (
    <details className="activity-runs">
      <summary><Trans>Agent run logs</Trans></summary>
      <p className="muted"><Trans>Run logs and restore points stay in this browser. Export a log before deleting it if you want to keep it.</Trans></p>
      <label className="check"><input type="checkbox" checked={copy === true} disabled={copy === null || saving} onChange={(event) => void changeCopy(event.target.checked)} /><Trans>Keep derived run-log copies in this project’s folder on this device.</Trans></label>
      <p className="muted"><Trans>Copies contain conversation and manuscript text, not restore points. They are never read to resume a run. Turning this off or discarding a browser log does not delete existing folder copies.</Trans></p>
      {error !== null || snapshot.runCopyFailure !== null ? <div role="alert" className="form-message is-error"><p>{error ?? snapshot.runCopyFailure}</p><button type="button" className="button" disabled={saving} onClick={() => void retryCopy()}>{preferenceFailed ? <Trans>Retry folder-copy preference</Trans> : <Trans>Retry folder copy</Trans>}</button></div> : null}
      {snapshot.runHistoryLoad.kind === 'loading' ? <p role="status"><Trans>Loading retained agent runs…</Trans></p> : null}
      {snapshot.runHistoryLoad.kind === 'failed' ? <div role="alert"><p>{snapshot.runHistoryLoad.message}</p><button type="button" className="button" disabled={snapshot.busy} onClick={() => void agent.loadInterrupted()}><Trans>Retry run history</Trans></button></div> : null}
      {snapshot.runHistory.length === 0 ? snapshot.runHistoryLoad.kind === 'ready' ? <p className="muted"><Trans>No retained agent runs in this project.</Trans></p> : null : <InterruptedRuns agent={agent} runs={snapshot.runHistory} busy={snapshot.busy} history onResume={onResume} />}
    </details>
  );
}
