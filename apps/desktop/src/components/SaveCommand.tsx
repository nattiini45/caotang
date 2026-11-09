import { t } from '@lingui/core/macro';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProjectSession } from '../app/session.js';
import { savedCommandProblem, savedCommandText } from '../app/project-commands.js';

export function SaveCommand({ session, intent }: { readonly session: ProjectSession; readonly intent: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  const close = (): void => { setOpen(false); requestAnimationFrame(() => toggle.current?.focus()); };
  if (!open) return <button ref={toggle} type="button" className="button is-quiet" onClick={() => setOpen(true)}>{t`Save as command…`}</button>;
  return (
    <form className="settings-form" aria-label={t`Save as command`} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }} onSubmit={(event) => {
      event.preventDefault();
      const problem = savedCommandProblem(name, [...session.state.skills.keys()]);
      if (problem !== undefined) { setMessage(problem); return; }
      const saved = session.writeSkillFile(name, 'SKILL.md', savedCommandText(name, intent));
      setMessage(saved.ok ? t`Saved. Review and approve it in Skills before running the command.` : saved.error.message);
    }}>
      <label>{t`Command name`}<input ref={field} value={name} maxLength={64} autoComplete="off" onChange={(event) => { setName(event.target.value); setMessage(''); }} /></label>
      <p className="muted">{t`This request becomes a project skill that only you can invoke. It does not change permissions.`}</p>
      <div className="profile-form-actions"><button type="submit" className="button" disabled={name.trim() === ''}>{t`Save command`}</button>
      <button type="button" className="button is-quiet" onClick={close}>{t`Close`}</button>
      </div>
      {message === '' ? null : <p role="status">{message}</p>}
    </form>
  );
}
