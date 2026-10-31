/**
 * The Knowledge list in the Findings tab (coherence.md §4.4, §8): the facts whose spread through the cast the writer tracks.
 * A fact is added, edited and removed here, and each shows its derived ledger, the scenes where a character learns it and where
 * one is shown knowing it. Who learns and who knows is declared on the scene, in the Inspector. Every change is a bus command.
 */

import { UserText } from '../i18n/UserText.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { isolate } from '@caotang/i18n';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useState, type ReactNode } from 'react';
import { KNOWLEDGE_TEXT_LIMIT } from '@caotang/coherence';

import { knowledgeRows, type KnowledgeRow, type LedgerLine } from '../app/knowledge-model.js';
import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { useComposingEnter, useReport, useSession } from './shared.js';


/* lingui-set comment="Knowledge facts. Interpolated values: fact, who, title and about are the writer's own text; declarations is a count." */
export function KnowledgeList({ session, onOpenDocument }: { session: ProjectSession; onOpenDocument?: (docId: string) => void }): ReactNode {
  useLingui();
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
    report({ text: removedText(row.fact.text, row.declarations), tone: 'info' });
  };

  return (
    <section className="knowledge" aria-label={t`Knowledge`} data-testid="knowledge-list">
      <h3 className="findings-section-title">
        <Trans>Knowledge</Trans> <span className="findings-section-count">{rows.length}</span>
      </h3>
      <p className="field-note">
        <Trans>Facts you want to track through the cast. Declare who learns each one, and who is shown knowing it, in a scene’s Inspector; the scan
        reports a character who knows a fact before they learn it.</Trans>
      </p>
      {file === undefined ? (
        <p className="field-note"><Trans>No findings file is open for this project, so facts cannot be kept.</Trans></p>
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
              <span><Trans>New fact</Trans></span>
              <input
                type="text"
                aria-label={t`New knowledge fact`}
                placeholder={t`Mara is the heir`}
                maxLength={KNOWLEDGE_TEXT_LIMIT}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <button type="submit" className="button" disabled={draft.trim() === ''}>
              <Trans>Add fact</Trans>
            </button>
          </form>
          {rows.length === 0 ? <p className="field-note"><Trans>No facts yet.</Trans></p> : null}
          <ul className="knowledge-facts" aria-label={t`Knowledge facts`}>
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
                      aria-label={accessibleText(t`Edit the fact ${{ fact: isolate(row.fact.text) }}`)}
                      maxLength={KNOWLEDGE_TEXT_LIMIT}
                      autoFocus
                      value={editing.text}
                      onChange={(event) => setEditing({ id: row.fact.id, text: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setEditing(null);
                      }}
                    />
                    <button type="submit" className="button" disabled={editing.text.trim() === ''}>
                      <Trans>Save fact</Trans>
                    </button>
                    <button type="button" className="button is-quiet" onClick={() => setEditing(null)}>
                      <Trans>Cancel</Trans>
                    </button>
                  </form>
                ) : (
                  <>
                    <p className="finding-message knowledge-text">{row.fact.text}</p>
                    {row.about !== undefined ? <p className="field-note">{t`About ${{ about: isolate(row.about) }}.`}</p> : null}
                    <Ledger label={accessibleText(t`Where “${{ fact: isolate(row.fact.text) }}” is learned`)} lines={row.learns} kind="learns" onOpen={onOpenDocument} />
                    {row.knows.length > 0 ? (
                      <Ledger label={accessibleText(t`Where “${{ fact: isolate(row.fact.text) }}” is acted on`)} lines={row.knows} kind="knows" onOpen={onOpenDocument} />
                    ) : null}
                    <div className="finding-actions">
                      <button type="button" className="button is-quiet" aria-label={accessibleText(t`Edit the fact ${{ fact: isolate(row.fact.text) }}`)} onClick={() => setEditing({ id: row.fact.id, text: row.fact.text })}>
                        <Trans>Edit</Trans>
                      </button>
                      <button type="button" className="button is-quiet" aria-label={accessibleText(t`Remove the fact ${{ fact: isolate(row.fact.text) }}`)} onClick={() => remove(row)}>
                        <Trans>Remove</Trans>
                      </button>
                      {row.declarations > 0 ? (
                        <span className="field-note">
                          {takesText(row.declarations)}
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
  kind,
  onOpen,
}: {
  label: string;
  lines: readonly LedgerLine[];
  kind: 'learns' | 'knows';
  onOpen?: ((docId: string) => void) | undefined;
}): ReactNode {
  useLingui();
  if (lines.length === 0) return kind === 'learns' ? <p className="field-note"><Trans>No one learns it yet.</Trans></p> : null;
  return (
    <ul className="knowledge-ledger" aria-label={accessibleText(label)}>
      {lines.map((line) => {
        const who = line.who;
        const title = line.title;
        const open = (): void => onOpen?.(line.docId);
        return (
        <li key={`${line.entryId}:${line.docId}`}>
          {kind === 'learns' ? (
            <Trans>
              <UserText value={who} /> learns it in{' '}
              <button type="button" className="knowledge-scene" onClick={open}>
                <UserText value={title} />
              </button>
            </Trans>
          ) : (
            <Trans>
              <UserText value={who} /> is shown knowing it in{' '}
              <button type="button" className="knowledge-scene" onClick={open}>
                <UserText value={title} />
              </button>
            </Trans>
          )}
          {line.counts ? null : <span className="field-note"> <Trans>(a scene that does not teach, so the scan does not count it)</Trans></span>}
        </li>
        );
      })}
    </ul>
  );
}

function removedText(text: string, declarations: number): string {
  const fact = isolate(text);
  return plural(declarations, {
    0: `Removed “${fact}”. Undo puts it back.`,
    one: `Removed “${fact}” and the declaration of who learns or knows it. Undo puts them back.`,
    other: `Removed “${fact}” and the # declarations of who learns or knows it. Undo puts them back.`,
  });
}

function takesText(declarations: number): string {
  return plural(declarations, { one: 'Removing it also takes # declaration from scenes.', other: 'Removing it also takes # declarations from scenes.' });
}
