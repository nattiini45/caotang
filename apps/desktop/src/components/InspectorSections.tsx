/**
 * The inspector's two sections that reach beyond the node's own fields: the codex (codex.md §8: the attach picker, the entries
 * attached here, and the mention chips detected in this document) and the scene declarations (coherence.md §5.2, §8: POV,
 * day offsets, the `after` and `expected present` lists, and the timeline mode). Each change is one bus command.
 */

import { type ReactNode } from 'react';
import { TIMELINE_MODES, type ScenePatch } from '@caotang/bus';
import type { CodexEntry, TreeNode } from '@caotang/store';

import { attachEntry, explain } from './actions.js';
import { afterCandidates, modeLabel, povCandidates, sceneMetaOf } from '../app/findings-model.js';
import type { ProjectSession } from '../app/session.js';
import { useStoreDraft } from './store-draft.js';
import { useReport, useSession } from './shared.js';

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
    </details>
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
          if (event.key === 'Enter') commit();
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
