/**
 * The words a stopped tab kept (unsent-copy.ts), offered back once the project is open again, in the binder footer. Each stop that kept
 * words has its own block, so two stops' words are both offered and neither overwrites the other.
 *
 * Words the pending journal kept through a reload that the store has moved past are offered the same way (`UnsentEntry.origin`, pending-journal.ts).
 * The offer shows only in a tab that is not stopped. A stopped tab answers its own notice (StaleTabNotice), and a put-back there would write
 * into a session that writes nothing to the store. Putting the words back adds them as new documents through the bus, so nothing already saved
 * is overwritten, and each addition is an undo group of its own. A block leaves the copy only once the store has saved the put-back: a save that
 * fails keeps it, and a second try repeats only the step that did not land (restoreStep). Discarding removes that stop's block and nothing else.
 */

import { useState, type ReactNode } from 'react';
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';

import {
  KEPT_CHAPTER_TITLE,
  RELOAD_CHAPTER_TITLE,
  browserStorage,
  putBackDocuments,
  readUnsentEntries,
  removeUnsentEntry,
  restoreParentOf,
  restoreStep,
  type UnsentDocument,
  unsentStamp,
  type UnsentEntry,
} from '../app/unsent-copy.js';
import type { ProjectSession } from '../app/session.js';
import { createdNodeId, explain } from './actions.js';
import { useSession } from './shared.js';
import './unsent-words.css';

/* lingui-set comment="Interpolated values: count, stamp, titles" */

export function UnsentWords({ session }: { session: ProjectSession }): ReactNode {
  // Re-read on every change to the session, because a stopped session keeps its copy up to date as it takes the writer's typing.
  useSession(session);
  const [answered, setAnswered] = useState(0);
  // The stop whose words are being put back (its buttons wait for the save), and the failure to show under the blocks.
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const storage = browserStorage();
  const entries = readUnsentEntries(storage, session.projectId);
  if (entries.length === 0) return null;
  if (session.saveState() === 'conflict') return null;

  const writeBody = (docId: string, body: string): string | null => {
    const written = session.dispatch('doc.write', { docId, body });
    return written.ok ? null : t`The words could not be put back: ${{ reason: explain(written.error) }}`;
  };

  /**
   * Makes one kept document as a new document in its own chapter (a note: its own Research folder), or writes its body into the document an earlier try made. Returns why
   * it could not, or `null`. The created id is recorded before the body is written, so a body write that fails is retried, not repeated as a
   * create. A document whose chapter is gone (or that recorded none) goes into the kept chapter, which `keptChapter` makes once per put-back.
   */
  const putOne = (
    doc: UnsentDocument,
    entry: UnsentEntry,
    recordCreated: (docId: string) => void,
    keptChapter: () => string | { readonly failure: string },
  ): string | null => {
    const existing = doc.restoredAs === undefined ? undefined : session.state.documents.get(doc.restoredAs);
    const step = restoreStep(doc, existing);
    if (step.kind === 'done') return null;
    if (step.kind === 'write') return writeBody(step.docId, doc.body);
    const parentId = restoreParentOf(session.state, doc.parentId) ?? keptChapter();
    if (typeof parentId !== 'string') return parentId.failure;
    const created = session.dispatch('binder.create', {
      parentId,
      type: 'document',
      title:
        entry.origin === 'reload'
          ? t`${{ title: doc.title }} (kept from before a reload)`
          : t`${{ title: doc.title }} (kept from a stopped tab)`,
    });
    const docId = createdNodeId(created);
    if (docId === undefined) {
      return created.ok
        ? t`The words could not be put back: the new document has no id.`
        : t`The words could not be put back: ${{ reason: explain(created.error) }}`;
    }
    recordCreated(docId);
    return writeBody(docId, doc.body);
  };

  const putBack = async (entry: UnsentEntry): Promise<void> => {
    setBusy(entry.stopId);
    setFailure(null);
    // The kept chapter, made the first time a document of this put-back needs it, at the end of the manuscript.
    let kept: string | null = null;
    const keptChapter = (): string | { readonly failure: string } => {
      if (kept !== null) return kept;
      const made = session.dispatch('binder.create', {
        parentId: 'manuscript',
        type: 'folder',
        title: entry.origin === 'reload' ? RELOAD_CHAPTER_TITLE : KEPT_CHAPTER_TITLE,
      });
      const id = createdNodeId(made);
      if (id === undefined) {
        return {
          failure: made.ok
            ? t`The words could not be put back: the new chapter has no id.`
            : t`The words could not be put back: ${{ reason: explain(made.error) }}`,
        };
      }
      kept = id;
      return id;
    };
    const failed = putBackDocuments(storage, session.projectId, entry.stopId, (doc, recordCreated) => putOne(doc, entry, recordCreated, keptChapter));
    if (failed !== null) {
      setFailure(failed);
    } else {
      // The documents are in the session. They leave the copy only once the store holds them, so a save that fails keeps the words.
      try {
        await session.settle();
      } catch {
        // The save state below says whether the store holds the words; a failed settle is that case.
      }
      if (session.saveState() === 'saved') removeUnsentEntry(storage, session.projectId, entry.stopId);
      else setFailure(t`The words are in this project, but the store has not saved them yet. They stay kept here until a save lands.`);
    }
    setBusy(null);
    setAnswered((count) => count + 1);
  };

  const discard = (entry: UnsentEntry): void => {
    removeUnsentEntry(storage, session.projectId, entry.stopId);
    setFailure(null);
    setAnswered((count) => count + 1);
  };

  return (
    <section className="footer-section unsent-words" aria-label={t`Words kept from a stopped tab`} data-testid="unsent-words" data-answered={answered}>
      {entries.map((entry) => {
        const count = entry.documents.length;
        const stamp = unsentStamp(entry.savedAt);
        const reload = entry.origin === 'reload';
        const lead = reload
          ? t`The page reloaded before these words were saved, and the project has newer text now (from another tab, or a save that did land).`
          : t`A tab stopped because another tab saved newer text for this project.`;
        const titles = isolate(entry.documents.map((doc) => doc.title).join(', '));
        const chapter = reload ? RELOAD_CHAPTER_TITLE : KEPT_CHAPTER_TITLE;
        const body =
          stamp === ''
            ? t`The words it held were kept in this browser, in ${plural(count, { one: 'one document', other: '# documents' })}: ${{ titles }}. Putting them back adds them as new documents in the chapters they came from, so nothing already saved is overwritten. A document whose chapter is gone goes into a new chapter, “${{ chapter }}”.`
            : t`The words it held were kept in this browser on ${{ stamp }}, in ${plural(count, { one: 'one document', other: '# documents' })}: ${{ titles }}. Putting them back adds them as new documents in the chapters they came from, so nothing already saved is overwritten. A document whose chapter is gone goes into a new chapter, “${{ chapter }}”.`;
        return (
          <div key={entry.stopId} className="unsent-entry" data-stop={entry.stopId}>
            <h3 className="footer-title">{reload ? <Trans>Kept from before a reload</Trans> : <Trans>Kept from a stopped tab</Trans>}</h3>
            <p className="field-note">
              {lead} {body}
            </p>
            <div className="unsent-actions">
              <button type="button" className="button is-primary" disabled={busy !== null} onClick={() => void putBack(entry)}>
                <Trans>Put them back as new documents</Trans>
              </button>
              <button type="button" className="button is-quiet" disabled={busy !== null} onClick={() => discard(entry)}>
                <Trans>Discard them</Trans>
              </button>
            </div>
          </div>
        );
      })}
      {failure !== null ? (
        <p className="form-message is-error" role="alert">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
