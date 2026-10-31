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

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { MEMORY_TYPES, slugOf, type MemoryType } from '@caotang/bus';
import type { ToolName } from '@caotang/harness';

import { INITIALISE_INTENT, agentInstructionsView, tokensLabel, type AgentInstructionsView } from '../app/agent-instructions-model.js';
import type { AppServices } from '../app/services.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { useReturnFocus } from './dialog-focus.js';
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

const TYPE_LABELS: Readonly<Record<MemoryType, string>> = {
  style: 'Style',
  preference: 'Preference',
  process: 'Process',
  reference: 'Reference',
};

/** The panel, rendered only while its request is open. It is a modal, so it is mounted on open and dropped on close. */
export function AgentInstructionsPanel(props: AgentInstructionsProps): ReactNode {
  const request = useDialogRequest();
  if (request === null || request.kind !== 'agent-instructions') return null;
  return <AgentInstructionsDialog {...props} />;
}

type Edit = { readonly kind: 'none' } | { readonly kind: 'note'; readonly slug: string | null };

function AgentInstructionsDialog({ session, services, onAgentIntent }: AgentInstructionsProps): ReactNode {
  useSession(session);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useReturnFocus();
  const report = useReport();
  const [edit, setEdit] = useState<Edit>({ kind: 'none' });
  const [forgetting, setForgetting] = useState<{ readonly slug: string; readonly title: string } | null>(null);
  const budget = services.settings.current().context.layerBudgets.LI;
  const view = agentInstructionsView(session.state, budget);

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
  }, []);

  const close = (): void => {
    returnFocus();
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
    report(result.ok ? { text: `Forgot “${forgetting.title}”. Undo brings it back.`, tone: 'info' } : { text: explain(result.error), tone: 'error' });
  };

  return (
    <>
    <dialog
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
        <h2 id="agent-instructions-title">Agent instructions</h2>
        {edit.kind === 'note' ? (
          <NoteEditor session={session} view={view} slug={edit.slug} onDone={() => setEdit({ kind: 'none' })} />
        ) : (
          <>
            <p className="project-dialog-help">
              What the agent reads with every request: your instructions, and a short index of the notes it has kept. Both are plain files in your
              project, <code>CAOTANG.md</code> and a <code>memory</code> folder, so you can edit them anywhere.
            </p>
            <Budget view={view} />
            <Instructions session={session} view={view} onInitialise={initialise} />
            <Notes view={view} onEdit={(slug) => setEdit({ kind: 'note', slug })} onForget={setForgetting} />
            <div className="confirm-actions">
              <button type="button" className="button is-primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </dialog>
    <ConfirmDialog
      open={forgetting !== null}
      title={forgetting === null ? 'Forget this note?' : `Forget “${forgetting.title}”?`}
      confirmLabel="Forget"
      onCancel={() => setForgetting(null)}
      onConfirm={forget}
    >
      <p>The agent will no longer see this note, and its file leaves the project at the next save. Undo brings it back.</p>
    </ConfirmDialog>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Size against the budget
 * ------------------------------------------------------------------ */

function Budget({ view }: { view: AgentInstructionsView }): ReactNode {
  const used = view.instructionsTokens + view.indexTokens;
  return (
    <div className="agent-instructions-budget" data-testid="instructions-budget">
      <p role="status">
        {tokensLabel(used)} in your instructions and the memory index; the agent is sent {tokensLabel(view.sentTokens)} of the {tokensLabel(view.budget)} allowed.
      </p>
      {view.capLines.map((line) => (
        <p key={line} className="project-dialog-error" role="alert">
          {line}. Shorten the file, or raise the limit in Settings › Context.
        </p>
      ))}
      <progress value={Math.min(view.sentTokens, view.budget)} max={Math.max(view.budget, 1)} aria-label="Share of the instructions budget in use" />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * CAOTANG.md
 * ------------------------------------------------------------------ */

function Instructions({ session, view, onInitialise }: { session: ProjectSession; view: AgentInstructionsView; onInitialise: () => void }): ReactNode {
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
    report(result.ok ? { text: 'Saved CAOTANG.md. Undo brings the old text back.', tone: 'info' } : { text: explain(result.error), tone: 'error' });
  };

  return (
    <section className="agent-instructions-file" aria-labelledby="agent-instructions-file-title">
      <h3 id="agent-instructions-file-title" className="skills-heading">
        {view.file === 'AGENTS.md' ? 'AGENTS.md (read because there is no CAOTANG.md)' : 'CAOTANG.md'}
      </h3>
      {view.file === 'AGENTS.md' ? (
        <p className="project-dialog-help">
          This project has an AGENTS.md and no CAOTANG.md, so the agent reads AGENTS.md. Saving here writes a CAOTANG.md, which the agent then reads instead; AGENTS.md is left as it is.
        </p>
      ) : null}
      {blocked ? (
        <p className="project-dialog-error" role="alert">
          CAOTANG.md in this project is not UTF-8 text, so it is left as it is and the agent does not see it. Convert it to UTF-8, then open the project again.
        </p>
      ) : null}
      <label className="project-dialog-field">
        <span className="field-label">Your instructions to the agent</span>
        <textarea
          className="skills-editor"
          rows={8}
          value={draft}
          spellCheck
          disabled={blocked}
          placeholder="British spelling. Past tense, close third person on Mara. No semicolons in dialogue."
          aria-describedby="agent-instructions-size"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <p id="agent-instructions-size" className="project-dialog-help">
        {tokensLabel(Math.ceil(draft.length / 4))} as typed.
      </p>
      <div className="project-dialog-row">
        <button type="button" className="button is-primary" disabled={!changed || blocked} onClick={save}>
          Save
        </button>
        <button type="button" className="button" disabled={!changed} onClick={() => setDraft(view.text)}>
          Revert
        </button>
        <button type="button" className="button" disabled={blocked} title="The agent drafts a first CAOTANG.md from your manuscript, and you approve it on a card" onClick={onInitialise}>
          Initialise from this project
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
  return (
    <section aria-labelledby="agent-notes-title">
      <h3 id="agent-notes-title" className="skills-heading">
        Memory notes
      </h3>
      <p className="project-dialog-help">
        A habit or a preference the agent kept so you do not have to say it again. A fact about the story belongs in the codex, not here.
      </p>
      {view.notes.length === 0 && view.unreadable.length === 0 ? <p className="skills-empty">The agent has kept no notes yet.</p> : null}
      <ul className="skills-list">
        {view.notes.map((note) => (
          <li key={note.slug} className="skills-row" data-testid={`memory-note-${note.slug}`}>
            <div className="skills-row-head">
              <strong>{note.title}</strong>
              <span className="chip">{TYPE_LABELS[note.type]}</span>
              <span className="chip">{note.origin === 'agent' ? 'Kept by the agent' : 'Written by you'}</span>
              <span className="project-dialog-help">{tokensLabel(note.tokens)}</span>
            </div>
            <p className="skills-description">{note.body}</p>
            <div className="project-dialog-row">
              <button type="button" className="button" aria-label={`Edit ${note.title}`} onClick={() => onEdit(note.slug)}>
                Edit
              </button>
              <button type="button" className="button is-quiet" aria-label={`Forget ${note.title}`} onClick={() => onForget(note)}>
                Forget
              </button>
            </div>
          </li>
        ))}
        {view.unreadable.map((note) => (
          <li key={note.path} className="skills-row">
            <div className="skills-row-head">
              <strong>{note.path}</strong>
              <span className="chip">Cannot be read</span>
            </div>
            <p className="skills-description">
              This file has no front matter the app can read, so it is kept as it is and the agent does not see it. Fix it in a text editor, or forget it here. Opening
              the project never deletes it.
            </p>
            <div className="project-dialog-row">
              <button type="button" className="button is-quiet" aria-label={`Forget ${note.path}`} onClick={() => onForget({ slug: note.slug, title: note.path })}>
                Forget
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="project-dialog-row">
        <button type="button" className="button" onClick={() => onEdit(null)}>
          Add a note…
        </button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Add or edit a note
 * ------------------------------------------------------------------ */

function NoteEditor({ session, view, slug, onDone }: { session: ProjectSession; view: AgentInstructionsView; slug: string | null; onDone: () => void }): ReactNode {
  const report = useReport();
  const held = slug === null ? undefined : view.notes.find((note) => note.slug === slug);
  const [title, setTitle] = useState(held?.title ?? '');
  const [type, setType] = useState<MemoryType>(held?.type ?? 'preference');
  const [body, setBody] = useState(held?.body ?? '');
  const [problem, setProblem] = useState<string | null>(null);

  const save = (): void => {
    const chosen = held?.slug ?? slugOf(title);
    if (chosen === '') {
      setProblem('Give the note a title in words.');
      return;
    }
    // A new note whose slug a note already has would replace that note: say so instead.
    if (held === undefined && view.notes.some((note) => note.slug === chosen)) {
      setProblem(`There is already a note called “${view.notes.find((note) => note.slug === chosen)?.title ?? chosen}”. Edit that one instead.`);
      return;
    }
    const result = session.writeMemoryNote({ slug: chosen, type, title: title.trim(), body }, held?.digest);
    if (!result.ok) {
      setProblem(explain(result.error));
      return;
    }
    report({ text: `Saved the note “${title.trim()}”. Undo brings back the old text.`, tone: 'info' });
    onDone();
  };

  return (
    <>
      <h3 className="skills-heading">{held === undefined ? 'New memory note' : `Edit “${held.title}”`}</h3>
      <label className="project-dialog-field">
        <span className="field-label">Title</span>
        <input type="text" value={title} maxLength={120} autoFocus onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="project-dialog-field">
        <span className="field-label">Kind</span>
        <select value={type} onChange={(event) => setType(event.target.value as MemoryType)}>
          {MEMORY_TYPES.map((kind) => (
            <option key={kind} value={kind}>
              {TYPE_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className="project-dialog-field">
        <span className="field-label">Note</span>
        <textarea className="skills-editor" rows={6} value={body} maxLength={4000} spellCheck onChange={(event) => setBody(event.target.value)} />
        <span className="project-dialog-help">{tokensLabel(Math.ceil(body.length / 4))}. Lead with the rule in one line.</span>
      </label>
      {problem !== null ? (
        <p className="project-dialog-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="button is-quiet" onClick={onDone}>
          Cancel
        </button>
        <button type="button" className="button is-primary" disabled={title.trim() === '' || body.trim() === ''} onClick={save}>
          Save
        </button>
      </div>
    </>
  );
}
