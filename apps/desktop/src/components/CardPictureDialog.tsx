/**
 * The keyboard way to give a corkboard card its picture (pictures.md §5), beside dropping a picture on it: choose one the project holds,
 * or a file to import. The card's picture is the `card` placement of the binder item, so choosing replaces the earlier one, which stays
 * on the item as a plain reference. A native <dialog>, so focus is trapped and Escape closes it.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';

import type { ProjectSession } from '../app/session.js';
import { accessibleText } from '../i18n/accessible-text.js';
import { entriesOf, PICTURE_ACCEPT } from '../media/picture-board-model.js';

import { useSession } from './shared.js';



export function CardPictureDialog({
  session,
  nodeId,
  title,
  currentAssetId,
  busy,
  onUse,
  onChooseFiles,
  onTakeOff,
  onClose,
}: {
  readonly session: ProjectSession;
  readonly nodeId: string | null;
  readonly title: string;
  /** The picture that is the card's now, when there is one. */
  readonly currentAssetId: string | undefined;
  readonly busy: boolean;
  readonly onUse: (assetId: string) => void;
  readonly onChooseFiles: (files: readonly File[]) => void;
  readonly onTakeOff: () => void;
  readonly onClose: () => void;
}): ReactNode {
  useSession(session);
  const ref = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pick, setPick] = useState('');
  const open = nodeId !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      setPick('');
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const entries = open ? entriesOf(session.state, null).filter((entry) => entry.id !== currentAssetId) : [];
  const contentLang = session.state.manifest.project.language;

  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length > 0) onChooseFiles(files);
  };

  return (
    <dialog
      ref={ref}
      className="confirm"
      aria-label={accessibleText(t({ message: `Card picture for ${{ title }}`, comment: "The dialog sets a card picture; the value is the card title, written by the writer." }))}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form method="dialog" className="confirm-body" onSubmit={(event) => event.preventDefault()}>
        <h2>
          <Trans>Card picture</Trans>
        </h2>
        <div className="confirm-text">
          <p lang={contentLang} dir="auto">
            {title}
          </p>
          <div className="pb-inline">
            <select aria-label={t`A picture the project holds`} value={pick} lang={contentLang} onChange={(event) => setPick(event.target.value)} autoFocus disabled={entries.length === 0}>
              <option value="">{entries.length === 0 ? t`No other pictures` : t`Choose a picture…`}</option>
              {entries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <button type="button" className="button is-primary" disabled={pick === ''} onClick={() => onUse(pick)}>
              <Trans>Use as card picture</Trans>
            </button>
          </div>
          <div className="pb-inline">
            <input ref={fileInput} type="file" accept={PICTURE_ACCEPT} multiple hidden onChange={choose} data-testid="card-picture-input" />
            <button type="button" className="button" disabled={busy} onClick={() => fileInput.current?.click()}>
              <Trans>Import a picture file…</Trans>
            </button>
            {currentAssetId === undefined ? null : (
              <button type="button" className="button is-quiet" onClick={onTakeOff}>
                <Trans>Take the card picture off</Trans>
              </button>
            )}
          </div>
        </div>
        <div className="confirm-actions">
          <button type="button" className="button" onClick={onClose}>
            <Trans>Close</Trans>
          </button>
        </div>
      </form>
    </dialog>
  );
}
