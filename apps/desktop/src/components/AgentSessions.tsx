/* lingui-set comment="Interpolated values: title is an isolated writer-supplied intent; count is a turn count; tokens is a formatted recorded token count." */
import { useId, useRef, useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { dateTimeFormat, isolate } from '@caotang/i18n';
import type { AgentController, AgentSnapshot } from '../app/agent.js';
import { formatterLocale } from '../i18n/format-locale.js';
import { formatCount } from '../i18n/locale.js';
import { ConfirmDialog } from './shared.js';
import './agent-sessions.css';

export function AgentSessions({ agent, snapshot }: { readonly agent: AgentController; readonly snapshot: AgentSnapshot }): ReactNode {
  useLingui();
  const panel = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const unavailable = snapshot.busy || snapshot.queue.length > 0 || snapshot.sessionSave.failure !== null;
  const current = snapshot.conversationSessions.find((row) => row.sessionId === snapshot.sessionId);
  const sessionCount = snapshot.conversationSessions.length;
  const close = (): void => {
    panel.current?.hidePopover();
    toggle.current?.focus();
  };
  return <>
    {snapshot.sessionSave.failure === null ? null : <p className="agent-session-save" role="alert">{snapshot.sessionSave.failure} <button type="button" className="button" disabled={snapshot.busy || snapshot.sessionSave.kind === 'writing'} onClick={() => void agent.retrySessionSave()}><Trans>Retry saving the conversation</Trans></button></p>}
    {snapshot.sessionLoad.kind === 'failed' ? <p className="agent-session-save" role="alert">{snapshot.sessionLoad.message} <button type="button" className="button" onClick={() => void agent.loadSessions()}><Trans>Try again</Trans></button></p> : null}
    <div className="agent-sessions" data-testid="agent-sessions" data-state={snapshot.sessionLoad.kind} data-open={open}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}>
      <button type="button" ref={toggle} className="button is-quiet agent-session-trigger" popoverTarget={panelId} aria-expanded={open} aria-controls={panelId}>
        <span><Trans>Sessions</Trans></span><span className="muted"><bdi>{current?.title || t`New session`}</bdi></span>
      </button>
      <div ref={panel} id={panelId} popover="auto" className="menu agent-sessions-content agent-sessions-popover" onToggle={(event) => {
        const shown = (event.nativeEvent as ToggleEvent).newState === 'open';
        setOpen(shown);
        const element = panel.current;
        const button = toggle.current;
        if (!shown || element === null || button === null) return;
        const bounds = button.getBoundingClientRect();
        const frame = document.documentElement.dataset['shell'] === 'modern' ? button.closest('.agent')?.getBoundingClientRect() : undefined;
        const top = Math.max(16, (frame?.top ?? 8) + 8);
        const bottom = Math.min(innerHeight - 16, (frame?.bottom ?? innerHeight - 8) - 8);
        const left = Math.max(16, (frame?.left ?? 8) + 8);
        const right = Math.min(innerWidth - 16, (frame?.right ?? innerWidth - 8) - 8);
        const width = Math.min(360, right - left);
        element.style.inlineSize = `${width}px`;
        element.style.maxBlockSize = `${Math.min(innerHeight * 0.3, bottom - top)}px`;
        const height = element.offsetHeight;
        const y = bounds.bottom + height + 4 <= bottom ? bounds.bottom + 4 : bounds.top - height - 4;
        element.style.insetBlockStart = `${Math.max(top, Math.min(y, bottom - height))}px`;
        const x = Math.max(left, Math.min(bounds.left, right - width));
        element.style.insetInlineStart = `${document.documentElement.dir === 'rtl' ? innerWidth - x - width : x}px`;
        const list = element.querySelector('.agent-session-list');
        if (list !== null) list.scrollTop = 0;
      }}>
        {snapshot.sessionLoad.kind === 'loading' ? <p role="status"><Trans>Loading sessions…</Trans></p> : null}
        <div className="agent-session-actions"><button type="button" className="button" disabled={unavailable} onClick={() => { void agent.newSession().then(close); }}><Trans>New session</Trans></button><span className="muted">{plural(sessionCount, { one: '# session', other: '# sessions' })}</span></div>
        {snapshot.busy || snapshot.queue.length > 0 ? <p className="muted"><Trans>Finish or stop the current turn and clear the queue before changing sessions.</Trans></p> : null}
        <p className="muted"><Trans>Opening does not change the manuscript.</Trans></p>
        <ol className="agent-session-list" aria-label={t`Saved agent sessions`}>
          {snapshot.conversationSessions.map((row) => {
            const title = row.title || t`New session`;
            const count = row.turns.length;
            const parent = row.forkedFrom === undefined ? undefined : snapshot.conversationSessions.find((item) => item.sessionId === row.forkedFrom?.sessionId);
            return <li key={row.sessionId} data-session={row.sessionId} aria-current={row.sessionId === snapshot.sessionId ? 'true' : undefined}>
              <strong><bdi>{title}</bdi></strong>
              {row.sessionId === snapshot.sessionId ? <span className="muted"> · <Trans>Current</Trans></span> : null}
              <p className="muted"><time dateTime={new Date(row.updatedAt).toISOString()}>{dateTimeFormat(formatterLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(row.updatedAt)}</time> · {plural(count, { one: '# turn', other: '# turns' })} · {row.tokens === null ? t`Recorded tokens unavailable` : t`${{ tokens: formatCount(row.tokens) }} recorded tokens`}
                {row.forkedFrom === undefined ? null : <> · {parent === undefined ? t`Forked from an earlier session` : <button type="button" className="status-link" disabled={unavailable} onClick={() => { void agent.openSession(parent.sessionId).then(close); }}>{t`Forked from ${{ title: isolate(parent.title || t`New session`) }}`}</button>}</>}
              </p>
              <div className="agent-session-actions">
                <button type="button" className="button" disabled={unavailable || row.sessionId === snapshot.sessionId} aria-label={t`Open session ${{ title: isolate(title) }}`} onClick={() => { void agent.openSession(row.sessionId).then(close); }}>{t({ message: 'Open', context: 'agent session action' })}</button>
                <details><summary aria-label={t`Actions for session ${{ title: isolate(title) }}`}><Trans>More actions</Trans></summary><div className="agent-session-actions">
                  <button type="button" className="button is-quiet" disabled={unavailable} aria-label={t`Export session ${{ title: isolate(title) }} as Markdown`} onClick={() => void agent.exportSession(row.sessionId)}><Trans>Export as Markdown</Trans></button>
                  <button type="button" className="button is-danger" disabled={unavailable} aria-label={t`Delete session ${{ title: isolate(title) }}`} onClick={() => setDeleting(row.sessionId)}><Trans>Delete session</Trans></button>
                </div></details>
              </div>
            </li>;
          })}
        </ol>
        {snapshot.conversationSessions.length === 0 ? <p className="muted"><Trans>Your first settled turn will be kept here.</Trans></p> : null}
      </div>
    </div>
    <ConfirmDialog open={deleting !== null} title={t`Delete this session?`} confirmLabel={t`Delete session`} onCancel={() => setDeleting(null)} onConfirm={() => {
      const id = deleting;
      setDeleting(null);
      if (id !== null) void agent.deleteSession(id).then(close);
    }}>
      <p><strong><bdi>{snapshot.conversationSessions.find((row) => row.sessionId === deleting)?.title || t`New session`}</bdi></strong></p>
      <p><Trans>This deletes the conversation and backing logs that no other session or fork keeps. Shared turns stay in those other sessions. The manuscript does not change.</Trans></p>
      <p><Trans>Exported files and folder copies are not deleted.</Trans></p>
    </ConfirmDialog>
  </>;
}
