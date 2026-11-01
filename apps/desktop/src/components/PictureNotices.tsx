/**
 * The notices about keeping pictures safe (pictures.md §6.6), in the slot the general storage banner uses: the picture-aware eviction
 * banner, and the bundle reminder for browsers that cannot save to a folder. One is shown at a time, the eviction banner first.
 * What the writer dismissed is kept per project in the app database (picture-notices.ts), never in the project.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { folderAccessSupported } from '../app/fs-access.js';
import {
  afterBundleReminded,
  afterBundleReminderOff,
  afterEvictionDismissed,
  bundleReminderDue,
  bundleReminderText,
  evictionNoticeDue,
  evictionPicturesText,
  readPictureNotices,
  writePictureNotices,
  type EvictionFacts,
  type PictureNoticeRecord,
} from '../app/picture-notices.js';

export interface PictureNoticesProps {
  readonly projectId: string;
  readonly facts: EvictionFacts;
  /** Whether this browser can save to a folder. The reminder is for the ones that cannot. */
  readonly folderAccess?: boolean;
  readonly userAgent?: string;
  readonly now?: () => number;
  /** Exports a bundle. */
  readonly onExport: () => void;
  /** Offered only where the browser can save to a folder. */
  readonly onSaveToFolder?: () => void;
}

export function PictureNotices({ projectId, facts, folderAccess = folderAccessSupported(), userAgent = navigator.userAgent, now = Date.now, onExport, onSaveToFolder }: PictureNoticesProps): ReactNode {
  // Nothing until the stored answer for this project has been read, so a dismissed notice never flashes back.
  const [stored, setStored] = useState<{ readonly projectId: string; readonly record: PictureNoticeRecord } | null>(null);
  useEffect(() => {
    let live = true;
    void readPictureNotices(projectId).then((read) => {
      if (live) setStored({ projectId, record: read });
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  const answer = useCallback(
    (next: PictureNoticeRecord): void => {
      setStored({ projectId, record: next });
      void writePictureNotices(projectId, next);
    },
    [projectId],
  );

  if (stored === null || stored.projectId !== projectId) return null;
  const record = stored.record;

  if (evictionNoticeDue(facts, record)) {
    return (
      <div className="storage-banner" role="status" aria-label={t`Browser storage`} data-testid="storage-banner" data-variant="pictures">
        <div>
          <p>{evictionPicturesText(userAgent)}</p>
        </div>
        <div className="storage-banner-actions">
          <button type="button" className="button" onClick={onExport}>
            <Trans>Export a bundle</Trans>
          </button>
          {folderAccess && onSaveToFolder !== undefined ? (
            <button type="button" className="button is-quiet" onClick={onSaveToFolder}>
              <Trans>Save to a folder</Trans>
            </button>
          ) : null}
          <button type="button" className="button is-quiet" onClick={() => answer(afterEvictionDismissed(record, facts.pictureBytes))}>
            <Trans>Dismiss</Trans>
          </button>
        </div>
      </div>
    );
  }

  if (bundleReminderDue({ folderAccess, pictureBytes: facts.pictureBytes, now: now() }, record)) {
    return (
      <div className="storage-banner" role="status" aria-label={t`Bundle reminder`} data-testid="bundle-reminder">
        <div>
          <p>{bundleReminderText(facts.pictureBytes)}</p>
        </div>
        <div className="storage-banner-actions">
          <button
            type="button"
            className="button"
            onClick={() => {
              answer(afterBundleReminded(record, now()));
              onExport();
            }}
          >
            <Trans>Export a bundle</Trans>
          </button>
          <button type="button" className="button is-quiet" onClick={() => answer(afterBundleReminded(record, now()))}>
            <Trans>Remind me next month</Trans>
          </button>
          <button type="button" className="button is-quiet" onClick={() => answer(afterBundleReminderOff(record))}>
            <Trans>Turn this reminder off</Trans>
          </button>
        </div>
      </div>
    );
  }

  return null;
}
