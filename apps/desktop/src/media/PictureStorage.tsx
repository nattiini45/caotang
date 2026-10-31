/**
 * The picture board's storage actions (pictures.md §6.3, §6.4 step 3, §6.6.1): *Sweep unused files…*, *Re-link N renamed pictures* and
 * *Store working copies*. Each one is a bus command the writer confirms here: the sweep is destructive and cannot be undone, so it
 * shows its exact candidates first; the re-link and the working copies are one undo step each.
 *
 * The functions that run a step take the session and the status line, and return what the view needs, so the sentences and the
 * calls are tested without a renderer. A refusal is said in the command's own words.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useState, type ReactNode } from 'react';
import type { RelinkPair, SweepCandidate } from '@caotang/store';

import type { ProjectSession } from '../app/session.js';
import { ChoiceDialog, ConfirmDialog, type Report } from '../components/shared.js';

import {
  exportSweepTitle,
  relinkLabel,
  relinkLinesOf,
  relinkNotice,
  relinkReport,
  sweepNothingText,
  sweepOfferOf,
  sweepReport,
  sweepTitle,
  workingCopyReport,
  workingCopyTitle,
  type SweepOffer,
} from './picture-storage-model.js';

/* lingui-set comment="The picture board's storage actions. count is a number; detail and reason are a sentence a browser or a command wrote; name is a picture's caption or a file name." */

/* ------------------------------------------------------------------ *
 * Steps the views run
 * ------------------------------------------------------------------ */

/**
 * Previews the sweep and says why when there is nothing to confirm. Returns the exact candidates when there are some, else `null`, and
 * has then said so in the status line. Removes nothing.
 */
export async function beginSweep(session: Pick<ProjectSession, 'previewPictureSweep'>, report: Report): Promise<readonly SweepCandidate[] | null> {
  let offer: SweepOffer;
  try {
    offer = sweepOfferOf(await session.previewPictureSweep());
  } catch (failure) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    report({ text: t`The unused files could not be listed, so none was removed: ${{ reason }}`, tone: 'error' });
    return null;
  }
  if (offer.kind === 'ready') return offer.candidates;
  report(offer.kind === 'refused' ? { text: offer.text, tone: 'error' } : { text: sweepNothingText(), tone: 'info' });
  return null;
}

/** Runs the sweep the writer confirmed, and reports what came of it: removed, remaining, and a refusal in the command's own sentence. */
export async function confirmSweep(session: Pick<ProjectSession, 'sweepPictures'>, report: Report): Promise<void> {
  report(sweepReport(await session.sweepPictures()));
}

/**
 * The sweep offered before *Export bundle* (pictures.md §6.5): the exact files a sweep would remove, or `null` when there is nothing
 * to offer. It is only ever an offer. A preview that refuses (a root it could not read, a listing that is not the whole of the folder)
 * or fails offers nothing, and the export goes ahead: a backup is never held back by a clean-up it could not check.
 */
export async function sweepOfferBeforeExport(session: Pick<ProjectSession, 'previewPictureSweep'>): Promise<readonly SweepCandidate[] | null> {
  try {
    const offer = sweepOfferOf(await session.previewPictureSweep());
    return offer.kind === 'ready' ? offer.candidates : null;
  } catch {
    return null;
  }
}

/**
 * Runs the sweep the writer chose before an export. Returns the sentence that says what it did, and whether the export may go on: a
 * sweep that was refused or stopped part-way says so and the export waits, so the writer chooses again with what happened in front of
 * them (the offer still has *Export without removing*).
 */
export async function sweepBeforeExport(session: Pick<ProjectSession, 'sweepPictures'>): Promise<{ readonly text: string; readonly proceed: boolean }> {
  const said = sweepReport(await session.sweepPictures());
  return { text: said.text, proceed: said.tone === 'info' };
}

/** Runs the re-link the writer confirmed: one `asset.relink` over every pair they were shown. */
export async function confirmRelink(session: Pick<ProjectSession, 'relinkPictures'>, report: Report, pairs: readonly RelinkPair[]): Promise<boolean> {
  const result = await session.relinkPictures(pairs);
  report(relinkReport(result));
  return result.ok;
}

/** Runs the bulk working copies the writer confirmed: one `asset.storeWorkingCopies`. Returns whether it landed. */
export async function confirmWorkingCopies(session: Pick<ProjectSession, 'storeWorkingCopies'>, report: Report, ids: readonly string[]): Promise<boolean> {
  const result = await session.storeWorkingCopies(ids);
  report(workingCopyReport(result, ids.length));
  return result.ok;
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

/** The sweep's confirmation: the exact files, and the plain statement that removing them cannot be undone. */
export function SweepConfirm({ candidates, onConfirm, onCancel }: { readonly candidates: readonly SweepCandidate[] | null; readonly onConfirm: () => void; readonly onCancel: () => void }): ReactNode {
  const count = candidates?.length ?? 0;
  return (
    <ConfirmDialog open={candidates !== null} title={sweepTitle(count)} confirmLabel={t`Remove the files`} onCancel={onCancel} onConfirm={onConfirm}>
      <p>
        <Trans>No picture, placement or saved copy in this project names these files:</Trans>
      </p>
      <ul className="pb-uses pb-sweep-list" aria-label={t`Files to remove`} data-testid="sweep-candidates">
        {(candidates ?? []).map((candidate) => (
          <li key={candidate.path} dir="auto">
            {candidate.file}
          </li>
        ))}
      </ul>
      <p>
        <Trans>Removing them cannot be undone. A file that still belongs to a picture is never removed; delete the picture first, then sweep.</Trans>
      </p>
    </ConfirmDialog>
  );
}

/** The offer before *Export bundle*: remove the unused files first, export as they are, or stop. Cancel takes the focus, so Enter removes nothing. */
export function ExportSweepOffer({
  candidates,
  onSweepThenExport,
  onExport,
  onCancel,
}: {
  readonly candidates: readonly SweepCandidate[] | null;
  readonly onSweepThenExport: () => void;
  readonly onExport: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const count = candidates?.length ?? 0;
  return (
    <ChoiceDialog
      open={candidates !== null}
      title={exportSweepTitle(count)}
      choices={[
        { label: t`Export without removing`, onChoose: onExport },
        { label: t`Remove them, then export`, onChoose: onSweepThenExport, danger: true },
      ]}
      onCancel={onCancel}
    >
      <p>
        <Trans>No picture, placement or saved copy in this project names these files:</Trans>
      </p>
      <ul className="pb-uses pb-sweep-list" aria-label={t`Files to remove`} data-testid="export-sweep-candidates">
        {(candidates ?? []).map((candidate) => (
          <li key={candidate.path} dir="auto">
            {candidate.file}
          </li>
        ))}
      </ul>
      <p>
        <Trans>Removing them cannot be undone. A file that still belongs to a picture is never removed. You can export without removing them.</Trans>
      </p>
    </ChoiceDialog>
  );
}

/** The re-link's confirmation: each picture, the file it recorded and the file its bytes were found under. */
export function RelinkConfirm({
  state,
  pairs,
  onConfirm,
  onCancel,
}: {
  readonly state: Pick<ProjectSession['state'], 'manifest'>;
  readonly pairs: readonly RelinkPair[] | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const lines = pairs === null ? [] : relinkLinesOf(state, pairs);
  return (
    <ConfirmDialog open={pairs !== null} title={relinkLabel(lines.length)} confirmLabel={relinkLabel(lines.length)} onCancel={onCancel} onConfirm={onConfirm}>
      <p>
        <Trans>Each picture is pointed at the file with the same bytes. Nothing is matched by name.</Trans>
      </p>
      <ul className="pb-uses" data-testid="relink-pairs">
        {lines.map((line) => (
          <li key={line.key} dir="auto">
            {t`${{ name: line.name }}: ${{ from: line.from }} is now ${{ to: line.to }}`}
          </li>
        ))}
      </ul>
      <p>
        <Trans>Undo points the pictures back at the old names.</Trans>
      </p>
    </ConfirmDialog>
  );
}

/** The bulk working copies' confirmation: what is changed, and that the originals stay until they are deleted and swept. */
export function WorkingCopyConfirm({
  ids,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  readonly ids: readonly string[] | null;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const count = ids?.length ?? 0;
  return (
    <ConfirmDialog open={ids !== null} title={workingCopyTitle(count)} confirmLabel={confirmLabel} onCancel={onCancel} onConfirm={onConfirm}>
      <p>
        <Trans>A working copy is scaled so its longest side is at most 4096 pixels, which takes far less room. Every placement and reference moves to it.</Trans>
      </p>
      <p>
        <Trans>The originals stay in the project, and Undo puts everything back. They are removed only when you delete them and then sweep unused files.</Trans>
      </p>
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ *
 * The re-link notice
 * ------------------------------------------------------------------ */

/**
 * The renamed pictures this project's files show (pictures.md §6.3): a record whose file is missing and an unrecorded file with the
 * same bytes. Looked for once the listing has changed and some picture's file is missing; `null` while there is nothing to offer.
 */
export function useRelinkPairs(session: ProjectSession, version: number, anyMissing: boolean): readonly RelinkPair[] | null {
  const [found, setFound] = useState<{ readonly version: number; readonly pairs: readonly RelinkPair[] } | null>(null);
  useEffect(() => {
    if (!anyMissing) return;
    let live = true;
    void session.planPictureRelink().then(
      (plan) => {
        if (live) setFound({ version, pairs: 'pairs' in plan ? plan.pairs : [] });
      },
      () => {
        if (live) setFound({ version, pairs: [] });
      },
    );
    return () => {
      live = false;
    };
  }, [session, version, anyMissing]);
  if (!anyMissing || found === null || found.version !== version || found.pairs.length === 0) return null;
  return found.pairs;
}

/** One unobtrusive notice on the board, not a modal: how many pictures look renamed, and the button that opens the confirmation. */
export function RelinkNotice({ pairs, busy, onOffer }: { readonly pairs: readonly RelinkPair[]; readonly busy: boolean; readonly onOffer: () => void }): ReactNode {
  return (
    <div className="pb-notice" role="status" data-testid="relink-notice">
      <p className="field-note">{relinkNotice(pairs.length)}</p>
      <div className="pb-notice-actions">
        <button type="button" className="button" disabled={busy} onClick={onOffer}>
          {relinkLabel(pairs.length)}
        </button>
      </div>
    </div>
  );
}
