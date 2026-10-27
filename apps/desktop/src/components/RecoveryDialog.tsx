/**
 * The recovery offer (project-format §5): a folder or a bundle whose project file will not load, and a copy that Caotang can open
 * instead. The dialog names the copy it would use, and what a rebuild would lose. Nothing is written until the writer says yes:
 * Cancel leaves the folder or bundle as it was. An accept the folder check refuses writes nothing either, and the dialog says why.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { select, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { isolate } from '@caotang/i18n';
import { joinWords } from '@caotang/store';

import type { FolderFileChange, PendingRecovery, RecoveryRefusal } from '../app/lifecycle.js';

/* lingui-set comment="Interpolated values: confirm, generation, label, name, path" */

export interface RecoveryDialogProps {
  readonly recovery: PendingRecovery;
  /** The accept is in progress; both buttons wait for it. */
  readonly busy: boolean;
  /** Why the last accept was refused, with nothing written. `locked` asks again with the lock answered; `changed` and `files` ask the writer to reopen. */
  readonly refusal: RecoveryRefusal | null;
  /** The documents and codex entries another program changed, when `files` is the refusal (named by title). */
  readonly files: readonly FolderFileChange[];
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function RecoveryDialog({ recovery, busy, refusal, files, onConfirm, onCancel }: RecoveryDialogProps): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const copy = recoveryCopy(recovery);
  // A refusal that asks for a reopen, not a yes: the accept cannot be retried as it stands, so the only button is Close.
  const closeOnly = refusal === 'changed' || refusal === 'files';

  // Mounted only while there is an offer to answer, so it opens with the offer and closes when it is taken away.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby={titleId}
      data-testid="recovery-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form method="dialog" className="confirm-body">
        <h2 id={titleId}>{copy.title}</h2>
        <div className="confirm-text">
          <p>{copy.lead}</p>
          {copy.loss.length > 0 ? (
            <>
              <p><Trans>Rebuilding loses:</Trans></p>
              <ul>
                {copy.loss.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p>{copy.keep}</p>
          {refusal === null ? null : <p role="alert">{refusalText(refusal, files)}</p>}
        </div>
        <div className="confirm-actions">
          <button type="button" className="button" autoFocus={!closeOnly} disabled={busy} onClick={onCancel}>
            {closeOnly ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
          </button>
          {closeOnly ? null : (
            <button type="button" className="button is-primary" disabled={busy} onClick={onConfirm}>
              {refusal === 'locked' ? copy.confirmAnyway : copy.confirm}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}

/** One change as the sentence names it: a whole phrase, so no verb is spliced into a frame on its own. */
function changeWords(change: string, label: string): string {
  return t`${select(change, { changed: 'changed', removed: 'removed', added: 'added', other: 'changed' })} ${{ label: isolate(label) }}`;
}

/** What a refused accept says: the reason, and the one thing to do about it. Nothing was written in either case. */
function refusalText(refusal: RecoveryRefusal, files: readonly FolderFileChange[]): string {
  if (refusal === 'locked') {
    return t`Another program may be using this folder: a lock file in it says so, and the Caotang MCP server may be writing this project too. Going ahead replaces caotang.json, so anything that program wrote could be lost. Go ahead anyway?`;
  }
  if (refusal === 'files') {
    const changes = joinWords(files.map(({ change, label }) => changeWords(change, label)));
    return changes === ''
      ? t`Another program changed a file in this folder after Caotang read the folder, so nothing was written. Close this, then open the folder again to see its current copy.`
      : t`Another program ${{ changes }} after Caotang read the folder, so nothing was written. Close this, then open the folder again to see its current copy.`;
  }
  return t`caotang.json in this folder was changed by another program after Caotang read it, so nothing was written. Close this, then open the folder again to see its current copy.`;
}

/** The words for one offer. A rebuild is the only one that loses structure, so it alone lists what is lost and asks for a yes. */
function recoveryCopy(recovery: PendingRecovery): {
  readonly title: string;
  readonly lead: string;
  readonly loss: readonly string[];
  readonly keep: string;
  readonly confirm: string;
  /** The same answer when a lock may lose another program's write: one whole sentence, not the label with a word after it. */
  readonly confirmAnyway: string;
} {
  const { offer, name } = recovery;
  // A folder keeps the damaged copy beside its new manifest. A bundle is read, and only the bundle file holds the damaged copy.
  const keptName = isolate(name);
  const keep =
    recovery.folder !== null
      ? t`The unreadable caotang.json is kept in the folder, under a name with the date, so nothing is lost.`
      : t`The bundle file itself is not changed. Its unreadable caotang.json is not kept, so keep the bundle file if you may need that copy.`;
  const source = offer.source;
  if (source.kind === 'rebuild') {
    return {
      title: t`Rebuild this project from its documents?`,
      lead: t`caotang.json in “${{ name: keptName }}” and every backup copy of it cannot be read. Caotang can rebuild the project from its document files. The rebuilt project is a new one.`,
      loss: offer.loss,
      keep,
      confirm: t`Rebuild the project`,
      confirmAnyway: t`Rebuild the project anyway`,
    };
  }
  if (source.kind === 'snapshot') {
    return {
      title: t`Open an older copy of this project?`,
      lead: t`caotang.json in “${{ name: keptName }}” cannot be read. The newest backup that can be read is ${{ path: source.path }}, which is backup ${{ generation: source.generation }} of 3 (1 is the newest). Caotang can open that copy instead.`,
      loss: [],
      keep,
      confirm: t`Open this copy`,
      confirmAnyway: t`Open this copy anyway`,
    };
  }
  if (source.kind === 'legacy-snapshot') {
    return {
      title: t`Open an older copy of this project?`,
      lead: t`caotang.json in “${{ name: keptName }}” cannot be read. The single backup an older version kept, ${{ path: source.path }}, can be read. Caotang can open that copy instead.`,
      loss: [],
      keep,
      confirm: t`Open this copy`,
      confirmAnyway: t`Open this copy anyway`,
    };
  }
  return {
    title: t`Open this project?`,
    lead: t`Caotang can read “${{ name: keptName }}”.`,
    loss: [],
    keep,
    confirm: t`Open the project`,
    confirmAnyway: t`Open the project anyway`,
  };
}
