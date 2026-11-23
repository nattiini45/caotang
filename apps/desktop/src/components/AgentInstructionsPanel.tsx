/**
 * The Agent instructions panel — the writer's standing instructions and the notes the agent keeps
 * ([context-assembly.md §2](../../../../docs/architecture/context-assembly.md), layer LI).
 *
 * It opens from the toolbar. `CAOTANG.md` is the writer's own file in the project: the rules the writer would otherwise retype in every
 * request. The memory notes are what the agent kept after it was told something once, each one a plain file the writer can read, edit and
 * forget. Both ride every request to the model, within a cap the panel shows; a file the cap cuts is named with how much was sent.
 *
 * "Initialise from this project" asks the agent for a first draft of `CAOTANG.md`. The draft arrives as one confirm card in the agent
 * panel, with the old and the new text side by side, and nothing is written until the writer approves it.
 */
/* lingui-set comment="Agent instructions copy. Interpolated values: title and name are note titles, path is a file path, used, sent, allowed and count are token counts." */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';

import { MEMORY_TYPES, slugOf, type MemoryType } from '@caotang/bus';
import type { ToolName } from '@caotang/harness';

import { INITIALISE_INTENT, agentInstructionsView, tokensLabel, type AgentInstructionsView } from '../app/agent-instructions-model.js';
import type { AppServices } from '../app/services.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { Modal, useModalDialog } from './modal.js';
import { closeDialog, useDialogRequest } from './dialog-requests.js';
import { ConfirmDialog, useReport, useSession } from './shared.js';
import './skills-dialog.css';
import './agent-instructions.css';

/** What the panel needs of the app: the project, the Settings value of the layer's cap, and the way to hand the agent a request. */
export interface AgentInstructionsProps {
  readonly session: ProjectSession;
  readonly services: AppServices;
  /** Sends a request to the agent, with the rows it should start with loaded. The workspace opens the agent panel for it. */
  readonly onAgentIntent: (intent: string, options?: { readonly preload?: readonly ToolName[] }) => void;
}

function typeLabel(type: MemoryType): string {
  switch (type) {
    case 'style':
      return t`Style`;
    case 'preference':
      return t`Preference`;
    case 'process':
      return t`Process`;
    case 'reference':
      return t`Reference`;
  }
}

/** The panel, rendered only while its request is open. It is a modal, so it is mounted on open and dropped on close. */
export function AgentInstructionsPanel(props: AgentInstructionsProps): ReactNode {
  const request = useDialogRequest();
  if (request === null || request.kind !== 'agent-instructions') return null;
  return <AgentInstructionsDialog {...props} />;
}

type Edit = { readonly kind: 'none' } | { readonly kind: 'note'; readonly slug: string | null };

function AgentInstructionsDialog({ session, services, onAgentIntent }: AgentInstructionsProps): ReactNode {
  useLingui();
  useSession(session);
  const dialog = useRef<HTMLDialogElement>(null);
  const report = useReport();
  const [edit, setEdit] = useState<Edit>({ kind: 'none' });
  const [forgetting, setForgetting] = useState<{ readonly slug: string; readonly title: string } | null>(null);
  const budget = services.settings.current().context.layerBudgets.LI;
  const view = agentInstructionsView(session.state, budget);

  useModalDialog(dialog);

  const close = (): void => {
    closeDialog();
  };

  const initialise = (): void => {
    // The draft comes back as a card in the agent panel, so the panel closes to let the writer see it.
    close();
    onAgentIntent(INITIALISE_INTENT, { preload: ['instructions.propose', 'memory.read'] });
  };

  const forget = (): void => {
    if (forgetting === null) return;
    const result = session.forgetMemoryNote(forgetting.slug);
    setForgetting(null);
    report(result.ok ? { text: t`Forgot “${{ title: forgetting.title }}”. Undo brings it back.`, tone: 'info' } : { text: explain(result.error), tone: 'error' });
  };

  return (
    <>
    <Modal
      ref={dialog}
      className="project-dialog skills-dialog"
      aria-labelledby="agent-instructions-title"
      onCancel={(event) => {
        // Escape goes back one step: from a note's editor to the list, and from the list out of the panel.
        event.preventDefault();
        if (edit.kind === 'none') close();
        else setEdit({ kind: 'none' });
      }}
    >
      <div className="project-dialog-body">
        <h2 id="agent-instructions-title"><Trans>Agent instructions</Trans></h2>
        {edit.kind === 'note' ? (
          <NoteEditor session={session} view={view} slug={edit.slug} onDone={() => setEdit({ kind: 'none' })} />
        ) : (
          <>
            <p className="project-dialog-help">
              <Trans>What the agent reads with every request: your instructions, and a short index of the notes it has kept. Both are plain files in your
              project, <code>CAOTANG.md</code> and a <code>memory</code> folder, so you can edit them anywhere.</Trans>
            </p>
            <Budget view={view} />
            <Instructions session={session} view={view} onInitialise={initialise} />
            <Notes view={view} onEdit={(slug) => setEdit({ kind: 'note', slug })} onForget={setForgetting} />
            <div className="confirm-actions">
              <button type="button" className="button is-primary" onClick={close}>
                <Trans>Done</Trans>
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
    <ConfirmDialog
      open={forgetting !== null}
      title={forgetting === null ? t`Forget this note?` : t`Forget “${{ title: forgetting.title }}”?`}
      confirmLabel={t`Forget`}
      onCancel={() => setForgetting(null)}
      onConfirm={forget}
    >
      <p><Trans>The agent will no longer see this note, and its file leaves the project at the next save. Undo brings it back.</Trans></p>
    </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Size against the budget
 * ------------------------------------------------------------------ */

function Budget({ view }: { view: AgentInstructionsView }): ReactNode {
  useLingui();
  const used = view.instructionsTokens + view.indexTokens;
  return (
    <div className="agent-instructions-budget" data-testid="instructions-budget">
      <p role="status">
        <Trans>{{ used: tokensLabel(used) }} in your instructions and the memory index; the agent is sent {{ sent: tokensLabel(view.sentTokens) }} of the {{ allowed: tokensLabel(view.budget) }} allowed.</Trans>
      </p>
      {view.capLines.map((line) => (
        <p key={line} className="project-dialog-error" role="alert">
          {line}. <Trans>Shorten the file, or raise the limit in Settings › Context.</Trans>
        </p>
      ))}
      <progress value={Math.min(view.sentTokens, view.budget)} max={Math.max(view.budget, 1)} aria-label={t`Share of the instructions budget in use`} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * CAOTANG.md
 * ------------------------------------------------------------------ */

function Instructions({ session, view, onInitialise }: { session: ProjectSession; view: AgentInstructionsView; onInitialise: () => void }): ReactNode {
  useLingui();
  const report = useReport();
  const [draft, setDraft] = useState(view.text);
  // The text and digest the box was last filled from: a change made elsewhere meanwhile (undo, another program) refills it when untouched.
  const loaded = useRef({ text: view.text, digest: view.digest });
  useEffect(() => {
    if (draft === loaded.current.text && view.digest !== loaded.current.digest) setDraft(view.text);
    loaded.current = { text: view.text, digest: view.digest };
    // The draft is read, not watched: only a change to the project's own text refills the box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.digest, view.text]);

  const changed = draft !== view.text;
  const blocked = view.heldBack.includes('CAOTANG.md');

  const save = (): void => {
    const result = session.setInstructions(draft, view.digest);
    report(result.ok ? { text: t`Saved CAOTANG.md. Undo brings the old text back.`, tone: 'info' } : { text: explain(result.error), tone: 'error' });
  };

  return (
    <section className="agent-instructions-file" aria-labelledby="agent-instructions-file-title">
      <h3 id="agent-instructions-file-title" className="skills-heading">
        {view.file === 'AGENTS.md' ? t`AGENTS.md (read because there is no CAOTANG.md)` : 'CAOTANG.md'}
      </h3>
      {view.file === 'AGENTS.md' ? (
        <p className="project-dialog-help">
          <Trans>This project has an AGENTS.md and no CAOTANG.md, so the agent reads AGENTS.md. Saving here writes a CAOTANG.md, which the agent then reads instead; AGENTS.md is left as it is.</Trans>
        </p>
      ) : null}
      {blocked ? (
        <p className="project-dialog-error" role="alert">
          <Trans>CAOTANG.md in this project is not UTF-8 text, so it is left as it is and the agent does not see it. Convert it to UTF-8, then open the project again.</Trans>
        </p>
      ) : null}
      <label className="project-dialog-field">
        <span className="field-label"><Trans>Your instructions to the agent</Trans></span>
        <textarea
          className="skills-editor"
          rows={8}
          value={draft}
          spellCheck
          disabled={blocked}
          placeholder={t`British spelling. Past tense, close third person on Mara. No semicolons in dialogue.`}
          aria-describedby="agent-instructions-size"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <p id="agent-instructions-size" className="project-dialog-help">
        <Trans>{{ count: tokensLabel(Math.ceil(draft.length / 4)) }} as typed.</Trans>
      </p>
      <div className="project-dialog-row">
        <button type="button" className="button is-primary" disabled={!changed || blocked} onClick={save}>
          <Trans>Save</Trans>
        </button>
        <button type="button" className="button" disabled={!changed} onClick={() => setDraft(view.text)}>
          <Trans>Revert</Trans>
        </button>
        <button type="button" className="button" disabled={blocked} title={t`The agent drafts a first CAOTANG.md from your manuscript, and you approve it on a card`} onClick={onInitialise}>
          <Trans>Initialise from this project</Trans>
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The notes
 * ------------------------------------------------------------------ */

function Notes({
  view,
  onEdit,
  onForget,
}: {
  view: AgentInstructionsView;
  onEdit: (slug: string | null) => void;
  onForget: (note: { readonly slug: string; readonly title: string }) => void;
}): ReactNode {
  useLingui();
  return (
    <section aria-labelledby="agent-notes-title">
      <h3 id="agent-notes-title" className="skills-heading">
        <Trans>Memory notes</Trans>
      </h3>
      <p className="project-dialog-help">
        <Trans>A habit or a preference the agent kept so you do not have to say it again. A fact about the story belongs in the codex, not here.</Trans>
      </p>
      {view.notes.length === 0 && view.unreadable.length === 0 ? <p className="skills-empty"><Trans>The agent has kept no notes yet.</Trans></p> : null}
      <ul className="skills-list">
        {view.notes.map((note) => (
          <li key={note.slug} className="skills-row" data-testid={`memory-note-${note.slug}`}>
            <div className="skills-row-head">
              <strong>{note.title}</strong>
              <span className="chip">{typeLabel(note.type)}</span>
              <span className="chip">{note.origin === 'agent' ? t`Kept by the agent` : t`Written by you`}</span>
              <span className="project-dialog-help">{tokensLabel(note.tokens)}</span>
            </div>
            <p className="skills-description">{note.body}</p>
            <div className="project-dialog-row">
              <button type="button" className="button" aria-label={t`Edit ${{ title: note.title }}`} onClick={() => onEdit(note.slug)}>
                <Trans>Edit</Trans>
              </button>
              <button type="button" className="button is-quiet" aria-label={t`Forget ${{ title: note.title }}`} onClick={() => onForget(note)}>
                <Trans>Forget</Trans>
              </button>
            </div>
          </li>
        ))}
        {view.unreadable.map((note) => (
          <li key={note.path} className="skills-row">
            <div className="skills-row-head">
              <strong>{note.path}</strong>
              <span className="chip"><Trans>Cannot be read</Trans></span>
            </div>
            <p className="skills-description">
              <Trans>This file has no front matter the app can read, so it is kept as it is and the agent does not see it. Fix it in a text editor, or forget it here. Opening
              the project never deletes it.</Trans>
            </p>
            <div className="project-dialog-row">
              <button type="button" className="button is-quiet" aria-label={t`Forget ${{ path: note.path }}`} onClick={() => onForget({ slug: note.slug, title: note.path })}>
                <Trans>Forget</Trans>
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="project-dialog-row">
        <button type="button" className="button" onClick={() => onEdit(null)}>
          <Trans>Add a note…</Trans>
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Add or edit a note
 * ------------------------------------------------------------------ */

function NoteEditor({ session, view, slug, onDone }: { session: ProjectSession; view: AgentInstructionsView; slug: string | null; onDone: () => void }): ReactNode {
  useLingui();
  const report = useReport();
  const held = slug === null ? undefined : view.notes.find((note) => note.slug === slug);
  const [title, setTitle] = useState(held?.title ?? '');
  const [type, setType] = useState<MemoryType>(held?.type ?? 'preference');
  const [body, setBody] = useState(held?.body ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const save = (): void => {
    const chosen = held?.slug ?? slugOf(title);
    if (chosen === '') {
      setProblem(t`Give the note a title in words.`);
      return;
    }
    // A new note whose slug a note already has would replace that note: say so instead.
    if (held === undefined && view.notes.some((note) => note.slug === chosen)) {
      setProblem(t`There is already a note called “${{ title: view.notes.find((note) => note.slug === chosen)?.title ?? chosen }}”. Edit that one instead.`);
      return;
    }
    const result = session.writeMemoryNote({ slug: chosen, type, title: title.trim(), body }, held?.digest);
    if (!result.ok) {
      setProblem(explain(result.error));
      return;
    }
    report({ text: t`Saved the note “${{ name: title.trim() }}”. Undo brings back the old text.`, tone: 'info' });
    onDone();
  };

  return (
    <>
      <h3 className="skills-heading">{held === undefined ? t`New memory note` : t`Edit “${{ title: held.title }}”`}</h3>
      <label className="project-dialog-field">
        <span className="field-label"><Trans>Title</Trans></span>
        <input type="text" value={title} maxLength={120} autoFocus onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="project-dialog-field">
        <span className="field-label"><Trans>Kind</Trans></span>
        <select value={type} onChange={(event) => setType(event.target.value as MemoryType)}>
          {MEMORY_TYPES.map((kind) => (
            <option key={kind} value={kind}>
              {typeLabel(kind)}
            </option>
          ))}
        </select>
      </label>
      <label className="project-dialog-field">
        <span className="field-label"><Trans>Note</Trans></span>
        <textarea className="skills-editor" rows={6} value={body} maxLength={4000} spellCheck onChange={(event) => setBody(event.target.value)} />
        <span className="project-dialog-help"><Trans>{{ count: tokensLabel(Math.ceil(body.length / 4)) }}. Lead with the rule in one line.</Trans></span>
      </label>
      {problem !== null ? (
        <p className="project-dialog-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="button is-quiet" onClick={onDone}>
          <Trans>Cancel</Trans>
        </button>
        <button type="button" className="button is-primary" disabled={title.trim() === '' || body.trim() === ''} onClick={save}>
          <Trans>Save</Trans>
        </button>
      </div>
    </>
  );
}
