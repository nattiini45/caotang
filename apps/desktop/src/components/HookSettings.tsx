import { useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import type { ProjectHook } from '@caotang/bus';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { useSession } from './shared.js';

export function HookSettings({ session }: { readonly session: ProjectSession | null }): ReactNode {
  return (
    <section className="settings-section" aria-labelledby="settings-hooks" data-testid="hook-settings">
      <h3 id="settings-hooks"><Trans>Hooks</Trans></h3>
      <p className="settings-note"><Trans>Hooks check this project at selected events. They can warn or stop an action, but never approve it, change your text or call a provider.</Trans></p>
      {session === null ? <p className="settings-note"><Trans>Open a project to manage its hooks.</Trans></p> : <ProjectHooks session={session} />}
    </section>
  );
}

function ProjectHooks({ session }: { readonly session: ProjectSession }): ReactNode {
  useSession(session);
  const hooks = session.state.manifest.agent?.hooks ?? [];
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const save = (hook: ProjectHook): void => {
    const result = session.dispatch('hook.save', { hook });
    setMessage(result.ok ? { text: t`Saved. The hook applies to the next matching event.`, error: false } : { text: explain(result.error), error: true });
  };
  const remove = (hook: ProjectHook): void => {
    const result = session.dispatch('hook.delete', { hookId: hook.id });
    setMessage(result.ok ? { text: t`Deleted the hook. Undo brings it back.`, error: false } : { text: explain(result.error), error: true });
  };
  return (
    <>
      <ul className="settings-rules" aria-label={t`Project hooks`}>
        {hooks.map((hook) => {
          const name = isolate(hook.name);
          return <li key={hook.id} data-testid="hook-row">
            <span><strong dir="auto">{hook.name}</strong><br /><code>{hook.event}</code></span>
            <label className="settings-check"><input type="checkbox" checked={hook.enabled} aria-label={t`Enable ${name}`} onChange={(event) => save({ ...hook, enabled: event.target.checked })} /><span><Trans>Enabled</Trans></span></label>
            <button type="button" className="button is-quiet is-danger" onClick={() => remove(hook)}><Trans>Delete</Trans><span className="visually-hidden"> {name}</span></button>
          </li>;
        })}
      </ul>
      {message === null ? null : <p className={`form-message is-${message.error ? 'error' : 'info'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
    </>
  );
}
