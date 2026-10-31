/**
 * The export dialog's Proof (exporter.md §4, the Proof half of the Draft/Proof duality): the file the compile would write, made by the
 * compile's own plan and renderer (`ProjectSession.proofExport`), shown as text. It is made again when the request or the project changes.
 * A binary format (Word, EPUB, the spreadsheets, the PDFs) has no Proof here, and the view says so in words rather than showing nothing.
 * It is a look: nothing here compiles, writes or dispatches a command. Loaded on first use (ExportPreviewPanel).
 */

/* lingui-set comment="The export dialog's Proof. Interpolated values: fileName and files are file names; formatLabel is the format's name in the format list; message and reason are why it failed; shown and total are counts grouped for the formatter locale." */
import { plural, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState, type ReactNode } from 'react';
import type { ExportPreviewRequest, ExportProof } from '@caotang/exporter';

import type { ProjectSession } from '../app/session.js';
import { explain } from './actions.js';
import { formatCount } from '../i18n/locale.js';
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
          <Trans>Preparing the Proof…</Trans>
        </p>
      );
    case 'failed': {
      const message = shown.message;
      return (
        <p className="form-message is-error" role="alert">
          <Trans>The Proof could not be made: {message}</Trans>
        </p>
      );
    }
    case 'ready':
      return <ProofResult proof={shown.proof} formatLabel={formatLabel} />;
  }
}

function ProofResult({ proof, formatLabel }: { proof: ExportProof; formatLabel: string }): ReactNode {
  if (proof.kind === 'refused') {
    const reason = explain(proof.error);
    return (
      <p className="form-message is-error">
        <Trans>This compile would be refused. {reason}</Trans>
      </p>
    );
  }
  if (proof.kind === 'none') {
    return (
      <div aria-live="polite">
        <p className="export-preview-summary">
          <Trans>There is no Proof of {formatLabel} in Caotang.</Trans>
        </p>
        <p className="export-note">
          <Trans>
            It is a binary file that Caotang cannot draw here, and a look-alike drawn in its place could differ from the real file. The Draft shows
            what goes in; compile and open the file to see its pages. Markdown, plain text and the other text formats (Fountain, Final Draft, the
            Ink story, the CSV tables, the prompt pack and the coherence report) have a Proof.
          </Trans>
        </p>
      </div>
    );
  }
  const excerpt = proofExcerpt(proof.text);
  const others = proof.otherFiles.length;
  const fileName = proof.fileName;
  const files = proof.otherFiles.join(', ');
  const totalChars = excerpt.totalChars;
  const shown = formatCount(excerpt.shownChars);
  return (
    <>
      <div aria-live="polite">
        <p className="export-preview-summary">
          {others > 0
            ? plural(others, {
                one: `The compile will write ${fileName}, and # more file: ${files}.`,
                other: `The compile will write ${fileName}, and # more files: ${files}.`,
              })
            : t`The compile will write ${fileName}.`}
        </p>
        {others > 0 ? (
          <p className="export-note">
            <Trans>The Proof shows the first file.</Trans>
          </p>
        ) : null}
        {excerpt.shownChars < totalChars ? (
          <p className="export-note">
            {plural(totalChars, {
              one: `Showing the first ${shown} of # character. The compile writes them all.`,
              other: `Showing the first ${shown} of # characters. The compile writes them all.`,
            })}
          </p>
        ) : null}
      </div>
      <div className="export-preview" role="region" aria-label={t`The file the compile will write`} tabIndex={0}>
        <pre className="export-proof-text">{excerpt.text}</pre>
      </div>
    </>
  );
}
