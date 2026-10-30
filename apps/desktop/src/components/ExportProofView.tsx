/**
 * The export dialog's Proof (exporter.md §4, the Proof half of the Draft/Proof duality): the file the compile would write, made by the
 * compile's own plan and renderer (`ProjectSession.proofExport`), shown as text. It is made again when the request or the project changes.
 * A binary format (Word, EPUB, the spreadsheets, the PDFs) has no Proof here, and the view says so in words rather than showing nothing.
 * It is a look: nothing here compiles, writes or dispatches a command. Loaded on first use (ExportPreviewPanel).
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { ExportPreviewRequest, ExportProof } from '@caotang/exporter';

import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { countPhrase } from './export-preview-model.js';
import { proofExcerpt } from './export-proof-model.js';

type ProofState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly proof: ExportProof };

export function ExportProofView({
  session,
  request,
  version,
  formatLabel,
}: {
  session: ProjectSession;
  request: ExportPreviewRequest;
  /** The session's version: a change to the project makes the Proof again. */
  version: number;
  formatLabel: string;
}): ReactNode {
  // The request is a new object on each of the dialog's renders, so the Proof is made again only when what it asks for changes.
  const key = `${version}\u0000${JSON.stringify(request)}`;
  const [state, setState] = useState<{ readonly key: string; readonly proof: ProofState } | null>(null);
  useEffect(() => {
    let live = true;
    const asked = JSON.parse(key.slice(key.indexOf('\u0000') + 1)) as ExportPreviewRequest;
    session.proofExport(asked).then(
      (proof) => {
        if (live) setState({ key, proof: { kind: 'ready', proof } });
      },
      (error: unknown) => {
        if (live) setState({ key, proof: { kind: 'failed', message: error instanceof Error ? error.message : String(error) } });
      },
    );
    return () => {
      live = false;
    };
  }, [session, key]);

  // A Proof made for an earlier request is not shown for this one.
  const shown: ProofState = state !== null && state.key === key ? state.proof : { kind: 'waiting' };
  switch (shown.kind) {
    case 'waiting':
      return (
        <p className="export-note" role="status">
          Preparing the Proof…
        </p>
      );
    case 'failed':
      return (
        <p className="form-message is-error" role="alert">
          The Proof could not be made: {shown.message}
        </p>
      );
    case 'ready':
      return <ProofResult proof={shown.proof} formatLabel={formatLabel} />;
  }
}

function ProofResult({ proof, formatLabel }: { proof: ExportProof; formatLabel: string }): ReactNode {
  if (proof.kind === 'refused') {
    return <p className="form-message is-error">This compile would be refused. {explain(proof.error)}</p>;
  }
  if (proof.kind === 'none') {
    return (
      <div aria-live="polite">
        <p className="export-preview-summary">There is no Proof of {formatLabel} in Caotang.</p>
        <p className="export-note">
          It is a binary file that Caotang cannot draw here, and a look-alike drawn in its place could differ from the real file. The Draft shows
          what goes in; compile and open the file to see its pages. Markdown, plain text and the other text formats (Fountain, Final Draft, the Ink
          story, the CSV tables, the prompt pack and the coherence report) have a Proof.
        </p>
      </div>
    );
  }
  const excerpt = proofExcerpt(proof.text);
  const others = proof.otherFiles.length;
  return (
    <>
      <div aria-live="polite">
        <p className="export-preview-summary">
          The compile will write {proof.fileName}
          {others > 0 ? `, and ${countPhrase(others, 'more file')}: ${proof.otherFiles.join(', ')}` : ''}.
        </p>
        {others > 0 ? <p className="export-note">The Proof shows the first file.</p> : null}
        {excerpt.shownChars < excerpt.totalChars ? (
          <p className="export-note">
            Showing the first {countPhrase(excerpt.shownChars, 'character')} of {countPhrase(excerpt.totalChars, 'character')}. The compile writes them all.
          </p>
        ) : null}
      </div>
      <div className="export-preview" role="region" aria-label="The file the compile will write" tabIndex={0}>
        <pre className="export-proof-text">{excerpt.text}</pre>
      </div>
    </>
  );
}
