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

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'review'; readonly name: string }
  | { readonly kind: 'edit'; readonly name: string }
  | { readonly kind: 'new' };

/** The panel, rendered only while its request is open. It is a modal, so it is mounted on open and dropped on close. */
export function SkillsPanel({ session }: { session: ProjectSession }): ReactNode {
  const request = useDialogRequest();
  if (request === null || request.kind !== 'skills') return null;
  return <SkillsDialog session={session} />;
}

function SkillsDialog({ session }: { session: ProjectSession }): ReactNode {
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
        <h2 id="skills-dialog-title">Skills</h2>
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
      say(`The skill could not be read: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
      say(`The skill could not be read: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
    else say(`Deleted the skill “${row.name}”. Undo brings it back.`, 'info');
  };

  return (
    <>
      <p className="skills-subtitle">Reusable writing instructions for the agent</p>
      <p className="project-dialog-help">
        A skill is a folder of instructions kept in your project. The agent can use a skill only after you have read all of it and approved it,
        and a skill you or another program changes has to be approved again.
      </p>

      <div className="project-dialog-row">
        <button type="button" className="button" disabled={busy} onClick={() => onView({ kind: 'new' })}>
          New skill…
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => folder.current?.click()}>
          Import a folder…
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => zip.current?.click()}>
          Import a zip…
        </button>
      </div>
      <input
        ref={folder}
        type="file"
        multiple
        hidden
        aria-label="Skill folder"
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
        aria-label="Skill zip"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void onZip(file);
        }}
      />

      {view.rows.length === 0 && view.problems.length === 0 ? <p className="skills-empty">This project has no skills yet.</p> : null}
      {view.waiting > 0 ? (
        <p className="skills-waiting" role="status">
          {view.waiting === 1 ? '1 skill is waiting for you to read and approve it.' : `${view.waiting} skills are waiting for you to read and approve them.`}
        </p>
      ) : null}

      <ul className="skills-list" aria-label="Skills">
        {view.rows.map((row) => (
          <li key={row.name} className="skills-row" data-skill={row.name} data-review={row.review}>
            <div className="skills-row-head">
              <strong className="skills-name">{row.name}</strong>
              {!row.enabled ? <span className="chip">Off</span> : null}
              {row.hasScripts ? <span className="chip" title={scriptsNotice()}>Includes scripts</span> : null}
              {row.writerOnly ? <span className="chip">Only you use it</span> : null}
            </div>
            <p className="skills-description">{row.description}</p>
            <p className={`skills-review${row.review === 'reviewed' ? '' : ' is-open'}`}>{reviewLine(row)}</p>
            <div className="project-dialog-row">
              <button type="button" className={`button${row.review === 'reviewed' ? '' : ' is-primary'}`} onClick={() => onView({ kind: 'review', name: row.name })}>
                {row.review === 'reviewed' ? 'Read again' : 'Read and approve…'}
                <span className="visually-hidden"> {row.name}</span>
              </button>
              <button type="button" className="button" onClick={() => onView({ kind: 'edit', name: row.name })}>
                Edit<span className="visually-hidden"> {row.name}</span>
              </button>
              <button type="button" className="button" onClick={() => toggle(row)}>
                {row.enabled ? 'Turn off' : 'Turn on'}
                <span className="visually-hidden"> {row.name}</span>
              </button>
              <button type="button" className="button is-quiet is-danger" onClick={() => remove(row)}>
                Delete<span className="visually-hidden"> {row.name}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>

      {view.problems.length > 0 ? (
        <section aria-label="Skills that cannot be used">
          <h3 className="skills-heading">Skills that cannot be used</h3>
          <ul className="skills-problems">
            {view.problems.map((problem) => (
              <li key={`${problem.folder}:${problem.text}`}>{problem.text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="confirm-actions">
        <button type="button" className="button is-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The review
 * ------------------------------------------------------------------ */

function Review({ session, name, onBack }: { session: ProjectSession; name: string; onBack: () => void }): ReactNode {
  const report = useReport();
  const row = session.skills().rows.find((candidate) => candidate.name === name);
  const card = useMemo(() => (row === undefined ? undefined : reviewCardOf(row.skill)), [row]);
  if (row === undefined || card === undefined) {
    return (
      <>
        <p>This skill is not in the project any more.</p>
        <button type="button" className="button" onClick={onBack}>
          Back
        </button>
      </>
    );
  }

  const approve = async (): Promise<void> => {
    await session.approveSkill(name);
    report({
      text: row.enabled && !row.writerOnly ? `Approved “${name}”. The agent can use it now.` : `Approved “${name}”.`,
      tone: 'info',
    });
    onBack();
  };

  return (
    <>
      <h3 className="skills-heading">Read “{card.name}”</h3>
      <p className="project-dialog-help">
        This is everything in the skill, exactly as it is, as plain text. The agent will read the instructions. Read all of it before you approve it.
      </p>
      <p className="skills-description">{card.description}</p>

      <div className="skills-notices">
        {card.scripts.length > 0 ? (
          <div role="note" className="skills-notice">
            <strong>Includes scripts.</strong> {scriptsNotice()}
            <ul>
              {card.scripts.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {card.allowedTools !== undefined ? (
          <div role="note" className="skills-notice">
            <strong>Allowed tools:</strong> {card.allowedTools}. {allowedToolsNotice()}
          </div>
        ) : null}
        {card.otherFiles > 0 ? (
          <div role="note" className="skills-notice">
            <strong>{card.otherFiles === 1 ? '1 other file.' : `${card.otherFiles} other files.`}</strong> {otherFilesNotice()}
          </div>
        ) : null}
        {card.invisible > 0 ? (
          <div role="note" className="skills-notice is-warning">
            <strong>{card.invisible === 1 ? '1 character that cannot be seen.' : `${card.invisible} characters that cannot be seen.`}</strong> Each is shown below as its code in
            brackets, like ⟦U+200B⟧.
          </div>
        ) : null}
        {card.comments > 0 ? (
          <div role="note" className="skills-notice is-warning">
            <strong>{card.comments === 1 ? '1 comment.' : `${card.comments} comments.`}</strong> A comment is text that a formatted view would hide. It is shown below as written.
          </div>
        ) : null}
      </div>

      {card.files.map((file) => (
        <section key={file.path} className="skills-file" aria-label={file.label}>
          <h4 className="skills-file-name">
            {file.label} <span className="skills-file-size">{sizeLabel(file.size)}</span>
          </h4>
          {file.text === undefined ? (
            <p className="project-dialog-help">This file is not text. It is kept with the skill and is part of what you approve.</p>
          ) : (
            <pre className="skills-text" tabIndex={0} aria-label={`Text of ${file.label}`}>
              {file.text}
            </pre>
          )}
        </section>
      ))}

      <div className="confirm-actions">
        <button type="button" className="button is-quiet" onClick={onBack}>
          Back
        </button>
        <button type="button" className="button is-primary" onClick={() => void approve()}>
          Approve this skill
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The editor and a new skill
 * ------------------------------------------------------------------ */

function Editor({ session, name, onBack }: { session: ProjectSession; name: string; onBack: () => void }): ReactNode {
  const report = useReport();
  const row = session.skills().rows.find((candidate) => candidate.name === name);
  const files = session.state.skills.get(name);
  const main = files?.find((file) => file.path === SKILL_FILE);
  const original = main === undefined ? '' : new TextDecoder('utf-8').decode(main.bytes);
  const [draft, setDraft] = useState(original);
  const problem = files === undefined ? 'This skill is not in the project any more.' : draftProblem(name, files, draft);

  if (files === undefined) {
    return (
      <>
        <p>This skill is not in the project any more.</p>
        <button type="button" className="button" onClick={onBack}>
          Back
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
      text: row?.review === 'reviewed' ? `Saved “${name}”. The agent does not see it until you approve it again.` : `Saved “${name}”.`,
      tone: 'info',
    });
    onBack();
  };

  return (
    <>
      <h3 className="skills-heading">Instructions of “{name}”</h3>
      <p className="project-dialog-help">
        The text between the two lines of dashes at the top gives the skill its name and says when to use it. Everything after it is what the agent reads.
        Saving a change means you approve the skill again before the agent can use it.
      </p>
      <label className="project-dialog-field">
        <span className="field-label">Instructions</span>
        <textarea className="skills-editor" value={draft} rows={16} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
      </label>
      {problem !== undefined ? (
        <p className="project-dialog-error" role="alert">
          {problem}
        </p>
      ) : (
        <p className="project-dialog-help" role="status">
          This skill can be used.
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="button is-quiet" onClick={onBack}>
          Cancel
        </button>
        <button type="button" className="button is-primary" disabled={problem !== undefined} onClick={save}>
          Save
        </button>
      </div>
    </>
  );
}

function NewSkill({ session, onBack, onCreated }: { session: ProjectSession; onBack: () => void; onCreated: (name: string) => void }): ReactNode {
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
      <h3 className="skills-heading">New skill</h3>
      <label className="project-dialog-field">
        <span className="field-label">Name</span>
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
        <span className="project-dialog-help">Lower-case letters, digits and hyphens, such as close-third-person.</span>
      </label>
      {name.trim() !== '' && problem !== undefined ? (
        <p className="project-dialog-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="button is-quiet" onClick={onBack}>
          Cancel
        </button>
        <button type="button" className="button is-primary" disabled={problem !== undefined} onClick={create}>
          Create
        </button>
      </div>
    </>
  );
}
