/**
 * The export dialog's Preview (exporter.md §4, the Draft/Proof duality). The Draft is what the compile would write and what it would leave
 * out, before any file is made: the title page, the chapters with their scenes and words, the totals, and the notes (every skipped document)
 * in the compile log's own words. A media format has no block list, so it shows the compile's counts, or the refusal the compile would get.
 * The Proof is the file itself, for a format whose file is text; it is loaded when the writer first asks for it (ExportProofView).
 * Both are a look: nothing here compiles, writes or dispatches a command.
 */

import { useMemo, useState, type ReactNode } from 'react';
import type { ExportPreview, ExportPreviewRequest } from '@caotang/exporter';

import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { countPhrase, draftListing, holdsOf } from './export-preview-model.js';
import { LazyBoundary, lazyView } from './lazy-view.js';

/** The Proof's code loads the first time the writer asks for it, so the dialog's first draw does not carry it. */
const ExportProofView = lazyView(() => import('./ExportProofView.js').then((module) => ({ default: module.ExportProofView })));

/** The notes the list shows. A longer log says how many it holds. */
const NOTE_CAP = 200;

/** What the dialog has to show: the Draft, or why it has none yet. */
export type PreviewState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'needs-vendor' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly preview: ExportPreview };

/** Which half of the Preview is shown. */
type PreviewView = 'draft' | 'proof';

export function ExportPreviewPanel({
  state,
  session,
  request,
  version,
  formatLabel,
}: {
  state: PreviewState;
  session: ProjectSession;
  /** The request the Draft was made for: the Proof is made for the same one. */
  request: ExportPreviewRequest;
  /** The session's version, so the Proof is made again when the project changes. */
  version: number;
  /** The chosen format in the format list's words, for the Proof's sentence about a format it cannot show. */
  formatLabel: string;
}): ReactNode {
  const [view, setView] = useState<PreviewView>('draft');
  return (
    <fieldset className="export-group">
      <legend className="field-label">Preview</legend>
      <div className="export-preview-views" role="radiogroup" aria-label="Preview shows">
        <label className="export-option">
          <input type="radio" name="export-preview-view" value="draft" checked={view === 'draft'} onChange={() => setView('draft')} />
          <span className="export-option-label">Draft</span>
          <span className="export-option-help">what goes in</span>
        </label>
        <label className="export-option">
          <input type="radio" name="export-preview-view" value="proof" checked={view === 'proof'} onChange={() => setView('proof')} />
          <span className="export-option-label">Proof</span>
          <span className="export-option-help">the file it makes</span>
        </label>
      </div>
      {view === 'draft' ? (
        <PreviewBody state={state} />
      ) : state.kind === 'ready' ? (
        <LazyBoundary label="the Proof">
          <ExportProofView session={session} request={request} version={version} formatLabel={formatLabel} />
        </LazyBoundary>
      ) : (
        <ProofNotReady state={state} />
      )}
    </fieldset>
  );
}

/** The Proof waits on what the Draft waits on (the exporter's readiness, a prompt pack's vendor), and says so in its own words. */
function ProofNotReady({ state }: { state: Exclude<PreviewState, { readonly kind: 'ready' }> }): ReactNode {
  switch (state.kind) {
    case 'waiting':
      return (
        <p className="export-note" role="status">
          Preparing the Proof…
        </p>
      );
    case 'needs-vendor':
      return <p className="export-note">Choose a vendor template to see the Proof of the prompt pack.</p>;
    case 'failed':
      return (
        <p className="form-message is-error" role="alert">
          The Proof could not be made: {state.message}
        </p>
      );
  }
}

function PreviewBody({ state }: { state: PreviewState }): ReactNode {
  switch (state.kind) {
    case 'waiting':
      return <p className="export-note">Preparing the preview…</p>;
    case 'needs-vendor':
      return <p className="export-note">Choose a vendor template to preview the prompt pack.</p>;
    case 'failed':
      return <p className="form-message is-error">The preview could not be made: {state.message}</p>;
    case 'ready':
      return <PreviewResult preview={state.preview} />;
  }
}

function PreviewResult({ preview }: { preview: ExportPreview }): ReactNode {
  const listing = useMemo(() => (preview.kind === 'draft' ? draftListing(preview.blocks) : null), [preview]);

  if (preview.kind === 'refused') {
    return <p className="form-message is-error">This compile would be refused. {explain(preview.error)}</p>;
  }

  const skipped = preview.skippedDocs.length;
  const notes = preview.notes.slice(0, NOTE_CAP);
  const capped = listing !== null && listing.shownScenes < listing.totalScenes;
  return (
    <>
      <div aria-live="polite">
        <p className="export-preview-summary">
          The compile will hold {holdsOf(preview)}
          {skipped > 0 ? `, and leave out ${countPhrase(skipped, 'empty document')}` : ''}.
        </p>
        {preview.kind === 'media' ? (
          <p className="export-note">This format is not built from a block list, so there is none to show. Its counts are the compile’s own.</p>
        ) : null}
        {capped ? (
          <p className="export-note">
            Showing {listing.shownScenes} of {listing.totalScenes} scenes (the counts above are for all of them).
          </p>
        ) : null}
      </div>
      <div className="export-preview" role="region" aria-label="What will be compiled" tabIndex={0}>
        {notes.length > 0 ? (
          <>
            <h3 className="export-preview-heading">Notes</h3>
            <ul className="export-preview-notes">
              {notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
            {preview.notes.length > notes.length ? (
              <p className="export-note">
                {notes.length} of {preview.notes.length} notes. The compile log keeps them all.
              </p>
            ) : null}
          </>
        ) : null}
        {listing === null ? null : (
          <>
            <h3 className="export-preview-heading">In this order</h3>
            {listing.totalScenes === 0 ? (
              <p className="export-note">Nothing to compile: every document in this selection is empty.</p>
            ) : (
              <ol className="export-preview-list">
                {listing.titlePage ? <li className="export-preview-front">Title page</li> : null}
                {listing.rows.map((row) => {
                  switch (row.kind) {
                    case 'chapter':
                      return (
                        <li key={row.key} className="export-preview-chapter" style={{ paddingInlineStart: `${Math.max(0, row.level - 1) * 14}px` }}>
                          {row.number}. {row.title}
                        </li>
                      );
                    case 'scene':
                      return (
                        <li key={row.key} className="export-preview-scene">
                          <span>{row.title}</span>
                          <span className="export-preview-words">{countPhrase(row.words, 'word')}</span>
                        </li>
                      );
                    case 'break':
                      return (
                        <li key={row.key} className="export-preview-break" aria-hidden="true">
                          · · ·
                        </li>
                      );
                  }
                })}
              </ol>
            )}
          </>
        )}
      </div>
    </>
  );
}
