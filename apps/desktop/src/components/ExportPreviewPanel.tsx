/**
 * The export dialog's Preview (exporter.md §4, the Draft/Proof duality). The Draft is what the compile would write and what it would leave
 * out, before any file is made: the title page, the chapters with their scenes and words, the totals, and the notes (every skipped document)
 * in the compile log's own words. A media format has no block list, so it shows the compile's counts, or the refusal the compile would get.
 * The Proof is the file itself, for a format whose file is text; it is loaded when the writer first asks for it (ExportProofView).
 * Both are a look: nothing here compiles, writes or dispatches a command.
 */

/* lingui-set comment="The export dialog's Preview. Interpolated values: holds is the compile's count sentence; message and reason are why it failed; shownScenes, totalScenes, shownNotes and allNotes are counts grouped for the formatter locale." */
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';
import type { ExportPreview, ExportPreviewRequest } from '@caotang/exporter';

import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { formatCount } from '../i18n/locale.js';
import { draftListing, holdsOf } from './export-preview-model.js';
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
      <legend className="field-label">
        <Trans>Preview</Trans>
      </legend>
      <div className="export-preview-views" role="radiogroup" aria-label={t`Preview shows`}>
        <label className="export-option">
          <input type="radio" name="export-preview-view" value="draft" checked={view === 'draft'} onChange={() => setView('draft')} />
          <span className="export-option-label">
            <Trans>Draft</Trans>
          </span>
          <span className="export-option-help">
            <Trans>what goes in</Trans>
          </span>
        </label>
        <label className="export-option">
          <input type="radio" name="export-preview-view" value="proof" checked={view === 'proof'} onChange={() => setView('proof')} />
          <span className="export-option-label">
            <Trans>Proof</Trans>
          </span>
          <span className="export-option-help">
            <Trans>the file it makes</Trans>
          </span>
        </label>
      </div>
      {view === 'draft' ? (
        <PreviewBody state={state} />
      ) : state.kind === 'ready' ? (
        <LazyBoundary label={t`the Proof`}>
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
          <Trans>Preparing the Proof…</Trans>
        </p>
      );
    case 'needs-vendor':
      return (
        <p className="export-note">
          <Trans>Choose a vendor template to see the Proof of the prompt pack.</Trans>
        </p>
      );
    case 'failed': {
      const message = state.message;
      return (
        <p className="form-message is-error" role="alert">
          <Trans>The Proof could not be made: {message}</Trans>
        </p>
      );
    }
  }
}

function PreviewBody({ state }: { state: PreviewState }): ReactNode {
  switch (state.kind) {
    case 'waiting':
      return (
        <p className="export-note">
          <Trans>Preparing the preview…</Trans>
        </p>
      );
    case 'needs-vendor':
      return (
        <p className="export-note">
          <Trans>Choose a vendor template to preview the prompt pack.</Trans>
        </p>
      );
    case 'failed': {
      const message = state.message;
      return (
        <p className="form-message is-error">
          <Trans>The preview could not be made: {message}</Trans>
        </p>
      );
    }
    case 'ready':
      return <PreviewResult preview={state.preview} />;
  }
}

function PreviewResult({ preview }: { preview: ExportPreview }): ReactNode {
  const listing = useMemo(() => (preview.kind === 'draft' ? draftListing(preview.blocks) : null), [preview]);

  if (preview.kind === 'refused') {
    const reason = explain(preview.error);
    return (
      <p className="form-message is-error">
        <Trans>This compile would be refused. {reason}</Trans>
      </p>
    );
  }

  const skipped = preview.skippedDocs.length;
  const notes = preview.notes.slice(0, NOTE_CAP);
  const capped = listing !== null && listing.shownScenes < listing.totalScenes;
  const holds = holdsOf(preview);
  const shownScenes = formatCount(listing?.shownScenes ?? 0);
  const totalScenes = formatCount(listing?.totalScenes ?? 0);
  const shownNotes = formatCount(notes.length);
  const allNotes = formatCount(preview.notes.length);
  return (
    <>
      <div aria-live="polite">
        <p className="export-preview-summary">
          {skipped > 0
            ? plural(skipped, {
                one: `The compile will hold ${holds}, and leave out # empty document.`,
                other: `The compile will hold ${holds}, and leave out # empty documents.`,
              })
            : t`The compile will hold ${holds}.`}
        </p>
        {preview.kind === 'media' ? (
          <p className="export-note">
            <Trans>This format is not built from a block list, so there is none to show. Its counts are the compile’s own.</Trans>
          </p>
        ) : null}
        {capped ? (
          <p className="export-note">
            <Trans>
              Showing {shownScenes} of {totalScenes} scenes (the counts above are for all of them).
            </Trans>
          </p>
        ) : null}
      </div>
      <div className="export-preview" role="region" aria-label={t`What will be compiled`} tabIndex={0}>
        {notes.length > 0 ? (
          <>
            <h3 className="export-preview-heading">
              <Trans>Notes</Trans>
            </h3>
            <ul className="export-preview-notes">
              {notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
            {preview.notes.length > notes.length ? (
              <p className="export-note">
                <Trans>
                  {shownNotes} of {allNotes} notes. The compile log keeps them all.
                </Trans>
              </p>
            ) : null}
          </>
        ) : null}
        {listing === null ? null : (
          <>
            <h3 className="export-preview-heading">
              <Trans>In this order</Trans>
            </h3>
            {listing.totalScenes === 0 ? (
              <p className="export-note">
                <Trans>Nothing to compile: every document in this selection is empty.</Trans>
              </p>
            ) : (
              <ol className="export-preview-list">
                {listing.titlePage ? (
                  <li className="export-preview-front">
                    <Trans>Title page</Trans>
                  </li>
                ) : null}
                {listing.rows.map((row) => {
                  switch (row.kind) {
                    case 'chapter':
                      return (
                        <li
                          key={row.key}
                          className={row.part ? 'export-preview-chapter is-part' : 'export-preview-chapter'}
                          style={{ paddingInlineStart: `${Math.max(0, row.level - 1) * 14}px` }}
                        >
                          {row.part ? row.title : `${row.number}. ${row.title}`}
                        </li>
                      );
                    case 'scene': {
                      const words = row.words;
                      return (
                        <li key={row.key} className="export-preview-scene">
                          <span>{row.title}</span>
                          <span className="export-preview-words">{plural(words, { one: '# word', other: '# words' })}</span>
                        </li>
                      );
                    }
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
