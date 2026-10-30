/**
 * The inspector's sections that reach beyond the node's own fields: the codex (codex.md §8: the attach picker, the entries
 * attached here, and the mention chips detected in this document) and the scene declarations (coherence.md §5.2, §8: POV,
 * day offsets, the `after` and `expected present` lists, the timeline mode, the setup → payoff threads and who learns and knows each fact), and the export style (exporter.md §2, Per-scene styling).
 * Each change is one bus command.
 */

import { useState, type ReactNode } from 'react';
import { SCENE_STYLES, THREAD_ID_LIMIT, THREAD_NOTE_LIMIT, TIMELINE_MODES, type KnowledgeLinkRecord, type ScenePatch, type SceneThread } from '@caotang/bus';
import type { CodexEntry, TreeNode } from '@caotang/store';

import { attachEntry, explain, setSceneStyle } from './actions.js';
import { afterCandidates, dialogueContainerChoices, modeLabel, povCandidates, sceneMetaOf } from '../app/findings-model.js';
import { characterCandidates, pairWords } from '../app/knowledge-model.js';
import type { ProjectSession } from '../app/session.js';
import { useStoreDraft } from './store-draft.js';
import { useReport, useSession } from './shared.js';
import { isImeEnter } from '../app/ime.js';

/* ------------------------------------------------------------------ *
 * Export style
 * ------------------------------------------------------------------ */

const STYLE_LABELS: Readonly<Record<string, string>> = { normal: 'Normal', section: 'Section' };

/**
 * The scene's export style: Normal, or Section, which prints the scene's title as a heading in the exports. Choosing Normal clears the
 * style. A value this build does not know shows as itself, disabled, and exports as Normal until the writer chooses another.
 */
export function SceneStyleSection({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useSession(session);
  const report = useReport();
  const stored = node.style ?? 'normal';
  const known = (SCENE_STYLES as readonly string[]).includes(stored);
  return (
    <section className="inspector-section" aria-label="Export style" data-testid="scene-style">
      <label className="scene-field">
        <span className="field-label">Export style</span>
        <select
          aria-label="Export style"
          value={stored}
          onChange={(event) => {
            const outcome = setSceneStyle(session, node.id, event.target.value);
            if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
          }}
        >
          {known ? null : (
            <option value={stored} disabled>
              {stored} (unknown, exported as Normal)
            </option>
          )}
          {SCENE_STYLES.map((style) => (
            <option key={style} value={style}>
              {STYLE_LABELS[style] ?? style}
            </option>
          ))}
        </select>
      </label>
      <p className="field-note">Section prints this scene’s title as a heading above it in Word, EPUB, Markdown and plain-text files.</p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Codex
 * ------------------------------------------------------------------ */

export function CodexSection({
  session,
  node,
  onOpenCodex,
}: {
  session: ProjectSession;
  node: TreeNode;
  onOpenCodex?: (entryId: string) => void;
}): ReactNode {
  useSession(session);
  const report = useReport();
  const entries = session.mentions.entriesOf(session.state);
  const attached = entries.filter((entry) => entry.attachments.includes(node.id));
  const available = entries.filter((entry) => !entry.attachments.includes(node.id)).sort(byName);
  const mentions =
    node.type === 'document'
      ? entries
          .map((entry) => ({ entry, count: session.mentions.countsIn(session.state, node.id, entries).get(entry.id) ?? 0 }))
          .filter((row) => row.count > 0)
      : [];

  const attach = (entry: CodexEntry): void => {
    const outcome = attachEntry(session, entry.id, [node.id], []);
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };
  const detach = (entry: CodexEntry): void => {
    const outcome = attachEntry(session, entry.id, [], [node.id]);
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };

  return (
    <section className="inspector-section codex-section" aria-labelledby="inspector-codex-label" data-testid="inspector-codex">
      <h3 id="inspector-codex-label" className="field-label">
        Codex
      </h3>
      <ul className="keyword-list codex-attached" aria-label="Attached codex entries">
        {attached.length === 0 ? <li className="field-note">Nothing is attached here.</li> : null}
        {attached.map((entry) => (
          <li key={entry.id} className="chip chip-codex" data-codex-attached={entry.name}>
            <span>{entry.name}</span>
            <button type="button" className="chip-remove" aria-label={`Detach ${entry.name}`} onClick={() => detach(entry)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {available.length > 0 ? (
        <label className="codex-attach">
          <span className="field-note">Attach an entry to this {node.type === 'document' ? 'document' : 'folder'}</span>
          <select
            aria-label="Attach a codex entry"
            value=""
            onChange={(event) => {
              const entry = available.find((candidate) => candidate.id === event.target.value);
              if (entry !== undefined) attach(entry);
            }}
          >
            <option value="">Choose an entry…</option>
            {available.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {node.type === 'document' ? (
        <div className="codex-mentions">
          <p className="field-label">Mentioned in this document</p>
          {mentions.length === 0 ? <p className="field-note">No codex entry is mentioned here.</p> : null}
          <ul className="mention-chips" aria-label="Mentioned codex entries">
            {mentions.map((row) => (
              <li key={row.entry.id}>
                <button
                  type="button"
                  className="chip mention-chip"
                  data-mention={row.entry.name}
                  aria-label={`Show in the codex: ${row.entry.name}, mentioned here ${row.count} ${row.count === 1 ? 'time' : 'times'}`}
                  onClick={() => onOpenCodex?.(row.entry.id)}
                >
                  <span>{row.entry.name}</span>
                  <span className="mention-count">{row.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function byName(a: CodexEntry, b: CodexEntry): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/* ------------------------------------------------------------------ *
 * Scene declarations
 * ------------------------------------------------------------------ */

/**
 * The SceneMeta editor on a document (coherence.md §5.2, §8): a native disclosure, so it collapses and expands without a
 * custom control. It is writer-declared: the agent never sets these, and the checks fire only on what is declared here.
 */
export function SceneMetaSection({ session, node }: { session: ProjectSession; node: TreeNode }): ReactNode {
  useSession(session);
  const report = useReport();
  const meta = sceneMetaOf(session.coherenceFile(), node.id);
  const entries = session.mentions.entriesOf(session.state);
  const characters = povCandidates(entries);
  const documents = afterCandidates(session.state, node.id);
  const afterTitles = (meta.after ?? []).map((id) => ({ id, title: documents.find((doc) => doc.id === id)?.title ?? 'a document that is gone' }));
  const expected = (meta.expectedPresent ?? []).map((id) => ({ id, name: entries.find((entry) => entry.id === id)?.name ?? 'an entry that is gone' }));

  const dialogue = dialogueContainerChoices(session.state, meta.dialogueContainer);

  const apply = (patch: ScenePatch): void => {
    const outcome = session.dispatch('coherence.setSceneMeta', { docId: node.id, patch });
    if (!outcome.ok) report({ text: explain(outcome.error), tone: 'error' });
  };

  return (
    <details className="inspector-section scene-meta" data-testid="scene-meta">
      <summary className="field-label">Scene declarations</summary>
      <p className="field-note">Only what you declare here is checked. Nothing is inferred from the text.</p>

      <label className="scene-field">
        <span>Point of view</span>
        <select aria-label="Point of view" value={meta.pov ?? ''} onChange={(event) => apply({ pov: event.target.value === '' ? null : event.target.value })}>
          <option value="">No point of view declared</option>
          {characters.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      <NumberField label="Day offset" value={meta.dayOffset} onCommit={(value) => apply({ dayOffset: value })} />
      <NumberField label="Duration in days" value={meta.durationDays} onCommit={(value) => apply({ durationDays: value })} />

      <label className="scene-field">
        <span>Timeline mode</span>
        <select
          aria-label="Timeline mode"
          value={meta.timelineMode ?? 'linear'}
          onChange={(event) => apply({ timelineMode: event.target.value })}
        >
          {TIMELINE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {modeLabel(mode)}
            </option>
          ))}
        </select>
      </label>

      <label className="scene-field">
        <span>Dialogue container</span>
        <select
          aria-label="Dialogue container"
          value={meta.dialogueContainer ?? ''}
          onChange={(event) => apply({ dialogueContainer: event.target.value === '' ? null : event.target.value })}
        >
          <option value="">No dialogue container linked</option>
          {dialogue.missing && meta.dialogueContainer !== undefined ? (
            <option value={meta.dialogueContainer}>A container that is missing</option>
          ) : null}
          {dialogue.containers.map((container) => (
            <option key={container.id} value={container.id}>
              {container.title}
            </option>
          ))}
        </select>
      </label>
      {dialogue.missing ? (
        <p className="field-note" data-testid="dialogue-container-missing">
          The linked dialogue container is archived, outside the manuscript or gone, so this scene is not compared with it.{' '}
          <button type="button" onClick={() => apply({ dialogueContainer: null })}>
            Clear the link
          </button>
        </p>
      ) : (
        <p className="field-note">A screenplay scene is compared with its linked dialogue on speakers only.</p>
      )}

      <ChipList
        label="Follows these scenes"
        items={afterTitles}
        addLabel="Add a scene this follows"
        candidates={documents.filter((doc) => !(meta.after ?? []).includes(doc.id)).map((doc) => ({ id: doc.id, label: doc.title }))}
        onAdd={(id) => apply({ after_add: [id] })}
        onRemove={(id) => apply({ after_remove: [id] })}
        removeLabel={(title) => `Stop following ${title}`}
      />
      <ChipList
        label="Expected to appear"
        items={expected.map((item) => ({ id: item.id, title: item.name }))}
        addLabel="Add an entry expected here"
        candidates={entries
          .filter((entry) => !(meta.expectedPresent ?? []).includes(entry.id))
          .sort(byName)
          .map((entry) => ({ id: entry.id, label: entry.name }))}
        onAdd={(id) => apply({ expectedPresent_add: [id] })}
        onRemove={(id) => apply({ expectedPresent_remove: [id] })}
        removeLabel={(title) => `Stop expecting ${title}`}
      />
      <ThreadsEditor key={node.id} threads={meta.threads ?? []} documents={documents} apply={apply} />
      <KnowledgeEditor
        learns={meta.learns ?? []}
        knows={meta.knows ?? []}
        entries={entries}
        facts={session.coherenceFile()?.knowledge ?? []}
        apply={apply}
      />
    </details>
  );
}

/**
 * Who learns and who knows a fact in this scene (coherence.md §4.4): two rows, each a list of declared pairs and a character and
 * a fact to add. A fact is stated once, in the Knowledge list of the Findings tab. The scan reports a character who is shown
 * knowing a fact in a scene before any scene at or before it teaches them.
 */
function KnowledgeEditor({
  learns,
  knows,
  entries,
  facts,
  apply,
}: {
  learns: readonly KnowledgeLinkRecord[];
  knows: readonly KnowledgeLinkRecord[];
  entries: readonly CodexEntry[];
  facts: readonly { readonly id: string; readonly text: string }[];
  apply: (patch: ScenePatch) => void;
}): ReactNode {
  const characters = characterCandidates(entries);
  const readyToDeclare = characters.length > 0 && facts.length > 0;
  return (
    <div className="scene-chips scene-knowledge" data-testid="scene-knowledge">
      <p className="field-label">Knowledge</p>
      {readyToDeclare ? null : (
        <p className="field-note">
          {facts.length === 0 ? 'Add a fact in the Knowledge list of the Findings tab first.' : 'Add a character to the codex first.'}
        </p>
      )}
      <KnowledgeRowEditor
        label="Learns"
        who="Character who learns"
        what="Fact learned"
        links={learns}
        characters={characters}
        entries={entries}
        facts={facts}
        enabled={readyToDeclare}
        onAdd={(link) => apply({ learns_add: [link] })}
        onRemove={(link) => apply({ learns_remove: [link] })}
      />
      <KnowledgeRowEditor
        label="Knows"
        who="Character who knows"
        what="Fact known"
        links={knows}
        characters={characters}
        entries={entries}
        facts={facts}
        enabled={readyToDeclare}
        onAdd={(link) => apply({ knows_add: [link] })}
        onRemove={(link) => apply({ knows_remove: [link] })}
      />
    </div>
  );
}

function KnowledgeRowEditor({
  label,
  who,
  what,
  links,
  characters,
  entries,
  facts,
  enabled,
  onAdd,
  onRemove,
}: {
  label: string;
  who: string;
  what: string;
  links: readonly KnowledgeLinkRecord[];
  characters: readonly CodexEntry[];
  entries: readonly CodexEntry[];
  facts: readonly { readonly id: string; readonly text: string }[];
  enabled: boolean;
  onAdd: (link: KnowledgeLinkRecord) => void;
  onRemove: (link: KnowledgeLinkRecord) => void;
}): ReactNode {
  const [entryId, setEntryId] = useState('');
  const [factId, setFactId] = useState('');
  return (
    <div className="knowledge-row">
      <p className="field-label">{label}</p>
      <ul className="keyword-list" aria-label={label}>
        {links.length === 0 ? <li className="field-note">None declared.</li> : null}
        {links.map((link) => {
          const words = pairWords(link, entries, facts);
          return (
            <li key={`${link.entryId}:${link.factId}`} className="chip chip-keyword">
              <span>{words}</span>
              <button type="button" className="chip-remove" aria-label={`Stop declaring ${words} under ${label}`} onClick={() => onRemove(link)}>
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {enabled ? (
        <div className="knowledge-pick">
          <select aria-label={who} value={entryId} onChange={(event) => setEntryId(event.target.value)}>
            <option value="">Choose a character…</option>
            {characters.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <select aria-label={what} value={factId} onChange={(event) => setFactId(event.target.value)}>
            <option value="">Choose a fact…</option>
            {facts.map((fact) => (
              <option key={fact.id} value={fact.id}>
                {fact.text}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={entryId === '' || factId === ''}
            aria-label={`Add to ${label}`}
            onClick={() => {
              onAdd({ entryId, factId });
              setEntryId('');
              setFactId('');
            }}
          >
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The threads this scene sets up (coherence.md §5.5): a handle, the scene that pays it off, and a line on what the payoff is
 * for. Editing a thread removes it and adds it back in one patch, so it is one command and one undo.
 */
function ThreadsEditor({
  threads,
  documents,
  apply,
}: {
  threads: readonly SceneThread[];
  documents: readonly { readonly id: string; readonly title: string }[];
  apply: (patch: ScenePatch) => void;
}): ReactNode {
  const [editing, setEditing] = useState<string | null>(null);
  const [handle, setHandle] = useState('');
  const [payoff, setPayoff] = useState('');
  const [note, setNote] = useState('');
  const reset = (): void => {
    setEditing(null);
    setHandle('');
    setPayoff('');
    setNote('');
  };
  const submit = (): void => {
    const thread: SceneThread = note.trim() === '' ? { id: handle.trim(), payoff } : { id: handle.trim(), payoff, note: note.trim() };
    apply(editing === null ? { threads_add: [thread] } : { threads_remove: [editing], threads_add: [thread] });
    reset();
  };
  const titleOf = (id: string): string => documents.find((doc) => doc.id === id)?.title ?? 'a document that is gone';

  return (
    <div className="scene-chips scene-threads" data-testid="scene-threads">
      <p className="field-label">Threads this scene sets up</p>
      <ul className="thread-list" aria-label="Threads">
        {threads.length === 0 ? <li className="field-note">None declared.</li> : null}
        {threads.map((thread) => (
          <li key={thread.id} className="thread-row">
            <span>
              <strong>{thread.id}</strong> is paid off in {titleOf(thread.payoff)}
              {thread.note === undefined ? '' : `: ${thread.note}`}
            </span>
            <button
              type="button"
              className="chip-remove"
              aria-label={`Edit the thread ${thread.id}`}
              onClick={() => {
                setEditing(thread.id);
                setHandle(thread.id);
                setPayoff(thread.payoff);
                setNote(thread.note ?? '');
              }}
            >
              Edit
            </button>
            <button type="button" className="chip-remove" aria-label={`Remove the thread ${thread.id}`} onClick={() => apply({ threads_remove: [thread.id] })}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <label className="scene-field">
        <span>Thread name</span>
        <input type="text" aria-label="Thread name" maxLength={THREAD_ID_LIMIT} value={handle} onChange={(event) => setHandle(event.target.value)} />
      </label>
      <label className="scene-field">
        <span>Paid off in</span>
        <select aria-label="Paid off in" value={payoff} onChange={(event) => setPayoff(event.target.value)}>
          <option value="">Choose a scene…</option>
          {documents.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.title}
            </option>
          ))}
        </select>
      </label>
      <label className="scene-field">
        <span>What the payoff is for</span>
        <input type="text" aria-label="What the payoff is for" maxLength={THREAD_NOTE_LIMIT} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="thread-actions">
        <button type="button" disabled={handle.trim() === '' || payoff === ''} onClick={submit}>
          {editing === null ? 'Add thread' : 'Save thread'}
        </button>
        {editing === null ? null : (
          <button type="button" onClick={reset}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A whole-number day field: committed on blur or Enter, and cleared to "not declared" when left
 * empty.
 *
 * The draft follows the project's value, so a value the project took back — an undo — leaves the
 * field showing what the project holds. Leaving the field then writes nothing, because the draft
 * is the project's value and the commit only writes a value the project does not hold.
 */
function NumberField({ label, value, onCommit }: { label: string; value: number | undefined; onCommit: (value: number | null) => void }): ReactNode {
  const draft = useStoreDraft(value === undefined ? '' : String(value));
  const commit = (): void => {
    const trimmed = draft.value.trim();
    if (trimmed === '') {
      if (value !== undefined) onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) {
      draft.reset();
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <label className="scene-field">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step={1}
        aria-label={label}
        value={draft.value}
        onChange={(event) => draft.change(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !isImeEnter(event)) commit();
        }}
      />
    </label>
  );
}

function ChipList({
  label,
  items,
  addLabel,
  candidates,
  onAdd,
  onRemove,
  removeLabel,
}: {
  label: string;
  items: readonly { readonly id: string; readonly title: string }[];
  addLabel: string;
  candidates: readonly { readonly id: string; readonly label: string }[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  removeLabel: (title: string) => string;
}): ReactNode {
  return (
    <div className="scene-chips">
      <p className="field-label">{label}</p>
      <ul className="keyword-list" aria-label={label}>
        {items.length === 0 ? <li className="field-note">None declared.</li> : null}
        {items.map((item) => (
          <li key={item.id} className="chip chip-keyword">
            <span>{item.title}</span>
            <button type="button" className="chip-remove" aria-label={removeLabel(item.title)} onClick={() => onRemove(item.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {candidates.length > 0 ? (
        <select
          aria-label={addLabel}
          value=""
          onChange={(event) => {
            if (event.target.value !== '') onAdd(event.target.value);
          }}
        >
          <option value="">{addLabel}…</option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
