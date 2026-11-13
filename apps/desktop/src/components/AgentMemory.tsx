/* lingui-set comment="Interpolated values: tokens, coveredTurns" */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import type { TaskRole } from '@caotang/gateway';
import type { SessionSummary } from '@caotang/store';
import type { AgentController, AgentSnapshot } from '../app/agent.js';
import { USAGE_ROLES } from './UsageBreakdown.js';
import './agent-memory.css';

export function AgentMemory({ agent, snapshot }: { readonly agent: AgentController; readonly snapshot: AgentSnapshot }): ReactNode {
  const { i18n } = useLingui();
  const [role, setRole] = useState<TaskRole>('chat');
  const [editingRole, setEditingRole] = useState(false);
  const memory = snapshot.sessionMemory.find((item) => item.role === role)!;
  if (snapshot.sessionMemory.every((item) => item.turns === 0 && item.summary === undefined) && snapshot.summaryNotice === null) return null;
  return <section className="agent-memory" data-testid="agent-memory">
    {snapshot.summaryNotice === null ? null : <p role="status">{snapshot.summaryNotice}</p>}
    <details>
      <summary>{snapshot.sessionMemory.some((item) => item.summary !== undefined) ? <Trans>Earlier in this session, summarised</Trans> : <Trans>Conversation memory</Trans>}</summary>
      <div className="agent-memory-content">
        <label className="field"><span><Trans>Conversation role</Trans></span><select value={role} disabled={editingRole || snapshot.busy} onChange={(event) => setRole(event.target.value as TaskRole)}>
          {snapshot.sessionMemory.map((item) => <option key={item.role} value={item.role}>{i18n._(USAGE_ROLES[item.role])}</option>)}
        </select></label>
        <MemoryRole key={role} agent={agent} snapshot={snapshot} memory={memory} onEditingChange={setEditingRole} />
      </div>
    </details>
  </section>;
}

function MemoryRole({ agent, snapshot, memory, onEditingChange }: { readonly agent: AgentController; readonly snapshot: AgentSnapshot; readonly memory: AgentSnapshot['sessionMemory'][number]; readonly onEditingChange: (editing: boolean) => void }): ReactNode {
  const [focus, setFocus] = useState('');
  const [editing, setEditing] = useState<{ readonly source: SessionSummary; readonly text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const isEditing = editing !== null;
  useEffect(() => {
    if (saving) return;
    if (isEditing) editor.current?.focus();
    else if (wasEditing.current) editButton.current?.focus();
    wasEditing.current = isEditing;
  }, [isEditing, saving]);
  const hint = useId();
  const editorLabel = useId();
  const summary = memory.summary;
  const coveredTurns = summary?.covers.turns ?? 0;
  const unavailable = snapshot.busy || snapshot.queue.length > 0 || snapshot.sessionSave.kind === 'writing' || snapshot.sessionSave.failure !== null || saving;
  const tokens = Math.ceil((editing?.text.trim().length ?? 0) / 4);
  return <>
    {summary === undefined ? <p><Trans>This role has no summary yet.</Trans></p> : <>
      <p className="agent-memory-meta">{plural(coveredTurns, { one: '# earlier turn summarised', other: '# earlier turns summarised' })} · {summary.origin === 'auto' ? <Trans>Automatic</Trans> : <Trans>Manual</Trans>}{summary.editedAt === undefined ? null : <> · <Trans>Edited by you</Trans></>}{summary.external ? <> · <span className="badge is-source-mcp"><Trans>External</Trans></span></> : null}</p>
      {memory.withheld ? <p role="status"><Trans>This summary is not sent to the model because the read rules changed. Start a new session to continue without this earlier memory.</Trans></p> : null}
      {editing === null ? <div className="agent-memory-text" dir="auto">{summary.text.split(/^(## [^\n]+)$/m).map((part, index) => part.startsWith('## ') ? <strong key={index}>{part.slice(3)}</strong> : part)}</div> : null}
    </>}
    {editing !== null ? <>
        <label className="field"><span id={editorLabel}><Trans>Session summary</Trans></span><textarea ref={editor} rows={8} value={editing.text} dir="auto" disabled={saving} aria-labelledby={editorLabel} aria-describedby={hint} onChange={(event) => setEditing({ ...editing, text: event.target.value })} /></label>
        <p id={hint} className="muted">{t`About ${{ tokens }} of 600 summary tokens. Saving an edit makes no provider call.`}</p>
        <div className="agent-memory-actions">
          <button type="button" className="button" disabled={unavailable || tokens === 0 || tokens > 600} onClick={() => {
            setSaving(true);
            void agent.editSessionSummary(memory.role, editing.text, editing.source).then((saved) => { if (saved) { setEditing(null); onEditingChange(false); } }).finally(() => setSaving(false));
          }}>{saving ? <Trans>Saving summary…</Trans> : <Trans>Save summary</Trans>}</button>
          <button type="button" className="button is-quiet" disabled={saving} onClick={() => { setEditing(null); onEditingChange(false); }}><Trans>Cancel</Trans></button>
        </div>
      </> : <>
    {summary === undefined ? null : <button ref={editButton} type="button" className="button is-quiet" disabled={unavailable} onClick={() => { setEditing({ source: summary, text: summary.text }); onEditingChange(true); }}><Trans>Edit summary</Trans></button>}
    <p className="muted"><Trans>Earlier requests are summarised automatically after more than six unsummarised turns. The newest two stay separate. Original turns remain below.</Trans></p>
    <label className="field"><span><Trans>Compaction focus (optional)</Trans></span><input value={focus} disabled={unavailable || editing !== null} onChange={(event) => setFocus(event.target.value)} /></label>
    <p className="muted"><Trans>Compact sends this role’s earlier conversation to your Background provider in one request, within your run limits. It does not change the manuscript. New session starts without this memory.</Trans></p>
    <button type="button" className="button" disabled={unavailable || editing !== null || memory.withheld || (summary === undefined && memory.turns <= 2)} onClick={() => void agent.compactSession(memory.role, focus)}><Trans>Compact</Trans></button>
    {summary === undefined && memory.turns <= 2 ? <p className="muted"><Trans>Continue this role’s conversation for at least three turns before compacting.</Trans></p> : null}
    </>}
  </>;
}
