/**
 * The Skills panel — a project's reusable writing instructions for the agent ([extensibility.md §10](../../../../docs/architecture/extensibility.md)).
 *
 * It opens from the toolbar. A skill is a folder of instructions in the project; the agent is told of one only after the writer has read
 * all of it and approved it, and a skill whose files change is read and approved again. The panel lists the skills with where each stands,
 * writes and imports them, turns them on and off, and shows the review: every file as plain text, with whatever cannot be seen made visible.
 *
 * It speaks of "skills", "instructions", "approve" and "on/off". What the folder is called on disk and how the approval is kept are in
 * the docs, not here.
 */

import { accessibleText } from '../i18n/accessible-text.js';
import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { SKILL_FILE } from '@caotang/skills';

import { isImeEnter } from '../app/keymap.js';
import { importPicked, nameFromFile, pickedFromZip, type PickedFile } from '../app/skills-import.js';
import {
  allowedToolsNotice,
  otherFilesNotice,
  scriptsNotice,
  draftProblem,
  nameProblem,
  reviewCardOf,
  reviewLine,
  sizeLabel,
  skillTemplate,
  type SkillRow,
} from '../app/skills-model.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { useReturnFocus } from './dialog-focus.js';
import { closeDialog, useDialogRequest } from './dialog-requests.js';
import { useReport, useSession } from './shared.js';
import './skills-dialog.css';


/* lingui-set comment="Skills. Interpolated values: name is the skill's own folder name; reason is a failure message; counts are numbers." */
type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'review'; readonly name: string }
  | { readonly kind: 'edit'; readonly name: string }
  | { readonly kind: 'new' };

/** The panel, rendered only while its request is open. It is a modal, so it is mounted on open and dropped on close. */
function waitingText(waiting: number): string {
  return plural(waiting, { one: '# skill is waiting for you to read and approve it.', other: '# skills are waiting for you to read and approve them.' });
}

function otherFilesText(otherFiles: number): string {
  return plural(otherFiles, { one: '# other file.', other: '# other files.' });
}

function invisibleText(invisible: number): string {
  return plural(invisible, { one: '# character that cannot be seen.', other: '# characters that cannot be seen.' });
}

function commentsText(comments: number): string {
  return plural(comments, { one: '# comment.', other: '# comments.' });
}

export function SkillsPanel({ session }: { session: ProjectSession }): ReactNode {
  const request = useDialogRequest();
  if (request === null || request.kind !== 'skills') return null;
  return <SkillsDialog session={session} />;
}

function SkillsDialog({ session }: { session: ProjectSession }): ReactNode {
  useLingui();
  useSession(session);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useReturnFocus();
  const [view, setView] = useState<View>({ kind: 'list' });

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const close = (): void => {
    returnFocus();
    closeDialog();
  };

  return (
    <dialog
      ref={dialog}
      className="project-dialog skills-dialog"
      aria-labelledby="skills-dialog-title"
      onCancel={(event) => {
        // Escape goes back one step: from a skill's review or editor to the list, and from the list out of the panel.
        event.preventDefault();
        if (view.kind === 'list') close();
        else setView({ kind: 'list' });
      }}
    >
      <div className="project-dialog-body">
        <h2 id="skills-dialog-title"><Trans>Skills</Trans></h2>
        {view.kind === 'list' ? <SkillList session={session} onView={setView} onDone={close} /> : null}
        {view.kind === 'review' ? <Review session={session} name={view.name} onBack={() => setView({ kind: 'list' })} /> : null}
        {view.kind === 'edit' ? <Editor session={session} name={view.name} onBack={() => setView({ kind: 'list' })} /> : null}
        {view.kind === 'new' ? <NewSkill session={session} onBack={() => setView({ kind: 'list' })} onCreated={(name) => setView({ kind: 'edit', name })} /> : null}
      </div>
    </dialog>
  );
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

function SkillList({ session, onView, onDone }: { session: ProjectSession; onView: (view: View) => void; onDone: () => void }): ReactNode {
  useLingui();
  const report = useReport();
  const folder = useRef<HTMLInputElement>(null);
  const zip = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const view = session.skills();

  const say = (text: string, tone: 'info' | 'error'): void => report({ text, tone });

  const importFiles = async (picked: readonly PickedFile[], fallback: string): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await importPicked(session, picked, fallback);
      say(outcome.text, outcome.tone);
    } catch (error) {
      say(t`The skill could not be read: ${{ reason: error instanceof Error ? error.message : String(error) }}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onFolder = (files: FileList | null): void => {
    if (files === null || files.length === 0) return;
    const picked: PickedFile[] = [...files].map((file) => ({
      path: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
    }));
    void importFiles(picked, 'imported-skill');
  };

  const onZip = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setBusy(true);
    try {
      const unpacked = await pickedFromZip(new Uint8Array(await file.arrayBuffer()));
      if ('problem' in unpacked) {
        say(unpacked.problem, 'error');
        return;
      }
      const outcome = await importPicked(session, unpacked.files, nameFromFile(file.name) || 'imported-skill');
      say(outcome.text, outcome.tone);
    } catch (error) {
      say(t`The skill could not be read: ${{ reason: error instanceof Error ? error.message : String(error) }}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (row: SkillRow): void => {
    const result = session.setSkillEnabled(row.name, !row.enabled);
    if (!result.ok) say(explain(result.error), 'error');
  };

  const remove = (row: SkillRow): void => {
    const result = session.deleteSkill(row.name);
    if (!result.ok) say(explain(result.error), 'error');
    else say(t`Deleted the skill “${{ name: isolate(row.name) }}”. Undo brings it back.`, 'info');
  };

  return (
    <>
      <p className="skills-subtitle"><Trans>Reusable writing instructions for the agent</Trans></p>
      <p className="project-dialog-help">
        <Trans>A skill is a folder of instructions kept in your project. The agent can use a skill only after you have read all of it and approved it,
        and a skill you or another program changes has to be approved again.</Trans>
      </p>

      <div className="project-dialog-row">
        <button type="button" className="button" disabled={busy} onClick={() => onView({ kind: 'new' })}>
          <Trans>New skill…</Trans>
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => folder.current?.click()}>
          <Trans>Import a folder…</Trans>
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => zip.current?.click()}>
          <Trans>Import a zip…</Trans>
        </button>
      </div>
      <input
        ref={folder}
        type="file"
        multiple
        hidden
        aria-label={t`Skill folder`}
        // A folder is picked whole; the browser lists its files with their paths (webkitRelativePath).
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          onFolder(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={zip}
        type="file"
        accept=".zip,application/zip"
        hidden
        aria-label={t`Skill zip`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void onZip(file);
        }}
      />

      {view.rows.length === 0 && view.problems.length === 0 ? <p className="skills-empty"><Trans>This project has no skills yet.</Trans></p> : null}
      {view.waiting > 0 ? (
        <p className="skills-waiting" role="status">
          {waitingText(view.waiting)}
        </p>
      ) : null}

      <ul className="skills-list" aria-label={t`Skills`}>
        {view.rows.map((row) => (
          <li key={row.name} className="skills-row" data-skill={row.name} data-review={row.review}>
            <div className="skills-row-head">
              <strong className="skills-name">{row.name}</strong>
              {!row.enabled ? <span className="chip"><Trans>Off</Trans></span> : null}
              {row.hasScripts ? <span className="chip" title={scriptsNotice()}><Trans>Includes scripts</Trans></span> : null}
              {row.writerOnly ? <span className="chip"><Trans>Only you use it</Trans></span> : null}
            </div>
            <p className="skills-description">{row.description}</p>
            <p className={`skills-review${row.review === 'reviewed' ? '' : ' is-open'}`}>{reviewLine(row)}</p>
            <div className="project-dialog-row">
              <button type="button" className={`button${row.review === 'reviewed' ? '' : ' is-primary'}`} onClick={() => onView({ kind: 'review', name: row.name })}>
                {row.review === 'reviewed' ? t`Read again` : t`Read and approve…`}
                <span className="visually-hidden"> {row.name}</span>
              </button>
              <button type="button" className="button" onClick={() => onView({ kind: 'edit', name: row.name })}>
                <Trans>Edit</Trans><span className="visually-hidden"> {row.name}</span>
              </button>
              <button type="button" className="button" onClick={() => toggle(row)}>
                {row.enabled ? t`Turn off` : t`Turn on`}
                <span className="visually-hidden"> {row.name}</span>
              </button>
              <button type="button" className="button is-quiet is-danger" onClick={() => remove(row)}>
                <Trans>Delete</Trans><span className="visually-hidden"> {row.name}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>

      {view.problems.length > 0 ? (
        <section aria-label={t`Skills that cannot be used`}>
          <h3 className="skills-heading"><Trans>Skills that cannot be used</Trans></h3>
          <ul className="skills-problems">
            {view.problems.map((problem) => (
              <li key={`${problem.folder}:${problem.text}`}>{problem.text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="confirm-actions">
        <button type="button" className="button is-primary" onClick={onDone}>
          <Trans>Done</Trans>
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The review
 * ------------------------------------------------------------------ */

function Review({ session, name, onBack }: { session: ProjectSession; name: string; onBack: () => void }): ReactNode {
  useLingui();
  const report = useReport();
  const row = session.skills().rows.find((candidate) => candidate.name === name);
  const card = useMemo(() => (row === undefined ? undefined : reviewCardOf(row.skill)), [row]);
  if (row === undefined || card === undefined) {
    return (
      <>
        <p><Trans>This skill is not in the project any more.</Trans></p>
        <button type="button" className="button" onClick={onBack}>
          <Trans>Back</Trans>
        </button>
      </>
    );
  }

  const approve = async (): Promise<void> => {
    await session.approveSkill(name);
    report({
      text: row.enabled && !row.writerOnly ? t`Approved “${{ name: isolate(name) }}”. The agent can use it now.` : t`Approved “${{ name: isolate(name) }}”.`,
      tone: 'info',
    });
    onBack();
  };

  return (
    <>
      <h3 className="skills-heading">{t`Read “${{ name: isolate(card.name) }}”`}</h3>
      <p className="project-dialog-help">
        <Trans>This is everything in the skill, exactly as it is, as plain text. The agent will read the instructions. Read all of it before you approve it.</Trans>
      </p>
      <p className="skills-description">{card.description}</p>

      <div className="skills-notices">
        {card.scripts.length > 0 ? (
          <div role="note" className="skills-notice">
            <strong><Trans>Includes scripts.</Trans></strong> {scriptsNotice()}
            <ul>
              {card.scripts.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {card.allowedTools !== undefined ? (
          <div role="note" className="skills-notice">
            <strong><Trans>Allowed tools:</Trans></strong> {card.allowedTools}. {allowedToolsNotice()}
          </div>
        ) : null}
        {card.otherFiles > 0 ? (
          <div role="note" className="skills-notice">
            <strong>{otherFilesText(card.otherFiles)}</strong> {otherFilesNotice()}
          </div>
        ) : null}
        {card.invisible > 0 ? (
          <div role="note" className="skills-notice is-warning">
            <strong>{invisibleText(card.invisible)}</strong>{' '}
            <Trans>Each is shown below as its code in brackets, like ⟦U+200B⟧.</Trans>
          </div>
        ) : null}
        {card.comments > 0 ? (
          <div role="note" className="skills-notice is-warning">
            <strong>{commentsText(card.comments)}</strong>{' '}
            <Trans>A comment is text that a formatted view would hide. It is shown below as written.</Trans>
          </div>
        ) : null}
      </div>

      {card.files.map((file) => (
        <section key={file.path} className="skills-file" aria-label={accessibleText(file.label)}>
          <h4 className="skills-file-name">
            {file.label} <span className="skills-file-size">{sizeLabel(file.size)}</span>
          </h4>
          {file.text === undefined ? (
            <p className="project-dialog-help"><Trans>This file is not text. It is kept with the skill and is part of what you approve.</Trans></p>
          ) : (
            <pre className="skills-text" tabIndex={0} aria-label={accessibleText(t`Text of ${{ name: isolate(file.label) }}`)}>
              {file.text}
            </pre>
          )}
        </section>
      ))}

      <div className="confirm-actions">
        <button type="button" className="button is-quiet" onClick={onBack}>
          <Trans>Back</Trans>
        </button>
        <button type="button" className="button is-primary" onClick={() => void approve()}>
          <Trans>Approve this skill</Trans>
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The editor and a new skill
 * ------------------------------------------------------------------ */

function Editor({ session, name, onBack }: { session: ProjectSession; name: string; onBack: () => void }): ReactNode {
  useLingui();
  const report = useReport();
  const row = session.skills().rows.find((candidate) => candidate.name === name);
  const files = session.state.skills.get(name);
  const main = files?.find((file) => file.path === SKILL_FILE);
  const original = main === undefined ? '' : new TextDecoder('utf-8').decode(main.bytes);
  const [draft, setDraft] = useState(original);
  const problem = files === undefined ? t`This skill is not in the project any more.` : draftProblem(name, files, draft);

  if (files === undefined) {
    return (
      <>
        <p><Trans>This skill is not in the project any more.</Trans></p>
        <button type="button" className="button" onClick={onBack}>
          <Trans>Back</Trans>
        </button>
      </>
    );
  }

  const save = (): void => {
    if (draft === original) {
      onBack();
      return;
    }
    const result = session.writeSkillFile(name, SKILL_FILE, draft);
    if (!result.ok) {
      report({ text: explain(result.error), tone: 'error' });
      return;
    }
    report({
      text: row?.review === 'reviewed' ? t`Saved “${{ name: isolate(name) }}”. The agent does not see it until you approve it again.` : t`Saved “${{ name: isolate(name) }}”.`,
      tone: 'info',
    });
    onBack();
  };

  return (
    <>
      <h3 className="skills-heading">{t`Instructions of “${{ name: isolate(name) }}”`}</h3>
      <p className="project-dialog-help">
        <Trans>The text between the two lines of dashes at the top gives the skill its name and says when to use it. Everything after it is what the agent reads.
        Saving a change means you approve the skill again before the agent can use it.</Trans>
      </p>
      <label className="project-dialog-field">
        <span className="field-label"><Trans>Instructions</Trans></span>
        <textarea className="skills-editor" value={draft} rows={16} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
      </label>
      {problem !== undefined ? (
        <p className="project-dialog-error" role="alert">
          {problem}
        </p>
      ) : (
        <p className="project-dialog-help" role="status">
          <Trans>This skill can be used.</Trans>
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="button is-quiet" onClick={onBack}>
          <Trans>Cancel</Trans>
        </button>
        <button type="button" className="button is-primary" disabled={problem !== undefined} onClick={save}>
          <Trans>Save</Trans>
        </button>
      </div>
    </>
  );
}

function NewSkill({ session, onBack, onCreated }: { session: ProjectSession; onBack: () => void; onCreated: (name: string) => void }): ReactNode {
  useLingui();
  const report = useReport();
  const [name, setName] = useState('');
  const taken = session.skills().rows.map((row) => row.name);
  const problem = nameProblem(name.trim(), [...taken, ...session.skills().problems.map((p) => p.folder)]);

  const create = (): void => {
    const trimmed = name.trim();
    if (problem !== undefined) return;
    const result = session.writeSkillFile(trimmed, SKILL_FILE, skillTemplate(trimmed));
    if (!result.ok) {
      report({ text: explain(result.error), tone: 'error' });
      return;
    }
    onCreated(trimmed);
  };

  return (
    <>
      <h3 className="skills-heading"><Trans>New skill</Trans></h3>
      <label className="project-dialog-field">
        <span className="field-label"><Trans>Name</Trans></span>
        <input
          type="text"
          value={name}
          maxLength={64}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            // The Enter that commits an IME candidate creates nothing; the candidate's text is still being composed.
            if (event.key === 'Enter' && !isImeEnter(event.nativeEvent)) create();
          }}
        />
        <span className="project-dialog-help"><Trans>Lower-case letters, digits and hyphens, such as close-third-person.</Trans></span>
      </label>
      {name.trim() !== '' && problem !== undefined ? (
        <p className="project-dialog-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="button is-quiet" onClick={onBack}>
          <Trans>Cancel</Trans>
        </button>
        <button type="button" className="button is-primary" disabled={problem !== undefined} onClick={create}>
          <Trans>Create</Trans>
        </button>
      </div>
    </>
  );
}
