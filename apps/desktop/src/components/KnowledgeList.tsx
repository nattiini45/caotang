/**
 * The Knowledge list in the Findings tab (coherence.md §4.4, §8): the facts whose spread through the cast the writer tracks.
 * A fact is added, edited and removed here, and each shows its derived ledger, the scenes where a character learns it and where
 * one is shown knowing it. Who learns and who knows is declared on the scene, in the Inspector. Every change is a bus command.
 */

import { useState, type ReactNode } from 'react';
import { KNOWLEDGE_TEXT_LIMIT } from '@caotang/coherence';

import { knowledgeRows, type KnowledgeRow, type LedgerLine } from '../app/knowledge-model.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { useComposingEnter, useReport, useSession } from './shared.js';

export function KnowledgeList({ session, onOpenDocument }: { session: ProjectSession; onOpenDocument?: (docId: string) => void }): ReactNode {
  useSession(session);
  const report = useReport();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string } | null>(null);
  // Both forms save on Enter (ui-modules §2.5): the mark from the keydown keeps a composing Enter from adding or editing a fact.
  const addIme = useComposingEnter();
  const editIme = useComposingEnter();
  const file = session.coherenceFile();
  const rows = knowledgeRows(session.state, file);

  const add = (): void => {
    const outcome = session.dispatch('coherence.addKnowledgeFact', { text: draft });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    setDraft('');
  };

  const save = (id: string, text: string): void => {
    const outcome = session.dispatch('coherence.editKnowledgeFact', { factId: id, text });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    setEditing(null);
  };

  const remove = (row: KnowledgeRow): void => {
    const outcome = session.dispatch('coherence.removeKnowledgeFact', { factId: row.fact.id });
    if (!outcome.ok) {
      report({ text: explain(outcome.error), tone: 'error' });
      return;
    }
    const taken = row.declarations === 0 ? '' : ` and the ${row.declarations === 1 ? 'declaration' : `${row.declarations} declarations`} of who learns or knows it`;
    report({ text: `Removed “${row.fact.text}”${taken}. Undo puts ${row.declarations === 0 ? 'it' : 'them'} back.`, tone: 'info' });
  };

  return (
    <section className="knowledge" aria-label="Knowledge" data-testid="knowledge-list">
      <h3 className="findings-section-title">
        Knowledge <span className="findings-section-count">{rows.length}</span>
      </h3>
      <p className="field-note">
        Facts you want to track through the cast. Declare who learns each one, and who is shown knowing it, in a scene’s Inspector; the scan
        reports a character who knows a fact before they learn it.
      </p>
      {file === undefined ? (
        <p className="field-note">No findings file is open for this project, so facts cannot be kept.</p>
      ) : (
        <>
          <form
            className="knowledge-add"
            onKeyDown={addIme.noteKey}
            onSubmit={(event) => {
              event.preventDefault();
              if (addIme.takesSubmit()) return;
              add();
            }}
          >
            <label className="scene-field">
              <span>New fact</span>
              <input
                type="text"
                aria-label="New knowledge fact"
                placeholder="Mara is the heir"
                maxLength={KNOWLEDGE_TEXT_LIMIT}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <button type="submit" className="button" disabled={draft.trim() === ''}>
              Add fact
            </button>
          </form>
          {rows.length === 0 ? <p className="field-note">No facts yet.</p> : null}
          <ul className="knowledge-facts" aria-label="Knowledge facts">
            {rows.map((row) => (
              <li key={row.fact.id} className="knowledge-fact" data-fact={row.fact.id}>
                {editing?.id === row.fact.id ? (
                  <form
                    className="knowledge-add"
                    onKeyDown={editIme.noteKey}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (editIme.takesSubmit()) return;
                      save(row.fact.id, editing.text);
                    }}
                  >
                    <input
                      type="text"
                      aria-label={`Edit the fact ${row.fact.text}`}
                      maxLength={KNOWLEDGE_TEXT_LIMIT}
                      autoFocus
                      value={editing.text}
                      onChange={(event) => setEditing({ id: row.fact.id, text: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setEditing(null);
                      }}
                    />
                    <button type="submit" className="button" disabled={editing.text.trim() === ''}>
                      Save fact
                    </button>
                    <button type="button" className="button is-quiet" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <p className="finding-message knowledge-text">{row.fact.text}</p>
                    {row.about !== undefined ? <p className="field-note">About {row.about}.</p> : null}
                    <Ledger label={`Where “${row.fact.text}” is learned`} lines={row.learns} verb="learns it in" none="No one learns it yet." onOpen={onOpenDocument} />
                    {row.knows.length > 0 ? (
                      <Ledger label={`Where “${row.fact.text}” is acted on`} lines={row.knows} verb="is shown knowing it in" none="" onOpen={onOpenDocument} />
                    ) : null}
                    <div className="finding-actions">
                      <button type="button" className="button is-quiet" aria-label={`Edit the fact ${row.fact.text}`} onClick={() => setEditing({ id: row.fact.id, text: row.fact.text })}>
                        Edit
                      </button>
                      <button type="button" className="button is-quiet" aria-label={`Remove the fact ${row.fact.text}`} onClick={() => remove(row)}>
                        Remove
                      </button>
                      {row.declarations > 0 ? (
                        <span className="field-note">
                          Removing it also takes {row.declarations === 1 ? '1 declaration' : `${row.declarations} declarations`} from scenes.
                        </span>
                      ) : null}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** One half of a fact's ledger: a sentence per character and scene, each scene a button that opens it. */
function Ledger({
  label,
  lines,
  verb,
  none,
  onOpen,
}: {
  label: string;
  lines: readonly LedgerLine[];
  verb: string;
  none: string;
  onOpen?: ((docId: string) => void) | undefined;
}): ReactNode {
  if (lines.length === 0) return none === '' ? null : <p className="field-note">{none}</p>;
  return (
    <ul className="knowledge-ledger" aria-label={label}>
      {lines.map((line) => (
        <li key={`${line.entryId}:${line.docId}`}>
          {line.who} {verb}{' '}
          <button type="button" className="knowledge-scene" onClick={() => onOpen?.(line.docId)}>
            {line.title}
          </button>
          {line.counts ? null : <span className="field-note"> (a scene that does not teach, so the scan does not count it)</span>}
        </li>
      ))}
    </ul>
  );
}
